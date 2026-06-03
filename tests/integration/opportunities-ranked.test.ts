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

describe("GET /orgs/opportunities (canonical read)", () => {
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
      .get("/orgs/opportunities")
      .set(AUTH_HEADERS);
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
      .get("/orgs/opportunities")
      .set(headers);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/x-brand-id/);
  });

  it("accepts limit > 50 (no upper cap)", async () => {
    const res = await request(app())
      .get("/orgs/opportunities?limit=200")
      .set(AUTH_HEADERS);
    expect(res.status).toBe(200);
  });

  it("returns ALL scored premium opps regardless of relevance, sorts by score desc, honors ?limit=&offset=", async () => {
    const high = await seedScoredOpportunity({
      fingerprint: "g-high",
      text: "high signal AI ethics",
      outlet: "Forbes",
      externalId: "g-1",
      featuredQuestionId: 3001,
      brandIds: [TEST_BRAND],
      score: 95,
    });
    const mid = await seedScoredOpportunity({
      fingerprint: "g-mid",
      text: "mid signal SaaS pricing",
      outlet: "TechCrunch",
      externalId: "g-2",
      featuredQuestionId: 3002,
      brandIds: [TEST_BRAND],
      score: 70,
    });
    // Low relevance — NO score floor on the read surface; front-end filters.
    const low = await seedScoredOpportunity({
      fingerprint: "g-low",
      text: "low",
      outlet: "BuzzFeed",
      externalId: "g-3",
      featuredQuestionId: 3003,
      brandIds: [TEST_BRAND],
      score: 20,
    });

    const all = await request(app())
      .get("/orgs/opportunities")
      .set(AUTH_HEADERS);
    expect(all.status).toBe(200);
    expect(all.body.opportunities.map((o: { opportunityId: string }) => o.opportunityId)).toEqual([
      high,
      mid,
      low,
    ]);
    expect(all.body.total).toBe(3);
    // The low-relevance row carries its score so the dashboard can filter.
    expect(all.body.opportunities[2].score).toBe(20);

    const paged = await request(app())
      .get("/orgs/opportunities?limit=1&offset=1")
      .set(AUTH_HEADERS);
    expect(paged.body.opportunities).toHaveLength(1);
    expect(paged.body.opportunities[0].opportunityId).toBe(mid);
    expect(paged.body.total).toBe(3);
  });

  it("annotates pitchStatus brand-atomically regardless of ?campaignId= (a brand cannot pitch the same opp twice)", async () => {
    const opp = await seedScoredOpportunity({
      fingerprint: "g-camp",
      text: "high signal camp",
      externalId: "g-camp-1",
      featuredQuestionId: 3100,
      brandIds: [TEST_BRAND],
      score: 90,
    });
    const silver = (
      await db
        .select()
        .from(providerQuoteRequests)
        .where(eq(providerQuoteRequests.externalId, "g-camp-1"))
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

    // Pitched under campaign A surfaces as pitched under BOTH the same-campaign
    // query and a different-campaign query — the annotation is per-brand, never
    // per-campaign (matches the atomic exclusion in /next + stats).
    const sameCampaign = await request(app())
      .get("/orgs/opportunities?campaignId=" + TEST_CAMPAIGN_A)
      .set(AUTH_HEADERS);
    expect(sameCampaign.body.opportunities[0].pitchStatus).toBe("submitted");

    const otherCampaign = await request(app())
      .get("/orgs/opportunities?campaignId=" + TEST_CAMPAIGN_B)
      .set(AUTH_HEADERS);
    expect(otherCampaign.body.opportunities[0].pitchStatus).toBe("submitted");
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

  it("counts silver pool + scored + eligible (no score floor) + best score", async () => {
    const high = await seedScoredOpportunity({
      fingerprint: "fp-high",
      text: "high signal",
      externalId: "s-1",
      featuredQuestionId: 5001,
      brandIds: [TEST_BRAND],
      score: 95,
    });
    // Low relevance — still eligible (no score floor); front-end filters.
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
    expect(res.body.eligibleCount).toBe(2); // both — no relevance gate
    expect(res.body.pitchedBlocking).toBe(0);
    expect(res.body.expiredCount).toBe(0);
    expect(res.body.bestEligibleScore).toBe(95);

    // Pitch the high one — it leaves the eligible set; the low one remains.
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
    expect(res2.body.eligibleCount).toBe(1); // low (20) still actionable
    expect(res2.body.pitchedBlocking).toBe(1);
    expect(res2.body.bestEligibleScore).toBe(20);
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

  it("counts pitchedBlocking brand-atomically regardless of ?campaign_id= (any campaign's pitch blocks)", async () => {
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

    // The pitch (under campaign A) blocks the opportunity for the brand-set
    // under EVERY campaign query — pitchedBlocking=1 / eligibleCount=0 for both
    // the same campaign and a different one. A brand cannot answer the same
    // Featured question twice, so campaign is never the block axis.
    const sameCampaign = await request(app())
      .get("/orgs/opportunities/stats?campaign_id=" + TEST_CAMPAIGN_A)
      .set(AUTH_HEADERS);
    expect(sameCampaign.body.pitchedBlocking).toBe(1);
    expect(sameCampaign.body.eligibleCount).toBe(0);

    const otherCampaign = await request(app())
      .get("/orgs/opportunities/stats?campaign_id=" + TEST_CAMPAIGN_B)
      .set(AUTH_HEADERS);
    expect(otherCampaign.body.pitchedBlocking).toBe(1);
    expect(otherCampaign.body.eligibleCount).toBe(0);
  });
});
