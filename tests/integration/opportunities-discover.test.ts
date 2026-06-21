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
  TEST_ORG_A,
  TEST_USER,
  TEST_PARENT_RUN,
} from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import {
  providerQuoteRequests,
  quoteOpportunities,
  quotePriorities,
} from "../../src/db/schema.js";
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
        score: /high/i.test(d.text) ? 85 : /mid/i.test(d.text) ? 50 : 15,
        reasoning: "test judge",
      })),
    })
  ),
}));

vi.mock("../../src/lib/brand-client.js", () => ({
  extractBrandContext: vi.fn(async () => "- Industry: Test\n- Expertise: Test"),
}));

let state: MockEqrsState;

/** Seed an unscored, submittable (Featured-premium) Gold cluster. */
async function seedUnscoredSubmittable(args: {
  fingerprint: string;
  text: string;
  externalId: string;
  featuredQuestionId: number;
  deadline?: Date | null;
}): Promise<string> {
  const [opp] = await db
    .insert(quoteOpportunities)
    .values({
      fingerprint: args.fingerprint,
      canonicalText: args.text,
      canonicalOutlet: "Outlet",
      canonicalDeadline: args.deadline ?? null,
    })
    .returning();
  await db.insert(providerQuoteRequests).values({
    provider: "featured",
    ingestionChannel: "api",
    externalId: args.externalId,
    featuredQuestionId: args.featuredQuestionId,
    mediaOutlet: "Outlet",
    opportunityText: args.text,
    deadline: args.deadline ?? null,
    quoteOpportunityId: opp.id,
    isCanonical: true,
    fingerprint: args.fingerprint,
    orgId: TEST_ORG_A,
  });
  return opp.id;
}

