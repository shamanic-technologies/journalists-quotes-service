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
  eqrsSyncState,
  providerQuoteRequests,
  quoteOpportunities,
  quotePitches,
  quotePriorities,
} from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import {
  buildMockEqrsClient,
  createMockEqrsState,
  makeOpportunity,
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

describe("POST /orgs/opportunities/next", () => {
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

  it("re-points existing silver row to the freshly-created Gold cluster on EQRS-driven re-ingest (fingerprint drift fix)", async () => {
    // Simulate legacy state: a silver row exists with external_id
    // = pitchUrl, pointing at an OLD Gold cluster whose fingerprint
    // hashed text differently than today's `computeFingerprint`.
    const legacyText = "legacy signal expert query";
    const legacyOutlet = "Legacy Outlet";
    const externalId = "https://pitch.example.com/legacy-1";

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
        opportunityText: legacyText,
        mediaOutlet: legacyOutlet,
        quoteOpportunityId: legacyGold.id,
        fingerprint: "LEGACY-FINGERPRINT-HASH",
        isCanonical: true,
        orgId: TEST_ORG_A,
      })
      .returning();
    // Pre-score the legacy Gold so /next's selectUnscoredBatch returns
    // 0 → exhaust path → EQRS fetch → repoint logic fires.
    await db.insert(quotePriorities).values({
      quoteOpportunityId: legacyGold.id,
      brandIds: [TEST_BRAND],
      score: "40.00",
      whyRelevant: "pre-seeded legacy score",
      orgId: TEST_ORG_A,
    });

    // EQRS now returns the same external_id but with a TEXT that
    // hashes to a different fingerprint under today's logic.
    state.opportunities = [
      makeOpportunity({
        externalId,
        featuredQuestionId: 7777,
        opportunityText: "high signal modern expert query",
        mediaOutlet: "Modern Outlet",
      }),
    ];

    await request(app())
      .post("/orgs/opportunities/next")
      .set(AUTH_HEADERS)
      .send({});

    // A new Gold cluster was created (modern fingerprint).
    const golds = await db.select().from(quoteOpportunities);
    expect(golds).toHaveLength(2);
    const modernGold = golds.find(
      (g) => g.fingerprint !== "LEGACY-FINGERPRINT-HASH"
    );
    expect(modernGold).toBeDefined();

    // The silver row was REPOINTED to the new Gold cluster — not left
    // orphaned at the legacy cluster.
    const [updated] = await db
      .select()
      .from(providerQuoteRequests)
      .where(eq(providerQuoteRequests.id, legacySilver.id));
    expect(updated.quoteOpportunityId).toBe(modernGold!.id);
    expect(updated.fingerprint).toBe(modernGold!.fingerprint);
    expect(updated.opportunityText).toBe(
      "high signal modern expert query"
    );
    expect(updated.mediaOutlet).toBe("Modern Outlet");
    // Identity / provenance fields preserved.
    expect(updated.externalId).toBe(externalId);
    expect(updated.orgId).toBe(TEST_ORG_A);
    expect(updated.provider).toBe("featured");
  });

  it("dedupes EQRS rows with duplicate fingerprints in the same batch (Featured surfaces same question across multiple rows)", async () => {
    // Same opportunityText + mediaOutlet → same fingerprint. Featured
    // sometimes returns the same question under different external_ids
    // (e.g. tagged for different verticals). ON CONFLICT DO UPDATE on
    // quote_opportunities errors with Postgres 21000 if not deduped.
    state.opportunities = [
      makeOpportunity({
        externalId: "dup-a",
        featuredQuestionId: 4001,
        opportunityText: "high signal duplicate question",
        mediaOutlet: "Outlet",
      }),
      makeOpportunity({
        externalId: "dup-b",
        featuredQuestionId: 4002,
        opportunityText: "high signal duplicate question",
        mediaOutlet: "Outlet",
      }),
      makeOpportunity({
        externalId: "uniq",
        featuredQuestionId: 4003,
        opportunityText: "high signal unique row",
        mediaOutlet: "Outlet",
      }),
    ];

    const res = await request(app())
      .post("/orgs/opportunities/next")
      .set(AUTH_HEADERS)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.found).toBe(true);

    // Two Gold clusters: one for the duplicated fingerprint, one for the unique row.
    const goldRows = await db.select().from(quoteOpportunities);
    expect(goldRows).toHaveLength(2);

    // Three silver rows: dup-a + dup-b BOTH inserted (silver natural key
    // is external_id, not fingerprint) + uniq. dup-a and dup-b point at
    // the SAME Gold cluster.
    const silverRows = await db.select().from(providerQuoteRequests);
    expect(silverRows).toHaveLength(3);
    const dupA = silverRows.find((s) => s.externalId === "dup-a");
    const dupB = silverRows.find((s) => s.externalId === "dup-b");
    expect(dupA?.quoteOpportunityId).toBe(dupB?.quoteOpportunityId);
  });

  it("returns { found: false } when EQRS has no opportunities", async () => {
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
      makeOpportunity({
        externalId: "1",
        featuredQuestionId: 1,
        opportunityText: "low signal cat memes",
        mediaOutlet: "BuzzFeed",
      }),
      makeOpportunity({
        externalId: "2",
        featuredQuestionId: 2,
        opportunityText: "high signal AI ethics",
        mediaOutlet: "Forbes",
      }),
      makeOpportunity({
        externalId: "3",
        featuredQuestionId: 3,
        opportunityText: "mid signal SaaS pricing",
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
    expect(res.body.brandIds).toEqual([TEST_BRAND]);

    const goldIds = (
      await db.select({ id: quoteOpportunities.id }).from(quoteOpportunities)
    ).map((g) => g.id);
    expect(goldIds).toContain(res.body.opportunity.opportunityId);
  });

  it("skips opportunities with a blocking pitch on the same brand-set", async () => {
    state.opportunities = [
      makeOpportunity({
        externalId: "11",
        featuredQuestionId: 11,
        opportunityText: "high signal top",
        mediaOutlet: "Outlet 1",
      }),
      makeOpportunity({
        externalId: "12",
        featuredQuestionId: 12,
        opportunityText: "high signal second",
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
      makeOpportunity({
        externalId: "21",
        featuredQuestionId: 21,
        opportunityText: "high signal solo target",
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

  it("cold start: pulls all opportunities from EQRS in a single fetch + scores in a single multi-brand call (LIMIT 10)", async () => {
    state.opportunities = Array.from({ length: 15 }, (_, i) =>
      makeOpportunity({
        externalId: String(500 + i),
        featuredQuestionId: 500 + i,
        opportunityText: `high signal item ${i}`,
        mediaOutlet: `Outlet ${i}`,
      })
    );

    const res = await request(app())
      .post("/orgs/opportunities/next")
      .set(AUTH_HEADERS)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.found).toBe(true);
    expect(state.fetchCalls).toBe(1);
    expect(state.fetchSinceLog[0]).toBeUndefined();
    expect(vi.mocked(judgeRelevance)).toHaveBeenCalledTimes(1);
    const call = vi.mocked(judgeRelevance).mock.calls[0][0] as {
      documents: unknown[];
      brandContext: string;
    };
    expect(call.documents).toHaveLength(10);
    // Brand identity reaches the judge as rendered brandContext text,
    // not as a brandIds field. The (opportunity, brand_ids[]) keying
    // lives in the quote_priorities upsert.
    expect(typeof call.brandContext).toBe("string");
    expect(vi.mocked(extractBrandContext)).toHaveBeenCalled();

    const rows = await db.select().from(quotePriorities);
    expect(rows).toHaveLength(10);
  });

  it("stable state: zero scoring when every visible opportunity is already in quote_priorities", async () => {
    state.opportunities = [
      makeOpportunity({
        externalId: "901",
        featuredQuestionId: 901,
        opportunityText: "high signal stable",
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

  it("exhaustion-driven: EQRS fetched once on cold start, skipped while unscored remain, refetched after pool drains with a `since` cursor", async () => {
    state.opportunities = Array.from({ length: 12 }, (_, i) =>
      makeOpportunity({
        externalId: String(9100 + i),
        featuredQuestionId: 9100 + i,
        opportunityText: `high signal exhaust ${i}`,
        mediaOutlet: `Outlet ${i}`,
      })
    );

    const a = app();
    // Call 1: silver empty → EQRS fetched → 12 ingested → score 10 of 12.
    await request(a)
      .post("/orgs/opportunities/next")
      .set(AUTH_HEADERS)
      .send({});
    expect(state.fetchCalls).toBe(1);

    // Call 2: 2 unscored remaining → NO EQRS fetch.
    await request(a)
      .post("/orgs/opportunities/next")
      .set(AUTH_HEADERS)
      .send({});
    expect(state.fetchCalls).toBe(1);

    // Call 3: pool drained → EQRS fetch fires, with `since` set to cursor.
    await request(a)
      .post("/orgs/opportunities/next")
      .set(AUTH_HEADERS)
      .send({});
    expect(state.fetchCalls).toBe(2);
    expect(state.fetchSinceLog[1]).toBeDefined();
  });

  it("EQRS cursor persists across calls in eqrs_sync_state", async () => {
    state.opportunities = [
      makeOpportunity({
        externalId: "9200",
        featuredQuestionId: 9200,
        opportunityText: "high signal cursor",
        mediaOutlet: "Outlet cursor",
      }),
    ];
    const a = app();
    await request(a)
      .post("/orgs/opportunities/next")
      .set(AUTH_HEADERS)
      .send({});

    const [row] = await db
      .select()
      .from(eqrsSyncState)
      .where(eq(eqrsSyncState.orgId, TEST_ORG_A));
    expect(row).toBeDefined();
    expect(row.lastSyncedAt).not.toBeNull();
  });

  it("does NOT re-score across calls — quote_priorities rows reused", async () => {
    state.opportunities = [
      makeOpportunity({
        externalId: "9300",
        featuredQuestionId: 9300,
        opportunityText: "high signal reuse",
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
    state.opportunities = [
      makeOpportunity({
        externalId: "8001",
        featuredQuestionId: 8001,
        opportunityText: "low signal noise",
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
    expect(res.body).toEqual({ found: false });
    expect(vi.mocked(judgeRelevance)).not.toHaveBeenCalled();
  });
});
