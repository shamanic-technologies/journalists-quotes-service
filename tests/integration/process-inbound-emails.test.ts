import {
  describe,
  it,
  expect,
  beforeEach,
  beforeAll,
  afterAll,
} from "vitest";
import request from "supertest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createTestApp } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import {
  inboundEmails,
  providerQuoteRequests,
  quoteOpportunities,
} from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import { SHARED_EMAIL_ORG_ID } from "../../src/lib/inbound/process.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const FIXTURE_EML = readFileSync(
  join(__dirname, "..", "fixtures", "haro-sample.eml"),
  "utf8"
);

function extractTextPart(eml: string): string {
  const boundaryMatch = eml.match(/boundary="?([^"\r\n;]+)"?/);
  if (!boundaryMatch) throw new Error("No multipart boundary");
  const boundary = boundaryMatch[1];
  const parts = eml.split(`--${boundary}`);
  for (const part of parts) {
    if (/Content-Type:\s*text\/plain/i.test(part)) {
      const headerEnd = part.search(/\r?\n\r?\n/);
      if (headerEnd === -1) continue;
      const body = part.slice(headerEnd).replace(/^\r?\n\r?\n/, "");
      return body
        .replace(/=\r?\n/g, "")
        .replace(/=([0-9A-Fa-f]{2})/g, (_, h) =>
          String.fromCharCode(parseInt(h, 16))
        );
    }
  }
  throw new Error("No text/plain part");
}

const HARO_TEXT_BODY = extractTextPart(FIXTURE_EML);

async function seedHaroInboundEmail(messageId: string) {
  await db.insert(inboundEmails).values({
    messageId,
    fromEmail: "haro@helpareporter.com",
    toEmail: "haro@inbox.test",
    subject: "[HARO] digest",
    rawPayload: {
      MessageID: messageId,
      From: "haro@helpareporter.com",
      To: "haro@inbox.test",
      Subject: "[HARO] digest",
      TextBody: HARO_TEXT_BODY,
    },
    provider: "haro",
    ingestionChannel: "email",
    sourceAlias: "haro@inbox.test",
    processingStatus: "pending",
  });
}

describe("POST /internal/process-inbound-emails", () => {
  beforeAll(async () => {
    await cleanTestData();
  });
  beforeEach(async () => {
    await cleanTestData();
  });
  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("parses pending HARO email into 20 silver rows + 20 gold clusters", async () => {
    await seedHaroInboundEmail("haro-msg-1");
    const app = createTestApp();
    const res = await request(app)
      .post("/internal/process-inbound-emails")
      .set("x-api-key", "test-api-key")
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.processed).toBe(1);
    expect(res.body.parsed).toBe(1);
    expect(res.body.silverRowsInserted).toBe(20);
    expect(res.body.goldClustersCreated).toBe(20);

    const silver = await db
      .select()
      .from(providerQuoteRequests)
      .where(eq(providerQuoteRequests.provider, "haro"));
    expect(silver).toHaveLength(20);
    for (const row of silver) {
      expect(row.orgId).toBe(SHARED_EMAIL_ORG_ID);
      expect(row.ingestionChannel).toBe("email");
      expect(row.fingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(row.quoteOpportunityId).not.toBeNull();
      expect(row.pitchEmail).toMatch(
        /^reply\+[a-f0-9-]+@helpareporter\.com$/i
      );
    }

    const gold = await db.select().from(quoteOpportunities);
    expect(gold).toHaveLength(20);

    const inbound = await db
      .select()
      .from(inboundEmails)
      .where(eq(inboundEmails.messageId, "haro-msg-1"));
    expect(inbound[0].processingStatus).toBe("parsed");
  });

  it("re-processing the same email is idempotent (no duplicate silver/gold)", async () => {
    await seedHaroInboundEmail("haro-msg-2");
    const app = createTestApp();
    await request(app)
      .post("/internal/process-inbound-emails")
      .set("x-api-key", "test-api-key")
      .send({});

    // Reset processing status to pending and rerun.
    await db
      .update(inboundEmails)
      .set({ processingStatus: "pending" })
      .where(eq(inboundEmails.messageId, "haro-msg-2"));

    const res = await request(app)
      .post("/internal/process-inbound-emails")
      .set("x-api-key", "test-api-key")
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.silverRowsInserted).toBe(0); // all duplicates skipped
    expect(res.body.goldClustersCreated).toBe(0);

    const silver = await db.select().from(providerQuoteRequests);
    expect(silver).toHaveLength(20);
    const gold = await db.select().from(quoteOpportunities);
    expect(gold).toHaveLength(20);
  });

  it("skips emails with no parser (provider=null)", async () => {
    await db.insert(inboundEmails).values({
      messageId: "unknown-msg-1",
      fromEmail: "x@y.com",
      toEmail: "unknown@inbox.test",
      subject: "Random",
      rawPayload: { MessageID: "unknown-msg-1", From: "x@y.com", To: "unknown@inbox.test" },
      provider: null,
      ingestionChannel: "email",
      sourceAlias: "unknown@inbox.test",
      processingStatus: "pending",
    });
    const app = createTestApp();
    const res = await request(app)
      .post("/internal/process-inbound-emails")
      .set("x-api-key", "test-api-key")
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.skipped).toBe(1);
    expect(res.body.silverRowsInserted).toBe(0);

    const inbound = await db
      .select()
      .from(inboundEmails)
      .where(eq(inboundEmails.messageId, "unknown-msg-1"));
    expect(inbound[0].processingStatus).toBe("skipped");
    expect(inbound[0].parseError).toContain("Provider unresolved");
  });

  it("marks failed when TextBody is missing", async () => {
    await db.insert(inboundEmails).values({
      messageId: "haro-broken-1",
      fromEmail: "haro@helpareporter.com",
      toEmail: "haro@inbox.test",
      subject: "broken",
      rawPayload: {
        From: "haro@helpareporter.com",
        To: "haro@inbox.test",
        // MessageID missing -> Zod parse fails inside processor
      },
      provider: "haro",
      ingestionChannel: "email",
      sourceAlias: "haro@inbox.test",
      processingStatus: "pending",
    });
    const app = createTestApp();
    const res = await request(app)
      .post("/internal/process-inbound-emails")
      .set("x-api-key", "test-api-key")
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.failed).toBe(1);

    const inbound = await db
      .select()
      .from(inboundEmails)
      .where(eq(inboundEmails.messageId, "haro-broken-1"));
    expect(inbound[0].processingStatus).toBe("failed");
    expect(inbound[0].parseError).toBeTruthy();
  });
});
