import type { FeaturedCredentials } from "./featured-client.js";

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
    "x-org-id": orgId,
  };
  if (userId) headers["x-user-id"] = userId;
  if (runId) headers["x-run-id"] = runId;

  const username = await fetchScalarKey(baseUrl, "featured-username", headers);
  const password = await fetchScalarKey(baseUrl, "featured-password", headers);

  return { username, password };
}

async function fetchScalarKey(
  baseUrl: string,
  keyName: "featured-username" | "featured-password",
  headers: Record<string, string>
): Promise<string> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/orgs/keys/${keyName}`, {
      method: "GET",
      headers,
    });
  } catch (err) {
    throw new KeyServiceUnavailableError(
      `key-service network error fetching ${keyName}: ${(err as Error).message}`
    );
  }

  if (response.status === 404) {
    throw new KeyServiceUnavailableError(
      `${keyName} key not registered in key-service`
    );
  }

  if (!response.ok) {
    const body = await response.text();
    throw new KeyServiceUnavailableError(
      `key-service GET /orgs/keys/${keyName} failed (${response.status}): ${body}`
    );
  }

  const data = (await response.json()) as { value?: unknown };
  if (typeof data.value !== "string" || data.value.length === 0) {
    throw new Error(
      `key-service returned malformed ${keyName} response: missing string value`
    );
  }
  return data.value;
}
