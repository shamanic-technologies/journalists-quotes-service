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
  TEST_CAMPAIGN_A,
  TEST_ORG_A,
} from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import {
  providerQuoteRequests,
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
      opportunitiesNextDeps: { buildClient: buildMockClient(state) },
      opportunitiesRankedDeps: { buildClient: buildMockClient(state) },
    });
  }

  it("returns an empty list with total 0 when no eligible candidates", async () => {
    const res = await request(app())
      .post("/orgs/opportunities/ranked")
      .set(AUTH_HEADERS)
      .send({ campaignId: TEST_CAMPAIGN_A, brandId: TEST_BRAND });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", opportunities: [], total: 0 });
  });

  it("returns opportunities sorted by score desc, above SCORE_THRESHOLD", async () => {
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
      .send({ campaignId: TEST_CAMPAIGN_A, brandId: TEST_BRAND });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    // low (0.2) drops below 0.5 threshold; high (0.95) > mid (0.7).
    expect(res.body.opportunities).toHaveLength(2);
    expect(res.body.opportunities[0].featuredQuestionId).toBe(2);
    expect(res.body.opportunities[0].score).toBeCloseTo(0.95);
    expect(res.body.opportunities[1].featuredQuestionId).toBe(3);
    expect(res.body.opportunities[1].score).toBeCloseTo(0.7);
    expect(res.body.total).toBe(2);
  });

  it("honors limit and offset for paging the ranked queue", async () => {
    state.opportunities = Array.from({ length: 4 }, (_, i) => ({
      featuredQuestionId: 1000 + i,
      opportunity: `high signal item ${i}`,
      mediaOutlet: "Outlet",
      source: "featured",
    }));

    const a = app();
    const first = await request(a)
      .post("/orgs/opportunities/ranked")
      .set(AUTH_HEADERS)
      .send({
        campaignId: TEST_CAMPAIGN_A,
        brandId: TEST_BRAND,
        limit: 2,
        offset: 0,
      });
    expect(first.body.opportunities).toHaveLength(2);
    expect(first.body.total).toBe(4);

    const second = await request(a)
      .post("/orgs/opportunities/ranked")
      .set(AUTH_HEADERS)
      .send({
        campaignId: TEST_CAMPAIGN_A,
        brandId: TEST_BRAND,
        limit: 2,
        offset: 2,
      });
    expect(second.body.opportunities).toHaveLength(2);
    expect(second.body.total).toBe(4);

    const ids = new Set([
      ...first.body.opportunities.map((o: { opportunityId: string }) => o.opportunityId),
      ...second.body.opportunities.map((o: { opportunityId: string }) => o.opportunityId),
    ]);
    expect(ids.size).toBe(4);
  });

  it("excludes opportunities already pitched (non-error) on the campaign", async () => {
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
    // Populate silver via /next path, then attach a submitted pitch to the first row.
    await request(a)
      .post("/orgs/opportunities/ranked")
      .set(AUTH_HEADERS)
      .send({ campaignId: TEST_CAMPAIGN_A, brandId: TEST_BRAND });

    const silver = await db
      .select()
      .from(providerQuoteRequests)
      .where(eq(providerQuoteRequests.externalId, "9001"));
    await db.insert(quotePitches).values({
      quoteRequestId: silver[0].id,
      featuredQuestionId: 9001,
      campaignId: TEST_CAMPAIGN_A,
      brandId: TEST_BRAND,
      status: "submitted",
      deliveryMethod: "featured_api",
      orgId: TEST_ORG_A,
    });

    const res = await request(a)
      .post("/orgs/opportunities/ranked")
      .set(AUTH_HEADERS)
      .send({ campaignId: TEST_CAMPAIGN_A, brandId: TEST_BRAND });

    expect(res.status).toBe(200);
    expect(res.body.opportunities).toHaveLength(1);
    expect(res.body.opportunities[0].featuredQuestionId).toBe(9002);
    expect(res.body.total).toBe(1);
  });

  it("rejects limit > 50 with 400", async () => {
    const res = await request(app())
      .post("/orgs/opportunities/ranked")
      .set(AUTH_HEADERS)
      .send({
        campaignId: TEST_CAMPAIGN_A,
        brandId: TEST_BRAND,
        limit: 100,
      });
    expect(res.status).toBe(400);
  });

  it("populates the category column when present on selected row", async () => {
    state.opportunities = [];
    await db.insert(providerQuoteRequests).values({
      provider: "haro",
      ingestionChannel: "email",
      externalId: "cat-1",
      opportunityText: "high signal email-sourced opportunity",
      mediaOutlet: "Lifehacker",
      orgId: TEST_ORG_A,
      category: "Lifestyle",
    });

    const res = await request(app())
      .post("/orgs/opportunities/ranked")
      .set(AUTH_HEADERS)
      .send({ campaignId: TEST_CAMPAIGN_A, brandId: TEST_BRAND });

    expect(res.status).toBe(200);
    expect(res.body.opportunities).toHaveLength(1);
    expect(res.body.opportunities[0].category).toBe("Lifestyle");
  });
});
