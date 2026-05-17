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
  orgId: "org-1",
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

  it("calls /keys/featured-username/decrypt and /keys/featured-password/decrypt and composes both with keySource", async () => {
    fetchSpy.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `${KS_URL}/keys/featured-username/decrypt`) {
        return jsonResponse({
          provider: "featured-username",
          key: "u-1",
          keySource: "platform",
          userId: "u",
        });
      }
      if (url === `${KS_URL}/keys/featured-password/decrypt`) {
        return jsonResponse({
          provider: "featured-password",
          key: "p-1",
          keySource: "platform",
          userId: "u",
        });
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const result = await getFeaturedCredentials({ ...CTX });
    expect(result).toEqual({
      username: "u-1",
      password: "p-1",
      keySource: "platform",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("returns keySource='org' when key-service reports the org configured its own key", async () => {
    fetchSpy.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      return jsonResponse({
        provider: url.includes("username")
          ? "featured-username"
          : "featured-password",
        key: url.includes("username") ? "org-u" : "org-p",
        keySource: "org",
        userId: "u",
      });
    });

    const result = await getFeaturedCredentials({ ...CTX });
    expect(result).toEqual({
      username: "org-u",
      password: "org-p",
      keySource: "org",
    });
  });

  it("throws on mismatched keySource across the two keys (fail loud)", async () => {
    fetchSpy.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      return jsonResponse({
        provider: url.includes("username")
          ? "featured-username"
          : "featured-password",
        key: "v",
        keySource: url.includes("username") ? "platform" : "org",
        userId: "u",
      });
    });

    await expect(getFeaturedCredentials({ ...CTX })).rejects.toThrow(
      /mismatched keySource/
    );
  });

  it("sends x-api-key, x-caller-service, x-caller-method, x-caller-path, x-org-id, and optional x-user-id / x-run-id", async () => {
    fetchSpy.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      return jsonResponse({
        provider: url.includes("username")
          ? "featured-username"
          : "featured-password",
        key: "v",
        keySource: "platform",
        userId: "u",
      });
    });

    await getFeaturedCredentials({
      callerMethod: "POST",
      callerPath: "/orgs/opportunities/next",
      orgId: "org-1",
      userId: "user-1",
      runId: "run-9",
    });

    for (const call of fetchSpy.mock.calls) {
      const init = call[1] as RequestInit;
      const headers = init.headers as Record<string, string>;
      expect(headers["x-api-key"]).toBe(KS_KEY);
      expect(headers["x-caller-service"]).toBe("journalists-quotes-service");
      expect(headers["x-caller-method"]).toBe("POST");
      expect(headers["x-caller-path"]).toBe("/orgs/opportunities/next");
      expect(headers["x-org-id"]).toBe("org-1");
      expect(headers["x-user-id"]).toBe("user-1");
      expect(headers["x-run-id"]).toBe("run-9");
    }
  });

  it("omits x-user-id and x-run-id when not provided", async () => {
    fetchSpy.mockImplementation(async () =>
      jsonResponse({
        provider: "featured-username",
        key: "v",
        keySource: "platform",
        userId: "u",
      })
    );
    await getFeaturedCredentials({ ...CTX });
    const headers = (fetchSpy.mock.calls[0][1] as RequestInit)
      .headers as Record<string, string>;
    expect(headers["x-user-id"]).toBeUndefined();
    expect(headers["x-run-id"]).toBeUndefined();
    expect(headers["x-org-id"]).toBe("org-1");
  });

  it("throws KeyServiceUnavailableError when featured-username returns 404", async () => {
    fetchSpy.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("featured-username")) {
        return new Response("not found", { status: 404 });
      }
      return jsonResponse({
        provider: "featured-password",
        key: "p",
        keySource: "platform",
        userId: "u",
      });
    });

    await expect(getFeaturedCredentials({ ...CTX })).rejects.toThrow(
      KeyServiceUnavailableError
    );
    await expect(getFeaturedCredentials({ ...CTX })).rejects.toThrow(
      /featured-username key not registered/
    );
  });

  it("throws KeyServiceUnavailableError when featured-password returns 404", async () => {
    fetchSpy.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("featured-username"))
        return jsonResponse({
          provider: "featured-username",
          key: "u",
          keySource: "platform",
          userId: "u",
        });
      return new Response("not found", { status: 404 });
    });

    await expect(getFeaturedCredentials({ ...CTX })).rejects.toThrow(
      /featured-password key not registered/
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
        return jsonResponse({ foo: "bar", keySource: "platform" });
      return jsonResponse({
        provider: "featured-password",
        key: "p",
        keySource: "platform",
        userId: "u",
      });
    });

    await expect(getFeaturedCredentials({ ...CTX })).rejects.toThrow(
      /malformed.*featured-username/
    );
  });

  it("throws when featured-password response is missing the key field", async () => {
    fetchSpy.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("featured-username"))
        return jsonResponse({
          provider: "featured-username",
          key: "u",
          keySource: "platform",
          userId: "u",
        });
      return jsonResponse({ wrong: "shape", keySource: "platform" });
    });

    await expect(getFeaturedCredentials({ ...CTX })).rejects.toThrow(
      /malformed.*featured-password/
    );
  });

  it("throws when keySource is missing or invalid", async () => {
    fetchSpy.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      return jsonResponse({
        provider: url.includes("username")
          ? "featured-username"
          : "featured-password",
        key: "v",
      });
    });

    await expect(getFeaturedCredentials({ ...CTX })).rejects.toThrow(
      /invalid keySource/
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
