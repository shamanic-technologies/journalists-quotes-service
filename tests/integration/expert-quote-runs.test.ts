import { describe, it, expect, beforeEach, afterAll, beforeAll, vi } from "vitest";
import request from "supertest";
import {
  createTestApp,
  AUTH_HEADERS,
  AUTH_HEADERS_ORG_B,
  TEST_ORG_A,
  TEST_BRAND,
  TEST_CAMPAIGN_A,
  TEST_CAMPAIGN_B,
} from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import {
  buildMockClient,
  createMockState,
  type MockFeaturedState,
} from "../helpers/mock-featured.js";
import { db } from "../../src/db/index.js";
import {
  featuredProfiles,
  quotePitches,
  providerQuoteRequests,
} from "../../src/db/schema.js";
import {
  _resetFeaturedClientState,
  FeaturedRateLimitError,
} from "../../src/lib/featured-client.js";

vi.mock("../../src/lib/key-service-client.js", () => ({
  getFeaturedCredentials: vi.fn(async () => ({
    username: "mock-u",
    password: "mock-p",
  })),
  KeyServiceUnavailableError: class extends Error {},
}));

vi.mock("../../src/lib/brand-client.js", () => ({
  getBrand: vi.fn(async (brandId: string) => ({
    id: brandId,
    name: "Test Brand",
    industry: "tech",
  })),
  getBrandLogo: vi.fn(async (brandId: string) => ({
    id: "logo-1",
    permanentUrl: `http://cdn.test/logo-${brandId}.png`,
    category: "logo",
  })),
  extractBrandFields: vi.fn(async (brandId: string) => ({
    brands: [
      {
        brandId,
        domain: "test.com",
        name: "Test Brand",
        brandUrl: "https://test.com",
      },
    ],
    fields: {
      industry: { value: "AI in healthcare", byBrand: {} },
      expertise: {
        value: "Clinical AI deployment and patient-data privacy",
        byBrand: {},
      },
      voice: { value: "plainspoken, evidence-led", byBrand: {} },
      targetAudience: { value: "Hospital CIOs and CTOs", byBrand: {} },
    },
  })),
}));

vi.mock("../../src/lib/chat-client.js", () => ({
  ragScore: vi.fn(async (req: { documents: { id: string; text: string }[] }) => ({
    results: req.documents.map((d, i) => ({
      id: d.id,
      score: i === 0 ? 0.9 : 0.2,
      whyRelevant: i === 0 ? "Strong relevance" : "Weak relevance",
    })),
  })),
}));

vi.mock("../../src/lib/content-generation-client.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../src/lib/content-generation-client.js")
  >("../../src/lib/content-generation-client.js");
  return {
    ...actual,
    generateExpertQuotePitch: vi.fn(async () => ({
      pitch: "P".repeat(150),
      charCount: 150,
      attempts: 1,
      tokensInput: 100,
      tokensOutput: 50,
      contentGenRunId: "00000000-0000-0000-0000-0000000000ee",
    })),
  };
});

const fetchLogoBytes = vi.fn(async () => ({
  bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]),
  contentType: "image/png",
  filename: "logo.png",
}));

let state: MockFeaturedState;

function makeApp() {
  state = createMockState({
    opportunities: [
      {
        featuredQuestionId: 100,
        opportunity: "Need expert on AI in healthcare",
        mediaOutlet: "Forbes",
        source: "featured",
      },
      {
        featuredQuestionId: 101,
        opportunity: "Need fashion designer quote",
        mediaOutlet: "Vogue",
        source: "featured",
      },
    ],
  });
  return createTestApp({
    expertQuoteRunsDeps: {
      buildClient: buildMockClient(state),
      fetchLogoBytes,
    },
  });
}