describe("POST /orgs/opportunities/discover (write-only batch scorer)", () => {
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
      opportunitiesDiscoverDeps: { eqrsClient: buildMockEqrsClient(state) },
    });
  }

  it("scores one batch (<=10) and returns { scored, exhausted } with NO opportunity payload", async () => {
    state.premiumQuestions = Array.from({ length: 25 }, (_, i) =>
      makePremiumQuestion({
        featuredQuestionId: 7000 + i,
        question: `high signal discover ${i}`,
        mediaOutlet: `Outlet ${i}`,
      })
    );

    const TEST_AUDIENCE = "00000000-0000-0000-0000-0000000000ad";
    const res = await request(app())
      .post("/orgs/opportunities/discover")
      .set(AUTH_HEADERS)
      .set("x-audience-id", TEST_AUDIENCE)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      scored: 10,
      exhausted: false,
      brandIds: [TEST_BRAND],
    });
    // Write-only — no read payload.
    expect(res.body.opportunity).toBeUndefined();
    expect(res.body.found).toBeUndefined();

    const rows = await db.select().from(quotePriorities);
    expect(rows).toHaveLength(10);
    expect(vi.mocked(judgeRelevance)).toHaveBeenCalledTimes(1);
    // Regression: scoreUnscored must forward the identity trio to brand-service
    // extract-fields (it 400s without x-user-id / x-run-id).
    // AND x-audience-id (inbound) must reach the egress so per-audience cost
    // attribution works downstream (extract-fields cost + judge LLM cost).
    expect(vi.mocked(extractBrandContext)).toHaveBeenCalledWith(
      [TEST_BRAND],
      TEST_ORG_A,
      TEST_USER,
      TEST_PARENT_RUN,
      TEST_AUDIENCE
    );
    expect(vi.mocked(judgeRelevance)).toHaveBeenCalledWith(
      expect.objectContaining({ audienceId: TEST_AUDIENCE })
    );
  });

  it("loops to drain the whole submittable pool, ending on { scored: 0, exhausted: true }", async () => {
    state.premiumQuestions = Array.from({ length: 22 }, (_, i) =>
      makePremiumQuestion({
        featuredQuestionId: 7100 + i,
        question: `high signal drain ${i}`,
        mediaOutlet: `Outlet ${i}`,
      })
    );

    const a = app();
    const results: Array<{ scored: number; exhausted: boolean }> = [];
    for (let i = 0; i < 6; i++) {
      const res = await request(a)
        .post("/orgs/opportunities/discover")
        .set(AUTH_HEADERS)
        .send({});
      results.push({
        scored: res.body.scored,
        exhausted: res.body.exhausted,
      });
      if (res.body.exhausted) break;
    }

    // 22 clusters → 10 + 10 + 2, then a final exhausted call.
    expect(results).toEqual([
      { scored: 10, exhausted: false },
      { scored: 10, exhausted: false },
      { scored: 2, exhausted: false },
      { scored: 0, exhausted: true },
    ]);

    const rows = await db.select().from(quotePriorities);
    expect(rows).toHaveLength(22);
  });

  it("prioritizes soonest-deadline clusters first (deadline ASC) when the pool exceeds one batch", async () => {
    // 12 unscored submittable clusters, deadlines now+1h .. now+12h.
    const ids: Array<{ id: string; hours: number }> = [];
    for (let h = 1; h <= 12; h++) {
      const id = await seedUnscoredSubmittable({
        fingerprint: `fp-dl-${h}`,
        text: `high signal deadline ${h}`,
        externalId: `featured-premium-72${h.toString().padStart(2, "0")}`,
        featuredQuestionId: 7200 + h,
        deadline: new Date(Date.now() + h * 3600_000),
      });
      ids.push({ id, hours: h });
    }

    const res = await request(app())
      .post("/orgs/opportunities/discover")
      .set(AUTH_HEADERS)
      .send({});
    expect(res.body.scored).toBe(10);
    expect(res.body.exhausted).toBe(false);

    const scoredIds = new Set(
      (
        await db
          .select({ id: quotePriorities.quoteOpportunityId })
          .from(quotePriorities)
      ).map((r) => r.id)
    );
    // The 10 soonest (h=1..10) scored; the 2 latest (h=11,12) deferred.
    for (const { id, hours } of ids) {
      expect(scoredIds.has(id)).toBe(hours <= 10);
    }
  });

  it("fetches Featured premium only when the silver pool is exhausted", async () => {
    state.premiumQuestions = Array.from({ length: 12 }, (_, i) =>
      makePremiumQuestion({
        featuredQuestionId: 7300 + i,
        question: `high signal fetch ${i}`,
        mediaOutlet: `Outlet ${i}`,
      })
    );

    const a = app();
    // Call 1: pool empty → premium fetched → 12 ingested → score 10.
    await request(a).post("/orgs/opportunities/discover").set(AUTH_HEADERS).send({});
    expect(state.premiumFetchCalls).toBe(1);
    // Call 2: 2 unscored remain → NO fetch.
    await request(a).post("/orgs/opportunities/discover").set(AUTH_HEADERS).send({});
    expect(state.premiumFetchCalls).toBe(1);
    // Call 3: pool drained → fetch fires again (returns same list, all
    // already scored) → exhausted.
    const res = await request(a)
      .post("/orgs/opportunities/discover")
      .set(AUTH_HEADERS)
      .send({});
    expect(state.premiumFetchCalls).toBe(2);
    expect(res.body).toEqual({
      scored: 0,
      exhausted: true,
      brandIds: [TEST_BRAND],
    });
  });

  it("returns { scored: 0, exhausted: true } when EQRS has no premium questions", async () => {
    const res = await request(app())
      .post("/orgs/opportunities/discover")
      .set(AUTH_HEADERS)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      scored: 0,
      exhausted: true,
      brandIds: [TEST_BRAND],
    });
    expect(vi.mocked(judgeRelevance)).not.toHaveBeenCalled();
  });

  it("does NOT surface discovery clusters (featured, null fqid, no email)", async () => {
    const [opp] = await db
      .insert(quoteOpportunities)
      .values({
        fingerprint: "fp-disc-discover",
        canonicalText: "high signal discovery lead",
        canonicalOutlet: "Qwoted",
      })
      .returning();
    await db.insert(providerQuoteRequests).values({
      provider: "featured",
      ingestionChannel: "api",
      externalId: "https://app.qwoted.com/opportunities/9",
      featuredQuestionId: null,
      pitchEmail: null,
      mediaOutlet: "Qwoted",
      opportunityText: "high signal discovery lead",
      pitchUrl: "https://app.qwoted.com/opportunities/9",
      quoteOpportunityId: opp.id,
      isCanonical: true,
      fingerprint: "fp-disc-discover",
      orgId: TEST_ORG_A,
    });

    const res = await request(app())
      .post("/orgs/opportunities/discover")
      .set(AUTH_HEADERS)
      .send({});
    // Non-submittable lead is invisible to scoring → nothing to score.
    expect(res.body).toEqual({
      scored: 0,
      exhausted: true,
      brandIds: [TEST_BRAND],
    });
    expect(vi.mocked(judgeRelevance)).not.toHaveBeenCalled();
  });

  it("rejects when x-brand-id header is missing", async () => {
    const headers = { ...AUTH_HEADERS } as Record<string, string>;
    delete headers["x-brand-id"];
    const res = await request(app())
      .post("/orgs/opportunities/discover")
      .set(headers)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/x-brand-id/);
  });

  it.each([
    ["x-user-id", /x-user-id/],
    ["x-run-id", /x-run-id/],
    ["x-campaign-id", /x-campaign-id/],
  ])("rejects when %s header is missing (mandatory)", async (header, re) => {
    const headers = { ...AUTH_HEADERS } as Record<string, string>;
    delete headers[header];
    const res = await request(app())
      .post("/orgs/opportunities/discover")
      .set(headers)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(re);
  });
});
