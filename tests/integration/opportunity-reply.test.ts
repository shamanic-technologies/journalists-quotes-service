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
} from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import {
  buildMockEqrsClient,
  createMockEqrsState,
  type MockEqrsState,
} from "../helpers/mock-eqrs.js";
import { EqrsServiceError } from "../../src/lib/eqrs-client.js";
import { SHARED_EMAIL_ORG_ID } from "../../src/lib/inbound/process.js";

// runs-client mock kept ONLY to assert JQS never declares the featured cost.
// addCosts has no caller in /reply anymore (EQRS owns the declaration); the
// mock is a regression lock — if a featured-submit cost re-appears, it fires.
vi.mock("../../src/lib/runs-client.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../src/lib/runs-client.js")
  >("../../src/lib/runs-client.js");
  return {
    ...actual,
    addCosts: vi.fn(async () => undefined),
  };
});

type FetchMock = ReturnType<typeof vi.fn>;
let fetchMock: FetchMock;
let state: MockEqrsState;

async function seedFeaturedCluster(featuredQuestionId: number) {
  const fingerprint = `fp-featured-${featuredQuestionId}`;
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
      externalId: String(featuredQuestionId),
      featuredQuestionId,
      opportunityText: "Featured demand",
      mediaOutlet: "Featured Outlet",
      orgId: TEST_ORG_A,
      quoteOpportunityId: opp.id,
      fingerprint,
      isCanonical: true,
    })
    .returning();
  return { opp, silver };
}

async function seedHaroCluster(externalId: string) {
  const fingerprint = `fp-haro-${externalId}`;
  const [opp] = await db
    .insert(quoteOpportunities)
    .values({
      fingerprint,
      canonicalText: "HARO query about ergonomics",
      canonicalOutlet: "Lifehacker",
    })
    .returning();
  const [silver] = await db
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
      quoteOpportunityId: opp.id,
      fingerprint,
      isCanonical: true,
    })
    .returning();
  return { opp, silver };
}