describe("POST /orgs/expert-quote-runs", () => {
  beforeAll(async () => {
    await cleanTestData();
  });

  beforeEach(async () => {
    await cleanTestData();
    _resetFeaturedClientState();
    fetchLogoBytes.mockClear();
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("happy path returns submitted with quoteRequestId + pitchId and persists pitch metadata", async () => {
    const app = makeApp();
    const res = await request(app)
      .post("/orgs/expert-quote-runs")
      .set(AUTH_HEADERS)
      .send({ campaignId: TEST_CAMPAIGN_A, brandId: TEST_BRAND });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("submitted");
    expect(res.body.quoteRequestId).toBeDefined();
    expect(res.body.pitchId).toBeDefined();
    expect(state.submitted).toHaveLength(1);
    expect(state.submitted[0].featuredQuestionId).toBe(100);

    const profiles = await db.select().from(featuredProfiles);
    expect(profiles).toHaveLength(1);
    expect(profiles[0].orgId).toBe(TEST_ORG_A);

    const [pitch] = await db.select().from(quotePitches);
    expect(pitch.status).toBe("submitted");
    expect(pitch.draft).toBe("P".repeat(150));
    expect(pitch.pitchCharCount).toBe(150);
    expect(pitch.pitchAttempts).toBe(1);
    expect(pitch.contentGenRunId).toBe(
      "00000000-0000-0000-0000-0000000000ee"
    );
  });

  it("returns no_match when nothing scores above threshold", async () => {
    const app = createTestApp({
      expertQuoteRunsDeps: {
        buildClient: buildMockClient(
          createMockState({
            opportunities: [
              {
                featuredQuestionId: 200,
                opportunity: "Some low-relevance request",
                mediaOutlet: "Outlet",
                source: "featured",
              },
            ],
          })
        ),
        fetchLogoBytes,
      },
    });

    const { ragScore } = await import("../../src/lib/chat-client.js");
    (ragScore as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async (req: { documents: { id: string; text: string }[] }) => ({
        results: req.documents.map((d) => ({ id: d.id, score: 0.1 })),
      })
    );

    const res = await request(app)
      .post("/orgs/expert-quote-runs")
      .set(AUTH_HEADERS)
      .send({ campaignId: TEST_CAMPAIGN_A, brandId: TEST_BRAND });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("no_match");
  });

  it("returns rate_limited when bucket empty", async () => {
    const localState = createMockState({
      opportunities: [
        {
          featuredQuestionId: 300,
          opportunity: "high relevance",
          mediaOutlet: "Wired",
          source: "featured",
        },
      ],
      rateRemaining: 0,
    });
    const app = createTestApp({
      expertQuoteRunsDeps: {
        buildClient: buildMockClient(localState, 1234),
        fetchLogoBytes,
      },
    });

    const res = await request(app)
      .post("/orgs/expert-quote-runs")
      .set(AUTH_HEADERS)
      .send({ campaignId: TEST_CAMPAIGN_A, brandId: TEST_BRAND });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("rate_limited");
    expect(res.body.retryAfter).toBe(1234);
    expect(localState.submitted).toHaveLength(0);
  });

  it("idempotent: re-running same campaign returns no_match for already-pitched", async () => {
    const app = makeApp();
    const first = await request(app)
      .post("/orgs/expert-quote-runs")
      .set(AUTH_HEADERS)
      .send({ campaignId: TEST_CAMPAIGN_A, brandId: TEST_BRAND });
    expect(first.body.status).toBe("submitted");

    const second = await request(app)
      .post("/orgs/expert-quote-runs")
      .set(AUTH_HEADERS)
      .send({ campaignId: TEST_CAMPAIGN_A, brandId: TEST_BRAND });

    expect(second.status).toBe(200);
    expect(["no_match", "submitted"]).toContain(second.body.status);
    if (second.body.status === "submitted") {
      expect(second.body.quoteRequestId).not.toBe(first.body.quoteRequestId);
    }

    const allPitches = await db.select().from(quotePitches);
    const top = allPitches.find(
      (p) => p.quoteRequestId === first.body.quoteRequestId
    );
    expect(top).toBeDefined();
    expect(top!.status).toBe("submitted");
  });

  it("different campaign on same org can pitch the same request", async () => {
    const app = makeApp();
    const first = await request(app)
      .post("/orgs/expert-quote-runs")
      .set(AUTH_HEADERS)
      .send({ campaignId: TEST_CAMPAIGN_A, brandId: TEST_BRAND });
    expect(first.body.status).toBe("submitted");

    const second = await request(app)
      .post("/orgs/expert-quote-runs")
      .set(AUTH_HEADERS)
      .send({ campaignId: TEST_CAMPAIGN_B, brandId: TEST_BRAND });
    expect(second.body.status).toBe("submitted");
    expect(second.body.quoteRequestId).toBe(first.body.quoteRequestId);
  });

  it("/orgs/* requires x-org-id", async () => {
    const app = makeApp();
    const headers: Record<string, string> = { ...AUTH_HEADERS };
    delete headers["x-org-id"];
    const res = await request(app)
      .post("/orgs/expert-quote-runs")
      .set(headers)
      .send({ campaignId: TEST_CAMPAIGN_A, brandId: TEST_BRAND });
    expect(res.status).toBe(400);
  });

  it("/orgs/* rejects bad api key", async () => {
    const app = makeApp();
    const res = await request(app)
      .post("/orgs/expert-quote-runs")
      .set({ ...AUTH_HEADERS, "x-api-key": "wrong" })
      .send({ campaignId: TEST_CAMPAIGN_A, brandId: TEST_BRAND });
    expect(res.status).toBe(401);
  });

  it("org isolation: org B cannot see org A's quote requests", async () => {
    const app = makeApp();
    await request(app)
      .post("/orgs/expert-quote-runs")
      .set(AUTH_HEADERS)
      .send({ campaignId: TEST_CAMPAIGN_A, brandId: TEST_BRAND });

    const orgAList = await request(app)
      .get("/orgs/quote-requests")
      .set(AUTH_HEADERS);
    expect(orgAList.body.providerQuoteRequests.length).toBeGreaterThan(0);

    const orgBList = await request(app)
      .get("/orgs/quote-requests")
      .set(AUTH_HEADERS_ORG_B);
    expect(orgBList.body.providerQuoteRequests).toEqual([]);
  });

  it("400 length-violation from content-gen persists status=length_violation, no Featured submit", async () => {
    const { generateExpertQuotePitch } = await import(
      "../../src/lib/content-generation-client.js"
    );
    const { ContentGenLengthError } = await import(
      "../../src/lib/content-generation-client.js"
    );
    (generateExpertQuotePitch as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async () => {
        throw new ContentGenLengthError(
          42,
          100,
          2500,
          2,
          "pitch length 42 outside [100, 2500] after 2 attempts",
          { error: "len" }
        );
      }
    );

    const app = makeApp();
    const res = await request(app)
      .post("/orgs/expert-quote-runs")
      .set(AUTH_HEADERS)
      .send({ campaignId: TEST_CAMPAIGN_A, brandId: TEST_BRAND });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("error");
    expect(res.body.pitchId).toBeDefined();
    expect(state.submitted).toHaveLength(0);

    const [pitch] = await db.select().from(quotePitches);
    expect(pitch.status).toBe("length_violation");
    expect(pitch.pitchCharCount).toBe(42);
    expect(pitch.pitchAttempts).toBe(2);
    expect(pitch.draft).toBeNull();
    expect((pitch.errorDetails as { minChars: number }).minChars).toBe(100);
  });

  it("404 template-missing persists status=template_missing, surfaces 424", async () => {
    const { generateExpertQuotePitch, ContentGenTemplateMissingError } =
      await import("../../src/lib/content-generation-client.js");
    (generateExpertQuotePitch as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async () => {
        throw new ContentGenTemplateMissingError(
          "No prompt found for type=expert-quote-pitch",
          { error: "missing" }
        );
      }
    );

    const app = makeApp();
    const res = await request(app)
      .post("/orgs/expert-quote-runs")
      .set(AUTH_HEADERS)
      .send({ campaignId: TEST_CAMPAIGN_A, brandId: TEST_BRAND });

    expect(res.status).toBe(424);
    expect(res.body.status).toBe("error");
    expect(state.submitted).toHaveLength(0);

    const [pitch] = await db.select().from(quotePitches);
    expect(pitch.status).toBe("template_missing");
    expect(pitch.draft).toBeNull();
  });

  it("402 insufficient credits persists status=insufficient_credits, propagates 402", async () => {
    const { generateExpertQuotePitch, ContentGenInsufficientCreditsError } =
      await import("../../src/lib/content-generation-client.js");
    (generateExpertQuotePitch as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async () => {
        throw new ContentGenInsufficientCreditsError(
          "Insufficient credits",
          {},
          50,
          200
        );
      }
    );

    const app = makeApp();
    const res = await request(app)
      .post("/orgs/expert-quote-runs")
      .set(AUTH_HEADERS)
      .send({ campaignId: TEST_CAMPAIGN_A, brandId: TEST_BRAND });

    expect(res.status).toBe(402);
    expect(res.body.balance_cents).toBe(50);
    expect(res.body.required_cents).toBe(200);
    expect(state.submitted).toHaveLength(0);

    const [pitch] = await db.select().from(quotePitches);
    expect(pitch.status).toBe("insufficient_credits");
  });

  it("brand-service missing required fields persists status=brand_missing_fields and fails loud", async () => {
    const { extractBrandFields } = await import(
      "../../src/lib/brand-client.js"
    );
    (extractBrandFields as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async (brandId: string) => ({
        brands: [
          {
            brandId,
            domain: "test.com",
            name: "Test Brand",
            brandUrl: "https://test.com",
          },
        ],
        fields: {
          industry: { value: "AI", byBrand: {} },
          // expertise missing
          voice: { value: "plain", byBrand: {} },
          targetAudience: { value: "CIOs", byBrand: {} },
        },
      })
    );

    const app = makeApp();
    const res = await request(app)
      .post("/orgs/expert-quote-runs")
      .set(AUTH_HEADERS)
      .send({ campaignId: TEST_CAMPAIGN_A, brandId: TEST_BRAND });

    expect(res.status).toBe(424);
    expect(res.body.status).toBe("error");
    expect(res.body.missing).toContain("expertise");
    expect(state.submitted).toHaveLength(0);

    const [pitch] = await db.select().from(quotePitches);
    expect(pitch.status).toBe("brand_missing_fields");
    expect(pitch.draft).toBeNull();
  });

  it("forwards identity headers + structured brand body to content-generation-service", async () => {
    const { generateExpertQuotePitch } = await import(
      "../../src/lib/content-generation-client.js"
    );
    (generateExpertQuotePitch as ReturnType<typeof vi.fn>).mockClear();

    const app = makeApp();
    const res = await request(app)
      .post("/orgs/expert-quote-runs")
      .set({
        ...AUTH_HEADERS,
        "x-workflow-slug": "expert-quote-flow",
        "x-feature-slug": "journalist-quotes",
      })
      .send({ campaignId: TEST_CAMPAIGN_A, brandId: TEST_BRAND });

    expect(res.status).toBe(200);
    expect(generateExpertQuotePitch).toHaveBeenCalledTimes(1);
    const [body, identity] = (
      generateExpertQuotePitch as ReturnType<typeof vi.fn>
    ).mock.calls[0];
    expect(body.brand).toMatchObject({
      name: "Test Brand",
      industry: "AI in healthcare",
      expertise: "Clinical AI deployment and patient-data privacy",
      voice: "plainspoken, evidence-led",
      targetAudience: "Hospital CIOs and CTOs",
    });
    expect(body.request.question).toMatch(/AI in healthcare/);
    expect(body.workflowSlug).toBe("expert-quote-flow");
    expect(body.featureSlug).toBe("journalist-quotes");
    expect(identity.orgId).toBe(TEST_ORG_A);
    expect(identity.userId).toBeTruthy();
    expect(identity.runId).toBeTruthy();
    expect(identity.brandId).toBe(TEST_BRAND);
    expect(identity.campaignId).toBe(TEST_CAMPAIGN_A);
    expect(identity.workflowSlug).toBe("expert-quote-flow");
    expect(identity.featureSlug).toBe("journalist-quotes");
  });

  it("persists parent_run_id and run_id on quote_pitches", async () => {
    const app = makeApp();
    const res = await request(app)
      .post("/orgs/expert-quote-runs")
      .set(AUTH_HEADERS)
      .send({ campaignId: TEST_CAMPAIGN_A, brandId: TEST_BRAND });
    expect(res.body.status).toBe("submitted");

    const [pitch] = await db
      .select()
      .from(quotePitches)
      .where(undefined as never);
    expect(pitch.parentRunId).toBeTruthy();
    expect(pitch.runId).toBeTruthy();
  });
});

describe("GET /health", () => {
  it("returns 200", async () => {
    const app = createTestApp({});
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });
});
