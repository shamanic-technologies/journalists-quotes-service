import {
  describe,
  it,
  expect,
  beforeEach,
  beforeAll,
  afterAll,
  vi,
} from "vitest";
import request from "supertest";
import {
  createTestApp,
  AUTH_HEADERS,
  TEST_BRAND,
  TEST_CAMPAIGN_A,
  TEST_ORG_A,
} from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import {
  providerQuoteRequests,
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
import { SHARED_EMAIL_ORG_ID } from "../../src/lib/inbound/process.js";

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
        score: /ai|ergonomics|available/i.test(d.text) ? 0.9 : 0.4,
        whyRelevant: "match keyword",
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

  it("returns no_match when Featured + silver are both empty", async () => {
    const res = await request(app())
      .post("/orgs/opportunities/next")
      .set(AUTH_HEADERS)
      .send({ campaignId: TEST_CAMPAIGN_A, brandId: TEST_BRAND });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "no_match" });
  });

  it("upserts Featured opportunities to silver and picks the top scored", async () => {
    state.opportunities = [
      {
        featuredQuestionId: 4242,
        opportunity: "AI ethics in healthcare",
        mediaOutlet: "Forbes",
        source: "featured",
      },
      {
        featuredQuestionId: 4243,
        opportunity: "Top 10 cat memes",
        mediaOutlet: "Buzzfeed",
        source: "featured",
      },
    ];

    const res = await request(app())
      .post("/orgs/opportunities/next")
      .set(AUTH_HEADERS)
      .send({ campaignId: TEST_CAMPAIGN_A, brandId: TEST_BRAND });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("match");
    expect(res.body.provider).toBe("featured");
    expect(res.body.featuredQuestionId).toBe(4242);
    expect(res.body.score).toBeCloseTo(0.9);

    const silver = await db
      .select()
      .from(providerQuoteRequests)
      .where(eq(providerQuoteRequests.orgId, TEST_ORG_A));
    expect(silver).toHaveLength(2);

    const priorities = await db.select().from(quotePriorities);
    expect(priorities).toHaveLength(2);
  });

  it("tolerates Featured opportunities with unparseable deadline strings", async () => {
    state.opportunities = [
      {
        featuredQuestionId: 5050,
        opportunity: "AI ethics in healthcare",
        mediaOutlet: "Forbes",
        source: "featured",
        deadline: "TBD",
      },
      {
        featuredQuestionId: 5051,
        opportunity: "available expert",
        mediaOutlet: "WSJ",
        source: "featured",
        deadline: "",
      },
      {
        featuredQuestionId: 5052,
        opportunity: "available now",
        mediaOutlet: "NYT",
        source: "featured",
        deadline: "2099-01-01T00:00:00Z",
      },
    ];

    const res = await request(app())
      .post("/orgs/opportunities/next")
      .set(AUTH_HEADERS)
      .send({ campaignId: TEST_CAMPAIGN_A, brandId: TEST_BRAND });

    expect(res.status).toBe(200);
    const silver = await db
      .select()
      .from(providerQuoteRequests)
      .where(eq(providerQuoteRequests.orgId, TEST_ORG_A));
    expect(silver).toHaveLength(3);

    const byExternalId = new Map(silver.map((r) => [r.externalId, r]));
    expect(byExternalId.get("5050")?.deadline).toBeNull();
    expect(byExternalId.get("5051")?.deadline).toBeNull();
    expect(byExternalId.get("5052")?.deadline).toBeInstanceOf(Date);
  });

  it("includes email-sourced silver rows (SHARED_EMAIL_ORG_ID) in the candidate pool", async () => {
    await db.insert(providerQuoteRequests).values({
      provider: "haro",
      ingestionChannel: "email",
      externalId: "haro-1",
      opportunityText: "Looking for ergonomics expert",
      mediaOutlet: "Lifehacker",
      orgId: SHARED_EMAIL_ORG_ID,
      pitchEmail: "reply+abc@helpareporter.com",
      journalistName: "Jane Doe",
    });
    state.opportunities = [];

    const res = await request(app())
      .post("/orgs/opportunities/next")
      .set(AUTH_HEADERS)
      .send({ campaignId: TEST_CAMPAIGN_A, brandId: TEST_BRAND });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("match");
    expect(res.body.provider).toBe("haro");
    expect(res.body.pitchEmail).toBe("reply+abc@helpareporter.com");
  });

  it("excludes opportunities with an existing non-error pitch on the campaign", async () => {
    // Two Featured opps; the first (top-scoring) already pitched -> should pick second.
    state.opportunities = [
      {
        featuredQuestionId: 9001,
        opportunity: "Already pitched",
        mediaOutlet: "Outlet A",
        source: "featured",
      },
      {
        featuredQuestionId: 9002,
        opportunity: "Available",
        mediaOutlet: "Outlet B",
        source: "featured",
      },
    ];

    const app1 = app();
    await request(app1)
      .post("/orgs/opportunities/next")
      .set(AUTH_HEADERS)
      .send({ campaignId: TEST_CAMPAIGN_A, brandId: TEST_BRAND });

    const silver = await db
      .select()
      .from(providerQuoteRequests)
      .where(eq(providerQuoteRequests.externalId, "9001"));
    await db.insert(quotePitches).values({
      quoteRequestId: silver[0].id,
      featuredQuestionId: 9001,
      campaignId: TEST_CAMPAIGN_A,
      brandId: TEST_BRAND,
      status: "submitted",
      deliveryMethod: "featured_api",
      orgId: TEST_ORG_A,
    });

    const res = await request(app1)
      .post("/orgs/opportunities/next")
      .set(AUTH_HEADERS)
      .send({ campaignId: TEST_CAMPAIGN_A, brandId: TEST_BRAND });

    expect(res.body.status).toBe("match");
    expect(res.body.featuredQuestionId).toBe(9002);
  });

  it("returns no_match when nothing scores above threshold", async () => {
    state.opportunities = [
      {
        featuredQuestionId: 1,
        opportunity: "Low score 1",
        mediaOutlet: "x",
        source: "featured",
      },
    ];
    const { ragScore } = await import("../../src/lib/chat-client.js");
    (ragScore as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async (req: { documents: { id: string }[] }) => ({
        results: req.documents.map((d) => ({
          id: d.id,
          score: 0.1,
          whyRelevant: "below threshold",
        })),
      })
    );

    const res = await request(app())
      .post("/orgs/opportunities/next")
      .set(AUTH_HEADERS)
      .send({ campaignId: TEST_CAMPAIGN_A, brandId: TEST_BRAND });
    expect(res.body.status).toBe("no_match");
  });
});
