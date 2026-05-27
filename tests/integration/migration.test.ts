import { describe, it, expect, afterAll } from "vitest";
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
  afterAll(async () => {
    // sql client lifecycle handled by global teardown
  });

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
    // featured_question_id must be nullable now (was notNull originally)
    expect(await isNullable("provider_quote_requests", "featured_question_id")).toBe(true);
    expect(await indexExists("idx_provider_quote_requests_provider_channel_external")).toBe(true);
  });

  it("adds dispatcher fields + nullable Featured cols on quote_pitches", async () => {
    expect(await columnExists("quote_pitches", "delivery_method")).toBe(true);
    expect(await columnExists("quote_pitches", "delivery_target")).toBe(true);
    expect(await columnExists("quote_pitches", "outbound_message_id")).toBe(true);
    expect(await columnExists("quote_pitches", "reply_in_thread_message_id")).toBe(true);
    expect(await columnExists("quote_pitches", "bounce_status")).toBe(true);
    expect(await columnExists("quote_pitches", "quote_opportunity_id")).toBe(true);
    expect(await isNullable("quote_pitches", "featured_question_id")).toBe(true);
    expect(await isNullable("quote_pitches", "featured_profile_id")).toBe(true);
    expect(await indexExists("idx_quote_pitches_opportunity_brand")).toBe(true);
  });

  it("creates new enums", async () => {
    expect(await enumExists("processing_status")).toBe(true);
    expect(await enumExists("cluster_method")).toBe(true);
    expect(await enumExists("delivery_method")).toBe(true);
  });

  it("provider unique constraint blocks duplicate (provider, ingestion_channel, external_id)", async () => {
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

  it("partial unique (quote_opportunity_id, brand_id) on quote_pitches when both set + non-error", async () => {
    const brandId = "00000000-0000-0000-0000-0000000000bb";
    const orgId = "00000000-0000-0000-0000-0000000000ee";
    const campaignId = "00000000-0000-0000-0000-0000000000d9";

    const [opp] = await db
      .insert(quoteOpportunities)
      .values({
        fingerprint: "fp-test-pitch-unique",
        canonicalText: "x",
      })
      .returning();

    const [req] = await db
      .insert(providerQuoteRequests)
      .values({
        provider: "haro",
        ingestionChannel: "email",
        externalId: "ext-pitch-unique",
        opportunityText: "x",
        orgId,
        quoteOpportunityId: opp.id,
      })
      .returning();

    await db.insert(quotePitches).values({
      quoteRequestId: req.id,
      quoteOpportunityId: opp.id,
      campaignId,
      brandId,
      draft: "d".repeat(150),
      status: "submitted",
      deliveryMethod: "email_reply",
      orgId,
    });

    let conflict = false;
    try {
      await db.insert(quotePitches).values({
        quoteRequestId: req.id,
        quoteOpportunityId: opp.id,
        campaignId,
        brandId,
        draft: "d".repeat(150),
        status: "submitted",
        deliveryMethod: "email_reply",
        orgId,
      });
    } catch {
      conflict = true;
    }
    expect(conflict).toBe(true);

    // status='error' bypasses partial unique
    await db.insert(quotePitches).values({
      quoteRequestId: req.id,
      quoteOpportunityId: opp.id,
      campaignId,
      brandId,
      draft: "d".repeat(150),
      status: "error",
      deliveryMethod: "email_reply",
      orgId,
    });

    await db.delete(quotePitches);
    await db.delete(providerQuoteRequests);
    await db.delete(quoteOpportunities);
  });
});

