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
  quotePriorities,
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

  it("filters to rows scored for the given campaign_id", async () => {
    const inserted = await db
      .insert(providerQuoteRequests)
      .values([
        {
          provider: "featured",
          ingestionChannel: "api",
          externalId: "ext-scored-a",
          opportunityText: "scored for A",
          orgId: TEST_ORG_A,
        },
        {
          provider: "featured",
          ingestionChannel: "api",
          externalId: "ext-scored-b",
          opportunityText: "scored for B",
          orgId: TEST_ORG_A,
        },
        {
          provider: "featured",
          ingestionChannel: "api",
          externalId: "ext-unscored",
          opportunityText: "no priority",
          orgId: TEST_ORG_A,
        },
      ])
      .returning({ id: providerQuoteRequests.id, externalId: providerQuoteRequests.externalId });

    const byExt = new Map(inserted.map((r) => [r.externalId, r.id]));
    await db.insert(quotePriorities).values([
      {
        quoteRequestId: byExt.get("ext-scored-a")!,
        campaignId: TEST_CAMPAIGN_A,
        brandId: TEST_BRAND,
        score: "0.90",
        orgId: TEST_ORG_A,
      },
      {
        quoteRequestId: byExt.get("ext-scored-b")!,
        campaignId: TEST_CAMPAIGN_B,
        brandId: TEST_BRAND,
        score: "0.80",
        orgId: TEST_ORG_A,
      },
    ]);

    const res = await request(createTestApp())
      .get(`/orgs/quote-requests?campaign_id=${TEST_CAMPAIGN_A}`)
      .set(AUTH_HEADERS);

    expect(res.status).toBe(200);
    expect(res.body.providerQuoteRequests).toHaveLength(1);
    expect(res.body.providerQuoteRequests[0].externalId).toBe("ext-scored-a");
  });

  it("returns empty list when campaign_id has no scored priorities", async () => {
    await db.insert(providerQuoteRequests).values({
      provider: "featured",
      ingestionChannel: "api",
      externalId: "ext-orphan",
      opportunityText: "no campaign scoring",
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
