import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import {
  createTestApp,
  AUTH_HEADERS,
  TEST_BRAND,
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
  buildMockEqrsClient,
  createMockEqrsState,
  makeSubmittedOutcome,
  makePublishedArticle,
  type MockEqrsState,
} from "../helpers/mock-eqrs.js";
import { EqrsServiceError } from "../../src/lib/eqrs-client.js";

const QID = 87374;
const PROFILE = 94058;

async function seedFeaturedPitch(args: {
  featuredQuestionId: number;
  featuredProfileId: number | null;
  status?: string;
}) {
  const fingerprint = `fp-${args.featuredQuestionId}-${args.featuredProfileId}`;
  const [opp] = await db
    .insert(quoteOpportunities)
    .values({
      fingerprint,
      canonicalText: "Featured demand",
      canonicalOutlet: "Featured Outlet",
    })
    .returning();
  const [silver] = await db
    .insert(providerQuoteRequests)
    .values({
      provider: "featured",
      ingestionChannel: "api",
      externalId: `featured-premium-${args.featuredQuestionId}`,
      featuredQuestionId: args.featuredQuestionId,
      opportunityText: "Featured demand",
      orgId: TEST_ORG_A,
      quoteOpportunityId: opp.id,
      fingerprint,
      isCanonical: true,
    })
    .returning();
  const [pitch] = await db
    .insert(quotePitches)
    .values({
      quoteRequestId: silver.id,
      quoteOpportunityId: opp.id,
      featuredQuestionId: args.featuredQuestionId,
      featuredProfileId: args.featuredProfileId,
      brandIds: [TEST_BRAND],
      deliveryMethod: "featured_api",
      status: (args.status ?? "submitted") as "submitted",
      orgId: TEST_ORG_A,
      submittedAt: new Date(),
    })
    .returning();
  return pitch;
}

function appWith(state: MockEqrsState) {
  return createTestApp({
    quotePitchesDeps: { eqrsClient: buildMockEqrsClient(state) },
  });
}

