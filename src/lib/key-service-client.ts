import type { FeaturedCredentials } from "./featured-client.js";

export class KeyServiceUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeyServiceUnavailableError";
  }
}

export interface FeaturedCredentialsFetchContext {
  callerMethod: string;
  callerPath: string;
  runId?: string;
}

export async function getFeaturedCredentials(
  ctx: FeaturedCredentialsFetchContext
): Promise<FeaturedCredentials> {
  const baseUrl = process.env.KEY_SERVICE_URL;
  const apiKey = process.env.KEY_SERVICE_API_KEY;
  if (!baseUrl) {
    throw new Error(
      "[journalists-quotes-service] KEY_SERVICE_URL is required to fetch Featured.com credentials"
    );
  }
  if (!apiKey) {
    throw new Error(
      "[journalists-quotes-service] KEY_SERVICE_API_KEY is required to fetch Featured.com credentials"
    );
  }

  const headers: Record<string, string> = {
    "x-api-key": apiKey,
    "x-caller-service": "journalists-quotes-service",
    "x-caller-method": ctx.callerMethod,
    "x-caller-path": ctx.callerPath,
  };
  if (ctx.runId) headers["x-run-id"] = ctx.runId;

  const username = await fetchPlatformKey(baseUrl, "featured-username", headers);
  const password = await fetchPlatformKey(baseUrl, "featured-password", headers);

  return { username, password };
}

async function fetchPlatformKey(
  baseUrl: string,
  provider: "featured-username" | "featured-password",
  headers: Record<string, string>
): Promise<string> {
  let response: Response;
  try {
    response = await fetch(
      `${baseUrl}/keys/platform/${provider}/decrypt`,
      { method: "GET", headers }
    );
  } catch (err) {
    throw new KeyServiceUnavailableError(
      `key-service network error fetching ${provider}: ${(err as Error).message}`
    );
  }

  if (response.status === 404) {
    throw new KeyServiceUnavailableError(
      `${provider} platform key not registered in key-service`
    );
  }

  if (!response.ok) {
    const body = await response.text();
    throw new KeyServiceUnavailableError(
      `key-service GET /keys/platform/${provider}/decrypt failed (${response.status}): ${body}`
    );
  }

  const data = (await response.json()) as { key?: unknown };
  if (typeof data.key !== "string" || data.key.length === 0) {
    throw new Error(
      `key-service returned malformed ${provider} response: missing string key`
    );
  }
  return data.key;
}
