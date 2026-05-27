export interface ExpertQuotePitchSuccessResponse {
  pitch: string;
  charCount: number;
  attempts: number;
  tokensInput: number;
  tokensOutput: number;
}

export interface ExpertQuotePitchLengthErrorDetails {
  error: string;
  charCount: number;
  minChars: number;
  maxChars: number;
  attempts: number;
}

export class ExpertQuotePitchLengthError extends Error {
  details: ExpertQuotePitchLengthErrorDetails;
  constructor(details: ExpertQuotePitchLengthErrorDetails) {
    super(details.error);
    this.name = "ExpertQuotePitchLengthError";
    this.details = details;
  }
}

export class ContentGenerationServiceError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.name = "ContentGenerationServiceError";
    this.status = status;
    this.body = body;
  }
}

export interface GenerateExpertQuotePitchRequest {
  variables: Record<string, unknown>;
  brandIds?: string[];
  campaignId?: string;
  workflowSlug?: string;
  featureSlug?: string;
}

export interface ContentGenerationCallerIdentity {
  orgId: string;
  userId?: string;
  runId?: string;
  brandId?: string;
  campaignId?: string;
  workflowSlug?: string;
  featureSlug?: string;
}

function getConfig() {
  const url = process.env.CONTENT_GENERATION_SERVICE_URL;
  const apiKey = process.env.CONTENT_GENERATION_SERVICE_API_KEY;
  if (!url) throw new Error("CONTENT_GENERATION_SERVICE_URL is not set");
  if (!apiKey) throw new Error("CONTENT_GENERATION_SERVICE_API_KEY is not set");
  return { url, apiKey };
}

export async function generateExpertQuotePitch(
  request: GenerateExpertQuotePitchRequest,
  identity: ContentGenerationCallerIdentity
): Promise<ExpertQuotePitchSuccessResponse> {
  const { url, apiKey } = getConfig();

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
    "x-org-id": identity.orgId,
  };
  if (identity.userId) headers["x-user-id"] = identity.userId;
  if (identity.runId) headers["x-run-id"] = identity.runId;
  if (identity.brandId) headers["x-brand-id"] = identity.brandId;
  if (identity.campaignId) headers["x-campaign-id"] = identity.campaignId;
  if (identity.workflowSlug) headers["x-workflow-slug"] = identity.workflowSlug;
  if (identity.featureSlug) headers["x-feature-slug"] = identity.featureSlug;

  const response = await fetch(`${url}/generate-expert-quote-pitch`, {
    method: "POST",
    headers,
    body: JSON.stringify(request),
  });

  if (response.status === 400) {
    const body = (await response.json().catch(() => ({}))) as Partial<
      ExpertQuotePitchLengthErrorDetails
    >;
    if (
      typeof body.charCount === "number" &&
      typeof body.minChars === "number" &&
      typeof body.maxChars === "number" &&
      typeof body.attempts === "number"
    ) {
      throw new ExpertQuotePitchLengthError({
        error: typeof body.error === "string" ? body.error : "pitch length out of range",
        charCount: body.charCount,
        minChars: body.minChars,
        maxChars: body.maxChars,
        attempts: body.attempts,
      });
    }
    throw new ContentGenerationServiceError(
      400,
      `content-generation POST /generate-expert-quote-pitch returned 400: ${JSON.stringify(body)}`,
      body
    );
  }

  if (!response.ok) {
    const text = await response.text();
    throw new ContentGenerationServiceError(
      response.status,
      `content-generation POST /generate-expert-quote-pitch failed (${response.status}): ${text}`,
      text
    );
  }

  return (await response.json()) as ExpertQuotePitchSuccessResponse;
}
