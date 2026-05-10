function getConfig() {
  const url = process.env.CONTENT_GENERATION_SERVICE_URL;
  const apiKey = process.env.CONTENT_GENERATION_SERVICE_API_KEY;
  if (!url) throw new Error("CONTENT_GENERATION_SERVICE_URL is not set");
  if (!apiKey) throw new Error("CONTENT_GENERATION_SERVICE_API_KEY is not set");
  return { url, apiKey };
}

export interface ExpertQuotePitchBrandInput {
  name: string;
  industry: string;
  expertise: string;
  voice: string;
  targetAudience: string;
}

export interface ExpertQuotePitchRequestInput {
  question: string;
  mediaOutlet: string;
  source: string;
  deadline?: string;
}

export interface GenerateExpertQuotePitchInput {
  brand: ExpertQuotePitchBrandInput;
  request: ExpertQuotePitchRequestInput;
  additionalContext?: string;
  campaignId?: string;
  workflowSlug?: string;
  featureSlug?: string;
}

export interface ExpertQuotePitchIdentity {
  orgId: string;
  userId: string;
  runId: string;
  brandId: string;
  campaignId?: string;
  workflowSlug?: string;
  featureSlug?: string;
}

export interface ExpertQuotePitchResult {
  pitch: string;
  charCount: number;
  attempts: number;
  tokensInput: number;
  tokensOutput: number;
  contentGenRunId?: string;
}

export class ContentGenLengthError extends Error {
  charCount: number;
  minChars: number;
  maxChars: number;
  attempts: number;
  body: unknown;
  constructor(
    charCount: number,
    minChars: number,
    maxChars: number,
    attempts: number,
    message: string,
    body: unknown
  ) {
    super(message);
    this.name = "ContentGenLengthError";
    this.charCount = charCount;
    this.minChars = minChars;
    this.maxChars = maxChars;
    this.attempts = attempts;
    this.body = body;
  }
}

export class ContentGenTemplateMissingError extends Error {
  body: unknown;
  constructor(message: string, body: unknown) {
    super(message);
    this.name = "ContentGenTemplateMissingError";
    this.body = body;
  }
}

export class ContentGenInsufficientCreditsError extends Error {
  balanceCents?: number;
  requiredCents?: number;
  body: unknown;
  constructor(
    message: string,
    body: unknown,
    balanceCents?: number,
    requiredCents?: number
  ) {
    super(message);
    this.name = "ContentGenInsufficientCreditsError";
    this.balanceCents = balanceCents;
    this.requiredCents = requiredCents;
    this.body = body;
  }
}

export async function generateExpertQuotePitch(
  input: GenerateExpertQuotePitchInput,
  identity: ExpertQuotePitchIdentity
): Promise<ExpertQuotePitchResult> {
  const { url, apiKey } = getConfig();

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
    "x-org-id": identity.orgId,
    "x-user-id": identity.userId,
    "x-run-id": identity.runId,
    "x-brand-id": identity.brandId,
  };
  if (identity.campaignId) headers["x-campaign-id"] = identity.campaignId;
  if (identity.workflowSlug) headers["x-workflow-slug"] = identity.workflowSlug;
  if (identity.featureSlug) headers["x-feature-slug"] = identity.featureSlug;

  const response = await fetch(`${url}/generate-expert-quote-pitch`, {
    method: "POST",
    headers,
    body: JSON.stringify(input),
  });

  const text = await response.text();
  let parsed: unknown = undefined;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  if (response.status === 200) {
    const body = parsed as {
      pitch?: string;
      charCount?: number;
      attempts?: number;
      tokensInput?: number;
      tokensOutput?: number;
    };
    if (
      !body ||
      typeof body.pitch !== "string" ||
      typeof body.charCount !== "number"
    ) {
      throw new Error(
        `content-generation-service /generate-expert-quote-pitch returned malformed 200 body: ${text}`
      );
    }
    return {
      pitch: body.pitch,
      charCount: body.charCount,
      attempts: body.attempts ?? 1,
      tokensInput: body.tokensInput ?? 0,
      tokensOutput: body.tokensOutput ?? 0,
      contentGenRunId:
        response.headers.get("x-run-id") ??
        response.headers.get("x-content-gen-run-id") ??
        undefined,
    };
  }

  if (response.status === 400) {
    const body = parsed as {
      error?: string;
      charCount?: number;
      minChars?: number;
      maxChars?: number;
      attempts?: number;
    };
    if (
      body &&
      typeof body.charCount === "number" &&
      typeof body.minChars === "number" &&
      typeof body.maxChars === "number" &&
      typeof body.attempts === "number"
    ) {
      throw new ContentGenLengthError(
        body.charCount,
        body.minChars,
        body.maxChars,
        body.attempts,
        body.error ?? "Pitch length out of range after retry",
        body
      );
    }
    throw new Error(
      `content-generation-service /generate-expert-quote-pitch 400: ${text}`
    );
  }

  if (response.status === 402) {
    const body = parsed as {
      error?: string;
      balance_cents?: number;
      required_cents?: number;
    };
    throw new ContentGenInsufficientCreditsError(
      body?.error ?? "Insufficient credits",
      body,
      body?.balance_cents,
      body?.required_cents
    );
  }

  if (response.status === 404) {
    const body = parsed as { error?: string };
    throw new ContentGenTemplateMissingError(
      body?.error ?? "expert-quote-pitch template not registered",
      body
    );
  }

  throw new Error(
    `content-generation-service /generate-expert-quote-pitch failed (${response.status}): ${text}`
  );
}
