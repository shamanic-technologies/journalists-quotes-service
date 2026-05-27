import {
  describe,
  it,
  expect,
  beforeEach,
  beforeAll,
  afterAll,
  vi,
} from "vitest";
import request from "supertest";
import {
  createTestApp,
  AUTH_HEADERS,
  TEST_BRAND,
  TEST_BRAND_B,
  TEST_CAMPAIGN_A,
  TEST_CAMPAIGN_B,
  TEST_ORG_A,
} from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import {
  providerQuoteRequests,
  quoteOpportunities,
  quotePitches,
} from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import {
  buildMockClient,
  createMockState,
  type MockFeaturedState,
} from "../helpers/mock-featured.js";
import { _resetFeaturedClientState } from "../../src/lib/featured-client.js";

vi.mock("../../src/lib/key-service-client.js", () => ({
  getFeaturedCredentials: vi.fn(async () => ({
    username: "mock-u",
    password: "mock-p",
    keySource: "platform" as const,
  })),
  KeyServiceUnavailableError: class extends Error {},
}));

vi.mock("../../src/lib/chat-client.js", () => ({
  ragScore: vi.fn(
    async (req: { documents: { id: string; text: string }[] }) => ({
      results: req.documents.map((d) => ({
        id: d.id,
        score: /high/i.test(d.text)
          ? 0.95
          : /mid/i.test(d.text)
            ? 0.7
            : 0.2,
        whyRelevant: "test scorer",
      })),
    })
  ),
}));

let state: MockFeaturedState;

