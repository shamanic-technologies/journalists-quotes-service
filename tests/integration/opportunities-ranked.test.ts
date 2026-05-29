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
  quotePriorities,
} from "../../src/db/schema.js";
import { eq } from "drizzle-orm";

async function seedScoredOpportunity(args: {
  fingerprint: string;
  text: string;
  outlet?: string | null;
  externalId: string;
  featuredQuestionId?: number;
  brandIds: string[];
  score: number;
  deadline?: Date | null;
  whyRelevant?: string;
}): Promise<string> {
  const [opp] = await db
    .insert(quoteOpportunities)
    .values({
      fingerprint: args.fingerprint,
      canonicalText: args.text,
      canonicalOutlet: args.outlet ?? null,
      canonicalDeadline: args.deadline ?? null,
    })
    .returning();
  await db.insert(providerQuoteRequests).values({
    provider: "featured",
    ingestionChannel: "api",
    externalId: args.externalId,
    featuredQuestionId: args.featuredQuestionId ?? null,
    mediaOutlet: args.outlet ?? null,
    opportunityText: args.text,
    deadline: args.deadline ?? null,
    quoteOpportunityId: opp.id,
    isCanonical: true,
    fingerprint: args.fingerprint,
    orgId: TEST_ORG_A,
  });
  await db.insert(quotePriorities).values({
    quoteOpportunityId: opp.id,
    brandIds: args.brandIds,
    campaignId: null,
    score: args.score.toFixed(2),
    whyRelevant: args.whyRelevant ?? "seeded",
    orgId: TEST_ORG_A,
  });
  return opp.id;
}

afterAll(async () => {
  await cleanTestData();
  await closeDb();
});

