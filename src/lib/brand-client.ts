const BRAND_SERVICE_URL = process.env.BRAND_SERVICE_URL;
const BRAND_SERVICE_API_KEY = process.env.BRAND_SERVICE_API_KEY;

function getConfig() {
  if (!BRAND_SERVICE_URL) throw new Error("BRAND_SERVICE_URL is not set");
  if (!BRAND_SERVICE_API_KEY)
    throw new Error("BRAND_SERVICE_API_KEY is not set");
  return { url: BRAND_SERVICE_URL, apiKey: BRAND_SERVICE_API_KEY };
}

export interface BrandContext {
  id: string;
  name: string;
  industry?: string;
  geography?: string;
  targetAudience?: string;
  description?: string;
  [key: string]: unknown;
}

export interface BrandLogoAsset {
  id: string;
  permanentUrl: string;
  category: string;
  [key: string]: unknown;
}

function buildHeaders(orgId: string, userId?: string, runId?: string) {
  const { apiKey } = getConfig();
  const headers: Record<string, string> = {
    "x-api-key": apiKey,
    "x-org-id": orgId,
  };
  if (userId) headers["x-user-id"] = userId;
  if (runId) headers["x-run-id"] = runId;
  return headers;
}

export async function getBrand(
  brandId: string,
  orgId: string,
  userId?: string,
  runId?: string
): Promise<BrandContext> {
  const { url } = getConfig();
  const response = await fetch(`${url}/orgs/brands/${brandId}`, {
    method: "GET",
    headers: buildHeaders(orgId, userId, runId),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `brand-service GET /orgs/brands/${brandId} failed (${response.status}): ${body}`
    );
  }
  const data = (await response.json()) as { brand?: BrandContext };
  if (!data.brand) throw new Error("brand-service response missing brand");
  return data.brand;
}

export async function getBrandLogo(
  brandId: string,
  orgId: string,
  userId?: string,
  runId?: string
): Promise<BrandLogoAsset | null> {
  const { url } = getConfig();
  const response = await fetch(
    `${url}/orgs/brands/${brandId}/media-assets?category=logo`,
    { method: "GET", headers: buildHeaders(orgId, userId, runId) }
  );
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `brand-service GET /orgs/brands/${brandId}/media-assets failed (${response.status}): ${body}`
    );
  }
  const data = (await response.json()) as { mediaAssets?: BrandLogoAsset[] };
  const logos = data.mediaAssets ?? [];
  return logos[0] ?? null;
}
