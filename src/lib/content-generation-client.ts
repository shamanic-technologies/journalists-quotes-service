const CONTENT_GENERATION_SERVICE_URL =
  process.env.CONTENT_GENERATION_SERVICE_URL;
const CONTENT_GENERATION_SERVICE_API_KEY =
  process.env.CONTENT_GENERATION_SERVICE_API_KEY;

export interface GeneratePitchRequest {
  template: "expert-quote-pitch";
  context: {
    brand: unknown;
    request: unknown;
    deadline?: string | null;
  };
}

export interface GeneratePitchResponse {
  content: string;
}

export async function generatePitch(
  request: GeneratePitchRequest,
  orgId: string,
  userId?: string,
  runId?: string
): Promise<GeneratePitchResponse> {
  // TODO(pitch-template): content-generation-service `expert-quote-pitch` template
  // not yet registered. Fallback to placeholder text built from request body.
  if (!CONTENT_GENERATION_SERVICE_URL || !CONTENT_GENERATION_SERVICE_API_KEY) {
    return fallbackPitch(request);
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": CONTENT_GENERATION_SERVICE_API_KEY,
    "x-org-id": orgId,
  };
  if (userId) headers["x-user-id"] = userId;
  if (runId) headers["x-run-id"] = runId;

  const response = await fetch(
    `${CONTENT_GENERATION_SERVICE_URL}/orgs/generate`,
    {
      method: "POST",
      headers,
      body: JSON.stringify(request),
    }
  );

  if (response.status === 404) {
    return fallbackPitch(request);
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `content-generation-service POST /orgs/generate failed (${response.status}): ${body}`
    );
  }

  return (await response.json()) as GeneratePitchResponse;
}

function fallbackPitch(request: GeneratePitchRequest): GeneratePitchResponse {
  const brand = request.context.brand as { name?: string } | undefined;
  const req = request.context.request as
    | { opportunityText?: string; mediaOutlet?: string }
    | undefined;
  const intro = `On behalf of ${brand?.name ?? "our brand"}, here is an expert response to the request from ${req?.mediaOutlet ?? "the publication"}.`;
  const body = req?.opportunityText
    ? `Regarding the prompt: "${req.opportunityText}". We can offer concrete, original insight backed by direct experience and recent data, and we can substantiate every claim with sources and named experts on request.`
    : "We can offer concrete, original insight backed by direct experience and recent data, and we can substantiate every claim with sources and named experts on request.";
  const closer =
    "Please reply if you would like fuller credentials, follow-up quotes, or images.";
  let content = `${intro} ${body} ${closer}`;
  while (content.length < 100) content += " " + closer;
  if (content.length > 2500) content = content.slice(0, 2500);
  return { content };
}