describe("POST /orgs/opportunities/ranked (pure-read)", () => {
  beforeAll(async () => {
    await cleanTestData();
  });
  beforeEach(async () => {
    await cleanTestData();
  });

  function app() {
    return createTestApp({});
  }

  it("returns empty list with total 0 when no quote_priorities rows exist", async () => {
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

  it("rejects limit > 50 with 400", async () => {
    const res = await request(app())
      .post("/orgs/opportunities/ranked")
      .set(AUTH_HEADERS)
      .send({ limit: 100 });
    expect(res.status).toBe(400);
  });

  it("sorts results by score desc and returns Gold cluster IDs", async () => {
    const high = await seedScoredOpportunity({
      fingerprint: "fp-high",
      text: "high signal AI ethics",
      outlet: "Forbes",
      externalId: "h-1",
      featuredQuestionId: 1001,
      brandIds: [TEST_BRAND],
      score: 95,
    });
    const mid = await seedScoredOpportunity({
      fingerprint: "fp-mid",
      text: "mid signal SaaS pricing",
      outlet: "TechCrunch",
      externalId: "m-1",
      featuredQuestionId: 1002,
      brandIds: [TEST_BRAND],
      score: 70,
    });
    // Below threshold — must be filtered.
    await seedScoredOpportunity({
      fingerprint: "fp-low",
      text: "low",
      outlet: "BuzzFeed",
      externalId: "l-1",
      featuredQuestionId: 1003,
      brandIds: [TEST_BRAND],
      score: 20,
    });

    const res = await request(app())
      .post("/orgs/opportunities/ranked")
      .set(AUTH_HEADERS)
      .send({ campaignId: TEST_CAMPAIGN_A });

    expect(res.status).toBe(200);
    expect(res.body.opportunities).toHaveLength(2);
    expect(res.body.opportunities[0].opportunityId).toBe(high);
    expect(res.body.opportunities[0].score).toBe(95);
    expect(res.body.opportunities[0].pitchStatus).toBeNull();
    expect(res.body.opportunities[0].submittable).toBe(true);
    expect(res.body.opportunities[0].deliveryMethod).toBe("featured_api");
    expect(res.body.opportunities[1].opportunityId).toBe(mid);
    expect(res.body.opportunities[1].score).toBe(70);
    expect(res.body.total).toBe(2);
  });

  it("excludes discovery rows (featured, null featured_question_id, no email) from the list", async () => {
    // Submittable premium row (lower score).
    const prem = await seedScoredOpportunity({
      fingerprint: "fp-prem",
      text: "high signal premium",
      outlet: "Forbes",
      externalId: "featured-premium-1500",
      featuredQuestionId: 1500,
      brandIds: [TEST_BRAND],
      score: 90,
    });
    // Discovery row (higher score) — no fqid, no email → non-submittable.
    await seedScoredOpportunity({
      fingerprint: "fp-disc",
      text: "high signal discovery",
      outlet: "Qwoted",
      externalId: "https://app.qwoted.com/opportunities/1",
      brandIds: [TEST_BRAND],
      score: 95,
    });

    const res = await request(app())
      .post("/orgs/opportunities/ranked")
      .set(AUTH_HEADERS)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.opportunities).toHaveLength(1);
    expect(res.body.opportunities[0].opportunityId).toBe(prem);
    expect(res.body.opportunities[0].featuredQuestionId).toBe(1500);
    expect(res.body.opportunities[0].submittable).toBe(true);
    expect(res.body.total).toBe(1);
  });

  it("honors limit + offset for paging", async () => {
    for (let i = 0; i < 4; i++) {
      await seedScoredOpportunity({
        fingerprint: `fp-${i}`,
        text: `high signal item ${i}`,
        outlet: `Outlet ${i}`,
        externalId: `e-${i}`,
        featuredQuestionId: 2000 + i,
        brandIds: [TEST_BRAND],
        score: 90 - i,
      });
    }

    const a = app();
    const first = await request(a)
      .post("/orgs/opportunities/ranked")
      .set(AUTH_HEADERS)
      .send({ limit: 2, offset: 0 });
    expect(first.body.opportunities).toHaveLength(2);
    expect(first.body.total).toBe(4);

    const second = await request(a)
      .post("/orgs/opportunities/ranked")
      .set(AUTH_HEADERS)
      .send({ limit: 2, offset: 2 });
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

  it("annotates pitchStatus from latest pitch on same brand-set within campaign scope", async () => {
    const oppA = await seedScoredOpportunity({
      fingerprint: "fp-a",
      text: "high signal A",
      externalId: "p-a",
      featuredQuestionId: 9001,
      brandIds: [TEST_BRAND],
      score: 90,
    });
    const oppB = await seedScoredOpportunity({
      fingerprint: "fp-b",
      text: "high signal B",
      externalId: "p-b",
      featuredQuestionId: 9002,
      brandIds: [TEST_BRAND],
      score: 80,
    });
    const silverA = (
      await db
        .select()
        .from(providerQuoteRequests)
        .where(eq(providerQuoteRequests.externalId, "p-a"))
    )[0];
    await db.insert(quotePitches).values({
      quoteRequestId: silverA.id,
      quoteOpportunityId: oppA,
      campaignId: TEST_CAMPAIGN_A,
      brandIds: [TEST_BRAND],
      status: "submitted",
      deliveryMethod: "featured_api",
      orgId: TEST_ORG_A,
    });

    const res = await request(app())
      .post("/orgs/opportunities/ranked")
      .set(AUTH_HEADERS)
      .send({ campaignId: TEST_CAMPAIGN_A });
    const byOpp: Record<string, { pitchStatus: string | null }> = {};
    for (const o of res.body.opportunities) {
      byOpp[o.opportunityId] = { pitchStatus: o.pitchStatus };
    }
    expect(byOpp[oppA].pitchStatus).toBe("submitted");
    expect(byOpp[oppB].pitchStatus).toBeNull();
  });

  it("isolates pitchStatus to the requested campaign", async () => {
    const opp = await seedScoredOpportunity({
      fingerprint: "fp-iso",
      text: "high signal iso",
      externalId: "p-iso",
      featuredQuestionId: 9100,
      brandIds: [TEST_BRAND],
      score: 90,
    });
    const silver = (
      await db
        .select()
        .from(providerQuoteRequests)
        .where(eq(providerQuoteRequests.externalId, "p-iso"))
    )[0];
    await db.insert(quotePitches).values({
      quoteRequestId: silver.id,
      quoteOpportunityId: opp,
      campaignId: TEST_CAMPAIGN_A,
      brandIds: [TEST_BRAND],
      status: "submitted",
      deliveryMethod: "featured_api",
      orgId: TEST_ORG_A,
    });

    // Same opp, different campaign — pitchStatus should be null.
    const res = await request(app())
      .post("/orgs/opportunities/ranked")
      .set(AUTH_HEADERS)
      .send({ campaignId: TEST_CAMPAIGN_B });
    expect(res.body.opportunities).toHaveLength(1);
    expect(res.body.opportunities[0].pitchStatus).toBeNull();
  });

  it("brand-only call surfaces pitchStatus across all campaigns of the brand-set", async () => {
    const opp = await seedScoredOpportunity({
      fingerprint: "fp-brand",
      text: "high signal brand",
      externalId: "p-brand",
      featuredQuestionId: 9200,
      brandIds: [TEST_BRAND],
      score: 90,
    });
    const silver = (
      await db
        .select()
        .from(providerQuoteRequests)
        .where(eq(providerQuoteRequests.externalId, "p-brand"))
    )[0];
    await db.insert(quotePitches).values({
      quoteRequestId: silver.id,
      quoteOpportunityId: opp,
      campaignId: TEST_CAMPAIGN_A,
      brandIds: [TEST_BRAND],
      status: "submitted",
      deliveryMethod: "featured_api",
      orgId: TEST_ORG_A,
    });

    const res = await request(app())
      .post("/orgs/opportunities/ranked")
      .set(AUTH_HEADERS)
      .send({});
    expect(res.body.opportunities).toHaveLength(1);
    expect(res.body.opportunities[0].pitchStatus).toBe("submitted");
  });

  it("filters out opportunities with a past canonical_deadline", async () => {
    const pastDeadline = new Date(Date.now() - 24 * 3600_000);
    await seedScoredOpportunity({
      fingerprint: "fp-expired",
      text: "high signal expired",
      externalId: "p-exp",
      featuredQuestionId: 9300,
      brandIds: [TEST_BRAND],
      score: 90,
      deadline: pastDeadline,
    });
    const res = await request(app())
      .post("/orgs/opportunities/ranked")
      .set(AUTH_HEADERS)
      .send({});
    expect(res.body.opportunities).toHaveLength(0);
    expect(res.body.total).toBe(0);
  });

  it("multi-brand x-brand-id CSV: brandIds canonicalized + filters to exact tuple", async () => {
    const tupleAB = [TEST_BRAND, TEST_BRAND_B].sort();
    await seedScoredOpportunity({
      fingerprint: "fp-ab",
      text: "high signal AB tuple",
      externalId: "p-ab",
      featuredQuestionId: 9400,
      brandIds: tupleAB,
      score: 90,
    });
    // Solo-[A] row for same opp must NOT match the [A,B] query.
    await seedScoredOpportunity({
      fingerprint: "fp-a-solo",
      text: "high signal solo A",
      externalId: "p-a-solo",
      featuredQuestionId: 9401,
      brandIds: [TEST_BRAND],
      score: 95,
    });

    const headers = { ...AUTH_HEADERS } as Record<string, string>;
    headers["x-brand-id"] = `${TEST_BRAND_B},${TEST_BRAND}`;

    const res = await request(app())
      .post("/orgs/opportunities/ranked")
      .set(headers)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.brandIds).toEqual(tupleAB);
    expect(res.body.opportunities).toHaveLength(1);
    expect(res.body.opportunities[0].featuredQuestionId).toBe(9400);
  });

  it("does NOT mutate quote_priorities or score on read", async () => {
    await seedScoredOpportunity({
      fingerprint: "fp-mut",
      text: "high signal mut",
      externalId: "p-mut",
      featuredQuestionId: 9500,
      brandIds: [TEST_BRAND],
      score: 90,
    });
    const beforeRows = await db.select().from(quotePriorities);
    const beforeScoredAt = beforeRows[0].scoredAt;

    await request(app())
      .post("/orgs/opportunities/ranked")
      .set(AUTH_HEADERS)
      .send({});

    const afterRows = await db.select().from(quotePriorities);
    expect(afterRows).toHaveLength(1);
    expect(afterRows[0].scoredAt.getTime()).toBe(beforeScoredAt.getTime());
  });
});

describe("GET /orgs/opportunities/stats", () => {
  beforeAll(async () => {
    await cleanTestData();
  });
  beforeEach(async () => {
    await cleanTestData();
  });

  function app() {
    return createTestApp({});
  }

  it("returns zero counts for an empty catalog", async () => {
    const res = await request(app())
      .get("/orgs/opportunities/stats")
      .set(AUTH_HEADERS);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      silverPoolSize: 0,
      scoredCount: 0,
      eligibleCount: 0,
      pitchedBlocking: 0,
      expiredCount: 0,
      bestEligibleScore: null,
      brandIds: [TEST_BRAND],
    });
  });

  it("rejects when x-brand-id header missing", async () => {
    const headers = { ...AUTH_HEADERS } as Record<string, string>;
    delete headers["x-brand-id"];
    const res = await request(app())
      .get("/orgs/opportunities/stats")
      .set(headers);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/x-brand-id/);
  });

  it("counts silver pool + scored + eligible + best score", async () => {
    const high = await seedScoredOpportunity({
      fingerprint: "fp-high",
      text: "high signal",
      externalId: "s-1",
      featuredQuestionId: 5001,
      brandIds: [TEST_BRAND],
      score: 95,
    });
    // Below threshold — scored but not eligible.
    await seedScoredOpportunity({
      fingerprint: "fp-low",
      text: "low signal",
      externalId: "s-2",
      featuredQuestionId: 5002,
      brandIds: [TEST_BRAND],
      score: 20,
    });
    // Other brand-set — not visible to brand A query.
    await seedScoredOpportunity({
      fingerprint: "fp-other",
      text: "other tuple",
      externalId: "s-3",
      featuredQuestionId: 5003,
      brandIds: [TEST_BRAND_B],
      score: 90,
    });

    const res = await request(app())
      .get("/orgs/opportunities/stats")
      .set(AUTH_HEADERS);
    expect(res.status).toBe(200);
    expect(res.body.silverPoolSize).toBe(3);
    expect(res.body.scoredCount).toBe(2); // brand-set filtered
    expect(res.body.eligibleCount).toBe(1);
    expect(res.body.pitchedBlocking).toBe(0);
    expect(res.body.expiredCount).toBe(0);
    expect(res.body.bestEligibleScore).toBe(95);

    // Pitch the high one — eligible drops.
    const silverHigh = (
      await db
        .select()
        .from(providerQuoteRequests)
        .where(eq(providerQuoteRequests.externalId, "s-1"))
    )[0];
    await db.insert(quotePitches).values({
      quoteRequestId: silverHigh.id,
      quoteOpportunityId: high,
      brandIds: [TEST_BRAND],
      status: "submitted",
      deliveryMethod: "featured_api",
      orgId: TEST_ORG_A,
    });

    const res2 = await request(app())
      .get("/orgs/opportunities/stats")
      .set(AUTH_HEADERS);
    expect(res2.body.eligibleCount).toBe(0);
    expect(res2.body.pitchedBlocking).toBe(1);
    expect(res2.body.bestEligibleScore).toBeNull();
  });

  it("excludes discovery rows (null featured_question_id) from eligibleCount", async () => {
    await seedScoredOpportunity({
      fingerprint: "fp-prem-s",
      text: "high signal premium stat",
      externalId: "featured-premium-1600",
      featuredQuestionId: 1600,
      brandIds: [TEST_BRAND],
      score: 90,
    });
    await seedScoredOpportunity({
      fingerprint: "fp-disc-s",
      text: "high signal discovery stat",
      externalId: "https://app.qwoted.com/opportunities/2",
      brandIds: [TEST_BRAND],
      score: 95,
    });

    const res = await request(app())
      .get("/orgs/opportunities/stats")
      .set(AUTH_HEADERS);
    expect(res.status).toBe(200);
    expect(res.body.scoredCount).toBe(2);
    expect(res.body.eligibleCount).toBe(1);
    expect(res.body.bestEligibleScore).toBe(90);
  });

  it("counts expired opportunities separately + excludes them from eligible", async () => {
    const past = new Date(Date.now() - 24 * 3600_000);
    await seedScoredOpportunity({
      fingerprint: "fp-expired",
      text: "high signal expired",
      externalId: "exp-1",
      featuredQuestionId: 6001,
      brandIds: [TEST_BRAND],
      score: 90,
      deadline: past,
    });

    const res = await request(app())
      .get("/orgs/opportunities/stats")
      .set(AUTH_HEADERS);
    expect(res.body.expiredCount).toBe(1);
    expect(res.body.eligibleCount).toBe(0);
    expect(res.body.scoredCount).toBe(1);
  });

  it("scopes pitchedBlocking to the campaign when campaign_id is provided", async () => {
    const opp = await seedScoredOpportunity({
      fingerprint: "fp-camp",
      text: "high signal camp",
      externalId: "c-1",
      featuredQuestionId: 7001,
      brandIds: [TEST_BRAND],
      score: 90,
    });
    const silver = (
      await db
        .select()
        .from(providerQuoteRequests)
        .where(eq(providerQuoteRequests.externalId, "c-1"))
    )[0];
    await db.insert(quotePitches).values({
      quoteRequestId: silver.id,
      quoteOpportunityId: opp,
      campaignId: TEST_CAMPAIGN_A,
      brandIds: [TEST_BRAND],
      status: "submitted",
      deliveryMethod: "featured_api",
      orgId: TEST_ORG_A,
    });

    const sameCampaign = await request(app())
      .get("/orgs/opportunities/stats?campaign_id=" + TEST_CAMPAIGN_A)
      .set(AUTH_HEADERS);
    expect(sameCampaign.body.pitchedBlocking).toBe(1);
    expect(sameCampaign.body.eligibleCount).toBe(0);

    const otherCampaign = await request(app())
      .get("/orgs/opportunities/stats?campaign_id=" + TEST_CAMPAIGN_B)
      .set(AUTH_HEADERS);
    expect(otherCampaign.body.pitchedBlocking).toBe(0);
    expect(otherCampaign.body.eligibleCount).toBe(1);
  });
});
