import { describe, it, expect, beforeEach, afterAll, beforeAll } from "vitest";
import request from "supertest";
import { createTestApp } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { inboundEmails } from "../../src/db/schema.js";
import { _resetAliasRoutingCache } from "../../src/lib/inbound/alias-routing.js";

const SERVICE_HEADERS = {
  "x-api-key": "test-api-key",
  "x-service-name": "email-gateway-service",
};

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

describe("POST /webhooks/inbound-email", () => {
  beforeAll(async () => {
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

  it("accepts valid payload, derives provider from alias", async () => {
    const app = createTestApp();
    const res = await request(app)
      .post("/webhooks/inbound-email")
      .set(SERVICE_HEADERS)
      .send(postmarkPayload());

    expect(res.status).toBe(200);
    expect(res.body.accepted).toBe(true);
    expect(res.body.inboundEmailId).toBeDefined();

    const rows = await db.select().from(inboundEmails);
    expect(rows).toHaveLength(1);
    expect(rows[0].provider).toBe("haro");
    expect(rows[0].ingestionChannel).toBe("email");
    expect(rows[0].sourceAlias).toBe("haro@inbox.test");
    expect(rows[0].toEmail).toBe("haro@inbox.test");
    expect(rows[0].messageId).toBe("test-msg-001");
    expect(rows[0].processingStatus).toBe("pending");
    expect(rows[0].rawPayload).toMatchObject({ MessageID: "test-msg-001" });
  });

  it("idempotent on duplicate MessageID", async () => {
    const app = createTestApp();
    const first = await request(app)
      .post("/webhooks/inbound-email")
      .set(SERVICE_HEADERS)
      .send(postmarkPayload());
    expect(first.status).toBe(200);
    expect(first.body.deduplicated).toBeUndefined();

    const second = await request(app)
      .post("/webhooks/inbound-email")
      .set(SERVICE_HEADERS)
      .send(postmarkPayload({ Subject: "Different subject" }));

    expect(second.status).toBe(200);
    expect(second.body.accepted).toBe(true);
    expect(second.body.deduplicated).toBe(true);

    const rows = await db.select().from(inboundEmails);
    expect(rows).toHaveLength(1);
  });

  it("stores unknown alias with provider=null", async () => {
    const app = createTestApp();
    const res = await request(app)
      .post("/webhooks/inbound-email")
      .set(SERVICE_HEADERS)
      .send(postmarkPayload({ To: "unknown@inbox.test", ToFull: [{ Email: "unknown@inbox.test", Name: "" }] }));

    expect(res.status).toBe(200);
    const rows = await db.select().from(inboundEmails);
    expect(rows).toHaveLength(1);
    expect(rows[0].provider).toBeNull();
    expect(rows[0].sourceAlias).toBe("unknown@inbox.test");
    expect(rows[0].processingStatus).toBe("pending");
  });

  it("matches SOS alias", async () => {
    const app = createTestApp();
    await request(app)
      .post("/webhooks/inbound-email")
      .set(SERVICE_HEADERS)
      .send(
        postmarkPayload({
          MessageID: "sos-msg-1",
          To: "sos@inbox.test",
          ToFull: [{ Email: "sos@inbox.test", Name: "" }],
        })
      );

    const rows = await db.select().from(inboundEmails);
    expect(rows[0].provider).toBe("sos");
  });

  it("rejects missing x-api-key with 401", async () => {
    const app = createTestApp();
    const res = await request(app)
      .post("/webhooks/inbound-email")
      .set({ "x-service-name": "email-gateway-service" })
      .send(postmarkPayload());
    expect(res.status).toBe(401);
  });

  it("rejects wrong x-api-key with 401", async () => {
    const app = createTestApp();
    const res = await request(app)
      .post("/webhooks/inbound-email")
      .set({ "x-api-key": "wrong", "x-service-name": "email-gateway-service" })
      .send(postmarkPayload());
    expect(res.status).toBe(401);
  });

  it("rejects missing x-service-name with 401", async () => {
    const app = createTestApp();
    const res = await request(app)
      .post("/webhooks/inbound-email")
      .set({ "x-api-key": "test-api-key" })
      .send(postmarkPayload());
    expect(res.status).toBe(401);
  });

  it("rejects unknown x-service-name with 401", async () => {
    const app = createTestApp();
    const res = await request(app)
      .post("/webhooks/inbound-email")
      .set({ "x-api-key": "test-api-key", "x-service-name": "evil-service" })
      .send(postmarkPayload());
    expect(res.status).toBe(401);
  });

  it("rejects malformed payload (missing MessageID) with 400", async () => {
    const app = createTestApp();
    const res = await request(app)
      .post("/webhooks/inbound-email")
      .set(SERVICE_HEADERS)
      .send({ From: "x@y.com", To: "haro@inbox.test" });
    expect(res.status).toBe(400);
  });

  it("preserves full Postmark payload in raw_payload jsonb", async () => {
    const app = createTestApp();
    const payload = postmarkPayload({
      Headers: [{ Name: "X-Spam-Score", Value: "0.0" }],
      Attachments: [{ Name: "doc.pdf", Content: "..." }],
    });
    await request(app)
      .post("/webhooks/inbound-email")
      .set(SERVICE_HEADERS)
      .send(payload);
    const rows = await db.select().from(inboundEmails);
    expect(rows[0].rawPayload).toMatchObject({
      Headers: [{ Name: "X-Spam-Score", Value: "0.0" }],
      Attachments: [{ Name: "doc.pdf", Content: "..." }],
    });
  });
});
