import type { FeaturedCredentials } from "./featured-client.js";

const KEY_SERVICE_URL = process.env.KEY_SERVICE_URL;
const KEY_SERVICE_API_KEY = process.env.KEY_SERVICE_API_KEY;

export class KeyServiceUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeyServiceUnavailableError";
  }
}

export async function getFeaturedCredentials(
  orgId: string,
  userId?: string,
  runId?: string
): Promise<FeaturedCredentials> {
  // TODO(featured-key-provider): once key-service exposes the `featured` provider,
  // remove the env-var fallback below and propagate 502 on key-service errors.
  if (!KEY_SERVICE_URL || !KEY_SERVICE_API_KEY) {
    return getFromEnv();
  }

  const headers: Record<string, string> = {
    "x-api-key": KEY_SERVICE_API_KEY,
    "x-org-id": orgId,
  };
  if (userId) headers["x-user-id"] = userId;
  if (runId) headers["x-run-id"] = runId;

  let response: Response;
  try {
    response = await fetch(
      `${KEY_SERVICE_URL}/orgs/keys/featured`,
      { method: "GET", headers }
    );
  } catch (err) {
    throw new KeyServiceUnavailableError(
      `key-service network error: ${(err as Error).message}`
    );
  }

  if (response.status === 404) {
    return getFromEnv();
  }

  if (!response.ok) {
    const body = await response.text();
    throw new KeyServiceUnavailableError(
      `key-service GET /orgs/keys/featured failed (${response.status}): ${body}`
    );
  }

  const data = (await response.json()) as { value?: FeaturedCredentials };
  if (!data.value || !data.value.username || !data.value.password) {
    throw new Error("key-service returned malformed featured credentials");
  }
  return data.value;
}

function getFromEnv(): FeaturedCredentials {
  const username = process.env.FEATURED_USERNAME;
  const password = process.env.FEATURED_PASSWORD;
  if (!username || !password) {
    throw new Error(
      "Featured credentials unavailable: key-service `featured` provider not registered and FEATURED_USERNAME/FEATURED_PASSWORD env vars unset"
    );
  }
  return { username, password };
}
