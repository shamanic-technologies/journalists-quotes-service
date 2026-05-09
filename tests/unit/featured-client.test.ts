import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  FeaturedClient,
  FeaturedRateLimitError,
  _resetFeaturedClientState,
} from "../../src/lib/featured-client.js";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("FeaturedClient", () => {
  beforeEach(() => {
    _resetFeaturedClientState();
  });

  it("login caches JWT for 24h", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ "x-access-token": "tok-1" }));
    const client = new FeaturedClient({
      credentials: { username: "u1", password: "p" },
      baseUrl: "http://featured.test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const t1 = await client.login();
    const t2 = await client.login();
    expect(t1).toBe("tok-1");
    expect(t2).toBe("tok-1");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("re-logs in on 401 from a request", async () => {
    let loginCalls = 0;
    let questionCalls = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/login")) {
        loginCalls++;
        return jsonResponse({ "x-access-token": `tok-${loginCalls}` });
      }
      questionCalls++;
      if (questionCalls === 1) {
        return new Response("expired", { status: 401 });
      }
      return jsonResponse([{ featuredQuestionId: 1, question: "q" }]);
    });

    const client = new FeaturedClient({
      credentials: { username: "u-401", password: "p" },
      baseUrl: "http://featured.test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await client.listPremiumQuestions();
    expect(result).toHaveLength(1);
    expect(loginCalls).toBe(2);
    expect(questionCalls).toBe(2);
  });

  it("listOpportunities returns array", async () => {
    const opportunities = [
      {
        opportunity: "Need expert quote",
        mediaOutlet: "Forbes",
        source: "featured",
        featuredQuestionId: 42,
      },
    ];
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/login"))
        return jsonResponse({ "x-access-token": "tok" });
      return jsonResponse(opportunities);
    });

    const client = new FeaturedClient({
      credentials: { username: "u-opps", password: "p" },
      baseUrl: "http://featured.test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await client.listOpportunities();
    expect(result).toEqual(opportunities);
  });

  it("submitAnswer succeeds and counts toward rate bucket", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/login"))
        return jsonResponse({ "x-access-token": "tok" });
      return jsonResponse({ message: "Success" });
    });
    const client = new FeaturedClient({
      credentials: { username: "u-submit", password: "p" },
      baseUrl: "http://featured.test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const answer = "x".repeat(120);
    const result = await client.submitAnswer({
      answer,
      featuredQuestionId: 1,
      profileId: 1,
    });
    expect(result.message).toBe("Success");
    expect(client.rateLimitState().remaining).toBe(99);
  });

  it("rate limiter throws on 101st submitAnswer in same hour", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/login"))
        return jsonResponse({ "x-access-token": "tok" });
      return jsonResponse({ message: "Success" });
    });
    const client = new FeaturedClient({
      credentials: { username: "u-rate", password: "p" },
      baseUrl: "http://featured.test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const answer = "y".repeat(120);
    for (let i = 0; i < 100; i++) {
      await client.submitAnswer({
        answer,
        featuredQuestionId: i,
        profileId: 1,
      });
    }
    await expect(
      client.submitAnswer({ answer, featuredQuestionId: 999, profileId: 1 })
    ).rejects.toBeInstanceOf(FeaturedRateLimitError);
  });

  it("submitAnswer rejects answers below 100 chars", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ "x-access-token": "tok" })
    );
    const client = new FeaturedClient({
      credentials: { username: "u-short", password: "p" },
      baseUrl: "http://featured.test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(
      client.submitAnswer({
        answer: "too short",
        featuredQuestionId: 1,
        profileId: 1,
      })
    ).rejects.toThrow(/100-2500/);
  });
});
