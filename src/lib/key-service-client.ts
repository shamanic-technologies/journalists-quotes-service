import type { FeaturedCredentials } from "./featured-client.js";

export class KeyServiceUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeyServiceUnavailableError";
  }
}

export type KeySource = "org" | "platform";

export interface FeaturedCredentialsFetchContext {
  callerMethod: string;
  callerPath: string;
  orgId: string;
  userId?: string;
  runId?: string;
}

export interface FeaturedCredentialsResult {
  username: string;
  password: string;
  keySource: KeySource;
}

export async function getFeaturedCredentials(
  ctx: FeaturedCredentialsFetchContext
): Promise<FeaturedCredentialsResult> {
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
    "x-org-id": ctx.orgId,
  };
  if (ctx.userId) headers["x-user-id"] = ctx.userId;
  if (ctx.runId) headers["x-run-id"] = ctx.runId;

  const username = await fetchKey(baseUrl, "featured-username", headers);
  const password = await fetchKey(baseUrl, "featured-password", headers);

  if (username.keySource !== password.keySource) {
    throw new Error(
      `key-service returned mismatched keySource: featured-username=${username.keySource} vs featured-password=${password.keySource}`
    );
  }

  return {
    username: username.key,
    password: password.key,
    keySource: username.keySource,
  };
}

interface DecryptedKey {
  key: string;
  keySource: KeySource;
}

async function fetchKey(
  baseUrl: string,
  provider: "featured-username" | "featured-password",
  headers: Record<string, string>
): Promise<DecryptedKey> {
  let response: Response;
  try {
    response = await fetch(
      `${baseUrl}/keys/${provider}/decrypt`,
      { method: "GET", headers }
    );
  } catch (err) {
    throw new KeyServiceUnavailableError(
      `key-service network error fetching ${provider}: ${(err as Error).message}`
    );
  }

  if (response.status === 404) {
    throw new KeyServiceUnavailableError(
      `${provider} key not registered in key-service`
    );
  }

  if (!response.ok) {
    const body = await response.text();
    throw new KeyServiceUnavailableError(
      `key-service GET /keys/${provider}/decrypt failed (${response.status}): ${body}`
    );
  }

  const data = (await response.json()) as {
    key?: unknown;
    keySource?: unknown;
  };
  if (typeof data.key !== "string" || data.key.length === 0) {
    throw new Error(
      `key-service returned malformed ${provider} response: missing string key`
    );
  }
  if (data.keySource !== "org" && data.keySource !== "platform") {
    throw new Error(
      `key-service returned malformed ${provider} response: invalid keySource ${String(
        data.keySource
      )}`
    );
  }
  return { key: data.key, keySource: data.keySource };
}

export type { FeaturedCredentials };
