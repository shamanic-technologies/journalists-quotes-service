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

interface UpstreamRagScoreResponse {
  results: { id: string; score: number; whyRelevant?: string }[];
}

/**
 * Score documents against a multi-brand profile. chat-service
 * /orgs/rag/score is currently single-brand; we loop per brand and
 * aggregate scores per document by arithmetic mean. One quote_priorities
 * row is later persisted per (opportunity, brandSet) — exactly one score
 * per opportunity per multi-brand set.
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

  const perBrand = await Promise.all(
    request.brandIds.map(async (brandId) => {
      const response = await fetch(`${chatServiceUrl}/orgs/rag/score`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          documents: request.documents,
          brandId,
        }),
      });
      if (!response.ok) {
        const body = await response.text();
        throw new Error(
          `chat-service POST /orgs/rag/score failed (${response.status}): ${body}`
        );
      }
      return (await response.json()) as UpstreamRagScoreResponse;
    })
  );

  const acc = new Map<
    string,
    { sum: number; count: number; whyRelevant?: string }
  >();
  for (const r of perBrand) {
    for (const item of r.results) {
      const prev = acc.get(item.id);
      if (prev) {
        acc.set(item.id, {
          sum: prev.sum + item.score,
          count: prev.count + 1,
          whyRelevant: prev.whyRelevant ?? item.whyRelevant,
        });
      } else {
        acc.set(item.id, {
          sum: item.score,
          count: 1,
          whyRelevant: item.whyRelevant,
        });
      }
    }
  }

  const results: RagScoreResult[] = [];
  for (const [id, agg] of acc) {
    results.push({
      id,
      score: agg.count > 0 ? agg.sum / agg.count : 0,
      whyRelevant: agg.whyRelevant,
    });
  }
  return { results };
}
