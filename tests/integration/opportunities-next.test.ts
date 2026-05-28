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
  quotePriorities,
} from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import {
  buildMockClient,
  createMockState,
  type MockFeaturedState,
} from "../helpers/mock-featured.js";
import { _resetFeaturedClientState } from "../../src/lib/featured-client.js";
import { _resetEmptyIngestSuspension } from "../../src/lib/opportunity-pipeline.js";
import { ragScore } from "../../src/lib/chat-client.js";

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
    _resetEmptyIngestSuspension();
    vi.mocked(ragScore).mockClear();
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
    const first = await request(a)
      .post("/orgs/opportunities/next")
      .set(AUTH_HEADERS)
      .send({});
    expect(first.body.opportunity.featuredQuestionId).toBe(11);
    const firstGoldId = first.body.opportunity.opportunityId;

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

    await db.insert(quotePitches).values({
      quoteRequestId: silver.id,
      quoteOpportunityId: silver.quoteOpportunityId,
      brandIds: [TEST_BRAND, TEST_BRAND_B].sort(),
      status: "submitted",
      deliveryMethod: "featured_api",
      orgId: TEST_ORG_A,
    });

    const res = await request(a)
      .post("/orgs/opportunities/next")
      .set(AUTH_HEADERS)
      .send({});
    expect(res.body.found).toBe(true);
    expect(res.body.opportunity.featuredQuestionId).toBe(21);
  });

  it("cold start: scores all unscored opportunities in a single multi-brand call (LIMIT 10)", async () => {
    state.opportunities = Array.from({ length: 15 }, (_, i) => ({
      featuredQuestionId: 500 + i,
      opportunity: `high signal item ${i}`,
      mediaOutlet: `Outlet ${i}`,
      source: "featured",
    }));

    const res = await request(app())
      .post("/orgs/opportunities/next")
      .set(AUTH_HEADERS)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.found).toBe(true);
    // Exactly one chat-service call, capped at UNSCORED_BATCH_SIZE = 10
    expect(vi.mocked(ragScore)).toHaveBeenCalledTimes(1);
    const call = vi.mocked(ragScore).mock.calls[0][0] as {
      documents: unknown[];
      brandIds: string[];
    };
    expect(call.documents).toHaveLength(10);
    expect(call.brandIds).toEqual([TEST_BRAND]);

    const rows = await db.select().from(quotePriorities);
    expect(rows).toHaveLength(10);
  });

  it("stable state: zero scoring when every visible opportunity is already in quote_priorities", async () => {
    state.opportunities = [
      {
        featuredQuestionId: 901,
        opportunity: "high signal stable",
        mediaOutlet: "Outlet X",
        source: "featured",
      },
    ];

    const a = app();
    // First call scores once.
    await request(a)
      .post("/orgs/opportunities/next")
      .set(AUTH_HEADERS)
      .send({});
    expect(vi.mocked(ragScore)).toHaveBeenCalledTimes(1);

    // Second call: all scored → no chat-service call.
    vi.mocked(ragScore).mockClear();
    const res = await request(a)
      .post("/orgs/opportunities/next")
      .set(AUTH_HEADERS)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.found).toBe(true);
    expect(vi.mocked(ragScore)).not.toHaveBeenCalled();
  });

  it("partial batch: only un-scored opportunities are sent to chat-service", async () => {
    state.opportunities = Array.from({ length: 4 }, (_, i) => ({
      featuredQuestionId: 600 + i,
      opportunity: `high signal partial ${i}`,
      mediaOutlet: `Outlet ${i}`,
      source: "featured",
    }));

    const a = app();
    // First call: ingests 4, scores 4.
    await request(a)
      .post("/orgs/opportunities/next")
      .set(AUTH_HEADERS)
      .send({});
    expect(vi.mocked(ragScore)).toHaveBeenCalledTimes(1);
    expect(
      (vi.mocked(ragScore).mock.calls[0][0] as { documents: unknown[] })
        .documents
    ).toHaveLength(4);

    // Featured later publishes 3 more opps.
    state.opportunities.push(
      ...Array.from({ length: 3 }, (_, i) => ({
        featuredQuestionId: 700 + i,
        opportunity: `high signal new ${i}`,
        mediaOutlet: `Outlet new ${i}`,
        source: "featured",
      }))
    );
    vi.mocked(ragScore).mockClear();

    // Second call: silver pool exhausted → re-ingest Featured → 3 new
    // silver rows → score only the 3 new ones (existing 4 are skipped
    // by the unscored anti-join).
    await request(a)
      .post("/orgs/opportunities/next")
      .set(AUTH_HEADERS)
      .send({});
    expect(vi.mocked(ragScore)).toHaveBeenCalledTimes(1);
    expect(
      (vi.mocked(ragScore).mock.calls[0][0] as { documents: unknown[] })
        .documents
    ).toHaveLength(3);
  });

  it("filters out opportunities with a past canonical_deadline", async () => {
    const a = app();
    // Seed manually: silver + Gold with a past deadline.
    const pastDeadline = new Date(Date.now() - 24 * 3600_000);
    const [opp] = await db
      .insert(quoteOpportunities)
      .values({
        fingerprint: "expired-fp",
        canonicalText: "high signal expired",
        canonicalOutlet: "Outlet expired",
        canonicalDeadline: pastDeadline,
      })
      .returning();
    await db.insert(providerQuoteRequests).values({
      provider: "featured",
      ingestionChannel: "api",
      externalId: "expired-1",
      featuredQuestionId: 4000,
      mediaOutlet: "Outlet expired",
      opportunityText: "high signal expired",
      deadline: pastDeadline,
      quoteOpportunityId: opp.id,
      isCanonical: true,
      fingerprint: "expired-fp",
      orgId: TEST_ORG_A,
    });

    const res = await request(a)
      .post("/orgs/opportunities/next")
      .set(AUTH_HEADERS)
      .send({});

    // Expired opp is filtered before scoring AND from the best-pick → found:false.
    expect(res.body).toEqual({ found: false });
    expect(vi.mocked(ragScore)).not.toHaveBeenCalled();
  });

  it("found:false when the only available opportunity is below SCORE_THRESHOLD", async () => {
    state.opportunities = [
      {
        featuredQuestionId: 8001,
        opportunity: "low signal noise",
        mediaOutlet: "Outlet noise",
        source: "featured",
      },
    ];
    const res = await request(app())
      .post("/orgs/opportunities/next")
      .set(AUTH_HEADERS)
      .send({});
    expect(res.body).toEqual({ found: false });
    // Was scored (mocked low=0.2) but filtered below 0.5 threshold.
    expect(vi.mocked(ragScore)).toHaveBeenCalledTimes(1);
  });

  it("exhaustion-driven: Featured fetched on first call (cold pool), skipped while unscored remain, refetched after pool drains", async () => {
    state.opportunities = Array.from({ length: 12 }, (_, i) => ({
      featuredQuestionId: 9100 + i,
      opportunity: `high signal exhaust ${i}`,
      mediaOutlet: `Outlet ${i}`,
      source: "featured",
    }));

    const a = app();
    // Call 1: silver empty → ingest fires → score 10 of 12.
    await request(a)
      .post("/orgs/opportunities/next")
      .set(AUTH_HEADERS)
      .send({});
    expect(state.listOpportunitiesCalls).toBe(1);

    // Call 2: 2 unscored still in silver → NO ingest (avoid wasting
    // Featured budget while consumer hasn't drained what's already
    // landed).
    await request(a)
      .post("/orgs/opportunities/next")
      .set(AUTH_HEADERS)
      .send({});
    expect(state.listOpportunitiesCalls).toBe(1);

    // Call 3: pool now fully scored → ingest fires. Featured publishes
    // nothing new; onConflictDoNothing makes the upsert a no-op.
    await request(a)
      .post("/orgs/opportunities/next")
      .set(AUTH_HEADERS)
      .send({});
    expect(state.listOpportunitiesCalls).toBe(2);
  });

  it("exhaustion refetch surfaces newly-published Featured opportunities", async () => {
    state.opportunities = [
      {
        featuredQuestionId: 9300,
        opportunity: "high signal first",
        mediaOutlet: "Outlet first",
        source: "featured",
      },
    ];
    const a = app();

    // Cold start: ingest + score the single available opp.
    await request(a)
      .post("/orgs/opportunities/next")
      .set(AUTH_HEADERS)
      .send({});
    expect(state.listOpportunitiesCalls).toBe(1);
    expect(vi.mocked(ragScore)).toHaveBeenCalledTimes(1);

    // Featured publishes a new opp later.
    state.opportunities.push({
      featuredQuestionId: 9301,
      opportunity: "high signal second",
      mediaOutlet: "Outlet second",
      source: "featured",
    });
    vi.mocked(ragScore).mockClear();

    // Next call: pool fully scored for this brand-set → refetch fires →
    // new opp lands in silver → scored → returned.
    const res = await request(a)
      .post("/orgs/opportunities/next")
      .set(AUTH_HEADERS)
      .send({});
    expect(state.listOpportunitiesCalls).toBe(2);
    expect(vi.mocked(ragScore)).toHaveBeenCalledTimes(1);
    expect(
      (vi.mocked(ragScore).mock.calls[0][0] as { documents: unknown[] })
        .documents
    ).toHaveLength(1);
    expect(res.body.found).toBe(true);
  });

  it("does NOT re-score across calls — quote_priorities rows reused", async () => {
    state.opportunities = [
      {
        featuredQuestionId: 9200,
        opportunity: "high signal reuse",
        mediaOutlet: "Outlet reuse",
        source: "featured",
      },
    ];

    const a = app();
    const first = await request(a)
      .post("/orgs/opportunities/next")
      .set(AUTH_HEADERS)
      .send({});
    expect(first.body.found).toBe(true);
    const firstScoredAt = (
      await db
        .select({ scoredAt: quotePriorities.scoredAt })
        .from(quotePriorities)
    )[0].scoredAt;

    // Wait a tick so any re-score would produce a different scoredAt.
    await new Promise((r) => setTimeout(r, 50));
    vi.mocked(ragScore).mockClear();

    const second = await request(a)
      .post("/orgs/opportunities/next")
      .set(AUTH_HEADERS)
      .send({});
    expect(second.body.found).toBe(true);
    expect(vi.mocked(ragScore)).not.toHaveBeenCalled();
    const secondScoredAt = (
      await db
        .select({ scoredAt: quotePriorities.scoredAt })
        .from(quotePriorities)
    )[0].scoredAt;
    expect(secondScoredAt.getTime()).toBe(firstScoredAt.getTime());
  });
});
