function getConfig() {
  const url = process.env.BRAND_SERVICE_URL;
  const apiKey = process.env.BRAND_SERVICE_API_KEY;
  if (!url) throw new Error("BRAND_SERVICE_URL is not set");
  if (!apiKey) throw new Error("BRAND_SERVICE_API_KEY is not set");
  return { url, apiKey };
}

export interface BrandContext {
  id: string;
  domain: string;
  url: string;
  name: string;
  logoUrl: string;
  createdAt: string;
  updatedAt: string;
}

export async function getBrand(
  brandId: string,
  orgId?: string
): Promise<BrandContext> {
  const { url, apiKey } = getConfig();
  const query = orgId ? `?orgId=${encodeURIComponent(orgId)}` : "";
  const response = await fetch(`${url}/internal/brands/${brandId}${query}`, {
    method: "GET",
    headers: { "x-api-key": apiKey },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `brand-service GET /internal/brands/${brandId} failed (${response.status}): ${body}`
    );
  }
  const data = (await response.json()) as { brand?: BrandContext };
  if (!data.brand) throw new Error("brand-service response missing brand");
  return data.brand;
}
