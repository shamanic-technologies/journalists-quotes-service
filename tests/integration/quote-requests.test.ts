import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
} from "vitest";
import request from "supertest";
import {
  createTestApp,
  AUTH_HEADERS,
  TEST_BRAND,
  TEST_CAMPAIGN_A,
  TEST_CAMPAIGN_B,
  TEST_ORG_A,
} from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import {
  providerQuoteRequests,
  quotePitches,
} from "../../src/db/schema.js";

describe("GET /orgs/quote-requests", () => {
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

  it("returns all org rows when campaign_id is omitted", async () => {
    await db.insert(providerQuoteRequests).values([
      {
        provider: "featured",
        ingestionChannel: "api",
        externalId: "ext-a",
        opportunityText: "opp a",
        orgId: TEST_ORG_A,
      },
      {
        provider: "featured",
        ingestionChannel: "api",
        externalId: "ext-b",
        opportunityText: "opp b",
        orgId: TEST_ORG_A,
      },
    ]);

    const res = await request(createTestApp())
      .get("/orgs/quote-requests")
      .set(AUTH_HEADERS);

    expect(res.status).toBe(200);
    expect(res.body.providerQuoteRequests).toHaveLength(2);
  });

  it("filters to rows pitched under the given campaign_id", async () => {
    const inserted = await db
      .insert(providerQuoteRequests)
      .values([
        {
          provider: "featured",
          ingestionChannel: "api",
          externalId: "ext-pitched-a",
          opportunityText: "pitched for A",
          orgId: TEST_ORG_A,
        },
        {
          provider: "featured",
          ingestionChannel: "api",
          externalId: "ext-pitched-b",
          opportunityText: "pitched for B",
          orgId: TEST_ORG_A,
        },
        {
          provider: "featured",
          ingestionChannel: "api",
          externalId: "ext-unpitched",
          opportunityText: "no pitch",
          orgId: TEST_ORG_A,
        },
      ])
      .returning({
        id: providerQuoteRequests.id,
        externalId: providerQuoteRequests.externalId,
      });

    const byExt = new Map(inserted.map((r) => [r.externalId, r.id]));
    await db.insert(quotePitches).values([
      {
        quoteRequestId: byExt.get("ext-pitched-a")!,
        campaignId: TEST_CAMPAIGN_A,
        brandIds: [TEST_BRAND],
        status: "submitted",
        deliveryMethod: "email_reply",
        orgId: TEST_ORG_A,
      },
      {
        quoteRequestId: byExt.get("ext-pitched-b")!,
        campaignId: TEST_CAMPAIGN_B,
        brandIds: [TEST_BRAND],
        status: "submitted",
        deliveryMethod: "email_reply",
        orgId: TEST_ORG_A,
      },
    ]);

    const res = await request(createTestApp())
      .get(`/orgs/quote-requests?campaign_id=${TEST_CAMPAIGN_A}`)
      .set(AUTH_HEADERS);

    expect(res.status).toBe(200);
    expect(res.body.providerQuoteRequests).toHaveLength(1);
    expect(res.body.providerQuoteRequests[0].externalId).toBe("ext-pitched-a");
  });

  it("returns empty list when campaign_id has no pitches", async () => {
    await db.insert(providerQuoteRequests).values({
      provider: "featured",
      ingestionChannel: "api",
      externalId: "ext-orphan",
      opportunityText: "no campaign pitch",
      orgId: TEST_ORG_A,
    });

    const res = await request(createTestApp())
      .get(`/orgs/quote-requests?campaign_id=${TEST_CAMPAIGN_A}`)
      .set(AUTH_HEADERS);

    expect(res.status).toBe(200);
    expect(res.body.providerQuoteRequests).toEqual([]);
  });

  it("rejects malformed campaign_id with 400", async () => {
    const res = await request(createTestApp())
      .get("/orgs/quote-requests?campaign_id=not-a-uuid")
      .set(AUTH_HEADERS);
    expect(res.status).toBe(400);
  });
});
