import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createEqrsClient } from "../../src/lib/eqrs-client.js";

const EQRS_URL = "http://eqrs.test";
const EQRS_KEY = "test-eqrs-key";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("createEqrsClient", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.EXPERT_QUOTES_REQUESTS_SERVICE_URL = EQRS_URL;
    process.env.EXPERT_QUOTES_REQUESTS_SERVICE_API_KEY = EQRS_KEY;
    fetchSpy = vi.fn();
  });

  afterEach(() => {
    delete process.env.EXPERT_QUOTES_REQUESTS_SERVICE_URL;
    delete process.env.EXPERT_QUOTES_REQUESTS_SERVICE_API_KEY;
  });

  describe("fetchOpportunities", () => {
    it("issues GET /orgs/featured/opportunities with x-api-key + identity headers", async () => {
      fetchSpy.mockResolvedValue(
        jsonResponse({ items: [], nextSince: null, refreshed: false })
      );
      const client = createEqrsClient({ fetchImpl: fetchSpy as unknown as typeof fetch });
      await client.fetchOpportunities({
        orgId: "org-1",
        userId: "user-7",
        runId: "run-9",
      });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(String(url)).toBe(`${EQRS_URL}/orgs/featured/opportunities`);
      expect(init.method).toBe("GET");
      const headers = init.headers as Record<string, string>;
      expect(headers["x-api-key"]).toBe(EQRS_KEY);
      expect(headers["x-org-id"]).toBe("org-1");
      expect(headers["x-user-id"]).toBe("user-7");
      expect(headers["x-run-id"]).toBe("run-9");
    });

    it("appends since + limit query params when provided", async () => {
      fetchSpy.mockResolvedValue(
        jsonResponse({ items: [], nextSince: null, refreshed: false })
      );
      const client = createEqrsClient({ fetchImpl: fetchSpy as unknown as typeof fetch });
      await client.fetchOpportunities({
        orgId: "org-1",
        since: "2026-05-28T09:00:00.000Z",
        limit: 25,
      });
      const [url] = fetchSpy.mock.calls[0] as [string];
      const parsed = new URL(String(url));
      expect(parsed.pathname).toBe("/orgs/featured/opportunities");
      expect(parsed.searchParams.get("since")).toBe(
        "2026-05-28T09:00:00.000Z"
      );
      expect(parsed.searchParams.get("limit")).toBe("25");
    });

    it("returns parsed body verbatim", async () => {
      fetchSpy.mockResolvedValue(
        jsonResponse({
          items: [
            {
              id: "uuid-1",
              externalId: "ext-1",
              featuredQuestionId: 42,
              opportunityText: "demand",
              mediaOutlet: "Outlet",
              source: "featured",
              pitchUrl: null,
              deadline: null,
              raw: { foo: "bar" },
              firstSeenAt: "2026-05-01T00:00:00.000Z",
              lastSeenAt: "2026-05-01T00:00:00.000Z",
            },
          ],
          nextSince: "2026-05-01T00:00:00.000Z",
          refreshed: true,
        })
      );
      const client = createEqrsClient({ fetchImpl: fetchSpy as unknown as typeof fetch });
      const res = await client.fetchOpportunities({ orgId: "org-1" });
      expect(res.items).toHaveLength(1);
      expect(res.items[0].featuredQuestionId).toBe(42);
      expect(res.nextSince).toBe("2026-05-01T00:00:00.000Z");
      expect(res.refreshed).toBe(true);
    });

    it("throws on non-2xx response (fail-loud)", async () => {
      fetchSpy.mockResolvedValue(new Response("upstream boom", { status: 502 }));
      const client = createEqrsClient({ fetchImpl: fetchSpy as unknown as typeof fetch });
      await expect(client.fetchOpportunities({ orgId: "org-1" })).rejects.toThrow(
        /EQRS GET \/orgs\/featured\/opportunities failed \(502\)/
      );
    });

    it("throws when EXPERT_QUOTES_REQUESTS_SERVICE_URL is unset", async () => {
      delete process.env.EXPERT_QUOTES_REQUESTS_SERVICE_URL;
      const client = createEqrsClient({ fetchImpl: fetchSpy as unknown as typeof fetch });
      await expect(client.fetchOpportunities({ orgId: "org-1" })).rejects.toThrow(
        /EXPERT_QUOTES_REQUESTS_SERVICE_URL is not set/
      );
    });

    it("throws when EXPERT_QUOTES_REQUESTS_SERVICE_API_KEY is unset", async () => {
      delete process.env.EXPERT_QUOTES_REQUESTS_SERVICE_API_KEY;
      const client = createEqrsClient({ fetchImpl: fetchSpy as unknown as typeof fetch });
      await expect(client.fetchOpportunities({ orgId: "org-1" })).rejects.toThrow(
        /EXPERT_QUOTES_REQUESTS_SERVICE_API_KEY is not set/
      );
    });
  });

  describe("submitAnswer", () => {
    it("issues POST /orgs/featured/answers with body", async () => {
      fetchSpy.mockResolvedValue(
        jsonResponse({
          status: "submitted",
          featuredQuestionId: 5050,
          featuredProfileId: 7,
        })
      );
      const client = createEqrsClient({ fetchImpl: fetchSpy as unknown as typeof fetch });
      const res = await client.submitAnswer({
        orgId: "org-1",
        userId: "user-7",
        brandId: "brand-1",
        featuredQuestionId: 5050,
        answer: "x".repeat(200),
      });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(String(url)).toBe(`${EQRS_URL}/orgs/featured/answers`);
      expect(init.method).toBe("POST");
      const headers = init.headers as Record<string, string>;
      expect(headers["x-api-key"]).toBe(EQRS_KEY);
      expect(headers["x-org-id"]).toBe("org-1");
      expect(headers["x-user-id"]).toBe("user-7");
      const body = JSON.parse(init.body as string);
      expect(body).toEqual({
        brandId: "brand-1",
        featuredQuestionId: 5050,
        answer: "x".repeat(200),
      });
      expect(res.status).toBe("submitted");
    });

    it("propagates rate_limited + retryAfter from EQRS", async () => {
      fetchSpy.mockResolvedValue(
        jsonResponse({ status: "rate_limited", retryAfter: 60 })
      );
      const client = createEqrsClient({ fetchImpl: fetchSpy as unknown as typeof fetch });
      const res = await client.submitAnswer({
        orgId: "org-1",
        brandId: "brand-1",
        featuredQuestionId: 5050,
        answer: "x".repeat(200),
      });
      expect(res).toEqual({ status: "rate_limited", retryAfter: 60 });
    });

    it("propagates error status from EQRS", async () => {
      fetchSpy.mockResolvedValue(
        jsonResponse({ status: "error", error: "featured submit failed" })
      );
      const client = createEqrsClient({ fetchImpl: fetchSpy as unknown as typeof fetch });
      const res = await client.submitAnswer({
        orgId: "org-1",
        brandId: "brand-1",
        featuredQuestionId: 5050,
        answer: "x".repeat(200),
      });
      expect(res).toEqual({ status: "error", error: "featured submit failed" });
    });

    it("throws on non-2xx response (fail-loud)", async () => {
      fetchSpy.mockResolvedValue(new Response("boom", { status: 500 }));
      const client = createEqrsClient({ fetchImpl: fetchSpy as unknown as typeof fetch });
      await expect(
        client.submitAnswer({
          orgId: "org-1",
          brandId: "brand-1",
          featuredQuestionId: 5050,
          answer: "x".repeat(200),
        })
      ).rejects.toThrow(/EQRS POST \/orgs\/featured\/answers failed \(500\)/);
    });
  });
});
