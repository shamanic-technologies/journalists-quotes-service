/**
 * HTTP client to expert-quotes-requests-service (EQRS).
 *
 * EQRS owns Featured.com auth (JWT lifecycle), rate limit, bronze raw
 * payload, and cursor pagination. This client is a thin wrapper —
 * journalists-quotes-service no longer touches featured.com directly.
 *
 * Failure mode: missing env vars / non-2xx responses throw. The caller
 * surfaces 502 upstream. NO silent fallback.
 */

export interface EqrsOpportunity {
  id: string;
  externalId: string;
  featuredQuestionId: number;
  opportunityText: string;
  mediaOutlet: string | null;
  source: string | null;
  pitchUrl: string | null;
  deadline: string | null;
  raw: unknown | null;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface EqrsOpportunitiesResponse {
  items: EqrsOpportunity[];
  nextSince: string | null;
  refreshed: boolean;
}

/**
 * A Featured PREMIUM question — the only Featured feed that is
 * programmatically submittable via POST /orgs/featured/answers.
 * Carries a `featuredQuestionId` (always present, unlike the discovery
 * `/opportunities` feed where it is null). EQRS exposes this as a
 * pass-through to Featured's premium-question-list (no cursor, no
 * bronze — returns the current premium list each call).
 */
export interface EqrsPremiumQuestion {
  featuredQuestionId: number;
  question: string;
  source: string | null;
  mediaOutlet: string | null;
  pitchUrl: string | null;
  createdAt: string | null;
  deadline: string | null;
}

export interface EqrsPremiumQuestionsResponse {
  questions: EqrsPremiumQuestion[];
}

export type EqrsSubmitResult =
  | {
      status: "submitted";
      featuredQuestionId: number;
      featuredProfileId?: number;
    }
  | { status: "rate_limited"; retryAfter: number }
  | { status: "error"; error: string };

export interface EqrsClient {
  fetchOpportunities(args: {
    orgId: string;
    userId?: string;
    runId?: string;
    since?: string;
    limit?: number;
  }): Promise<EqrsOpportunitiesResponse>;

  fetchPremiumQuestions(args: {
    orgId: string;
    userId?: string;
    runId?: string;
  }): Promise<EqrsPremiumQuestionsResponse>;

  submitAnswer(args: {
    orgId: string;
    userId?: string;
    runId?: string;
    brandId: string;
    featuredQuestionId: number;
    answer: string;
  }): Promise<EqrsSubmitResult>;
}

export interface EqrsClientOptions {
  fetchImpl?: typeof fetch;
}

function requireEnv(): { baseUrl: string; apiKey: string } {
  const baseUrl = process.env.EXPERT_QUOTES_REQUESTS_SERVICE_URL;
  const apiKey = process.env.EXPERT_QUOTES_REQUESTS_SERVICE_API_KEY;
  if (!baseUrl)
    throw new Error("EXPERT_QUOTES_REQUESTS_SERVICE_URL is not set");
  if (!apiKey)
    throw new Error("EXPERT_QUOTES_REQUESTS_SERVICE_API_KEY is not set");
  return { baseUrl, apiKey };
}

export function createEqrsClient(
  options: EqrsClientOptions = {}
): EqrsClient {
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    async fetchOpportunities(args) {
      const { baseUrl, apiKey } = requireEnv();
      const params = new URLSearchParams();
      if (args.since) params.set("since", args.since);
      if (args.limit != null) params.set("limit", String(args.limit));
      const qs = params.toString();
      const url = `${baseUrl}/orgs/featured/opportunities${qs ? "?" + qs : ""}`;

      const headers: Record<string, string> = {
        "x-api-key": apiKey,
        "x-org-id": args.orgId,
      };
      if (args.userId) headers["x-user-id"] = args.userId;
      if (args.runId) headers["x-run-id"] = args.runId;

      const response = await fetchImpl(url, { method: "GET", headers });
      if (!response.ok) {
        const body = await response.text();
        throw new Error(
          `EQRS GET /orgs/featured/opportunities failed (${response.status}): ${body}`
        );
      }
      return (await response.json()) as EqrsOpportunitiesResponse;
    },

    async fetchPremiumQuestions(args) {
      const { baseUrl, apiKey } = requireEnv();
      const headers: Record<string, string> = {
        "x-api-key": apiKey,
        "x-org-id": args.orgId,
      };
      if (args.userId) headers["x-user-id"] = args.userId;
      if (args.runId) headers["x-run-id"] = args.runId;

      const response = await fetchImpl(
        `${baseUrl}/orgs/featured/premium-questions`,
        { method: "GET", headers }
      );
      if (!response.ok) {
        const body = await response.text();
        throw new Error(
          `EQRS GET /orgs/featured/premium-questions failed (${response.status}): ${body}`
        );
      }
      return (await response.json()) as EqrsPremiumQuestionsResponse;
    },

    async submitAnswer(args) {
      const { baseUrl, apiKey } = requireEnv();
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "x-org-id": args.orgId,
      };
      if (args.userId) headers["x-user-id"] = args.userId;
      if (args.runId) headers["x-run-id"] = args.runId;

      const response = await fetchImpl(
        `${baseUrl}/orgs/featured/answers`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            brandId: args.brandId,
            featuredQuestionId: args.featuredQuestionId,
            answer: args.answer,
          }),
        }
      );
      if (!response.ok) {
        const body = await response.text();
        throw new Error(
          `EQRS POST /orgs/featured/answers failed (${response.status}): ${body}`
        );
      }
      return (await response.json()) as EqrsSubmitResult;
    },
  };
}
