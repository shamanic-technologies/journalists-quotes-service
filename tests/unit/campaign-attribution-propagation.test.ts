import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { judgeRelevance } from "../../src/lib/judge-client.js";
import { createChildRun } from "../../src/lib/runs-client.js";

/**
 * Regression: the campaign attribution trio (x-campaign-id +
 * x-brand-id/brand_ids + x-feature-slug) must be forwarded on JQS's
 * cost-bearing downstream calls and on its own run creation so the
 * resulting runs_costs rows carry campaign_id.
 *
 * The platform daily-budget gate (campaign-service) paces a campaign's
 * spend by SUM(runs_costs) GROUP BY runs.campaign_id. JQS spends LLM
 * tokens on the judge call (via chat-service); without forwarding
 * x-campaign-id those costs land on campaign-NULL runs and the gate
 * never sees them → the campaign runs uncapped.
 *
 * Headers are OPTIONAL (absent outside the campaign flux). Each case
 * also asserts that when the field is omitted, no header is emitted.
 */

const CAMPAIGN = "22222222-2222-2222-2222-222222222222";
const BRAND_A = "33333333-3333-3333-3333-333333333333";
const BRAND_B = "44444444-4444-4444-4444-444444444444";
const FEATURE = "pr-expert-quote-opportunities";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function headersOf(call: unknown[]): Record<string, string> {
  const [, init] = call as [string, RequestInit];
  return init.headers as Record<string, string>;
}

describe("campaign attribution propagation to internal siblings", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    process.env.CHAT_SERVICE_URL = "http://chat.test";
    process.env.CHAT_SERVICE_API_KEY = "k";
    process.env.RUNS_SERVICE_URL = "http://runs.test";
    process.env.RUNS_SERVICE_API_KEY = "k";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.CHAT_SERVICE_URL;
    delete process.env.CHAT_SERVICE_API_KEY;
    delete process.env.RUNS_SERVICE_URL;
    delete process.env.RUNS_SERVICE_API_KEY;
  });

  it("judge-client (chat-service /complete) forwards campaign + brand-ids + feature so the judge LLM cost is attributed to the campaign", async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ json: { results: [] } }));
    await judgeRelevance({
      documents: [{ id: "a", text: "AI ethics" }],
      brandContext: "- Industry: AI",
      orgId: "org-1",
      userId: "u-1",
      runId: "r-1",
      campaignId: CAMPAIGN,
      brandIds: [BRAND_A, BRAND_B],
      featureSlug: FEATURE,
    });
    const headers = headersOf(fetchSpy.mock.calls[0]);
    expect(headers["x-campaign-id"]).toBe(CAMPAIGN);
    expect(headers["x-brand-id"]).toBe(`${BRAND_A},${BRAND_B}`);
    expect(headers["x-feature-slug"]).toBe(FEATURE);
  });

  it("judge-client omits campaign + brand + feature headers when absent", async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ json: { results: [] } }));
    await judgeRelevance({
      documents: [{ id: "a", text: "AI ethics" }],
      brandContext: "- Industry: AI",
      orgId: "org-1",
      userId: "u-1",
      runId: "r-1",
    });
    const headers = headersOf(fetchSpy.mock.calls[0]);
    expect(headers).not.toHaveProperty("x-campaign-id");
    expect(headers).not.toHaveProperty("x-brand-id");
    expect(headers).not.toHaveProperty("x-feature-slug");
  });

  it("judge-client omits x-brand-id when brandIds is empty", async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ json: { results: [] } }));
    await judgeRelevance({
      documents: [{ id: "a", text: "AI ethics" }],
      brandContext: "- Industry: AI",
      orgId: "org-1",
      userId: "u-1",
      runId: "r-1",
      campaignId: CAMPAIGN,
      brandIds: [],
    });
    const headers = headersOf(fetchSpy.mock.calls[0]);
    expect(headers["x-campaign-id"]).toBe(CAMPAIGN);
    expect(headers).not.toHaveProperty("x-brand-id");
  });

  it("runs-client createChildRun tags the run row with campaign + brand + feature", async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse({
        id: "run-1",
        parentRunId: null,
        serviceName: "journalists-quotes-service",
        taskName: "POST /x",
      })
    );
    await createChildRun(
      {
        parentRunId: "parent-1",
        serviceName: "journalists-quotes-service",
        taskName: "POST /x",
      },
      "org-1",
      "u-1",
      undefined,
      CAMPAIGN,
      BRAND_A,
      FEATURE
    );
    const headers = headersOf(fetchSpy.mock.calls[0]);
    expect(String(fetchSpy.mock.calls[0][0])).toBe("http://runs.test/v1/runs");
    expect(headers["x-campaign-id"]).toBe(CAMPAIGN);
    expect(headers["x-brand-id"]).toBe(BRAND_A);
    expect(headers["x-feature-slug"]).toBe(FEATURE);
  });

  it("runs-client createChildRun omits campaign + brand + feature when absent", async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse({
        id: "run-1",
        parentRunId: null,
        serviceName: "journalists-quotes-service",
        taskName: "POST /x",
      })
    );
    await createChildRun(
      {
        parentRunId: "parent-1",
        serviceName: "journalists-quotes-service",
        taskName: "POST /x",
      },
      "org-1",
      "u-1"
    );
    const headers = headersOf(fetchSpy.mock.calls[0]);
    expect(headers).not.toHaveProperty("x-campaign-id");
    expect(headers).not.toHaveProperty("x-brand-id");
    expect(headers).not.toHaveProperty("x-feature-slug");
  });
});
