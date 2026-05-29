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
  buildMockEqrsClient,
  createMockEqrsState,
  makePremiumQuestion,
  type MockEqrsState,
} from "../helpers/mock-eqrs.js";
import { judgeRelevance } from "../../src/lib/judge-client.js";
import { extractBrandContext } from "../../src/lib/brand-client.js";

// LLM judge mock: high→85, mid→50, else→15 (0-100 scale).
vi.mock("../../src/lib/judge-client.js", () => ({
  judgeRelevance: vi.fn(
    async (args: { documents: { id: string; text: string }[] }) => ({
      results: args.documents.map((d) => ({
        id: d.id,
        score: /high/i.test(d.text)
          ? 85
          : /mid/i.test(d.text)
            ? 50
            : 15,
        reasoning: "test judge",
      })),
    })
  ),
}));

// Brand context fetch mock — avoid hitting brand-service in tests.
vi.mock("../../src/lib/brand-client.js", () => ({
  extractBrandContext: vi.fn(async () => "- Industry: Test\n- Expertise: Test"),
}));

let state: MockEqrsState;

describe("POST /orgs/opportunities/next (premium questions)", () => {
  beforeAll(async () => {
    await cleanTestData();
  });
  beforeEach(async () => {
    vi.mocked(judgeRelevance).mockClear();
    vi.mocked(extractBrandContext).mockClear();
    await cleanTestData();
    state = createMockEqrsState();
  });
  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  function app() {
    return createTestApp({
      opportunitiesNextDeps: { eqrsClient: buildMockEqrsClient(state) },
    });
  }

  it("ingests premium questions into silver with synthesized external_id + non-null featured_question_id", async () => {
    state.premiumQuestions = [
      makePremiumQuestion({
        featuredQuestionId: 6001,
        question: "high signal AI ethics question",
        mediaOutlet: "Forbes",
      }),
    ];

    const res = await request(app())
      .post("/orgs/opportunities/next")
      .set(AUTH_HEADERS)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.found).toBe(true);
    expect(state.premiumFetchCalls).toBe(1);

    const silver = await db.select().from(providerQuoteRequests);
    expect(silver).toHaveLength(1);
    expect(silver[0].externalId).toBe("featured-premium-6001");
    expect(silver[0].featuredQuestionId).toBe(6001);
    expect(silver[0].provider).toBe("featured");
    expect(silver[0].ingestionChannel).toBe("api");
  });

  it("returns submittable=true + deliveryMethod=featured_api on the payload", async () => {
    state.premiumQuestions = [
      makePremiumQuestion({
        featuredQuestionId: 6100,
        question: "high signal payload shape",
        mediaOutlet: "Forbes",
      }),
    ];

    const res = await request(app())
      .post("/orgs/opportunities/next")
      .set(AUTH_HEADERS)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.opportunity.submittable).toBe(true);
    expect(res.body.opportunity.deliveryMethod).toBe("featured_api");
    expect(res.body.opportunity.featuredQuestionId).toBe(6100);
  });

  it("does NOT surface discovery silver rows (featured, null featured_question_id, no email)", async () => {
    // Simulate the legacy/discovery catalog: scored above threshold but
    // not submittable. Must be filtered out — found:false, no scoring.
    const [opp] = await db
      .insert(quoteOpportunities)
      .values({
        fingerprint: "fp-discovery",
        canonicalText: "high signal discovery lead",
        canonicalOutlet: "Qwoted",
      })
      .returning();
    await db.insert(providerQuoteRequests).values({
      provider: "featured",
      ingestionChannel: "api",
      externalId: "https://app.qwoted.com/opportunities/123",
      featuredQuestionId: null,
      pitchEmail: null,
      mediaOutlet: "Qwoted",
      opportunityText: "high signal discovery lead",
      pitchUrl: "https://app.qwoted.com/opportunities/123",
      quoteOpportunityId: opp.id,
      fingerprint: "fp-discovery",
      isCanonical: true,
      orgId: TEST_ORG_A,
    });
    await db.insert(quotePriorities).values({
      quoteOpportunityId: opp.id,
      brandIds: [TEST_BRAND],
      score: "90.00",
      whyRelevant: "seeded discovery score",
      orgId: TEST_ORG_A,
    });

    // No premium questions available either.
    const res = await request(app())
      .post("/orgs/opportunities/next")
      .set(AUTH_HEADERS)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ found: false });
    // Discovery cluster is not even scored (filtered before judge).
    expect(vi.mocked(judgeRelevance)).not.toHaveBeenCalled();
  });

  it("re-points existing premium silver row to the freshly-created Gold cluster on re-ingest (fingerprint drift fix)", async () => {
    const legacyText = "legacy signal expert query";
    const legacyOutlet = "Legacy Outlet";
    const externalId = "featured-premium-7777";

    const [legacyGold] = await db
      .insert(quoteOpportunities)
      .values({
        fingerprint: "LEGACY-FINGERPRINT-HASH",
        canonicalText: legacyText,
        canonicalOutlet: legacyOutlet,
      })
      .returning();
    const [legacySilver] = await db
      .insert(providerQuoteRequests)
      .values({
        provider: "featured",
        ingestionChannel: "api",
        externalId,
        featuredQuestionId: 7777,
        opportunityText: legacyText,
        mediaOutlet: legacyOutlet,
        quoteOpportunityId: legacyGold.id,
        fingerprint: "LEGACY-FINGERPRINT-HASH",
        isCanonical: true,
        orgId: TEST_ORG_A,
      })
      .returning();
    // Pre-score the legacy Gold so /next's selectUnscoredBatch returns
    // 0 → exhaust path → premium fetch → repoint logic fires.
    await db.insert(quotePriorities).values({
      quoteOpportunityId: legacyGold.id,
      brandIds: [TEST_BRAND],
      score: "40.00",
      whyRelevant: "pre-seeded legacy score",
      orgId: TEST_ORG_A,
    });

    // Premium feed now returns the same question id but with TEXT that
    // hashes to a different fingerprint under today's logic.
    state.premiumQuestions = [
      makePremiumQuestion({
        featuredQuestionId: 7777,
        question: "high signal modern expert query",
        mediaOutlet: "Modern Outlet",
      }),
    ];

    await request(app())
      .post("/orgs/opportunities/next")
      .set(AUTH_HEADERS)
      .send({});

    const golds = await db.select().from(quoteOpportunities);
    expect(golds).toHaveLength(2);
    const modernGold = golds.find(
      (g) => g.fingerprint !== "LEGACY-FINGERPRINT-HASH"
    );
    expect(modernGold).toBeDefined();

    const [updated] = await db
      .select()
      .from(providerQuoteRequests)
      .where(eq(providerQuoteRequests.id, legacySilver.id));
    expect(updated.quoteOpportunityId).toBe(modernGold!.id);
    expect(updated.fingerprint).toBe(modernGold!.fingerprint);
    expect(updated.opportunityText).toBe("high signal modern expert query");
    expect(updated.mediaOutlet).toBe("Modern Outlet");
    // Identity / provenance preserved.
    expect(updated.externalId).toBe(externalId);
    expect(updated.orgId).toBe(TEST_ORG_A);
    expect(updated.provider).toBe("featured");
    expect(updated.featuredQuestionId).toBe(7777);
  });

  it("dedupes premium questions with duplicate fingerprints in the same batch", async () => {
    state.premiumQuestions = [
      makePremiumQuestion({
        featuredQuestionId: 4001,
        question: "high signal duplicate question",
        mediaOutlet: "Outlet",
      }),
      makePremiumQuestion({
        featuredQuestionId: 4002,
        question: "high signal duplicate question",
        mediaOutlet: "Outlet",
      }),
      makePremiumQuestion({
        featuredQuestionId: 4003,
        question: "high signal unique row",
        mediaOutlet: "Outlet",
      }),
    ];

    const res = await request(app())
      .post("/orgs/opportunities/next")
      .set(AUTH_HEADERS)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.found).toBe(true);

    const goldRows = await db.select().from(quoteOpportunities);
    expect(goldRows).toHaveLength(2);

    const silverRows = await db.select().from(providerQuoteRequests);
    expect(silverRows).toHaveLength(3);
    const dupA = silverRows.find(
      (s) => s.externalId === "featured-premium-4001"
    );
    const dupB = silverRows.find(
      (s) => s.externalId === "featured-premium-4002"
    );
    expect(dupA?.quoteOpportunityId).toBe(dupB?.quoteOpportunityId);
  });

  it("returns { found: false } when EQRS has no premium questions", async () => {
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
    state.premiumQuestions = [
      makePremiumQuestion({
        featuredQuestionId: 1,
        question: "low signal cat memes",
        mediaOutlet: "BuzzFeed",
      }),
      makePremiumQuestion({
        featuredQuestionId: 2,
        question: "high signal AI ethics",
        mediaOutlet: "Forbes",
      }),
      makePremiumQuestion({
        featuredQuestionId: 3,
        question: "mid signal SaaS pricing",
        mediaOutlet: "TechCrunch",
      }),
    ];

    const res = await request(app())
      .post("/orgs/opportunities/next")
      .set(AUTH_HEADERS)
      .send({ campaignId: TEST_CAMPAIGN_A });

    expect(res.status).toBe(200);
    expect(res.body.found).toBe(true);
    expect(res.body.opportunity.featuredQuestionId).toBe(2);
    expect(res.body.opportunity.score).toBe(85);
    expect(res.body.opportunity.submittable).toBe(true);
    expect(res.body.opportunity.deliveryMethod).toBe("featured_api");
    expect(res.body.brandIds).toEqual([TEST_BRAND]);

    const goldIds = (
      await db.select({ id: quoteOpportunities.id }).from(quoteOpportunities)
    ).map((g) => g.id);
    expect(goldIds).toContain(res.body.opportunity.opportunityId);
  });

  it("skips opportunities with a blocking pitch on the same brand-set", async () => {
    // Distinct scores (high=85, mid=50) so the post-block winner is
    // deterministic — equal scores tie-break on first_seen_at, which is
    // identical for clusters created in the same ingest batch.
    state.premiumQuestions = [
      makePremiumQuestion({
        featuredQuestionId: 11,
        question: "high signal top",
        mediaOutlet: "Outlet 1",
      }),
      makePremiumQuestion({
        featuredQuestionId: 12,
        question: "mid signal second",
        mediaOutlet: "Outlet 2",
      }),
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
        .where(eq(providerQuoteRequests.externalId, "featured-premium-11"))
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
    state.premiumQuestions = [
      makePremiumQuestion({
        featuredQuestionId: 21,
        question: "high signal solo target",
        mediaOutlet: "Outlet S",
      }),
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
        .where(eq(providerQuoteRequests.externalId, "featured-premium-21"))
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

  it("cold start: pulls all premium questions in a single fetch + scores in a single multi-brand call (LIMIT 10)", async () => {
    state.premiumQuestions = Array.from({ length: 15 }, (_, i) =>
      makePremiumQuestion({
        featuredQuestionId: 500 + i,
        question: `high signal item ${i}`,
        mediaOutlet: `Outlet ${i}`,
      })
    );

    const res = await request(app())
      .post("/orgs/opportunities/next")
      .set(AUTH_HEADERS)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.found).toBe(true);
    expect(state.premiumFetchCalls).toBe(1);
    expect(vi.mocked(judgeRelevance)).toHaveBeenCalledTimes(1);
    const call = vi.mocked(judgeRelevance).mock.calls[0][0] as {
      documents: unknown[];
      brandContext: string;
    };
    expect(call.documents).toHaveLength(10);
    expect(typeof call.brandContext).toBe("string");
    expect(vi.mocked(extractBrandContext)).toHaveBeenCalled();

    const rows = await db.select().from(quotePriorities);
    expect(rows).toHaveLength(10);
  });

  it("stable state: zero scoring when every visible opportunity is already in quote_priorities", async () => {
    state.premiumQuestions = [
      makePremiumQuestion({
        featuredQuestionId: 901,
        question: "high signal stable",
        mediaOutlet: "Outlet X",
      }),
    ];

    const a = app();
    await request(a)
      .post("/orgs/opportunities/next")
      .set(AUTH_HEADERS)
      .send({});
    expect(vi.mocked(judgeRelevance)).toHaveBeenCalledTimes(1);

    vi.mocked(judgeRelevance).mockClear();
    const res = await request(a)
      .post("/orgs/opportunities/next")
      .set(AUTH_HEADERS)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.found).toBe(true);
    expect(vi.mocked(judgeRelevance)).not.toHaveBeenCalled();
  });

  it("exhaustion-driven: premium fetched on cold start, skipped while unscored remain, refetched after pool drains", async () => {
    state.premiumQuestions = Array.from({ length: 12 }, (_, i) =>
      makePremiumQuestion({
        featuredQuestionId: 9100 + i,
        question: `high signal exhaust ${i}`,
        mediaOutlet: `Outlet ${i}`,
      })
    );

    const a = app();
    // Call 1: silver empty → premium fetched → 12 ingested → score 10 of 12.
    await request(a)
      .post("/orgs/opportunities/next")
      .set(AUTH_HEADERS)
      .send({});
    expect(state.premiumFetchCalls).toBe(1);

    // Call 2: 2 unscored remaining → NO premium fetch (scores the 2).
    await request(a)
      .post("/orgs/opportunities/next")
      .set(AUTH_HEADERS)
      .send({});
    expect(state.premiumFetchCalls).toBe(1);

    // Call 3: pool drained (all 12 scored) → premium fetch fires again.
    await request(a)
      .post("/orgs/opportunities/next")
      .set(AUTH_HEADERS)
      .send({});
    expect(state.premiumFetchCalls).toBe(2);
  });

  it("does NOT re-score across calls — quote_priorities rows reused", async () => {
    state.premiumQuestions = [
      makePremiumQuestion({
        featuredQuestionId: 9300,
        question: "high signal reuse",
        mediaOutlet: "Outlet reuse",
      }),
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

    await new Promise((r) => setTimeout(r, 50));
    vi.mocked(judgeRelevance).mockClear();

    const second = await request(a)
      .post("/orgs/opportunities/next")
      .set(AUTH_HEADERS)
      .send({});
    expect(second.body.found).toBe(true);
    expect(vi.mocked(judgeRelevance)).not.toHaveBeenCalled();
    const secondScoredAt = (
      await db
        .select({ scoredAt: quotePriorities.scoredAt })
        .from(quotePriorities)
    )[0].scoredAt;
    expect(secondScoredAt.getTime()).toBe(firstScoredAt.getTime());
  });

  it("found:false when only available opportunity is below SCORE_THRESHOLD", async () => {
    state.premiumQuestions = [
      makePremiumQuestion({
        featuredQuestionId: 8001,
        question: "low signal noise",
        mediaOutlet: "Outlet noise",
      }),
    ];
    const res = await request(app())
      .post("/orgs/opportunities/next")
      .set(AUTH_HEADERS)
      .send({});
    expect(res.body).toEqual({ found: false });
    expect(vi.mocked(judgeRelevance)).toHaveBeenCalledTimes(1);
  });

  it("filters out opportunities with a past canonical_deadline", async () => {
    const a = app();
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
      externalId: "featured-premium-4000",
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
    expect(res.body).toEqual({ found: false });
    expect(vi.mocked(judgeRelevance)).not.toHaveBeenCalled();
  });
});