describe("POST /orgs/opportunities/:id/reply", () => {
  beforeAll(async () => {
    await cleanTestData();
  });
  beforeEach(async () => {
    await cleanTestData();
    state = createMockEqrsState();
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
        eqrsClient: buildMockEqrsClient(state),
      },
    });
  }

  it("dispatches Featured opportunity via EQRS POST /orgs/featured/answers (id = Gold cluster id)", async () => {
    const { opp } = await seedFeaturedCluster(5050);
    const pitchContent = "P".repeat(200);

    const res = await request(app())
      .post(`/orgs/opportunities/${opp.id}/reply`)
      .set(AUTH_HEADERS)
      .send({ pitchContent, campaignId: TEST_CAMPAIGN_A });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("submitted");
    expect(res.body.deliveryMethod).toBe("featured_api");
    expect(state.submitCalls).toHaveLength(1);
    expect(state.submitCalls[0].featuredQuestionId).toBe(5050);
    expect(state.submitCalls[0].answer).toBe(pitchContent);
    expect(state.submitCalls[0].brandId).toBe(TEST_BRAND);
    expect(state.submitCalls[0].orgId).toBe(TEST_ORG_A);

    const pitches = await db
      .select()
      .from(quotePitches)
      .where(eq(quotePitches.id, res.body.pitchId));
    expect(pitches[0].status).toBe("submitted");
    expect(pitches[0].deliveryMethod).toBe("featured_api");
    expect(pitches[0].brandIds).toEqual([TEST_BRAND]);
    expect(pitches[0].quoteOpportunityId).toBe(opp.id);
  });

  it("returns 422 not_submittable for a discovery opportunity (featured, null featured_question_id, no email)", async () => {
    const fingerprint = "fp-discovery-reply";
    const [opp] = await db
      .insert(quoteOpportunities)
      .values({
        fingerprint,
        canonicalText: "Discovery lead",
        canonicalOutlet: "Qwoted",
      })
      .returning();
    await db.insert(providerQuoteRequests).values({
      provider: "featured",
      ingestionChannel: "api",
      externalId: "https://app.qwoted.com/opportunities/9",
      featuredQuestionId: null,
      pitchEmail: null,
      pitchUrl: "https://app.qwoted.com/opportunities/9",
      opportunityText: "Discovery lead",
      mediaOutlet: "Qwoted",
      orgId: TEST_ORG_A,
      quoteOpportunityId: opp.id,
      fingerprint,
      isCanonical: true,
    });

    const res = await request(app())
      .post(`/orgs/opportunities/${opp.id}/reply`)
      .set(AUTH_HEADERS)
      .send({ pitchContent: "x".repeat(200), campaignId: TEST_CAMPAIGN_A });

    expect(res.status).toBe(422);
    expect(res.body.status).toBe("not_submittable");
    expect(res.body.deliveryMethod).toBe("external_manual");
    expect(res.body.pitchUrl).toBe(
      "https://app.qwoted.com/opportunities/9"
    );
    // No submit, no pitch row written.
    expect(state.submitCalls).toHaveLength(0);
    const pitches = await db.select().from(quotePitches);
    expect(pitches).toHaveLength(0);
  });

  it("dispatches HARO opportunity via email-gateway /orgs/send (id = Gold cluster id)", async () => {
    const { opp } = await seedHaroCluster("uuid-haro-1");
    const pitchContent = "Pitching this expert. " + "P".repeat(120);

    const res = await request(app())
      .post(`/orgs/opportunities/${opp.id}/reply`)
      .set(AUTH_HEADERS)
      .send({ pitchContent, campaignId: TEST_CAMPAIGN_A });

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
    expect(pitches[0].brandIds).toEqual([TEST_BRAND]);
  });

  it("picks Featured silver representative when cluster has both Featured + email silvers", async () => {
    const { opp } = await seedHaroCluster("uuid-mixed");
    await db.insert(providerQuoteRequests).values({
      provider: "featured",
      ingestionChannel: "api",
      externalId: "mixed-9999",
      featuredQuestionId: 9999,
      opportunityText: "HARO query about ergonomics",
      mediaOutlet: "Lifehacker",
      orgId: TEST_ORG_A,
      quoteOpportunityId: opp.id,
      fingerprint: "fp-haro-uuid-mixed",
    });

    const res = await request(app())
      .post(`/orgs/opportunities/${opp.id}/reply`)
      .set(AUTH_HEADERS)
      .send({ pitchContent: "x".repeat(200), campaignId: TEST_CAMPAIGN_A });

    expect(res.status).toBe(200);
    expect(res.body.deliveryMethod).toBe("featured_api");
    expect(state.submitCalls[0].featuredQuestionId).toBe(9999);
  });

  it("picks most recently fetched email silver when cluster has only email silvers", async () => {
    const fingerprint = "fp-haro-multi-email";
    const [opp] = await db
      .insert(quoteOpportunities)
      .values({ fingerprint, canonicalText: "x" })
      .returning();
    await db.insert(providerQuoteRequests).values({
      provider: "haro",
      ingestionChannel: "email",
      externalId: "older-haro",
      opportunityText: "x",
      mediaOutlet: "Older Outlet",
      journalistName: "Old Reporter",
      pitchEmail: "reply+older@helpareporter.com",
      orgId: SHARED_EMAIL_ORG_ID,
      quoteOpportunityId: opp.id,
      fingerprint,
      fetchedAt: new Date("2026-01-01"),
    });
    await db.insert(providerQuoteRequests).values({
      provider: "haro",
      ingestionChannel: "email",
      externalId: "newer-haro",
      opportunityText: "x",
      mediaOutlet: "Newer Outlet",
      journalistName: "New Reporter",
      pitchEmail: "reply+newer@helpareporter.com",
      orgId: SHARED_EMAIL_ORG_ID,
      quoteOpportunityId: opp.id,
      fingerprint,
      fetchedAt: new Date("2026-01-05"),
    });

    const res = await request(app())
      .post(`/orgs/opportunities/${opp.id}/reply`)
      .set(AUTH_HEADERS)
      .send({ pitchContent: "x".repeat(200), campaignId: TEST_CAMPAIGN_A });

    expect(res.status).toBe(200);
    expect(res.body.deliveryMethod).toBe("email_reply");
    const sentBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(sentBody.to).toBe("reply+newer@helpareporter.com");
  });

  it("returns 404 for opportunity not found", async () => {
    const res = await request(app())
      .post(`/orgs/opportunities/00000000-0000-0000-0000-00000000dead/reply`)
      .set(AUTH_HEADERS)
      .send({ pitchContent: "x".repeat(200), campaignId: TEST_CAMPAIGN_A });
    expect(res.status).toBe(404);
  });

  it("idempotent: second call with same (opp, brand-set, campaign) returns already_submitted", async () => {
    const { opp } = await seedHaroCluster("uuid-haro-2");
    const body = {
      pitchContent: "x".repeat(200),
      campaignId: TEST_CAMPAIGN_A,
    };

    const first = await request(app())
      .post(`/orgs/opportunities/${opp.id}/reply`)
      .set(AUTH_HEADERS)
      .send(body);
    expect(first.body.status).toBe("submitted");

    const second = await request(app())
      .post(`/orgs/opportunities/${opp.id}/reply`)
      .set(AUTH_HEADERS)
      .send(body);
    expect(second.body.status).toBe("already_submitted");
    expect(second.body.pitchId).toBe(first.body.pitchId);

    const pitches = await db.select().from(quotePitches);
    expect(pitches).toHaveLength(1);
  });

  it("co-brand pitch [A,B] is distinct from solo pitch [A] for idempotency", async () => {
    const { opp } = await seedHaroCluster("uuid-co-brand");

    const solo = await request(app())
      .post(`/orgs/opportunities/${opp.id}/reply`)
      .set(AUTH_HEADERS)
      .send({ pitchContent: "S".repeat(200), campaignId: TEST_CAMPAIGN_A });
    expect(solo.body.status).toBe("submitted");

    const headers = { ...AUTH_HEADERS } as Record<string, string>;
    headers["x-brand-id"] = `${TEST_BRAND},${TEST_BRAND_B}`;
    const coBrand = await request(app())
      .post(`/orgs/opportunities/${opp.id}/reply`)
      .set(headers)
      .send({ pitchContent: "C".repeat(200), campaignId: TEST_CAMPAIGN_A });
    expect(coBrand.body.status).toBe("submitted");
    expect(coBrand.body.pitchId).not.toBe(solo.body.pitchId);

    const pitches = await db.select().from(quotePitches);
    expect(pitches).toHaveLength(2);
    const sortedSets = pitches
      .map((p) => p.brandIds.slice().sort())
      .map((s) => JSON.stringify(s));
    expect(sortedSets).toContain(JSON.stringify([TEST_BRAND]));
    expect(sortedSets).toContain(
      JSON.stringify([TEST_BRAND, TEST_BRAND_B].sort())
    );
  });

  it("persists brand_ids canonical-sorted regardless of header input order", async () => {
    const { opp } = await seedHaroCluster("uuid-sort");
    const headers = { ...AUTH_HEADERS } as Record<string, string>;
    headers["x-brand-id"] = `${TEST_BRAND_B},${TEST_BRAND}`;

    const res = await request(app())
      .post(`/orgs/opportunities/${opp.id}/reply`)
      .set(headers)
      .send({ pitchContent: "x".repeat(200), campaignId: TEST_CAMPAIGN_A });
    expect(res.body.status).toBe("submitted");

    const pitch = (
      await db
        .select()
        .from(quotePitches)
        .where(eq(quotePitches.id, res.body.pitchId))
    )[0];
    expect(pitch.brandIds).toEqual([TEST_BRAND, TEST_BRAND_B].sort());
  });

  it("surfaces 402 from EQRS when credit is insufficient (no local gate, no pitch row)", async () => {
    // EQRS owns the credit gate now: it 402s on insufficient credit. JQS
    // surfaces that status verbatim — it does NOT gate locally. EQRS IS
    // called (the 402 comes from it), and no pitch row is written.
    const { opp } = await seedFeaturedCluster(7777);
    state.submitImpl = async () => {
      throw new EqrsServiceError(
        "EQRS POST /orgs/featured/answers failed (402): insufficient credit for featured pitch submit",
        402
      );
    };

    const res = await request(app())
      .post(`/orgs/opportunities/${opp.id}/reply`)
      .set(AUTH_HEADERS)
      .send({ pitchContent: "x".repeat(200), campaignId: TEST_CAMPAIGN_A });

    expect(res.status).toBe(402);
    expect(res.body.error).toMatch(/insufficient credit/);
    expect(state.submitCalls).toHaveLength(1);
    const pitches = await db.select().from(quotePitches);
    expect(pitches).toHaveLength(0);
  });

  it("does NOT declare the featured-api-pitch-submit cost (EQRS owns it — no double-charge)", async () => {
    const { opp } = await seedFeaturedCluster(8888);
    const { addCosts } = await import("../../src/lib/runs-client.js");
    const mocked = addCosts as unknown as ReturnType<typeof vi.fn>;
    mocked.mockClear();

    const res = await request(app())
      .post(`/orgs/opportunities/${opp.id}/reply`)
      .set(AUTH_HEADERS)
      .send({ pitchContent: "x".repeat(200), campaignId: TEST_CAMPAIGN_A });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("submitted");
    // Regression lock: JQS must never declare a featured-submit cost.
    const declaredFeaturedCost = mocked.mock.calls.some(([, items]) =>
      (items as Array<{ costName: string }>).some(
        (i) => i.costName === "featured-api-pitch-submit"
      )
    );
    expect(declaredFeaturedCost).toBe(false);
  });

  it("brand-only body (no campaignId) submits + persists pitch with campaign_id NULL", async () => {
    const { opp } = await seedFeaturedCluster(5151);
    const pitchContent = "B".repeat(220);

    const res = await request(app())
      .post(`/orgs/opportunities/${opp.id}/reply`)
      .set(AUTH_HEADERS)
      .send({ pitchContent });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("submitted");
    expect(res.body.deliveryMethod).toBe("featured_api");

    const pitches = await db
      .select()
      .from(quotePitches)
      .where(eq(quotePitches.id, res.body.pitchId));
    expect(pitches[0].campaignId).toBeNull();
    expect(pitches[0].brandIds).toEqual([TEST_BRAND]);
  });

  it("retryable status (error) does NOT block a new pitch on same brand-set", async () => {
    const { opp } = await seedHaroCluster("uuid-haro-retryable");

    await db.insert(quotePitches).values({
      quoteRequestId: (
        await db
          .select()
          .from(providerQuoteRequests)
          .where(eq(providerQuoteRequests.externalId, "uuid-haro-retryable"))
      )[0].id,
      quoteOpportunityId: opp.id,
      campaignId: TEST_CAMPAIGN_A,
      brandIds: [TEST_BRAND],
      status: "error",
      deliveryMethod: "email_reply",
      orgId: TEST_ORG_A,
    });

    const res = await request(app())
      .post(`/orgs/opportunities/${opp.id}/reply`)
      .set(AUTH_HEADERS)
      .send({ pitchContent: "z".repeat(200), campaignId: TEST_CAMPAIGN_A });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("submitted");
  });

  it("returns 502 + error pitch row when email-gateway fails", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "internal" }), {
        status: 503,
        headers: { "content-type": "application/json" },
      })
    );
    const { opp } = await seedHaroCluster("uuid-haro-3");
    const res = await request(app())
      .post(`/orgs/opportunities/${opp.id}/reply`)
      .set(AUTH_HEADERS)
      .send({ pitchContent: "x".repeat(200), campaignId: TEST_CAMPAIGN_A });
    expect(res.status).toBe(502);
    expect(res.body.status).toBe("error");

    const pitches = await db.select().from(quotePitches);
    expect(pitches).toHaveLength(1);
    expect(pitches[0].status).toBe("error");
    expect(pitches[0].deliveryMethod).toBe("email_reply");
  });

  it("rejects when x-brand-id header is missing", async () => {
    const { opp } = await seedHaroCluster("uuid-no-brand");
    const headers = { ...AUTH_HEADERS } as Record<string, string>;
    delete headers["x-brand-id"];
    const res = await request(app())
      .post(`/orgs/opportunities/${opp.id}/reply`)
      .set(headers)
      .send({ pitchContent: "x".repeat(200), campaignId: TEST_CAMPAIGN_A });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/x-brand-id/);
  });

  it("surfaces EQRS rate_limited status", async () => {
    const { opp } = await seedFeaturedCluster(9090);
    state.submitImpl = async () => ({
      status: "rate_limited",
      retryAfter: 60,
    });

    const res = await request(app())
      .post(`/orgs/opportunities/${opp.id}/reply`)
      .set(AUTH_HEADERS)
      .send({ pitchContent: "x".repeat(200), campaignId: TEST_CAMPAIGN_A });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("rate_limited");
    expect(res.body.retryAfter).toBe(60);
    const pitches = await db.select().from(quotePitches);
    expect(pitches).toHaveLength(0);
  });

  it("persists EQRS error status + returns error", async () => {
    const { opp } = await seedFeaturedCluster(9191);
    state.submitImpl = async () => ({
      status: "error",
      error: "featured submit failed downstream",
    });

    const res = await request(app())
      .post(`/orgs/opportunities/${opp.id}/reply`)
      .set(AUTH_HEADERS)
      .send({ pitchContent: "x".repeat(200), campaignId: TEST_CAMPAIGN_A });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("error");
    expect(res.body.error).toMatch(/featured submit failed/);
    const pitches = await db.select().from(quotePitches);
    expect(pitches).toHaveLength(1);
    expect(pitches[0].status).toBe("error");
  });

  it("marks a dead Featured question (404 Question not found) as terminal question_not_found + returns 410", async () => {
    // EQRS surfaces a permanently-dead question as a 200 error result whose
    // message is "...(404): Question not found". JQS must record it with the
    // terminal, BLOCKING status question_not_found so /next never re-serves
    // it — stopping the infinite 404 re-fail loop (prod question 83147).
    const { opp } = await seedFeaturedCluster(83147);
    state.submitImpl = async () => ({
      status: "error",
      error:
        "Featured POST /answer-question failed (404): Question not found",
    });

    const res = await request(app())
      .post(`/orgs/opportunities/${opp.id}/reply`)
      .set(AUTH_HEADERS)
      .send({ pitchContent: "x".repeat(200), campaignId: TEST_CAMPAIGN_A });

    expect(res.status).toBe(410);
    expect(res.body.status).toBe("question_not_found");
    expect(state.submitCalls).toHaveLength(1);

    const pitches = await db.select().from(quotePitches);
    expect(pitches).toHaveLength(1);
    expect(pitches[0].status).toBe("question_not_found");
    expect(pitches[0].deliveryMethod).toBe("featured_api");
    expect(pitches[0].brandIds).toEqual([TEST_BRAND]);
  });

  it("dead question via EqrsServiceError 404 throw is also marked question_not_found + 410", async () => {
    const { opp } = await seedFeaturedCluster(83148);
    state.submitImpl = async () => {
      throw new EqrsServiceError(
        "EQRS POST /orgs/featured/answers failed (404): Question not found",
        404
      );
    };

    const res = await request(app())
      .post(`/orgs/opportunities/${opp.id}/reply`)
      .set(AUTH_HEADERS)
      .send({ pitchContent: "x".repeat(200), campaignId: TEST_CAMPAIGN_A });

    expect(res.status).toBe(410);
    expect(res.body.status).toBe("question_not_found");
    const pitches = await db.select().from(quotePitches);
    expect(pitches).toHaveLength(1);
    expect(pitches[0].status).toBe("question_not_found");
  });

  it("a second reply to a dead question short-circuits (410) WITHOUT re-submitting to Featured", async () => {
    const { opp } = await seedFeaturedCluster(83149);
    state.submitImpl = async () => ({
      status: "error",
      error:
        "Featured POST /answer-question failed (404): Question not found",
    });
    const body = { pitchContent: "x".repeat(200), campaignId: TEST_CAMPAIGN_A };

    const first = await request(app())
      .post(`/orgs/opportunities/${opp.id}/reply`)
      .set(AUTH_HEADERS)
      .send(body);
    expect(first.status).toBe(410);
    expect(first.body.status).toBe("question_not_found");
    expect(state.submitCalls).toHaveLength(1);

    const second = await request(app())
      .post(`/orgs/opportunities/${opp.id}/reply`)
      .set(AUTH_HEADERS)
      .send(body);
    expect(second.status).toBe(410);
    expect(second.body.status).toBe("question_not_found");
    // No second Featured submit — the dead row short-circuits the idempotency
    // check, and only ONE dead pitch row exists (no unique-index crash).
    expect(state.submitCalls).toHaveLength(1);
    const pitches = await db.select().from(quotePitches);
    expect(pitches).toHaveLength(1);
  });
});
