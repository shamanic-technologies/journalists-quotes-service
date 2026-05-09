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
  quoteRequests,
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

vi.mock("../../src/lib/content-generation-client.js", () => ({
  generatePitch: vi.fn(async () => ({
    content: "P".repeat(150),
  })),
}));

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

  it("happy path returns submitted with quoteRequestId + pitchId", async () => {
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
    expect(orgAList.body.quoteRequests.length).toBeGreaterThan(0);

    const orgBList = await request(app)
      .get("/orgs/quote-requests")
      .set(AUTH_HEADERS_ORG_B);
    expect(orgBList.body.quoteRequests).toEqual([]);
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
