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

const CTX = {
  callerMethod: "POST",
  callerPath: "/orgs/opportunities/next",
} as const;

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

  it("calls /keys/platform/featured-username/decrypt and /keys/platform/featured-password/decrypt and composes both", async () => {
    fetchSpy.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `${KS_URL}/keys/platform/featured-username/decrypt`) {
        return jsonResponse({ provider: "featured-username", key: "u-1" });
      }
      if (url === `${KS_URL}/keys/platform/featured-password/decrypt`) {
        return jsonResponse({ provider: "featured-password", key: "p-1" });
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const creds = await getFeaturedCredentials({ ...CTX });
    expect(creds).toEqual({ username: "u-1", password: "p-1" });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("sends x-api-key, x-caller-service, x-caller-method, x-caller-path, optional x-run-id and does NOT send x-org-id / x-user-id", async () => {
    fetchSpy.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      return jsonResponse({
        provider: url.includes("username") ? "featured-username" : "featured-password",
        key: "v",
      });
    });

    await getFeaturedCredentials({
      callerMethod: "POST",
      callerPath: "/orgs/opportunities/next",
      runId: "run-9",
    });

    for (const call of fetchSpy.mock.calls) {
      const init = call[1] as RequestInit;
      const headers = init.headers as Record<string, string>;
      expect(headers["x-api-key"]).toBe(KS_KEY);
      expect(headers["x-caller-service"]).toBe("journalists-quotes-service");
      expect(headers["x-caller-method"]).toBe("POST");
      expect(headers["x-caller-path"]).toBe("/orgs/opportunities/next");
      expect(headers["x-run-id"]).toBe("run-9");
      expect(headers["x-org-id"]).toBeUndefined();
      expect(headers["x-user-id"]).toBeUndefined();
    }
  });

  it("omits x-run-id when ctx.runId is not provided", async () => {
    fetchSpy.mockImplementation(async () =>
      jsonResponse({ provider: "featured-username", key: "v" })
    );
    await getFeaturedCredentials({ ...CTX });
    const headers = (fetchSpy.mock.calls[0][1] as RequestInit)
      .headers as Record<string, string>;
    expect(headers["x-run-id"]).toBeUndefined();
  });

  it("throws KeyServiceUnavailableError when featured-username returns 404", async () => {
    fetchSpy.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("featured-username")) {
        return new Response("not found", { status: 404 });
      }
      return jsonResponse({ provider: "featured-password", key: "p" });
    });

    await expect(getFeaturedCredentials({ ...CTX })).rejects.toThrow(
      KeyServiceUnavailableError
    );
    await expect(getFeaturedCredentials({ ...CTX })).rejects.toThrow(
      /featured-username platform key not registered/
    );
  });

  it("throws KeyServiceUnavailableError when featured-password returns 404", async () => {
    fetchSpy.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("featured-username"))
        return jsonResponse({ provider: "featured-username", key: "u" });
      return new Response("not found", { status: 404 });
    });

    await expect(getFeaturedCredentials({ ...CTX })).rejects.toThrow(
      /featured-password platform key not registered/
    );
  });

  it("throws KeyServiceUnavailableError on non-2xx non-404 status", async () => {
    fetchSpy.mockImplementation(async () =>
      new Response("boom", { status: 500 })
    );

    await expect(getFeaturedCredentials({ ...CTX })).rejects.toThrow(
      KeyServiceUnavailableError
    );
    await expect(getFeaturedCredentials({ ...CTX })).rejects.toThrow(/500/);
  });

  it("wraps network errors in KeyServiceUnavailableError", async () => {
    fetchSpy.mockImplementation(async () => {
      throw new Error("ECONNREFUSED");
    });

    await expect(getFeaturedCredentials({ ...CTX })).rejects.toThrow(
      KeyServiceUnavailableError
    );
    await expect(getFeaturedCredentials({ ...CTX })).rejects.toThrow(
      /ECONNREFUSED/
    );
  });

  it("throws when featured-username response is missing the key field", async () => {
    fetchSpy.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("featured-username"))
        return jsonResponse({ foo: "bar" });
      return jsonResponse({ provider: "featured-password", key: "p" });
    });

    await expect(getFeaturedCredentials({ ...CTX })).rejects.toThrow(
      /malformed.*featured-username/
    );
  });

  it("throws when featured-password response is missing the key field", async () => {
    fetchSpy.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("featured-username"))
        return jsonResponse({ provider: "featured-username", key: "u" });
      return jsonResponse({ wrong: "shape" });
    });

    await expect(getFeaturedCredentials({ ...CTX })).rejects.toThrow(
      /malformed.*featured-password/
    );
  });

  it("throws when KEY_SERVICE_URL is unset", async () => {
    delete process.env.KEY_SERVICE_URL;
    await expect(getFeaturedCredentials({ ...CTX })).rejects.toThrow(
      /KEY_SERVICE_URL/
    );
  });

  it("throws when KEY_SERVICE_API_KEY is unset", async () => {
    delete process.env.KEY_SERVICE_API_KEY;
    await expect(getFeaturedCredentials({ ...CTX })).rejects.toThrow(
      /KEY_SERVICE_API_KEY/
    );
  });
});
