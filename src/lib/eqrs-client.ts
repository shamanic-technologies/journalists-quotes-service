/**
 * HTTP client to expert-quotes-requests-service (EQRS).
 *
 * EQRS owns Featured.com auth (JWT lifecycle), rate limit, bronze raw
 * payload, and cursor pagination. This client is a thin wrapper —
 * journalists-quotes-service no longer touches featured.com directly.
 *
 * Failure mode: missing env vars / non-2xx responses throw. The caller
 * surfaces 502 upstream — except a 402 (insufficient credit), which the
 * caller surfaces as 402 since EQRS owns the featured-submit credit gate.
 * NO silent fallback.
 */

/**
 * Thrown on a non-2xx response from EQRS. Carries the upstream HTTP
 * `status` so callers can map it (e.g. 402 insufficient-credit → 402).
 * Mirrors the repo's BillingServiceError / EmailGatewayError pattern.
 */
export class EqrsServiceError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body?: string
  ) {
    super(message);
    this.name = "EqrsServiceError";
  }
}

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

/**
 * A single Featured/Connectively submission record, as decoded from EQRS's
 * `GET /orgs/featured/submissions` pass-through (Connectively `/submitted`).
 *
 * The match key onto a JQS pitch is `(featuredQuestionId, profileId)` — the
 * exact pair JQS stores as `(featured_question_id, featured_profile_id)`.
 *
 * `status` is Connectively's verbatim label (`In Review` | `Selected` |
 * `Published` | `Not Selected`). The `/submitted` feed carries status +
 * outlet + DR + attribution but NOT the published article's URL/title/date
 * — those come from the separate `/published` feed (see
 * `EqrsPublishedArticle`).
 */
export interface EqrsSubmittedOutcome {
  featuredQuestionId: number;
  profileId: number;
  status: string;
  publicationSource: string | null;
  domainAuthority: number | null;
  attribution: string | null;
  submissionDate: string | null;
}

/**
 * A single published-article record, decoded from EQRS's
 * `GET /orgs/featured/published` pass-through (Connectively `/published`).
 *
 * This is the feed that DOES carry the placement fields absent from
 * `/submitted`: `publishedLink` (the article URL), `articleTitle`, and
 * `publishDate` (when the article went live). Matched onto a pitch by the
 * same `(featuredQuestionId, profileId)` key.
 *
 * `articleUrl`/`publishDate` are present on ~100% of published rows;
 * `articleTitle` on ~95% (null when Connectively omits it). Never
 * fabricated — a missing field decodes to null.
 */
export interface EqrsPublishedArticle {
  featuredQuestionId: number;
  profileId: number;
  articleUrl: string | null;
  articleTitle: string | null;
  publishDate: string | null;
}

export interface EqrsClient {
  fetchOpportunities(args: {
    orgId: string;
    userId?: string;
    runId?: string;
    audienceId?: string;
    since?: string;
    limit?: number;
  }): Promise<EqrsOpportunitiesResponse>;

  fetchPremiumQuestions(args: {
    orgId: string;
    userId?: string;
    runId?: string;
    audienceId?: string;
  }): Promise<EqrsPremiumQuestionsResponse>;

  submitAnswer(args: {
    orgId: string;
    userId?: string;
    runId?: string;
    audienceId?: string;
    brandId: string;
    featuredQuestionId: number;
    answer: string;
  }): Promise<EqrsSubmitResult>;

  /**
   * Pull the full list of Featured/Connectively submission outcomes for the
   * org (paginated internally). Used by the pitch-outcome reconcile to
   * advance pitch status + record press-value metadata. Throws
   * EqrsServiceError on a non-2xx from EQRS. NO silent fallback.
   */
  fetchSubmittedOutcomes(args: {
    orgId: string;
    userId?: string;
    runId?: string;
    audienceId?: string;
  }): Promise<EqrsSubmittedOutcome[]>;

  /**
   * Pull the full list of Featured/Connectively PUBLISHED articles for the
   * org (paginated internally). Used by the pitch-outcome reconcile to
   * persist the article URL/title/publish-date onto published pitches.
   * Throws EqrsServiceError on a non-2xx from EQRS. NO silent fallback.
   */
  fetchPublishedArticles(args: {
    orgId: string;
    userId?: string;
    runId?: string;
    audienceId?: string;
  }): Promise<EqrsPublishedArticle[]>;
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
      if (args.audienceId) headers["x-audience-id"] = args.audienceId;