describe("pitch-outcome reconcile", () => {
  beforeEach(async () => {
    await cleanTestData();
  });
  afterAll(async () => {
    await closeDb();
  });

  it("advances a submitted pitch to published + records DR/attribution/outlet", async () => {
    const pitch = await seedFeaturedPitch({
      featuredQuestionId: QID,
      featuredProfileId: PROFILE,
    });
    const state = createMockEqrsState({
      submittedOutcomes: [
        makeSubmittedOutcome({
          featuredQuestionId: QID,
          profileId: PROFILE,
          status: "Published",
          publicationSource: "The AJ Center",
          domainAuthority: 14,
          attribution: "DoFollow",
        }),
      ],
    });
    const app = appWith(state);

    const res = await request(app)
      .post("/orgs/quote-pitches/reconcile-outcomes")
      .set(AUTH_HEADERS);

    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(1);
    expect(res.body.advanced.published).toBe(1);
    expect(res.body.pitchesScanned).toBe(1);

    const [row] = await db
      .select()
      .from(quotePitches)
      .where(eq(quotePitches.id, pitch.id));
    expect(row.status).toBe("published");
    expect(row.publicationSource).toBe("The AJ Center");
    expect(row.outletDomainRating).toBe(14);
    expect(row.backlinkAttribution).toBe("DoFollow");
    expect(row.outcomeObservedAt).not.toBeNull();
    // No /published match in this state → article URL stays null (never
    // fabricated). The URL comes from the separate /published feed, covered
    // by the "persists the published article URL" test below.
    expect(row.featuredArticleUrl).toBeNull();
  });

  it("persists the published article URL / title / publish date from /published", async () => {
    const pitch = await seedFeaturedPitch({
      featuredQuestionId: QID,
      featuredProfileId: PROFILE,
      status: "submitted",
    });
    const state = createMockEqrsState({
      submittedOutcomes: [
        makeSubmittedOutcome({
          featuredQuestionId: QID,
          profileId: PROFILE,
          status: "Published",
          publicationSource: "Brett Farmiloe",
          domainAuthority: 21,
          attribution: "DoFollow",
        }),
      ],
      publishedArticles: [
        makePublishedArticle({
          featuredQuestionId: QID,
          profileId: PROFILE,
          articleUrl: "https://brettfarmiloe.com/some-article/",
          articleTitle: "Some Great Article",
          publishDate: "2026-07-22T00:00:00.000Z",
        }),
      ],
    });
    const app = appWith(state);

    const res = await request(app)
      .post("/orgs/quote-pitches/reconcile-outcomes")
      .set(AUTH_HEADERS);
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(1);
    expect(res.body.advanced.published).toBe(1);
    expect(res.body.publishedFetched).toBe(1);

    const [row] = await db
      .select()
      .from(quotePitches)
      .where(eq(quotePitches.id, pitch.id));
    expect(row.status).toBe("published");
    expect(row.featuredArticleUrl).toBe(
      "https://brettfarmiloe.com/some-article/"
    );
    expect(row.articleTitle).toBe("Some Great Article");
    expect(row.publishedAt?.toISOString()).toBe("2026-07-22T00:00:00.000Z");

    // Idempotent: a re-run writes nothing.
    const second = await request(app)
      .post("/orgs/quote-pitches/reconcile-outcomes")
      .set(AUTH_HEADERS);
    expect(second.body.updated).toBe(0);
  });

  it("enriches the article URL even when a /submitted outcome is absent", async () => {
    // A pitch already marked published (e.g. via a prior /submitted pass);
    // this run only supplies the /published article, no /submitted outcome.
    const pitch = await seedFeaturedPitch({
      featuredQuestionId: QID,
      featuredProfileId: PROFILE,
      status: "published",
    });
    const state = createMockEqrsState({
      publishedArticles: [
        makePublishedArticle({
          featuredQuestionId: QID,
          profileId: PROFILE,
          articleUrl: "https://x.com/a",
          publishDate: "2026-07-22T00:00:00.000Z",
        }),
      ],
    });
    const app = appWith(state);

    const res = await request(app)
      .post("/orgs/quote-pitches/reconcile-outcomes")
      .set(AUTH_HEADERS);
    expect(res.body.updated).toBe(1);
    expect(res.body.advanced.published).toBe(0); // no status change

    const [row] = await db
      .select()
      .from(quotePitches)
      .where(eq(quotePitches.id, pitch.id));
    expect(row.featuredArticleUrl).toBe("https://x.com/a");
  });

  it("is idempotent: a second reconcile updates nothing", async () => {
    await seedFeaturedPitch({ featuredQuestionId: QID, featuredProfileId: PROFILE });
    const state = createMockEqrsState({
      submittedOutcomes: [
        makeSubmittedOutcome({
          featuredQuestionId: QID,
          profileId: PROFILE,
          status: "Selected",
          publicationSource: "Outlet",
          domainAuthority: 30,
          attribution: "Unknown",
        }),
      ],
    });
    const app = appWith(state);

    const first = await request(app)
      .post("/orgs/quote-pitches/reconcile-outcomes")
      .set(AUTH_HEADERS);
    expect(first.body.updated).toBe(1);
    expect(first.body.advanced.selected).toBe(1);

    const second = await request(app)
      .post("/orgs/quote-pitches/reconcile-outcomes")
      .set(AUTH_HEADERS);
    expect(second.body.updated).toBe(0);
    expect(second.body.advanced.selected).toBe(0);
  });

  it("leaves an unmatched pitch untouched", async () => {
    const pitch = await seedFeaturedPitch({
      featuredQuestionId: QID,
      featuredProfileId: PROFILE,
    });
    const state = createMockEqrsState({
      submittedOutcomes: [
        // Different (question, profile) → no match.
        makeSubmittedOutcome({
          featuredQuestionId: 99999,
          profileId: PROFILE,
          status: "Published",
        }),
      ],
    });
    const app = appWith(state);

    const res = await request(app)
      .post("/orgs/quote-pitches/reconcile-outcomes")
      .set(AUTH_HEADERS);
    expect(res.body.updated).toBe(0);

    const [row] = await db
      .select()
      .from(quotePitches)
      .where(eq(quotePitches.id, pitch.id));
    expect(row.status).toBe("submitted");
    expect(row.outcomeObservedAt).toBeNull();
  });

  it("does not match a pitch with a null featured_profile_id", async () => {
    await seedFeaturedPitch({ featuredQuestionId: QID, featuredProfileId: null });
    const state = createMockEqrsState({
      submittedOutcomes: [
        makeSubmittedOutcome({
          featuredQuestionId: QID,
          profileId: PROFILE,
          status: "Published",
        }),
      ],
    });
    const app = appWith(state);

    const res = await request(app)
      .post("/orgs/quote-pitches/reconcile-outcomes")
      .set(AUTH_HEADERS);
    // The null-profile pitch is excluded from the scan entirely.
    expect(res.body.pitchesScanned).toBe(0);
    expect(res.body.updated).toBe(0);
  });

  it("surfaces an EQRS failure as 502 (fail loud)", async () => {
    await seedFeaturedPitch({ featuredQuestionId: QID, featuredProfileId: PROFILE });
    const state = createMockEqrsState({
      submittedFetchImpl: () => {
        throw new EqrsServiceError("boom", 500);
      },
    });
    const app = appWith(state);

    const res = await request(app)
      .post("/orgs/quote-pitches/reconcile-outcomes")
      .set(AUTH_HEADERS);
    expect(res.status).toBe(502);
    expect(res.body.error).toContain("boom");
  });

  it("GET /orgs/quote-pitches returns the outcome enrichment fields", async () => {
    await seedFeaturedPitch({
      featuredQuestionId: QID,
      featuredProfileId: PROFILE,
      status: "published",
    });
    const state = createMockEqrsState();
    const app = appWith(state);

    const res = await request(app)
      .get("/orgs/quote-pitches")
      .set(AUTH_HEADERS);
    expect(res.status).toBe(200);
    const p = res.body.quotePitches[0];
    expect(p).toHaveProperty("outcomeObservedAt");
    expect(p).toHaveProperty("publicationSource");
    expect(p).toHaveProperty("outletDomainRating");
    expect(p).toHaveProperty("backlinkAttribution");
    expect(p).toHaveProperty("featuredArticleUrl");
    expect(p).toHaveProperty("articleTitle");
    expect(p).toHaveProperty("publishedAt");
  });
});
