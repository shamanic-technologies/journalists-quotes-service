import { describe, it, expect, beforeEach, afterAll, beforeAll } from "vitest";
import request from "supertest";
import { createTestApp } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { inboundEmails } from "../../src/db/schema.js";
import { _resetAliasRoutingCache } from "../../src/lib/inbound/alias-routing.js";
import { buildSignatureHeader } from "../helpers/hmac-sign.js";

const HMAC_SECRET = "test-hmac-secret";

function postmarkPayload(overrides: Record<string, unknown> = {}) {
  return {
    MessageID: "test-msg-001",
    From: "haro@helpareporter.com",
    FromFull: { Email: "haro@helpareporter.com", Name: "HARO" },
    To: "haro@inbox.test",
    ToFull: [{ Email: "haro@inbox.test", Name: "" }],
    Subject: "[HARO] Daily digest",
    Date: "Mon, 10 May 2026 09:00:00 +0000",
    TextBody: "Some queries here...",
    HtmlBody: "<p>Some queries here...</p>",
    Headers: [],
    Attachments: [],
    ...overrides,
  };
}

function signedPost(
  app: ReturnType<typeof createTestApp>,
  payload: object,
  options: { timestampSeconds?: number } = {}
) {
  const { signature, bodyString } = buildSignatureHeader(
    payload,
    HMAC_SECRET,
    options
  );
  return request(app)
    .post("/webhooks/inbound-email")
    .set("x-eg-signature", signature)
    .set("content-type", "application/json")
    .send(bodyString);
}

describe("POST /webhooks/inbound-email (HMAC-verified)", () => {
  beforeAll(async () => {
    process.env.JQS_INBOUND_HMAC_SECRET = HMAC_SECRET;
    _resetAliasRoutingCache();
    await cleanTestData();
  });

  beforeEach(async () => {
    await cleanTestData();
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("accepts valid signed payload, derives provider from alias", async () => {
    const app = createTestApp();
    const res = await signedPost(app, postmarkPayload());

    expect(res.status).toBe(200);
    expect(res.body.accepted).toBe(true);
    expect(res.body.inboundEmailId).toBeDefined();

    const rows = await db.select().from(inboundEmails);
    expect(rows).toHaveLength(1);
    expect(rows[0].provider).toBe("haro");
    expect(rows[0].ingestionChannel).toBe("email");
    expect(rows[0].sourceAlias).toBe("haro@inbox.test");
    expect(rows[0].messageId).toBe("test-msg-001");
    expect(rows[0].processingStatus).toBe("pending");
    expect(rows[0].rawPayload).toMatchObject({ MessageID: "test-msg-001" });
  });

  it("idempotent on duplicate MessageID", async () => {
    const app = createTestApp();
    const first = await signedPost(app, postmarkPayload());
    expect(first.status).toBe(200);
    expect(first.body.deduplicated).toBeUndefined();

    const second = await signedPost(
      app,
      postmarkPayload({ Subject: "Different subject" })
    );
    expect(second.status).toBe(200);
    expect(second.body.accepted).toBe(true);
    expect(second.body.deduplicated).toBe(true);

    const rows = await db.select().from(inboundEmails);
    expect(rows).toHaveLength(1);
  });

  it("stores unknown alias with provider=null", async () => {
    const app = createTestApp();
    const res = await signedPost(
      app,
      postmarkPayload({
        To: "unknown@inbox.test",
        ToFull: [{ Email: "unknown@inbox.test", Name: "" }],
      })
    );
    expect(res.status).toBe(200);
    const rows = await db.select().from(inboundEmails);
    expect(rows[0].provider).toBeNull();
  });

  it("rejects missing signature header with 401", async () => {
    const app = createTestApp();
    const res = await request(app)
      .post("/webhooks/inbound-email")
      .send(postmarkPayload());
    expect(res.status).toBe(401);
  });

  it("rejects malformed signature header with 401", async () => {
    const app = createTestApp();
    const res = await request(app)
      .post("/webhooks/inbound-email")
      .set("x-eg-signature", "garbage")
      .send(postmarkPayload());
    expect(res.status).toBe(401);
  });

  it("rejects signature computed with wrong secret with 401", async () => {
    const app = createTestApp();
    const payload = postmarkPayload();
    const { signature, bodyString } = buildSignatureHeader(
      payload,
      "wrong-secret"
    );
    const res = await request(app)
      .post("/webhooks/inbound-email")
      .set("x-eg-signature", signature)
      .set("content-type", "application/json")
      .send(bodyString);
    expect(res.status).toBe(401);
  });

  it("rejects signature outside replay window with 401", async () => {
    const app = createTestApp();
    const oldTs = Math.floor(Date.now() / 1000) - 10_000;
    const res = await signedPost(app, postmarkPayload(), {
      timestampSeconds: oldTs,
    });
    expect(res.status).toBe(401);
  });

  it("rejects malformed payload (missing MessageID) with 400", async () => {
    const app = createTestApp();
    const res = await signedPost(app, {
      From: "x@y.com",
      To: "haro@inbox.test",
    });
    expect(res.status).toBe(400);
  });

  it("preserves full Postmark payload in raw_payload jsonb", async () => {
    const app = createTestApp();
    const payload = postmarkPayload({
      Headers: [{ Name: "X-Spam-Score", Value: "0.0" }],
      Attachments: [{ Name: "doc.pdf", Content: "..." }],
    });
    await signedPost(app, payload);
    const rows = await db.select().from(inboundEmails);
    expect(rows[0].rawPayload).toMatchObject({
      Headers: [{ Name: "X-Spam-Score", Value: "0.0" }],
      Attachments: [{ Name: "doc.pdf", Content: "..." }],
    });
  });
});