      const response = await fetchImpl(url, { method: "GET", headers });
      if (!response.ok) {
        const body = await response.text();
        throw new EqrsServiceError(
          `EQRS GET /orgs/featured/opportunities failed (${response.status}): ${body}`,
          response.status,
          body
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
      if (args.audienceId) headers["x-audience-id"] = args.audienceId;

      const response = await fetchImpl(
        `${baseUrl}/orgs/featured/premium-questions`,
        { method: "GET", headers }
      );
      if (!response.ok) {
        const body = await response.text();
        throw new EqrsServiceError(
          `EQRS GET /orgs/featured/premium-questions failed (${response.status}): ${body}`,
          response.status,
          body
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
      if (args.audienceId) headers["x-audience-id"] = args.audienceId;

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
        throw new EqrsServiceError(
          `EQRS POST /orgs/featured/answers failed (${response.status}): ${body}`,
          response.status,
          body
        );
      }
      return (await response.json()) as EqrsSubmitResult;
    },

    async fetchSubmittedOutcomes(args) {
      const { baseUrl, apiKey } = requireEnv();
      const headers: Record<string, string> = {
        "x-api-key": apiKey,
        "x-org-id": args.orgId,
      };
      if (args.userId) headers["x-user-id"] = args.userId;
      if (args.runId) headers["x-run-id"] = args.runId;
      if (args.audienceId) headers["x-audience-id"] = args.audienceId;

      const PAGE_SIZE = 100;
      const MAX_PAGES = 100; // safety cap: 10k submissions
      const outcomes: EqrsSubmittedOutcome[] = [];

      for (let page = 1; page <= MAX_PAGES; page++) {
        const response = await fetchImpl(
          `${baseUrl}/orgs/featured/submissions?page=${page}`,
          { method: "GET", headers }
        );
        if (!response.ok) {
          const body = await response.text();
          throw new EqrsServiceError(
            `EQRS GET /orgs/featured/submissions failed (${response.status}): ${body}`,
            response.status,
            body
          );
        }
        const payload = (await response.json()) as Record<string, unknown>;
        // EQRS is a pass-through of Connectively `/submitted`, which returns
        // `{ submitted: [...] }`. Accept `data` too (the endpoint's OpenAPI
        // types it that way) but fail loud if neither is an array — never a
        // silent empty.
        const rawList =
          (payload.submitted as unknown) ?? (payload.data as unknown);
        if (!Array.isArray(rawList)) {
          throw new EqrsServiceError(
            `EQRS GET /orgs/featured/submissions returned unexpected shape (expected { submitted: [...] }): ${JSON.stringify(
              payload
            ).slice(0, 200)}`,
            502
          );
        }
        for (const raw of rawList as Array<Record<string, unknown>>) {
          const featuredQuestionId = raw.featuredQuestionId;
          const profileId = raw.profileId;
          // A submission with no (question, profile) pair cannot be matched
          // to a pitch — skip it (not fabricating a key).
          if (
            typeof featuredQuestionId !== "number" ||
            typeof profileId !== "number"
          ) {
            continue;
          }
          outcomes.push({
            featuredQuestionId,
            profileId,
            status: typeof raw.status === "string" ? raw.status : "",
            publicationSource:
              typeof raw.publicationSource === "string"
                ? raw.publicationSource
                : null,
            domainAuthority:
              typeof raw.domainAuthority === "number"
                ? raw.domainAuthority
                : null,
            attribution:
              typeof raw.attribution === "string" ? raw.attribution : null,
            submissionDate:
              typeof raw.submissionDate === "string"
                ? raw.submissionDate
                : null,
          });
        }
        if (rawList.length < PAGE_SIZE) break;
      }

      return outcomes;
    },

    async fetchPublishedArticles(args) {
      const { baseUrl, apiKey } = requireEnv();
      const headers: Record<string, string> = {
        "x-api-key": apiKey,
        "x-org-id": args.orgId,
      };
      if (args.userId) headers["x-user-id"] = args.userId;
      if (args.runId) headers["x-run-id"] = args.runId;
      if (args.audienceId) headers["x-audience-id"] = args.audienceId;

      const PAGE_SIZE = 100;
      const MAX_PAGES = 100; // safety cap: 10k published articles
      const articles: EqrsPublishedArticle[] = [];

      for (let page = 1; page <= MAX_PAGES; page++) {
        const response = await fetchImpl(
          `${baseUrl}/orgs/featured/published?page=${page}`,
          { method: "GET", headers }
        );
        if (!response.ok) {
          const body = await response.text();
          throw new EqrsServiceError(
            `EQRS GET /orgs/featured/published failed (${response.status}): ${body}`,
            response.status,
            body
          );
        }
        const payload = (await response.json()) as Record<string, unknown>;
        // EQRS is a pass-through of Connectively `/published`, which returns
        // `{ published: [...] }`. Accept `data` too (defensive) but fail loud
        // if neither is an array — never a silent empty.
        const rawList =
          (payload.published as unknown) ?? (payload.data as unknown);
        if (!Array.isArray(rawList)) {
          throw new EqrsServiceError(
            `EQRS GET /orgs/featured/published returned unexpected shape (expected { published: [...] }): ${JSON.stringify(
              payload
            ).slice(0, 200)}`,
            502
          );
        }
        for (const raw of rawList as Array<Record<string, unknown>>) {
          const featuredQuestionId = raw.featuredQuestionId;
          const profileId = raw.profileId;
          // A published record with no (question, profile) pair cannot be
          // matched to a pitch — skip it (not fabricating a key).
          if (
            typeof featuredQuestionId !== "number" ||
            typeof profileId !== "number"
          ) {
            continue;
          }
          articles.push({
            featuredQuestionId,
            profileId,
            articleUrl:
              typeof raw.publishedLink === "string" ? raw.publishedLink : null,
            articleTitle:
              typeof raw.articleTitle === "string" ? raw.articleTitle : null,
            publishDate:
              typeof raw.publishDate === "string" ? raw.publishDate : null,
          });
        }
        if (rawList.length < PAGE_SIZE) break;
      }

      return articles;
    },
  };
}