describe("POST /orgs/opportunities/ranked", () => {
  beforeAll(async () => {
    await cleanTestData();
  });
  beforeEach(async () => {
    _resetFeaturedClientState();
    await cleanTestData();
    state = createMockState();
  });
  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  function app() {
    return createTestApp({
      opportunitiesRankedDeps: { buildClient: buildMockClient(state) },
    });
  }

  it("returns an empty list with total 0 when no eligible candidates", async () => {
    const res = await request(app())
      .post("/orgs/opportunities/ranked")
      .set(AUTH_HEADERS)
      .send({ campaignId: TEST_CAMPAIGN_A });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: "ok",
      opportunities: [],
      total: 0,
      brandIds: [TEST_BRAND],
    });
  });

  it("returns opportunities sorted by score desc with Gold cluster IDs, pitchStatus null when unpitched", async () => {
    state.opportunities = [
      {
        featuredQuestionId: 1,
        opportunity: "low signal cat memes",
        mediaOutlet: "BuzzFeed",
        source: "featured",
      },
      {
        featuredQuestionId: 2,
        opportunity: "high signal AI ethics",
        mediaOutlet: "Forbes",
        source: "featured",
      },
      {
        featuredQuestionId: 3,
        opportunity: "mid signal SaaS pricing",
        mediaOutlet: "TechCrunch",
        source: "featured",
      },
    ];

    const res = await request(app())
      .post("/orgs/opportunities/ranked")
      .set(AUTH_HEADERS)
      .send({ campaignId: TEST_CAMPAIGN_A });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.opportunities).toHaveLength(2);
    expect(res.body.opportunities[0].featuredQuestionId).toBe(2);
    expect(res.body.opportunities[0].score).toBeCloseTo(0.95);
    expect(res.body.opportunities[0].pitchStatus).toBeNull();
    expect(res.body.opportunities[1].featuredQuestionId).toBe(3);
    expect(res.body.opportunities[1].score).toBeCloseTo(0.7);
    expect(res.body.total).toBe(2);

    // opportunityId is the Gold cluster id, not the silver request id.
    const goldIds = await db
      .select({ id: quoteOpportunities.id })
      .from(quoteOpportunities);
    const goldIdSet = new Set(goldIds.map((g) => g.id));
    for (const o of res.body.opportunities) {
      expect(goldIdSet.has(o.opportunityId)).toBe(true);
    }
  });

  it("honors limit and offset for paging the ranked queue", async () => {
    state.opportunities = Array.from({ length: 4 }, (_, i) => ({
      featuredQuestionId: 1000 + i,
      opportunity: `high signal item ${i}`,
      mediaOutlet: `Outlet ${i}`,
      source: "featured",
    }));

    const a = app();
    const first = await request(a)
      .post("/orgs/opportunities/ranked")
      .set(AUTH_HEADERS)
      .send({ campaignId: TEST_CAMPAIGN_A, limit: 2, offset: 0 });
    expect(first.body.opportunities).toHaveLength(2);
    expect(first.body.total).toBe(4);

    const second = await request(a)
      .post("/orgs/opportunities/ranked")
      .set(AUTH_HEADERS)
      .send({ campaignId: TEST_CAMPAIGN_A, limit: 2, offset: 2 });
    expect(second.body.opportunities).toHaveLength(2);
    expect(second.body.total).toBe(4);

    const ids = new Set([
      ...first.body.opportunities.map(
        (o: { opportunityId: string }) => o.opportunityId
      ),
      ...second.body.opportunities.map(
        (o: { opportunityId: string }) => o.opportunityId
      ),
    ]);
    expect(ids.size).toBe(4);
  });

  it("surfaces pitchStatus when the brand-set has a pitch under the same campaign", async () => {
    state.opportunities = [
      {
        featuredQuestionId: 9001,
        opportunity: "high signal already-pitched",
        mediaOutlet: "Outlet A",
        source: "featured",
      },
      {
        featuredQuestionId: 9002,
        opportunity: "high signal available",
        mediaOutlet: "Outlet B",
        source: "featured",
      },
    ];

    const a = app();
    await request(a)
      .post("/orgs/opportunities/ranked")
      .set(AUTH_HEADERS)
      .send({ campaignId: TEST_CAMPAIGN_A });

    const silver = await db
      .select()
      .from(providerQuoteRequests)
      .where(eq(providerQuoteRequests.externalId, "9001"));

    await db.insert(quotePitches).values({
      quoteRequestId: silver[0].id,
      quoteOpportunityId: silver[0].quoteOpportunityId,
      featuredQuestionId: 9001,
      campaignId: TEST_CAMPAIGN_A,
      brandIds: [TEST_BRAND],
      status: "submitted",
      deliveryMethod: "featured_api",
      orgId: TEST_ORG_A,
    });

    const res = await request(a)
      .post("/orgs/opportunities/ranked")
      .set(AUTH_HEADERS)
      .send({ campaignId: TEST_CAMPAIGN_A });

    expect(res.status).toBe(200);
    expect(res.body.opportunities).toHaveLength(2);
    const byFq: Record<number, { pitchStatus: string | null }> = {};
    for (const o of res.body.opportunities) {
      byFq[o.featuredQuestionId] = { pitchStatus: o.pitchStatus };
    }
    expect(byFq[9001].pitchStatus).toBe("submitted");
    expect(byFq[9002].pitchStatus).toBeNull();
  });

  it("brand-only call surfaces pitchStatus across all campaigns of the brand-set", async () => {
    state.opportunities = [
      {
        featuredQuestionId: 7001,
        opportunity: "high signal cross-campaign brand dedup",
        mediaOutlet: "Outlet C",
        source: "featured",
      },
    ];

    const a = app();
    await request(a)
      .post("/orgs/opportunities/ranked")
      .set(AUTH_HEADERS)
      .send({});

    const silver = await db
      .select()
      .from(providerQuoteRequests)
      .where(eq(providerQuoteRequests.externalId, "7001"));

    await db.insert(quotePitches).values({
      quoteRequestId: silver[0].id,
      quoteOpportunityId: silver[0].quoteOpportunityId,
      featuredQuestionId: 7001,
      campaignId: TEST_CAMPAIGN_A,
      brandIds: [TEST_BRAND],
      status: "submitted",
      deliveryMethod: "featured_api",
      orgId: TEST_ORG_A,
    });

    const res = await request(a)
      .post("/orgs/opportunities/ranked")
      .set(AUTH_HEADERS)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.opportunities).toHaveLength(1);
    expect(res.body.opportunities[0].pitchStatus).toBe("submitted");
  });

  it("campaign-scoped call isolates pitchStatus to that campaign only", async () => {
    state.opportunities = [
      {
        featuredQuestionId: 7002,
        opportunity: "high signal scope isolation",
        mediaOutlet: "Outlet D",
        source: "featured",
      },
    ];

    const a = app();
    await request(a)
      .post("/orgs/opportunities/ranked")
      .set(AUTH_HEADERS)
      .send({});

    const silver = await db
      .select()
      .from(providerQuoteRequests)
      .where(eq(providerQuoteRequests.externalId, "7002"));

    await db.insert(quotePitches).values({
      quoteRequestId: silver[0].id,
      quoteOpportunityId: silver[0].quoteOpportunityId,
      featuredQuestionId: 7002,
      campaignId: TEST_CAMPAIGN_A,
      brandIds: [TEST_BRAND],
      status: "submitted",
      deliveryMethod: "featured_api",
      orgId: TEST_ORG_A,
    });

    const res = await request(a)
      .post("/orgs/opportunities/ranked")
      .set(AUTH_HEADERS)
      .send({ campaignId: TEST_CAMPAIGN_B });

    expect(res.status).toBe(200);
    expect(res.body.opportunities).toHaveLength(1);
    expect(res.body.opportunities[0].pitchStatus).toBeNull();
  });

  it("rejects limit > 50 with 400", async () => {
    const res = await request(app())
      .post("/orgs/opportunities/ranked")
      .set(AUTH_HEADERS)
      .send({ campaignId: TEST_CAMPAIGN_A, limit: 100 });
    expect(res.status).toBe(400);
  });

  it("rejects when x-brand-id header is missing", async () => {
    const headers = { ...AUTH_HEADERS } as Record<string, string>;
    delete headers["x-brand-id"];
    const res = await request(app())
      .post("/orgs/opportunities/ranked")
      .set(headers)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/x-brand-id/);
  });

  it("multi-brand x-brand-id CSV: brandIds canonicalized in response", async () => {
    state.opportunities = [
      {
        featuredQuestionId: 6000,
        opportunity: "high signal multi-brand",
        mediaOutlet: "Outlet M",
        source: "featured",
      },
    ];

    const headers = { ...AUTH_HEADERS } as Record<string, string>;
    // Send unsorted CSV — server must canonicalize (sort + dedup).
    headers["x-brand-id"] = `${TEST_BRAND_B},${TEST_BRAND},${TEST_BRAND}`;

    const res = await request(app())
      .post("/orgs/opportunities/ranked")
      .set(headers)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.brandIds).toEqual([TEST_BRAND, TEST_BRAND_B].sort());
  });

  it("populates the category column when present on selected row", async () => {
    state.opportunities = [];
    const [silver] = await db
      .insert(providerQuoteRequests)
      .values({
        provider: "haro",
        ingestionChannel: "email",
        externalId: "cat-1",
        opportunityText: "high signal email-sourced opportunity",
        mediaOutlet: "Lifehacker",
        orgId: TEST_ORG_A,
        category: "Lifestyle",
      })
      .returning();
    // Attach a Gold cluster so the opportunity is visible.
    const [opp] = await db
      .insert(quoteOpportunities)
      .values({
        fingerprint: "cat-1-fp",
        canonicalText: silver.opportunityText,
        canonicalOutlet: silver.mediaOutlet,
      })
      .returning();
    await db
      .update(providerQuoteRequests)
      .set({ quoteOpportunityId: opp.id })
      .where(eq(providerQuoteRequests.id, silver.id));

    const res = await request(app())
      .post("/orgs/opportunities/ranked")
      .set(AUTH_HEADERS)
      .send({ campaignId: TEST_CAMPAIGN_A });

    expect(res.status).toBe(200);
    expect(res.body.opportunities).toHaveLength(1);
    expect(res.body.opportunities[0].category).toBe("Lifestyle");
  });
});
