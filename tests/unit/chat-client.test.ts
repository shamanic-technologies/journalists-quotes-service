import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ragScore } from "../../src/lib/chat-client.js";

const ORIG_URL = process.env.CHAT_SERVICE_URL;
const ORIG_KEY = process.env.CHAT_SERVICE_API_KEY;

describe("ragScore (multi-brand tuple)", () => {
  beforeEach(() => {
    process.env.CHAT_SERVICE_URL = "http://chat.test";
    process.env.CHAT_SERVICE_API_KEY = "k";
  });
  afterEach(() => {
    process.env.CHAT_SERVICE_URL = ORIG_URL;
    process.env.CHAT_SERVICE_API_KEY = ORIG_KEY;
    vi.restoreAllMocks();
  });

  it("issues a single HTTP call with the brandIds tuple — NOT a per-brand fan-out", async () => {
    const captured: unknown[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      captured.push(JSON.parse(init?.body as string));
      const body = JSON.parse(init?.body as string) as {
        documents: { id: string }[];
      };
      return new Response(
        JSON.stringify({
          results: body.documents.map((d) => ({
            id: d.id,
            score: 0.5,
            whyRelevant: "ok",
          })),
        }),
        { status: 200 }
      );
    });

    const res = await ragScore(
      {
        documents: [{ id: "doc-1", text: "hello" }],
        brandIds: [
          "11111111-1111-1111-1111-111111111111",
          "22222222-2222-2222-2222-222222222222",
        ],
      },
      "org-1"
    );
    expect(captured).toHaveLength(1);
    expect(captured[0]).toEqual({
      documents: [{ id: "doc-1", text: "hello" }],
      brandIds: [
        "11111111-1111-1111-1111-111111111111",
        "22222222-2222-2222-2222-222222222222",
      ],
    });
    expect(res.results).toHaveLength(1);
    expect(res.results[0].score).toBeCloseTo(0.5);
  });

  it("forwards chat-service results verbatim (no averaging, no mutation)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          results: [
            { id: "doc-1", score: 0.91, whyRelevant: "rationale-1" },
            { id: "doc-2", score: 0.42, whyRelevant: "rationale-2" },
          ],
        }),
        { status: 200 }
      )
    );

    const res = await ragScore(
      {
        documents: [
          { id: "doc-1", text: "t1" },
          { id: "doc-2", text: "t2" },
        ],
        brandIds: ["11111111-1111-1111-1111-111111111111"],
      },
      "org-1"
    );
    expect(res.results).toEqual([
      { id: "doc-1", score: 0.91, whyRelevant: "rationale-1" },
      { id: "doc-2", score: 0.42, whyRelevant: "rationale-2" },
    ]);
  });

  it("propagates orgId / userId / runId via identity headers", async () => {
    let capturedHeaders: Record<string, string> = {};
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      capturedHeaders = (init as RequestInit).headers as Record<string, string>;
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    });

    await ragScore(
      {
        documents: [{ id: "doc-1", text: "t" }],
        brandIds: ["11111111-1111-1111-1111-111111111111"],
      },
      "org-1",
      "user-7",
      "run-9"
    );
    expect(capturedHeaders["x-api-key"]).toBe("k");
    expect(capturedHeaders["x-org-id"]).toBe("org-1");
    expect(capturedHeaders["x-user-id"]).toBe("user-7");
    expect(capturedHeaders["x-run-id"]).toBe("run-9");
  });

  it("returns empty results without calling chat-service when documents is empty", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const out = await ragScore(
      {
        documents: [],
        brandIds: ["11111111-1111-1111-1111-111111111111"],
      },
      "org-1"
    );
    expect(out.results).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("throws on non-ok response (fail-loud, no fallback)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("bad", { status: 500 })
    );
    await expect(
      ragScore(
        {
          documents: [{ id: "1", text: "hello" }],
          brandIds: ["11111111-1111-1111-1111-111111111111"],
        },
        "org-1"
      )
    ).rejects.toThrow(/failed \(500\)/);
  });

  it("throws when CHAT_SERVICE_URL is unset (fail-loud)", async () => {
    delete process.env.CHAT_SERVICE_URL;
    await expect(
      ragScore(
        {
          documents: [{ id: "1", text: "hello" }],
          brandIds: ["11111111-1111-1111-1111-111111111111"],
        },
        "org-1"
      )
    ).rejects.toThrow(/CHAT_SERVICE_URL is not set/);
  });

  it("throws when CHAT_SERVICE_API_KEY is unset (fail-loud)", async () => {
    delete process.env.CHAT_SERVICE_API_KEY;
    await expect(
      ragScore(
        {
          documents: [{ id: "1", text: "hello" }],
          brandIds: ["11111111-1111-1111-1111-111111111111"],
        },
        "org-1"
      )
    ).rejects.toThrow(/CHAT_SERVICE_API_KEY is not set/);
  });

  it("throws when brandIds is empty (fail-loud)", async () => {
    await expect(
      ragScore(
        {
          documents: [{ id: "1", text: "hello" }],
          brandIds: [],
        },
        "org-1"
      )
    ).rejects.toThrow(/brandIds must be non-empty/);
  });
});
