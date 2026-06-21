/**
 * LLM relevance judge. Replaces the prior RAG (semantic-similarity)
 * scorer. Calls chat-service `POST /complete` with a judge system
 * prompt + strict `responseSchema`, returning a 0-100 relevance score
 * per opportunity for the brand-set.
 *
 * Bands (interpretation, derived at read — NOT stored):
 *   70-100  directly relevant — brand is a credible expert source
 *   30-69   adjacent — related topic, not a direct fit
 *   0-29    off-topic — different, non-adjacent subject
 *
 * No fallback. Missing env vars / non-2xx / unparsable response throw;
 * the route's error handler surfaces 502 upstream.
 */

export interface JudgeDocument {
  id: string;
  text: string;
}

export interface JudgeResult {
  id: string;
  score: number; // 0-100
  reasoning: string;
}

export interface JudgeResponse {
  results: JudgeResult[];
}

const JUDGE_PROVIDER = "google";
const JUDGE_MODEL = "flash";
const JUDGE_TEMPERATURE = 0.2;

const RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          score: { type: "integer" },
          reasoning: { type: "string" },
        },
        required: ["id", "score", "reasoning"],
      },
    },
  },
  required: ["results"],
};

function buildSystemPrompt(brandContext: string): string {
  return [
    "You are a PR relevance judge. Given a brand profile and a set of journalist quote-request opportunities, score how relevant each opportunity is for THIS brand to respond to as an expert source.",
    "",
    "Score 0-100 per opportunity:",
    "- 70-100: directly relevant — the brand is a credible expert source for this exact request.",
    "- 30-69: adjacent — related/neighbouring topic, not a direct fit, but defensible.",
    "- 0-29: off-topic — a different, non-adjacent subject the brand has no standing on.",
    "",
    "Judge the brand-set as a whole (collective relevance), not each brand individually.",
    "Be strict: a superficial keyword overlap is NOT direct relevance. Ask whether a journalist would credibly quote this brand on this request.",
    "Return one result per opportunity id provided. `reasoning` is one concise sentence explaining the score.",
    "",
    "Brand profile:",
    brandContext,
  ].join("\n");
}

export async function judgeRelevance(args: {
  documents: JudgeDocument[];
  brandContext: string;
  orgId: string;
  userId?: string;
  runId?: string;
  audienceId?: string;
}): Promise<JudgeResponse> {
  const { documents, brandContext, orgId, userId, runId, audienceId } = args;

  const chatServiceUrl = process.env.CHAT_SERVICE_URL;
  const chatServiceApiKey = process.env.CHAT_SERVICE_API_KEY;
  if (!chatServiceUrl) throw new Error("CHAT_SERVICE_URL is not set");
  if (!chatServiceApiKey) throw new Error("CHAT_SERVICE_API_KEY is not set");
  if (documents.length === 0) return { results: [] };

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": chatServiceApiKey,
    "x-org-id": orgId,
  };
  if (userId) headers["x-user-id"] = userId;
  if (runId) headers["x-run-id"] = runId;
  // Forward the campaign audience so chat-service tags the judge LLM
  // cost (the biggest spend on the press-pitch path) to this audience.
  if (audienceId) headers["x-audience-id"] = audienceId;

  const message = [
    "Score these opportunities. Return a `results` array with one entry per id.",
    "",
    JSON.stringify(
      documents.map((d) => ({ id: d.id, opportunity: d.text })),
      null,
      2
    ),
  ].join("\n");

  const response = await fetch(`${chatServiceUrl}/complete`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      message,
      systemPrompt: buildSystemPrompt(brandContext),
      provider: JUDGE_PROVIDER,
      model: JUDGE_MODEL,
      temperature: JUDGE_TEMPERATURE,
      responseFormat: "json",
      responseSchema: RESPONSE_SCHEMA,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `chat-service POST /complete (judge) failed (${response.status}): ${body}`
    );
  }

  const data = (await response.json()) as {
    json?: { results?: JudgeResult[] };
  };
  if (!data.json || !Array.isArray(data.json.results)) {
    throw new Error(
      "chat-service /complete (judge) returned no parsable results array"
    );
  }
  return { results: data.json.results };
}
