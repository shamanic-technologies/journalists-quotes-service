import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
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

describe("POST /orgs/opportunities/next", () => {
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
    });
  }

  it("returns { found: false } when no eligible opportunities", async () => {
    const res = await request(app())
      .post("/orgs/opportunities/next")
      .set(AUTH_HEADERS)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ found: false });
  });

  it("rejects when x-brand-id header is missing", async () => {
    const headers = { ...AUTH_HEADERS } as Record<string, string>;
    delete headers["x-brand-id"];
    const res = await request(app())
      .post("/orgs/opportunities/next")
      .set(headers)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/x-brand-id/);
  });

  it("returns the single highest-scored Gold opportunity with brandIds echoed", async () => {
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
      .post("/orgs/opportunities/next")
      .set(AUTH_HEADERS)
      .send({ campaignId: TEST_CAMPAIGN_A });

    expect(res.status).toBe(200);
    expect(res.body.found).toBe(true);
    expect(res.body.opportunity.featuredQuestionId).toBe(2);
    expect(res.body.opportunity.score).toBeCloseTo(0.95);
    expect(res.body.brandIds).toEqual([TEST_BRAND]);

    const goldIds = (
      await db.select({ id: quoteOpportunities.id }).from(quoteOpportunities)
    ).map((g) => g.id);
    expect(goldIds).toContain(res.body.opportunity.opportunityId);
  });

  it("skips opportunities with a blocking pitch on the same brand-set", async () => {
    state.opportunities = [
      {
        featuredQuestionId: 11,
        opportunity: "high signal top",
        mediaOutlet: "Outlet 1",
        source: "featured",
      },
      {
        featuredQuestionId: 12,
        opportunity: "high signal second",
        mediaOutlet: "Outlet 2",
        source: "featured",
      },
    ];

    const a = app();
    // Initial call surfaces the top opp (#11).
    const first = await request(a)
      .post("/orgs/opportunities/next")
      .set(AUTH_HEADERS)
      .send({});
    expect(first.body.opportunity.featuredQuestionId).toBe(11);
    const firstGoldId = first.body.opportunity.opportunityId;

    // Block the top opp via a submitted pitch for the same brand-set.
    const silverTop = (
      await db
        .select()
        .from(providerQuoteRequests)
        .where(eq(providerQuoteRequests.externalId, "11"))
    )[0];
    await db.insert(quotePitches).values({
      quoteRequestId: silverTop.id,
      quoteOpportunityId: firstGoldId,
      brandIds: [TEST_BRAND],
      status: "submitted",
      deliveryMethod: "featured_api",
      orgId: TEST_ORG_A,
    });

    // Next call must skip #11 and return #12.
    const second = await request(a)
      .post("/orgs/opportunities/next")
      .set(AUTH_HEADERS)
      .send({});
    expect(second.body.found).toBe(true);
    expect(second.body.opportunity.featuredQuestionId).toBe(12);
  });

  it("co-brand pitch [A,B] does NOT block solo /next for [A]", async () => {
    state.opportunities = [
      {
        featuredQuestionId: 21,
        opportunity: "high signal solo target",
        mediaOutlet: "Outlet S",
        source: "featured",
      },
    ];

    const a = app();
    // Seed silver + gold via the ranked-style ingest.
    await request(a)
      .post("/orgs/opportunities/next")
      .set(AUTH_HEADERS)
      .send({});

    const silver = (
      await db
        .select()
        .from(providerQuoteRequests)
        .where(eq(providerQuoteRequests.externalId, "21"))
    )[0];

    // Pitch by the co-brand set [A, B].
    await db.insert(quotePitches).values({
      quoteRequestId: silver.id,
      quoteOpportunityId: silver.quoteOpportunityId,
      brandIds: [TEST_BRAND, TEST_BRAND_B].sort(),
      status: "submitted",
      deliveryMethod: "featured_api",
      orgId: TEST_ORG_A,
    });

    // Solo [A] /next must still surface the opportunity.
    const res = await request(a)
      .post("/orgs/opportunities/next")
      .set(AUTH_HEADERS)
      .send({});
    expect(res.body.found).toBe(true);
    expect(res.body.opportunity.featuredQuestionId).toBe(21);
  });
});