describe("0003 migration — brand-canonical dedup + score cache", () => {
  it("quote_priorities campaign_id is nullable", async () => {
    expect(await isNullable("quote_priorities", "campaign_id")).toBe(true);
  });

  it("quote_pitches campaign_id is nullable", async () => {
    expect(await isNullable("quote_pitches", "campaign_id")).toBe(true);
  });

  it("quote_priorities PK is (quote_request_id, brand_id)", async () => {
    const rows = await sql<{ contype: string; pkdef: string }[]>`
      SELECT con.contype, pg_get_constraintdef(con.oid) AS pkdef
      FROM pg_constraint con
      WHERE con.conrelid = '"quote_priorities"'::regclass
        AND con.contype  = 'p'
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].pkdef).toContain("brand_id");
    expect(rows[0].pkdef).not.toContain("campaign_id");
  });

  it("idx_quote_priorities_brand_score replaces idx_quote_priorities_campaign_score", async () => {
    expect(await indexExists("idx_quote_priorities_brand_score")).toBe(true);
    expect(await indexExists("idx_quote_priorities_campaign_score")).toBe(false);
  });

  it("new partial unique idx_quote_pitches_request_brand exists", async () => {
    expect(await indexExists("idx_quote_pitches_request_brand")).toBe(true);
  });

  it("idx_quote_pitches_request_brand blocks duplicate non-retryable pitches without opportunity_id", async () => {
    const orgId = "00000000-0000-0000-0000-0000000000ff";
    const brandId = "00000000-0000-0000-0000-0000000000bd";
    const campaignId = "00000000-0000-0000-0000-0000000000da";

    const [req] = await db
      .insert(providerQuoteRequests)
      .values({
        provider: "haro",
        ingestionChannel: "email",
        externalId: "ext-req-brand-uniq",
        opportunityText: "x",
        orgId,
      })
      .returning();

    await db.insert(quotePitches).values({
      quoteRequestId: req.id,
      campaignId,
      brandId,
      draft: "d".repeat(150),
      status: "submitted",
      deliveryMethod: "email_reply",
      orgId,
    });

    let conflict = false;
    try {
      await db.insert(quotePitches).values({
        quoteRequestId: req.id,
        campaignId,
        brandId,
        draft: "d".repeat(150),
        status: "submitted",
        deliveryMethod: "email_reply",
        orgId,
      });
    } catch {
      conflict = true;
    }
    expect(conflict).toBe(true);

    // length_violation (retryable) bypasses the partial unique.
    await db.insert(quotePitches).values({
      quoteRequestId: req.id,
      campaignId,
      brandId,
      status: "length_violation",
      deliveryMethod: "email_reply",
      orgId,
    });

    await db.delete(quotePitches);
    await db.delete(providerQuoteRequests);
  });

  it("retryable statuses (length_violation, template_missing, etc.) bypass idx_quote_pitches_opportunity_brand", async () => {
    const orgId = "00000000-0000-0000-0000-0000000000fe";
    const brandId = "00000000-0000-0000-0000-0000000000bc";
    const campaignId = "00000000-0000-0000-0000-0000000000db";

    const [opp] = await db
      .insert(quoteOpportunities)
      .values({ fingerprint: "fp-test-retryable", canonicalText: "x" })
      .returning();
    const [req] = await db
      .insert(providerQuoteRequests)
      .values({
        provider: "haro",
        ingestionChannel: "email",
        externalId: "ext-req-retryable",
        opportunityText: "x",
        orgId,
        quoteOpportunityId: opp.id,
      })
      .returning();

    await db.insert(quotePitches).values({
      quoteRequestId: req.id,
      quoteOpportunityId: opp.id,
      campaignId,
      brandId,
      status: "length_violation",
      deliveryMethod: "email_reply",
      orgId,
    });
    await db.insert(quotePitches).values({
      quoteRequestId: req.id,
      quoteOpportunityId: opp.id,
      campaignId,
      brandId,
      status: "length_violation",
      deliveryMethod: "email_reply",
      orgId,
    });

    const rows = await db.select().from(quotePitches);
    expect(rows.length).toBeGreaterThanOrEqual(2);

    await db.delete(quotePitches);
    await db.delete(providerQuoteRequests);
    await db.delete(quoteOpportunities);
  });

  it("quote_priorities row upsert on (quote_request_id, brand_id) collapses across campaigns", async () => {
    const orgId = "00000000-0000-0000-0000-0000000000fa";
    const brandId = "00000000-0000-0000-0000-0000000000be";

    const [req] = await db
      .insert(providerQuoteRequests)
      .values({
        provider: "haro",
        ingestionChannel: "email",
        externalId: "ext-req-priority-brand-pk",
        opportunityText: "x",
        orgId,
      })
      .returning();

    await db.insert(quotePriorities).values({
      quoteRequestId: req.id,
      campaignId: "00000000-0000-0000-0000-0000000000dc",
      brandId,
      score: "0.75",
      orgId,
    });

    let conflict = false;
    try {
      await db.insert(quotePriorities).values({
        quoteRequestId: req.id,
        campaignId: "00000000-0000-0000-0000-0000000000dd",
        brandId,
        score: "0.85",
        orgId,
      });
    } catch {
      conflict = true;
    }
    expect(conflict).toBe(true);

    await db.delete(quotePriorities);
    await db.delete(providerQuoteRequests);
  });
});
