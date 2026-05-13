import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { addCosts } from "../../src/lib/runs-client.js";

const RS_URL = "http://runs.test";
const RS_KEY = "test-runs-key";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("runs-client.addCosts", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.env.RUNS_SERVICE_URL = RS_URL;
    process.env.RUNS_SERVICE_API_KEY = RS_KEY;
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    delete process.env.RUNS_SERVICE_URL;
    delete process.env.RUNS_SERVICE_API_KEY;
  });

  it("POSTs to /v1/runs/:runId/costs with items, costSource and status", async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ costs: [] }));

    await addCosts(
      "run-1",
      [
        {
          costName: "featured-api-opportunity-fetch",
          costSource: "platform",
          quantity: 1,
          status: "actual",
        },
      ],
      {
        orgId: "org-1",
        userId: "user-1",
        brandId: "brand-1",
        campaignId: "campaign-1",
        featureSlug: "feat",
        workflowSlug: "wf",
      }
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe(`${RS_URL}/v1/runs/run-1/costs`);
    expect((init as RequestInit).method).toBe("POST");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe(RS_KEY);
    expect(headers["x-org-id"]).toBe("org-1");
    expect(headers["x-run-id"]).toBe("run-1");
    expect(headers["x-user-id"]).toBe("user-1");
    expect(headers["x-brand-id"]).toBe("brand-1");
    expect(headers["x-campaign-id"]).toBe("campaign-1");
    expect(headers["x-feature-slug"]).toBe("feat");
    expect(headers["x-workflow-slug"]).toBe("wf");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      items: [
        {
          costName: "featured-api-opportunity-fetch",
          costSource: "platform",
          quantity: 1,
          status: "actual",
        },
      ],
    });
  });

  it("throws on non-2xx status", async () => {
    fetchSpy.mockResolvedValue(new Response("boom", { status: 500 }));

    await expect(
      addCosts(
        "run-1",
        [
          {
            costName: "x",
            costSource: "platform",
            quantity: 1,
            status: "actual",
          },
        ],
        { orgId: "org-1" }
      )
    ).rejects.toThrow(/Runs-service POST .* failed \(500\)/);
  });
});
