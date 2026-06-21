import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { judgeRelevance } from "../../src/lib/judge-client.js";
import { extractBrandContext } from "../../src/lib/brand-client.js";
import { createChildRun, addCosts } from "../../src/lib/runs-client.js";
import { createEqrsClient } from "../../src/lib/eqrs-client.js";

/**
 * Regression: x-audience-id (campaign audience attribution) must be
 * forwarded on every JQS → internal-sibling egress so per-audience cost
 * attribution works (runs-service aggregates SUM(cost) GROUP BY
 * COALESCE(runs_costs.audience_id, runs.audience_id) — flat, no rollup,
 * so each run/cost row must carry the audience itself).
 *
 * The header is OPTIONAL: absent outside the campaign flux. Each case
 * also asserts that when audienceId is omitted, no x-audience-id header
 * is emitted (never a throw, never an empty/garbage value).
 */

const AUD = "11111111-1111-1111-1111-111111111111";

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

describe("x-audience-id propagation to internal siblings", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    process.env.CHAT_SERVICE_URL = "http://chat.test";
    process.env.CHAT_SERVICE_API_KEY = "k";
    process.env.BRAND_SERVICE_URL = "http://brand.test";
    process.env.BRAND_SERVICE_API_KEY = "k";
    process.env.RUNS_SERVICE_URL = "http://runs.test";
    process.env.RUNS_SERVICE_API_KEY = "k";
    process.env.EXPERT_QUOTES_REQUESTS_SERVICE_URL = "http://eqrs.test";
    process.env.EXPERT_QUOTES_REQUESTS_SERVICE_API_KEY = "k";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.CHAT_SERVICE_URL;
    delete process.env.CHAT_SERVICE_API_KEY;
    delete process.env.BRAND_SERVICE_URL;
    delete process.env.BRAND_SERVICE_API_KEY;
    delete process.env.RUNS_SERVICE_URL;
    delete process.env.RUNS_SERVICE_API_KEY;
    delete process.env.EXPERT_QUOTES_REQUESTS_SERVICE_URL;
    delete process.env.EXPERT_QUOTES_REQUESTS_SERVICE_API_KEY;
  });

  it("judge-client (chat-service /complete) forwards x-audience-id — the biggest spend on the press-pitch path", async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ json: { results: [] } }));
    await judgeRelevance({
      documents: [{ id: "a", text: "AI ethics" }],
      brandContext: "- Industry: AI",
      orgId: "org-1",
      userId: "u-1",
      runId: "r-1",
      audienceId: AUD,
    });
    expect(headersOf(fetchSpy.mock.calls[0])["x-audience-id"]).toBe(AUD);
  });

  it("judge-client omits x-audience-id when audienceId is absent", async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ json: { results: [] } }));
    await judgeRelevance({
      documents: [{ id: "a", text: "AI ethics" }],
      brandContext: "- Industry: AI",
      orgId: "org-1",
      userId: "u-1",
      runId: "r-1",
    });
    expect(headersOf(fetchSpy.mock.calls[0])).not.toHaveProperty(
      "x-audience-id"
    );
  });

  it("brand-client (extract-fields) forwards x-audience-id", async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ fields: {} }));
    await extractBrandContext(["b-1"], "org-1", "u-1", "r-1", AUD);
    expect(headersOf(fetchSpy.mock.calls[0])["x-audience-id"]).toBe(AUD);
  });

  it("runs-client createChildRun tags the run row with x-audience-id", async () => {
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
      AUD
    );
    expect(String(fetchSpy.mock.calls[0][0])).toBe("http://runs.test/v1/runs");
    expect(headersOf(fetchSpy.mock.calls[0])["x-audience-id"]).toBe(AUD);
  });

  it("runs-client createChildRun omits x-audience-id when absent", async () => {
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
    expect(headersOf(fetchSpy.mock.calls[0])).not.toHaveProperty(
      "x-audience-id"
    );
  });

  it("runs-client addCosts tags the cost declaration with x-audience-id", async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ costs: [] }));
    await addCosts(
      "run-1",
      [{ costName: "x", costSource: "platform", quantity: 1, status: "actual" }],
      { orgId: "org-1", audienceId: AUD }
    );
    expect(headersOf(fetchSpy.mock.calls[0])["x-audience-id"]).toBe(AUD);
  });

  it("eqrs-client submitAnswer forwards x-audience-id (EQRS tags the featured-submit cost)", async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse({ status: "submitted", featuredQuestionId: 5 })
    );
    const client = createEqrsClient({
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    await client.submitAnswer({
      orgId: "org-1",
      userId: "u-1",
      runId: "r-1",
      audienceId: AUD,
      brandId: "b-1",
      featuredQuestionId: 5,
      answer: "answer",
    });
    expect(headersOf(fetchSpy.mock.calls[0])["x-audience-id"]).toBe(AUD);
  });

  it("eqrs-client fetchPremiumQuestions forwards x-audience-id", async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ questions: [] }));
    const client = createEqrsClient({
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    await client.fetchPremiumQuestions({
      orgId: "org-1",
      userId: "u-1",
      runId: "r-1",
      audienceId: AUD,
    });
    expect(headersOf(fetchSpy.mock.calls[0])["x-audience-id"]).toBe(AUD);
  });
});
