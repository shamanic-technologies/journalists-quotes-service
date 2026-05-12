import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  getFeaturedCredentials,
  KeyServiceUnavailableError,
} from "../../src/lib/key-service-client.js";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const KS_URL = "http://key-service.test";
const KS_KEY = "test-key-service-key";

describe("key-service-client.getFeaturedCredentials", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.env.KEY_SERVICE_URL = KS_URL;
    process.env.KEY_SERVICE_API_KEY = KS_KEY;
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    delete process.env.KEY_SERVICE_URL;
    delete process.env.KEY_SERVICE_API_KEY;
  });

  it("returns composed credentials when both scalar endpoints return 200", async () => {
    fetchSpy.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/orgs/keys/featured-username")) {
        return jsonResponse({ value: "u-1" });
      }
      if (url.endsWith("/orgs/keys/featured-password")) {
        return jsonResponse({ value: "p-1" });
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const creds = await getFeaturedCredentials("org-1");
    expect(creds).toEqual({ username: "u-1", password: "p-1" });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("forwards x-api-key, x-org-id, x-user-id, x-run-id headers", async () => {
    fetchSpy.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("featured-username"))
        return jsonResponse({ value: "u" });
      return jsonResponse({ value: "p" });
    });

    await getFeaturedCredentials("org-42", "user-7", "run-9");

    for (const call of fetchSpy.mock.calls) {
      const init = call[1] as RequestInit;
      const headers = init.headers as Record<string, string>;
      expect(headers["x-api-key"]).toBe(KS_KEY);
      expect(headers["x-org-id"]).toBe("org-42");
      expect(headers["x-user-id"]).toBe("user-7");
      expect(headers["x-run-id"]).toBe("run-9");
    }
  });

  it("throws KeyServiceUnavailableError when featured-username returns 404", async () => {
    fetchSpy.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("featured-username")) {
        return new Response("not found", { status: 404 });
      }
      return jsonResponse({ value: "p" });
    });

    await expect(getFeaturedCredentials("org-1")).rejects.toThrow(
      KeyServiceUnavailableError
    );
    await expect(getFeaturedCredentials("org-1")).rejects.toThrow(
      /featured-username key not registered/
    );
  });

  it("throws KeyServiceUnavailableError when featured-password returns 404", async () => {
    fetchSpy.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("featured-username"))
        return jsonResponse({ value: "u" });
      return new Response("not found", { status: 404 });
    });

    await expect(getFeaturedCredentials("org-1")).rejects.toThrow(
      /featured-password key not registered/
    );
  });

  it("throws KeyServiceUnavailableError on non-2xx non-404 status", async () => {
    fetchSpy.mockImplementation(async () =>
      new Response("boom", { status: 500 })
    );

    await expect(getFeaturedCredentials("org-1")).rejects.toThrow(
      KeyServiceUnavailableError
    );
    await expect(getFeaturedCredentials("org-1")).rejects.toThrow(/500/);
  });

  it("wraps network errors in KeyServiceUnavailableError", async () => {
    fetchSpy.mockImplementation(async () => {
      throw new Error("ECONNREFUSED");
    });

    await expect(getFeaturedCredentials("org-1")).rejects.toThrow(
      KeyServiceUnavailableError
    );
    await expect(getFeaturedCredentials("org-1")).rejects.toThrow(
      /ECONNREFUSED/
    );
  });

  it("throws when featured-username response is missing the value field", async () => {
    fetchSpy.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("featured-username"))
        return jsonResponse({ foo: "bar" });
      return jsonResponse({ value: "p" });
    });

    await expect(getFeaturedCredentials("org-1")).rejects.toThrow(
      /malformed.*featured-username/
    );
  });

  it("throws when featured-password response is missing the value field", async () => {
    fetchSpy.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("featured-username"))
        return jsonResponse({ value: "u" });
      return jsonResponse({ wrong: "shape" });
    });

    await expect(getFeaturedCredentials("org-1")).rejects.toThrow(
      /malformed.*featured-password/
    );
  });

  it("throws when KEY_SERVICE_URL is unset", async () => {
    delete process.env.KEY_SERVICE_URL;
    await expect(getFeaturedCredentials("org-1")).rejects.toThrow(
      /KEY_SERVICE_URL/
    );
  });

  it("throws when KEY_SERVICE_API_KEY is unset", async () => {
    delete process.env.KEY_SERVICE_API_KEY;
    await expect(getFeaturedCredentials("org-1")).rejects.toThrow(
      /KEY_SERVICE_API_KEY/
    );
  });
});
