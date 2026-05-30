import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { extractBrandContext } from "../../src/lib/brand-client.js";

const BS_URL = "http://brand.test";
const BS_KEY = "k";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const FIELDS_BODY = {
  fields: {
    industry: { value: "AI" },
    expertise: { value: "LLM safety" },
    targetAudience: { value: "developers" },
    expertiseTopics: { value: ["alignment", "evals"] },
  },
};

describe("extractBrandContext", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.BRAND_SERVICE_URL = BS_URL;
    process.env.BRAND_SERVICE_API_KEY = BS_KEY;
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.BRAND_SERVICE_URL;
    delete process.env.BRAND_SERVICE_API_KEY;
  });

  it("forwards x-user-id (mandatory) alongside x-org-id + x-brand-id to /orgs/brands/extract-fields", async () => {
    fetchSpy.mockResolvedValue(jsonResponse(FIELDS_BODY));

    const out = await extractBrandContext(["b-1"], "org-1", "u-1");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe(`${BS_URL}/orgs/brands/extract-fields`);
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe(BS_KEY);
    expect(headers["x-org-id"]).toBe("org-1");
    // Regression guard: brand-service hard-requires x-user-id (400 without).
    expect(headers["x-user-id"]).toBe("u-1");
    expect(headers["x-brand-id"]).toBe("b-1");

    expect(out).toContain("Industry: AI");
    expect(out).toContain("Expertise topics: alignment, evals");
  });

  it("joins multiple brand ids into the x-brand-id CSV", async () => {
    fetchSpy.mockResolvedValue(jsonResponse(FIELDS_BODY));

    await extractBrandContext(["b-1", "b-2"], "org-1", "u-1");

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["x-brand-id"]).toBe("b-1,b-2");
  });

  it("throws without calling brand-service when userId is empty (fail-loud)", async () => {
    await expect(extractBrandContext(["b-1"], "org-1", "")).rejects.toThrow(
      /userId must be non-empty/
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("throws without calling brand-service when brandIds is empty (fail-loud)", async () => {
    await expect(extractBrandContext([], "org-1", "u-1")).rejects.toThrow(
      /brandIds must be non-empty/
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("throws on non-2xx (fail-loud)", async () => {
    fetchSpy.mockResolvedValue(new Response("boom", { status: 400 }));
    await expect(
      extractBrandContext(["b-1"], "org-1", "u-1")
    ).rejects.toThrow(/brand-service POST \/orgs\/brands\/extract-fields failed \(400\)/);
  });

  it("throws when BRAND_SERVICE_URL unset", async () => {
    delete process.env.BRAND_SERVICE_URL;
    await expect(
      extractBrandContext(["b-1"], "org-1", "u-1")
    ).rejects.toThrow(/BRAND_SERVICE_URL is not set/);
  });
});
