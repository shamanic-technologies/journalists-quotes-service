import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { judgeRelevance } from "../../src/lib/judge-client.js";

const CS_URL = "http://chat.test";
const CS_KEY = "k";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("judgeRelevance", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.CHAT_SERVICE_URL = CS_URL;
    process.env.CHAT_SERVICE_API_KEY = CS_KEY;
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.CHAT_SERVICE_URL;
    delete process.env.CHAT_SERVICE_API_KEY;
  });

  it("calls chat-service /complete with google/flash + responseSchema and parses json.results", async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse({
        json: {
          results: [
            { id: "a", score: 85, reasoning: "direct fit" },
            { id: "b", score: 15, reasoning: "off topic" },
          ],
        },
        content: "...",
        tokensInput: 100,
        tokensOutput: 50,
        model: "gemini-x",
      })
    );
    const out = await judgeRelevance({
      documents: [
        { id: "a", text: "AI ethics" },
        { id: "b", text: "cat memes" },
      ],
      brandContext: "- Industry: AI",
      orgId: "org-1",
      userId: "u-1",
      runId: "r-1",
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe(`${CS_URL}/complete`);
    const body = JSON.parse(init.body as string);
    expect(body.provider).toBe("google");
    expect(body.model).toBe("flash");
    expect(body.temperature).toBe(0.2);
    expect(body.responseFormat).toBe("json");
    expect(body.responseSchema).toBeDefined();
    expect(body.responseSchema.properties.results).toBeDefined();
    expect(body.systemPrompt).toContain("- Industry: AI");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe(CS_KEY);
    expect(headers["x-org-id"]).toBe("org-1");
    expect(headers["x-user-id"]).toBe("u-1");
    expect(headers["x-run-id"]).toBe("r-1");

    expect(out.results).toEqual([
      { id: "a", score: 85, reasoning: "direct fit" },
      { id: "b", score: 15, reasoning: "off topic" },
    ]);
  });

  it("returns empty without calling chat-service when no documents", async () => {
    const out = await judgeRelevance({
      documents: [],
      brandContext: "x",
      orgId: "org-1",
    });
    expect(out.results).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("throws on non-2xx (fail-loud)", async () => {
    fetchSpy.mockResolvedValue(new Response("boom", { status: 502 }));
    await expect(
      judgeRelevance({
        documents: [{ id: "a", text: "t" }],
        brandContext: "x",
        orgId: "org-1",
      })
    ).rejects.toThrow(/chat-service POST \/complete \(judge\) failed \(502\)/);
  });

  it("throws when response has no parsable results array (fail-loud)", async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ content: "no json field" }));
    await expect(
      judgeRelevance({
        documents: [{ id: "a", text: "t" }],
        brandContext: "x",
        orgId: "org-1",
      })
    ).rejects.toThrow(/no parsable results array/);
  });

  it("throws when CHAT_SERVICE_URL unset", async () => {
    delete process.env.CHAT_SERVICE_URL;
    await expect(
      judgeRelevance({
        documents: [{ id: "a", text: "t" }],
        brandContext: "x",
        orgId: "org-1",
      })
    ).rejects.toThrow(/CHAT_SERVICE_URL is not set/);
  });
});
