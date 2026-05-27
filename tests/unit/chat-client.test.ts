import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ragScore } from "../../src/lib/chat-client.js";

const ORIG_URL = process.env.CHAT_SERVICE_URL;
const ORIG_KEY = process.env.CHAT_SERVICE_API_KEY;

describe("ragScore", () => {
  beforeEach(() => {
    process.env.CHAT_SERVICE_URL = "http://chat.test";
    process.env.CHAT_SERVICE_API_KEY = "k";
  });
  afterEach(() => {
    process.env.CHAT_SERVICE_URL = ORIG_URL;
    process.env.CHAT_SERVICE_API_KEY = ORIG_KEY;
    vi.restoreAllMocks();
  });

  it("sends one HTTP call per brandId with the documents batch", async () => {
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
    expect(captured).toHaveLength(2);
    expect(captured[0]).toEqual({
      documents: [{ id: "doc-1", text: "hello" }],
      brandId: "11111111-1111-1111-1111-111111111111",
    });
    expect(captured[1]).toEqual({
      documents: [{ id: "doc-1", text: "hello" }],
      brandId: "22222222-2222-2222-2222-222222222222",
    });
    expect(res.results).toHaveLength(1);
    expect(res.results[0].score).toBeCloseTo(0.5);
  });

  it("aggregates per-document scores across brands via arithmetic mean", async () => {
    let call = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      call += 1;
      const body = JSON.parse(init?.body as string) as {
        documents: { id: string }[];
      };
      const score = call === 1 ? 0.8 : 0.4;
      return new Response(
        JSON.stringify({
          results: body.documents.map((d) => ({ id: d.id, score })),
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
    expect(res.results).toHaveLength(1);
    expect(res.results[0].score).toBeCloseTo(0.6);
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

  it("throws when brandIds is empty", async () => {
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
