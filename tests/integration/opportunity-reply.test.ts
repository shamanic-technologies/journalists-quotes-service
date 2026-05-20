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

vi.mock("../../src/lib/billing-client.js", () => ({
  authorizeCredit: vi.fn(async () => ({
    sufficient: true,
    balance_cents: 10_000,
    required_cents: 1,
  })),
  BillingServiceError: class extends Error {
    constructor(message: string, public readonly status: number) {
      super(message);
    }
  },
}));

vi.mock("../../src/lib/runs-client.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../src/lib/runs-client.js")
  >("../../src/lib/runs-client.js");
  return {
    ...actual,
    addCosts: vi.fn(async () => undefined),
  };
});

vi.mock("../../src/lib/brand-client.js", () => ({
  getBrand: vi.fn(async (brandId: string) => ({
    id: brandId,
    domain: "test-brand.com",
    url: "https://test-brand.com",
    name: "Test Brand",
    logoUrl: "http://cdn.test/logo.png",
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
  })),
}));

// Stub fetch for email-gateway-client `sendTransactionalEmail` calls.
type FetchMock = ReturnType<typeof vi.fn>;
let fetchMock: FetchMock;

const fetchLogoBytes = vi.fn(async () => ({
  bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]),
  contentType: "image/png",
  filename: "logo.png",
}));

let state: MockFeaturedState;

