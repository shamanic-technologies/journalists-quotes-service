import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  ContentGenerationServiceError,
  ExpertQuotePitchLengthError,
  generateExpertQuotePitch,
} from "../../src/lib/content-generation-client.js";

const ORIG_URL = process.env.CONTENT_GENERATION_SERVICE_URL;
const ORIG_KEY = process.env.CONTENT_GENERATION_SERVICE_API_KEY;

describe("generateExpertQuotePitch", () => {
  beforeEach(() => {
    process.env.CONTENT_GENERATION_SERVICE_URL = "http://content-gen.test";
    process.env.CONTENT_GENERATION_SERVICE_API_KEY = "k";
  });
  afterEach(() => {
    process.env.CONTENT_GENERATION_SERVICE_URL = ORIG_URL;
    process.env.CONTENT_GENERATION_SERVICE_API_KEY = ORIG_KEY;
    vi.restoreAllMocks();
  });

  it("forwards full identity headers and request body", async () => {
    let capturedUrl: string | undefined;
    let capturedHeaders: Record<string, string> = {};
    let capturedBody: unknown;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      capturedUrl = String(url);
      capturedHeaders = (init?.headers as Record<string, string>) ?? {};
      capturedBody = JSON.parse(init?.body as string);
      return new Response(
        JSON.stringify({
          pitch: "x".repeat(200),
          charCount: 200,
          attempts: 1,
          tokensInput: 50,
          tokensOutput: 100,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });

    const result = await generateExpertQuotePitch(
      {
        variables: {
          brands: [{ name: "Jane Doe" }],
          request: { question: "Q?" },
          additionalContext: "ctx",
        },
        brandIds: ["b-1"],
        campaignId: "c-1",
        workflowSlug: "wf",
        featureSlug: "fs",
      },
      {
        orgId: "org-1",
        userId: "u-1",
        runId: "r-1",
        brandId: "b-1",
        campaignId: "c-1",
        workflowSlug: "wf",
        featureSlug: "fs",
      }
    );

    expect(capturedUrl).toBe("http://content-gen.test/generate-expert-quote-pitch");
    expect(capturedHeaders).toMatchObject({
      "x-api-key": "k",
      "x-org-id": "org-1",
      "x-user-id": "u-1",
      "x-run-id": "r-1",
      "x-brand-id": "b-1",
      "x-campaign-id": "c-1",
      "x-workflow-slug": "wf",
      "x-feature-slug": "fs",
    });
    expect(capturedBody).toEqual({
      variables: {
        brands: [{ name: "Jane Doe" }],
        request: { question: "Q?" },
        additionalContext: "ctx",
      },
      brandIds: ["b-1"],
      campaignId: "c-1",
      workflowSlug: "wf",
      featureSlug: "fs",
    });
    expect(result.pitch).toHaveLength(200);
    expect(result.charCount).toBe(200);
  });

  it("throws ExpertQuotePitchLengthError on length-passthrough 400", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          error: "pitch length out of range",
          charCount: 50,
          minChars: 100,
          maxChars: 2500,
          attempts: 2,
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      )
    );
    await expect(
      generateExpertQuotePitch(
        { variables: {} },
        { orgId: "org-1" }
      )
    ).rejects.toBeInstanceOf(ExpertQuotePitchLengthError);
  });

  it("throws ContentGenerationServiceError on non-400 non-length 400", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("upstream broke", { status: 502 })
    );
    await expect(
      generateExpertQuotePitch(
        { variables: {} },
        { orgId: "org-1" }
      )
    ).rejects.toBeInstanceOf(ContentGenerationServiceError);
  });

  it("treats malformed 400 (no length fields) as generic ContentGenerationServiceError", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "missing variables" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      })
    );
    await expect(
      generateExpertQuotePitch(
        { variables: {} },
        { orgId: "org-1" }
      )
    ).rejects.toBeInstanceOf(ContentGenerationServiceError);
  });
});
