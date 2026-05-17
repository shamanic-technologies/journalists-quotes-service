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

  it("omits campaignId from outbound body (chat-service rejects unknown keys)", async () => {
    let captured: unknown;
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (_url, init) => {
        captured = JSON.parse(init?.body as string);
        return new Response(JSON.stringify({ results: [] }), { status: 200 });
      });

    await ragScore(
      {
        documents: [{ id: "1", text: "hello" }],
        brandId: "11111111-1111-1111-1111-111111111111",
        campaignId: "22222222-2222-2222-2222-222222222222",
      },
      "org-1"
    );

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(captured).toEqual({
      documents: [{ id: "1", text: "hello" }],
      brandId: "11111111-1111-1111-1111-111111111111",
    });
    expect(captured).not.toHaveProperty("campaignId");
  });

  it("falls back when 404 returned", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("", { status: 404 })
    );
    const res = await ragScore(
      {
        documents: [{ id: "1", text: "hello" }],
        brandId: "11111111-1111-1111-1111-111111111111",
      },
      "org-1"
    );
    expect(res.results).toHaveLength(1);
    expect(res.results[0]).toMatchObject({ id: "1" });
  });

  it("throws on non-ok non-404 response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("bad", { status: 400 })
    );
    await expect(
      ragScore(
        {
          documents: [{ id: "1", text: "hello" }],
          brandId: "11111111-1111-1111-1111-111111111111",
        },
        "org-1"
      )
    ).rejects.toThrow(/failed \(400\)/);
  });
});