describe("POST /orgs/opportunities/:id/reply", () => {
  beforeAll(async () => {
    await cleanTestData();
  });
  beforeEach(async () => {
    _resetFeaturedClientState();
    await cleanTestData();
    state = createMockState();
    fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          success: true,
          provider: "transactional",
          messageId: "outbound-msg-123",
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    vi.stubGlobal("fetch", fetchMock);
  });
  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  function app() {
    return createTestApp({
      opportunityReplyDeps: {
        buildClient: buildMockClient(state),
        fetchLogoBytes,
      },
    });
  }

  async function seedFeaturedSilver(featuredQuestionId: number) {
    const [row] = await db
      .insert(providerQuoteRequests)
      .values({
        provider: "featured",
        ingestionChannel: "api",
        externalId: String(featuredQuestionId),
        featuredQuestionId,
        opportunityText: "Featured demand",
        mediaOutlet: "Featured Outlet",
        orgId: TEST_ORG_A,
      })
      .returning();
    return row;
  }

  async function seedHaroSilver(externalId: string) {
    const [row] = await db
      .insert(providerQuoteRequests)
      .values({
        provider: "haro",
        ingestionChannel: "email",
        externalId,
        opportunityText: "HARO query about ergonomics",
        mediaOutlet: "Lifehacker",
        journalistName: "Jane Doe",
        pitchEmail: `reply+${externalId}@helpareporter.com`,
        orgId: SHARED_EMAIL_ORG_ID,
      })
      .returning();
    return row;
  }

  it("dispatches Featured opportunity via FeaturedClient.submitAnswer", async () => {
    const silver = await seedFeaturedSilver(5050);
    const pitchContent = "P".repeat(200);

    const res = await request(app())
      .post(`/orgs/opportunities/${silver.id}/reply`)
      .set(AUTH_HEADERS)
      .send({
        pitchContent,
        brandId: TEST_BRAND,
        campaignId: TEST_CAMPAIGN_A,
      });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("submitted");
    expect(res.body.deliveryMethod).toBe("featured_api");
    expect(state.submitted).toHaveLength(1);
    expect(state.submitted[0].featuredQuestionId).toBe(5050);
    expect(state.submitted[0].answer).toBe(pitchContent);

    const pitches = await db
      .select()
      .from(quotePitches)
      .where(eq(quotePitches.id, res.body.pitchId));
    expect(pitches[0].status).toBe("submitted");
    expect(pitches[0].deliveryMethod).toBe("featured_api");
  });

  it("dispatches HARO opportunity via email-gateway /orgs/send", async () => {
    const silver = await seedHaroSilver("uuid-haro-1");
    const pitchContent = "Pitching this expert. " + "P".repeat(120);

    const res = await request(app())
      .post(`/orgs/opportunities/${silver.id}/reply`)
      .set(AUTH_HEADERS)
      .send({
        pitchContent,
        brandId: TEST_BRAND,
        campaignId: TEST_CAMPAIGN_A,
      });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("submitted");
    expect(res.body.deliveryMethod).toBe("email_reply");
    expect(res.body.outboundMessageId).toBe("outbound-msg-123");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const fetchArgs = fetchMock.mock.calls[0];
    expect(String(fetchArgs[0])).toContain("/orgs/send");
    const sentBody = JSON.parse(fetchArgs[1].body as string);
    expect(sentBody.to).toBe("reply+uuid-haro-1@helpareporter.com");
    expect(sentBody.recipientFirstName).toBe("Jane");
    expect(sentBody.recipientLastName).toBe("Doe");
    expect(sentBody.recipientCompany).toBe("Lifehacker");
    expect(sentBody.textBody).toBe(pitchContent);

    const pitches = await db.select().from(quotePitches);
    expect(pitches).toHaveLength(1);
    expect(pitches[0].deliveryMethod).toBe("email_reply");
    expect(pitches[0].outboundMessageId).toBe("outbound-msg-123");
    expect(pitches[0].deliveryTarget).toBe(
      "reply+uuid-haro-1@helpareporter.com"
    );
  });

  it("returns 404 for opportunity not found", async () => {
    const res = await request(app())
      .post(`/orgs/opportunities/00000000-0000-0000-0000-00000000dead/reply`)
      .set(AUTH_HEADERS)
      .send({
        pitchContent: "x".repeat(200),
        brandId: TEST_BRAND,
        campaignId: TEST_CAMPAIGN_A,
      });
    expect(res.status).toBe(404);
  });

  it("is idempotent: second call with same campaign returns already_submitted", async () => {
    const silver = await seedHaroSilver("uuid-haro-2");
    const body = {
      pitchContent: "x".repeat(200),
      brandId: TEST_BRAND,
      campaignId: TEST_CAMPAIGN_A,
    };

    const first = await request(app())
      .post(`/orgs/opportunities/${silver.id}/reply`)
      .set(AUTH_HEADERS)
      .send(body);
    expect(first.body.status).toBe("submitted");

    const second = await request(app())
      .post(`/orgs/opportunities/${silver.id}/reply`)
      .set(AUTH_HEADERS)
      .send(body);
    expect(second.body.status).toBe("already_submitted");
    expect(second.body.pitchId).toBe(first.body.pitchId);

    const pitches = await db.select().from(quotePitches);
    expect(pitches).toHaveLength(1);
  });

  it("returns 402 and does NOT call Featured submitAnswer when billing is insufficient for a featured reply", async () => {
    const silver = await seedFeaturedSilver(7777);
    const { authorizeCredit } = await import("../../src/lib/billing-client.js");
    (authorizeCredit as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      sufficient: false,
      balance_cents: 0,
      required_cents: 5,
    });

    const res = await request(app())
      .post(`/orgs/opportunities/${silver.id}/reply`)
      .set(AUTH_HEADERS)
      .send({
        pitchContent: "x".repeat(200),
        brandId: TEST_BRAND,
        campaignId: TEST_CAMPAIGN_A,
      });

    expect(res.status).toBe(402);
    expect(res.body.error).toMatch(/insufficient credit/);
    expect(state.submitted).toHaveLength(0);
    const pitches = await db.select().from(quotePitches);
    expect(pitches).toHaveLength(0);
  });

  it("records featured-api-pitch-submit cost after a successful featured reply", async () => {
    const silver = await seedFeaturedSilver(8888);
    const { addCosts } = await import("../../src/lib/runs-client.js");
    const mocked = addCosts as unknown as ReturnType<typeof vi.fn>;
    mocked.mockClear();

    const res = await request(app())
      .post(`/orgs/opportunities/${silver.id}/reply`)
      .set(AUTH_HEADERS)
      .send({
        pitchContent: "x".repeat(200),
        brandId: TEST_BRAND,
        campaignId: TEST_CAMPAIGN_A,
      });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("submitted");
    expect(mocked).toHaveBeenCalledTimes(1);
    const [, items] = mocked.mock.calls[0];
    expect(items).toEqual([
      {
        costName: "featured-api-pitch-submit",
        costSource: "platform",
        quantity: 1,
        status: "actual",
      },
    ]);
  });

  it("skips billing-service authorize and records costSource='org' when keySource is 'org'", async () => {
    const silver = await seedFeaturedSilver(6060);
    const { getFeaturedCredentials } = await import(
      "../../src/lib/key-service-client.js"
    );
    (
      getFeaturedCredentials as unknown as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce({
      username: "org-u",
      password: "org-p",
      keySource: "org",
    });
    const { authorizeCredit } = await import("../../src/lib/billing-client.js");
    const authorized = authorizeCredit as unknown as ReturnType<typeof vi.fn>;
    authorized.mockClear();
    const { addCosts } = await import("../../src/lib/runs-client.js");
    const addCostsMock = addCosts as unknown as ReturnType<typeof vi.fn>;
    addCostsMock.mockClear();

    const res = await request(app())
      .post(`/orgs/opportunities/${silver.id}/reply`)
      .set(AUTH_HEADERS)
      .send({
        pitchContent: "x".repeat(200),
        brandId: TEST_BRAND,
        campaignId: TEST_CAMPAIGN_A,
      });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("submitted");
    expect(authorized).not.toHaveBeenCalled();
    expect(addCostsMock).toHaveBeenCalledTimes(1);
    const [, items] = addCostsMock.mock.calls[0];
    expect(items).toEqual([
      {
        costName: "featured-api-pitch-submit",
        costSource: "org",
        quantity: 1,
        status: "actual",
      },
    ]);
  });

  it("does NOT call billing-service on email-reply path (no Featured API spend)", async () => {
    const silver = await seedHaroSilver("uuid-haro-billing");
    const { authorizeCredit } = await import("../../src/lib/billing-client.js");
    const authorized = authorizeCredit as unknown as ReturnType<typeof vi.fn>;
    authorized.mockClear();

    const res = await request(app())
      .post(`/orgs/opportunities/${silver.id}/reply`)
      .set(AUTH_HEADERS)
      .send({
        pitchContent: "x".repeat(200),
        brandId: TEST_BRAND,
        campaignId: TEST_CAMPAIGN_A,
      });

    expect(res.status).toBe(200);
    expect(res.body.deliveryMethod).toBe("email_reply");
    expect(authorized).not.toHaveBeenCalled();
  });

  it("returns 502 + error pitch row when email-gateway fails", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: "internal" }),
        { status: 503, headers: { "content-type": "application/json" } }
      )
    );
    const silver = await seedHaroSilver("uuid-haro-3");
    const res = await request(app())
      .post(`/orgs/opportunities/${silver.id}/reply`)
      .set(AUTH_HEADERS)
      .send({
        pitchContent: "x".repeat(200),
        brandId: TEST_BRAND,
        campaignId: TEST_CAMPAIGN_A,
      });
    expect(res.status).toBe(502);
    expect(res.body.status).toBe("error");

    const pitches = await db.select().from(quotePitches);
    expect(pitches).toHaveLength(1);
    expect(pitches[0].status).toBe("error");
    expect(pitches[0].deliveryMethod).toBe("email_reply");
  });
});
