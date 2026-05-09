const CHAT_SERVICE_URL = process.env.CHAT_SERVICE_URL;
const CHAT_SERVICE_API_KEY = process.env.CHAT_SERVICE_API_KEY;

export interface RagScoreDocument {
  id: string;
  text: string;
}

export interface RagScoreResult {
  id: string;
  score: number;
  whyRelevant?: string;
}

export interface RagScoreRequest {
  documents: RagScoreDocument[];
  brandId: string;
  campaignId?: string;
}

export interface RagScoreResponse {
  results: RagScoreResult[];
}

export async function ragScore(
  request: RagScoreRequest,
  orgId: string,
  userId?: string,
  runId?: string
): Promise<RagScoreResponse> {
  // TODO(rag-endpoint): chat-service /orgs/rag/score not yet implemented.
  // Fallback: assign descending recency-based scores so end-to-end flow remains testable.
  if (!CHAT_SERVICE_URL || !CHAT_SERVICE_API_KEY) {
    return fallbackScore(request);
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": CHAT_SERVICE_API_KEY,
    "x-org-id": orgId,
  };
  if (userId) headers["x-user-id"] = userId;
  if (runId) headers["x-run-id"] = runId;

  const response = await fetch(`${CHAT_SERVICE_URL}/orgs/rag/score`, {
    method: "POST",
    headers,
    body: JSON.stringify(request),
  });

  if (response.status === 404) {
    return fallbackScore(request);
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `chat-service POST /orgs/rag/score failed (${response.status}): ${body}`
    );
  }

  return (await response.json()) as RagScoreResponse;
}

function fallbackScore(request: RagScoreRequest): RagScoreResponse {
  const total = request.documents.length;
  const results = request.documents.map((doc, i) => ({
    id: doc.id,
    score: total <= 1 ? 1 : Math.max(0, 1 - i / total),
    whyRelevant: "fallback recency-based score (rag endpoint unavailable)",
  }));
  return { results };
}
