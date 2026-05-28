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
  brandIds: string[];
}

export interface RagScoreResponse {
  results: RagScoreResult[];
}

/**
 * Score documents against a multi-brand tuple. The brandSet
 * `brandIds: string[]` is sent as a single tuple to chat-service
 * `POST /orgs/rag/score` — one score per document for the tuple, NOT
 * a per-brand fan-out + mean. A co-brand tuple [A,B] is a distinct
 * scoring target from solo [A].
 *
 * No fallback. Missing env vars / non-2xx response throw; the route's
 * error handler surfaces 502 upstream.
 */
export async function ragScore(
  request: RagScoreRequest,
  orgId: string,
  userId?: string,
  runId?: string
): Promise<RagScoreResponse> {
  const chatServiceUrl = process.env.CHAT_SERVICE_URL;
  const chatServiceApiKey = process.env.CHAT_SERVICE_API_KEY;
  if (!chatServiceUrl) throw new Error("CHAT_SERVICE_URL is not set");
  if (!chatServiceApiKey) throw new Error("CHAT_SERVICE_API_KEY is not set");
  if (request.brandIds.length === 0) {
    throw new Error("ragScore: brandIds must be non-empty");
  }
  if (request.documents.length === 0) return { results: [] };

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": chatServiceApiKey,
    "x-org-id": orgId,
  };
  if (userId) headers["x-user-id"] = userId;
  if (runId) headers["x-run-id"] = runId;

  const response = await fetch(`${chatServiceUrl}/orgs/rag/score`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      documents: request.documents,
      brandIds: request.brandIds,
    }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `chat-service POST /orgs/rag/score failed (${response.status}): ${body}`
    );
  }
  return (await response.json()) as RagScoreResponse;
}
