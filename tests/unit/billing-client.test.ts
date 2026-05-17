import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  authorizeCredit,
  BillingServiceError,
} from "../../src/lib/billing-client.js";

const BS_URL = "http://billing.test";
const BS_KEY = "test-billing-key";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("billing-client.authorizeCredit", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.env.BILLING_SERVICE_URL = BS_URL;
    process.env.BILLING_SERVICE_API_KEY = BS_KEY;
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    delete process.env.BILLING_SERVICE_URL;
    delete process.env.BILLING_SERVICE_API_KEY;
  });

  it("POSTs to /v1/customer_balance/authorize with items, description, and identity headers", async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse({ sufficient: true, balance_cents: 1000, required_cents: 5 })
    );

    const result = await authorizeCredit({
      items: [{ costName: "featured-api-opportunity-fetch", quantity: 1 }],
      description: "test",
      orgId: "org-1",
      userId: "user-1",
      runId: "run-1",
      brandId: "brand-1",
      campaignId: "campaign-1",
      featureSlug: "feat",
      workflowSlug: "wf",
    });

    expect(result).toEqual({
      sufficient: true,
      balance_cents: 1000,
      required_cents: 5,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe(`${BS_URL}/v1/customer_balance/authorize`);
    expect((init as RequestInit).method).toBe("POST");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["X-API-Key"]).toBe(BS_KEY);
    expect(headers["x-org-id"]).toBe("org-1");
    expect(headers["x-user-id"]).toBe("user-1");
    expect(headers["x-run-id"]).toBe("run-1");
    expect(headers["x-brand-id"]).toBe("brand-1");
    expect(headers["x-campaign-id"]).toBe("campaign-1");
    expect(headers["x-feature-slug"]).toBe("feat");
    expect(headers["x-workflow-slug"]).toBe("wf");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      items: [{ costName: "featured-api-opportunity-fetch", quantity: 1 }],
      description: "test",
    });
  });

  it("returns sufficient=false response without throwing", async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse({ sufficient: false, balance_cents: 0, required_cents: 5 })
    );

    const result = await authorizeCredit({
      items: [{ costName: "featured-api-opportunity-fetch", quantity: 1 }],
      description: "test",
      orgId: "org-1",
    });

    expect(result.sufficient).toBe(false);
  });

  it("throws BillingServiceError on non-2xx status", async () => {
    fetchSpy.mockResolvedValue(new Response("boom", { status: 502 }));

    await expect(
      authorizeCredit({
        items: [{ costName: "x", quantity: 1 }],
        description: "test",
        orgId: "org-1",
      })
    ).rejects.toBeInstanceOf(BillingServiceError);
  });

  it("throws when BILLING_SERVICE_URL is unset", async () => {
    delete process.env.BILLING_SERVICE_URL;
    await expect(
      authorizeCredit({
        items: [{ costName: "x", quantity: 1 }],
        description: "test",
        orgId: "org-1",
      })
    ).rejects.toThrow(/BILLING_SERVICE_URL/);
  });

  it("throws when BILLING_SERVICE_API_KEY is unset", async () => {
    delete process.env.BILLING_SERVICE_API_KEY;
    await expect(
      authorizeCredit({
        items: [{ costName: "x", quantity: 1 }],
        description: "test",
        orgId: "org-1",
      })
    ).rejects.toThrow(/BILLING_SERVICE_API_KEY/);
  });

  it("omits optional headers when not provided", async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse({ sufficient: true, balance_cents: 1, required_cents: 1 })
    );

    await authorizeCredit({
      items: [{ costName: "x", quantity: 1 }],
      description: "test",
      orgId: "org-1",
    });

    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["x-user-id"]).toBeUndefined();
    expect(headers["x-run-id"]).toBeUndefined();
    expect(headers["x-brand-id"]).toBeUndefined();
    expect(headers["x-campaign-id"]).toBeUndefined();
    expect(headers["x-feature-slug"]).toBeUndefined();
    expect(headers["x-workflow-slug"]).toBeUndefined();
  });
});
