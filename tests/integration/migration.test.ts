import { describe, it, expect } from "vitest";
import { db, sql } from "../../src/db/index.js";
import {
  inboundEmails,
  providerQuoteRequests,
  quoteOpportunities,
  quotePitches,
  quotePriorities,
} from "../../src/db/schema.js";

async function columnExists(table: string, column: string): Promise<boolean> {
  const rows = await sql<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = ${table}
        AND column_name = ${column}
    ) AS exists
  `;
  return rows[0]?.exists === true;
}

async function isNullable(table: string, column: string): Promise<boolean> {
  const rows = await sql<{ is_nullable: string }[]>`
    SELECT is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = ${table}
      AND column_name = ${column}
  `;
  return rows[0]?.is_nullable === "YES";
}

async function indexExists(name: string): Promise<boolean> {
  const rows = await sql<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM pg_indexes
      WHERE schemaname = 'public' AND indexname = ${name}
    ) AS exists
  `;
  return rows[0]?.exists === true;
}

async function enumExists(name: string): Promise<boolean> {
  const rows = await sql<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM pg_type WHERE typname = ${name}
    ) AS exists
  `;
  return rows[0]?.exists === true;
}

describe("0001 migration — multi-source opportunities", () => {
  it("creates inbound_emails table", async () => {
    expect(await columnExists("inbound_emails", "message_id")).toBe(true);
    expect(await columnExists("inbound_emails", "raw_payload")).toBe(true);
    expect(await columnExists("inbound_emails", "processing_status")).toBe(true);
    expect(await indexExists("idx_inbound_emails_message_id")).toBe(true);
  });

  it("creates quote_opportunities table without org_id (global)", async () => {
    expect(await columnExists("quote_opportunities", "fingerprint")).toBe(true);
    expect(await columnExists("quote_opportunities", "canonical_text")).toBe(true);
    expect(await columnExists("quote_opportunities", "org_id")).toBe(false);
    expect(await indexExists("idx_quote_opportunities_fingerprint")).toBe(true);
  });

  it("renames quote_requests -> provider_quote_requests with new columns", async () => {
    expect(await columnExists("provider_quote_requests", "provider")).toBe(true);
    expect(await columnExists("provider_quote_requests", "ingestion_channel")).toBe(true);
    expect(await columnExists("provider_quote_requests", "external_id")).toBe(true);
    expect(await columnExists("provider_quote_requests", "journalist_email")).toBe(true);
    expect(await columnExists("provider_quote_requests", "pitch_email")).toBe(true);
    expect(await columnExists("provider_quote_requests", "quote_opportunity_id")).toBe(true);
    expect(await columnExists("provider_quote_requests", "fingerprint")).toBe(true);
    expect(await columnExists("provider_quote_requests", "is_canonical")).toBe(true);
    expect(await columnExists("provider_quote_requests", "inbound_email_id")).toBe(true);
    expect(await isNullable("provider_quote_requests", "featured_question_id")).toBe(true);
    expect(await indexExists("idx_provider_quote_requests_provider_channel_external")).toBe(true);
  });

  it("dispatcher fields + nullable Featured cols on quote_pitches", async () => {
    expect(await columnExists("quote_pitches", "delivery_method")).toBe(true);
    expect(await columnExists("quote_pitches", "delivery_target")).toBe(true);
    expect(await columnExists("quote_pitches", "outbound_message_id")).toBe(true);
    expect(await columnExists("quote_pitches", "reply_in_thread_message_id")).toBe(true);
    expect(await columnExists("quote_pitches", "bounce_status")).toBe(true);
    expect(await columnExists("quote_pitches", "quote_opportunity_id")).toBe(true);
    expect(await isNullable("quote_pitches", "featured_question_id")).toBe(true);
    expect(await isNullable("quote_pitches", "featured_profile_id")).toBe(true);
  });

  it("creates new enums", async () => {
    expect(await enumExists("processing_status")).toBe(true);
    expect(await enumExists("cluster_method")).toBe(true);
    expect(await enumExists("delivery_method")).toBe(true);
  });
});

describe("0004 migration — Gold-cluster IDs + multi-brand brand_ids[]", () => {
  it("quote_pitches.brand_id (singular) dropped", async () => {
    expect(await columnExists("quote_pitches", "brand_id")).toBe(false);
  });

  it("quote_pitches.brand_ids (plural uuid[]) present + NOT NULL", async () => {
    expect(await columnExists("quote_pitches", "brand_ids")).toBe(true);
    expect(await isNullable("quote_pitches", "brand_ids")).toBe(false);
  });

  it("quote_priorities.brand_id (singular) dropped", async () => {
    expect(await columnExists("quote_priorities", "brand_id")).toBe(false);
  });

  it("quote_priorities.brand_ids (plural uuid[]) present + NOT NULL", async () => {
    expect(await columnExists("quote_priorities", "brand_ids")).toBe(true);
    expect(await isNullable("quote_priorities", "brand_ids")).toBe(false);
  });

  it("quote_priorities key column is quote_opportunity_id (Gold), not quote_request_id (silver)", async () => {
    expect(await columnExists("quote_priorities", "quote_opportunity_id")).toBe(true);
    expect(await columnExists("quote_priorities", "quote_request_id")).toBe(false);
  });

  it("quote_priorities PK = (quote_opportunity_id, brand_ids)", async () => {
    const rows = await sql<{ pkdef: string }[]>`
      SELECT pg_get_constraintdef(con.oid) AS pkdef
      FROM pg_constraint con
      WHERE con.conrelid = '"quote_priorities"'::regclass
        AND con.contype  = 'p'
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].pkdef).toContain("quote_opportunity_id");
    expect(rows[0].pkdef).toContain("brand_ids");
    expect(rows[0].pkdef).not.toContain("quote_request_id");
  });

  it("indexes: GIN brand_ids on quote_priorities + quote_pitches", async () => {
    expect(await indexExists("idx_quote_priorities_brand_ids")).toBe(true);
    expect(await indexExists("idx_quote_pitches_brand_ids")).toBe(true);
  });

  it("partial unique (quote_opportunity_id, brand_ids) on quote_pitches when non-retryable", async () => {
    expect(await indexExists("idx_quote_pitches_opportunity_brand_ids")).toBe(true);

    const orgId = "00000000-0000-0000-0000-0000000000ee";
    const brandIds = ["00000000-0000-0000-0000-0000000000ab"];

    const [opp] = await db
      .insert(quoteOpportunities)
      .values({
        fingerprint: "fp-0004-unique-test",
        canonicalText: "x",
      })
      .returning();
    const [req] = await db
      .insert(providerQuoteRequests)
      .values({
        provider: "haro",
        ingestionChannel: "email",
        externalId: "ext-0004-unique-test",
        opportunityText: "x",
        orgId,
        quoteOpportunityId: opp.id,
      })
      .returning();

    await db.insert(quotePitches).values({
      quoteRequestId: req.id,
      quoteOpportunityId: opp.id,
      brandIds,
      draft: "x".repeat(150),
      status: "submitted",
      deliveryMethod: "email_reply",
      orgId,
    });

    let conflict = false;
    try {
      await db.insert(quotePitches).values({
        quoteRequestId: req.id,
        quoteOpportunityId: opp.id,
        brandIds,
        draft: "x".repeat(150),
        status: "submitted",
        deliveryMethod: "email_reply",
        orgId,
      });
    } catch {
      conflict = true;
    }
    expect(conflict).toBe(true);

    // retryable status bypasses the partial unique
    await db.insert(quotePitches).values({
      quoteRequestId: req.id,
      quoteOpportunityId: opp.id,
      brandIds,
      status: "error",
      deliveryMethod: "email_reply",
      orgId,
    });

    // co-brand (different brandSet) is distinct: [A, B] != [A]
    await db.insert(quotePitches).values({
      quoteRequestId: req.id,
      quoteOpportunityId: opp.id,
      brandIds: [
        "00000000-0000-0000-0000-0000000000ab",
        "00000000-0000-0000-0000-0000000000ac",
      ],
      draft: "y".repeat(150),
      status: "submitted",
      deliveryMethod: "email_reply",
      orgId,
    });

    await db.delete(quotePitches);
    await db.delete(providerQuoteRequests);
    await db.delete(quoteOpportunities);
  });

  it("quote_priorities upsert on (quote_opportunity_id, brand_ids) collapses across campaigns", async () => {
    const orgId = "00000000-0000-0000-0000-0000000000fa";
    const brandIds = ["00000000-0000-0000-0000-0000000000be"];

    const [opp] = await db
      .insert(quoteOpportunities)
      .values({ fingerprint: "fp-0004-prio-test", canonicalText: "x" })
      .returning();

    await db.insert(quotePriorities).values({
      quoteOpportunityId: opp.id,
      brandIds,
      campaignId: "00000000-0000-0000-0000-0000000000dc",
      score: "0.75",
      orgId,
    });

    let conflict = false;
    try {
      await db.insert(quotePriorities).values({
        quoteOpportunityId: opp.id,
        brandIds,
        campaignId: "00000000-0000-0000-0000-0000000000dd",
        score: "0.85",
        orgId,
      });
    } catch {
      conflict = true;
    }
    expect(conflict).toBe(true);

    // co-brand brandSet is distinct
    await db.insert(quotePriorities).values({
      quoteOpportunityId: opp.id,
      brandIds: [
        "00000000-0000-0000-0000-0000000000be",
        "00000000-0000-0000-0000-0000000000bf",
      ],
      score: "0.80",
      orgId,
    });

    await db.delete(quotePriorities);
    await db.delete(quoteOpportunities);
  });
});

