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

// ---------- Field extraction ----------------------------------------

export interface ExtractFieldSpec {
  key: string;
  description: string;
}

export interface ExtractFieldsResponse {
  brands: Array<{
    brandId: string;
    domain: string;
    name: string;
    brandUrl: string;
  }>;
  fields: Record<
    string,
    {
      value: unknown;
      byBrand: Record<
        string,
        {
          value: unknown;
          cached: boolean;
          extractedAt: string;
          expiresAt: string | null;
          sourceUrls: string[] | null;
        }
      >;
    }
  >;
}

export class BrandServiceError extends Error {
  status: number;
  body: string;
  constructor(status: number, message: string, body: string) {
    super(message);
    this.name = "BrandServiceError";
    this.status = status;
    this.body = body;
  }
}

/**
 * Call brand-service POST /internal/brands/extract-fields. Brand IDs go
 * through the x-brand-id header (comma-separated). Each field's
 * description is the AI prompt; brand-service caches the extracted
 * value for ~30 days keyed by (brandId, description).
 *
 * Fails loud: throws on missing env, non-2xx response, or schema mismatch.
 */
export async function extractFields(args: {
  brandIds: string[];
  fields: ExtractFieldSpec[];
}): Promise<ExtractFieldsResponse> {
  const { brandIds, fields } = args;
  if (brandIds.length === 0)
    throw new Error("extractFields: brandIds must be non-empty");
  if (fields.length === 0)
    throw new Error("extractFields: fields must be non-empty");

  const { url, apiKey } = getConfig();
  const response = await fetch(`${url}/internal/brands/extract-fields`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "x-brand-id": brandIds.join(","),
    },
    body: JSON.stringify({ fields }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new BrandServiceError(
      response.status,
      `brand-service POST /internal/brands/extract-fields failed (${response.status}): ${body}`,
      body
    );
  }

  const data = (await response.json()) as ExtractFieldsResponse;
  if (!data || typeof data !== "object" || !data.fields) {
    throw new BrandServiceError(
      200,
      "brand-service extract-fields response missing `fields`",
      JSON.stringify(data)
    );
  }
  return data;
}
