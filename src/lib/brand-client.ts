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

// Fields requested from brand-service AI extraction to give the
// relevance judge enough brand context to score press opportunities.
const JUDGE_BRAND_FIELDS = [
  {
    key: "industry",
    description: "The brand's primary industry vertical",
  },
  {
    key: "expertise",
    description:
      "What the brand and its spokespeople are credible experts on",
  },
  {
    key: "targetAudience",
    description: "The brand's target audience",
  },
  {
    key: "expertiseTopics",
    description:
      "Specific topics the brand can authoritatively comment on for press / journalist quote requests",
  },
] as const;

interface ExtractFieldsResponse {
  fields: Record<string, { value: unknown }>;
}

function coerceFieldValue(value: unknown): string {
  if (value == null) return "(unknown)";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(coerceFieldValue).join(", ");
  return JSON.stringify(value);
}

/**
 * Resolve a brand-set's profile via brand-service AI extraction and
 * render it as a plain-text block for the relevance judge prompt.
 * Reads brand identity from the `x-brand-id` header (CSV when plural);
 * brand-service consolidates multi-brand values. Results are cached
 * 30 days brand-side, so repeat calls for the same brand-set are cheap.
 *
 * brand-service `/orgs/brands/extract-fields` is an org-route: it hard-requires
 * the full identity trio `x-org-id` + `x-user-id` + `x-run-id` (400 on any
 * missing). All three are forwarded unconditionally — mirroring the inbound
 * `/next` + `/discover` identity tier (`requireOpportunityIdentity`) and the
 * `judge-client` chat-service call.
 */
export async function extractBrandContext(
  brandIds: string[],
  orgId: string,
  userId: string,
  runId: string,
  audienceId?: string
): Promise<string> {
  if (brandIds.length === 0) {
    throw new Error("extractBrandContext: brandIds must be non-empty");
  }
  if (!userId) {
    throw new Error("extractBrandContext: userId must be non-empty");
  }
  if (!runId) {
    throw new Error("extractBrandContext: runId must be non-empty");
  }
  const { url, apiKey } = getConfig();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
    "x-org-id": orgId,
    "x-user-id": userId,
    "x-run-id": runId,
    "x-brand-id": brandIds.join(","),
  };
  // Forward the campaign audience so brand-service tags the
  // field-extraction cost to this audience.
  if (audienceId) headers["x-audience-id"] = audienceId;
  const response = await fetch(`${url}/orgs/brands/extract-fields`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      fields: JUDGE_BRAND_FIELDS.map((f) => ({
        key: f.key,
        description: f.description,
      })),
    }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `brand-service POST /orgs/brands/extract-fields failed (${response.status}): ${body}`
    );
  }
  const data = (await response.json()) as ExtractFieldsResponse;
  const labels: Record<string, string> = {
    industry: "Industry",
    expertise: "Expertise",
    targetAudience: "Target audience",
    expertiseTopics: "Expertise topics",
  };
  return JUDGE_BRAND_FIELDS.map((f) => {
    const value = coerceFieldValue(data.fields?.[f.key]?.value);
    return `- ${labels[f.key] ?? f.key}: ${value}`;
  }).join("\n");
}