describe("provider unique constraint", () => {
  it("blocks duplicate (provider, ingestion_channel, external_id)", async () => {
    const orgId = "00000000-0000-0000-0000-0000000000ee";
    await db
      .insert(providerQuoteRequests)
      .values({
        provider: "haro",
        ingestionChannel: "email",
        externalId: "test-ext-1",
        opportunityText: "first",
        orgId,
      })
      .onConflictDoNothing();
    let conflict = false;
    try {
      await db.insert(providerQuoteRequests).values({
        provider: "haro",
        ingestionChannel: "email",
        externalId: "test-ext-1",
        opportunityText: "second",
        orgId,
      });
    } catch {
      conflict = true;
    }
    expect(conflict).toBe(true);
    await db.delete(providerQuoteRequests);
  });

  it("inbound_emails.message_id unique blocks duplicates", async () => {
    await db
      .insert(inboundEmails)
      .values({
        messageId: "test-msg-1",
        fromEmail: "a@b.com",
        toEmail: "haro@inbox.test",
        rawPayload: { foo: 1 },
      })
      .onConflictDoNothing();
    let conflict = false;
    try {
      await db.insert(inboundEmails).values({
        messageId: "test-msg-1",
        fromEmail: "a@b.com",
        toEmail: "haro@inbox.test",
        rawPayload: { foo: 2 },
      });
    } catch {
      conflict = true;
    }
    expect(conflict).toBe(true);
    await db.delete(inboundEmails);
  });
});
