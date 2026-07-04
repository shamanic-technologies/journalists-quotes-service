import { z } from "zod";
import {
  OpenAPIRegistry,
  extendZodWithOpenApi,
} from "@asteasolutions/zod-to-openapi";

extendZodWithOpenApi(z);

export const registry = new OpenAPIRegistry();

const apiKeyAuth = registry.registerComponent("securitySchemes", "ApiKeyAuth", {
  type: "apiKey",
  in: "header",
  name: "x-api-key",
});

export const ErrorResponseSchema = z
  .object({ error: z.string() })
  .openapi("ErrorResponse");

// ==================== Quote Request Schemas ====================

export const QuoteRequestSchema = z
  .object({
    id: z.string().uuid(),
    provider: z.string(),
    ingestionChannel: z.string(),
    externalId: z.string(),
    featuredQuestionId: z.number().int().nullable(),
    inboundEmailId: z.string().uuid().nullable(),
    mediaOutlet: z.string().nullable(),
    journalistName: z.string().nullable(),
    journalistEmail: z.string().nullable(),
    pitchEmail: z.string().nullable(),
    category: z.string().nullable(),
    opportunityText: z.string(),
    pitchUrl: z.string().nullable(),
    deadline: z.string().nullable(),
    fetchedAt: z.string(),
    quoteOpportunityId: z.string().uuid().nullable(),
    isCanonical: z.boolean(),
    fingerprint: z.string().nullable(),
    orgId: z.string().uuid(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("ProviderQuoteRequest");

export const QuoteRequestListQuerySchema = z.object({
  campaign_id: z.string().uuid().optional(),
  provider: z.string().optional(),
  ingestion_channel: z.string().optional(),
  limit: z.string().optional(),
  offset: z.string().optional(),
});

export const QuoteOpportunitySchema = z
  .object({
    id: z.string().uuid(),
    fingerprint: z.string(),
    canonicalText: z.string(),
    canonicalOutlet: z.string().nullable(),
    canonicalDeadline: z.string().nullable(),
    clusterMethod: z.enum(["fingerprint", "embedding", "manual"]),
    firstSeenAt: z.string(),
    lastSeenAt: z.string(),
    createdAt: z.string(),
  })
  .openapi("QuoteOpportunity");

export const InboundEmailSchema = z
  .object({
    id: z.string().uuid(),
    messageId: z.string(),
    fromEmail: z.string(),
    toEmail: z.string(),
    subject: z.string().nullable(),
    receivedAt: z.string(),
    provider: z.string().nullable(),
    ingestionChannel: z.string(),
    sourceAlias: z.string().nullable(),
    processingStatus: z.enum(["pending", "parsed", "failed", "skipped"]),
    parseError: z.string().nullable(),
    createdAt: z.string(),
  })
  .openapi("InboundEmail");

export const QuoteRequestStatsSchema = z
  .object({
    totalRequests: z.number().int(),
    totalPitched: z.number().int(),
  })
  .openapi("QuoteRequestStats");

// ==================== Quote Pitch Schemas ====================

export const QuotePitchSchema = z
  .object({
    id: z.string().uuid(),
    quoteRequestId: z.string().uuid(),
    quoteOpportunityId: z.string().uuid().nullable(),
    featuredQuestionId: z.number().int().nullable(),
    featuredProfileId: z.number().int().nullable(),
    campaignId: z.string().uuid().nullable(),
    brandIds: z.array(z.string().uuid()),
    draft: z.string().nullable(),
    pitchCharCount: z.number().int().nullable(),
    pitchAttempts: z.number().int().nullable(),
    contentGenRunId: z.string().uuid().nullable(),
    submittedAt: z.string().nullable(),
    status: z.enum([
      "drafted",
      "submitted",
      "selected",
      "published",
      "not_selected",
      "error",
      "length_violation",
      "template_missing",
      "brand_missing_fields",
      "insufficient_credits",
      // Terminal, BLOCKING: dead Featured question (submit 404 "Question
      // not found"). Served on the wire by GET /orgs/quote-pitches[/:id].
      "question_not_found",
    ]),
    deliveryMethod: z.enum(["featured_api", "email_reply"]),
    deliveryTarget: z.string().nullable(),
    outboundMessageId: z.string().nullable(),
    replyInThreadMessageId: z.string().nullable(),
    bounceStatus: z.string().nullable(),
    featuredArticleUrl: z.string().nullable(),
    error: z.string().nullable(),
    errorDetails: z.unknown().nullable(),
    parentRunId: z.string().uuid().nullable(),
    runId: z.string().uuid().nullable(),
    orgId: z.string().uuid(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("QuotePitch");

export const QuotePitchListQuerySchema = z.object({
  campaign_id: z.string().uuid().optional(),
  status: z
    .enum([
      "drafted",
      "submitted",
      "selected",
      "published",
      "not_selected",
      "error",
      "length_violation",
      "template_missing",
      "brand_missing_fields",
      "insufficient_credits",
      "question_not_found",
    ])
    .optional(),
  limit: z.string().optional(),
  offset: z.string().optional(),
});

// ==================== Opportunity Workflow Schemas ====================

export const OpportunityDiscoverResponseSchema = z
  .object({
    scored: z.number().int(),
    exhausted: z.boolean(),
    brandIds: z.array(z.string().uuid()),
  })
  .openapi("OpportunityDiscoverResponse");

export const OpportunityReplyRequestSchema = z
  .object({
    pitchContent: z.string().min(1),
    campaignId: z.string().uuid().optional(),
    subject: z.string().optional(),
  })
  .openapi("OpportunityReplyRequest");

export const PitchStatusSchema = z
  .enum([
    "drafted",
    "submitted",
    "selected",
    "published",
    "not_selected",
    "error",
    "length_violation",
    "template_missing",
    "brand_missing_fields",
    "insufficient_credits",
    // Terminal, BLOCKING dead-question status — annotated on the wire by
    // GET /orgs/opportunities + /ranked pitchStatus (brand-atomic).
    "question_not_found",
  ])
  .openapi("PitchStatus");

export const FullQuoteOpportunitySchema = z
  .object({
    opportunityId: z.string().uuid(),
    provider: z.string(),
    ingestionChannel: z.string(),
    featuredQuestionId: z.number().int().nullable(),
    mediaOutlet: z.string().nullable(),
    journalistName: z.string().nullable(),
    opportunityText: z.string(),
    deadline: z.string().nullable(),
    pitchUrl: z.string().nullable(),
    pitchEmail: z.string().nullable(),
    category: z.string().nullable(),
    score: z.number(),
    whyRelevant: z.string().nullable(),
  })
  .openapi("FullQuoteOpportunity");

export const RankedOpportunitySchema = FullQuoteOpportunitySchema.extend({
  pitchStatus: PitchStatusSchema.nullable(),
}).openapi("RankedOpportunity");

export const OpportunityNextResponseSchema = z
  .discriminatedUnion("found", [
    z.object({ found: z.literal(false) }),
    z.object({
      found: z.literal(true),
      opportunity: FullQuoteOpportunitySchema,
      brandIds: z.array(z.string().uuid()),
    }),
  ])
  .openapi("OpportunityNextResponse");

export const OpportunityRankedResponseSchema = z
  .object({
    status: z.literal("ok"),
    opportunities: z.array(RankedOpportunitySchema),
    total: z.number().int(),
    brandIds: z.array(z.string().uuid()),
  })
  .openapi("OpportunityRankedResponse");

export const OpportunityStatsResponseSchema = z
  .object({
    silverPoolSize: z.number().int(),
    scoredCount: z.number().int(),
    eligibleCount: z.number().int(),
    pitchedBlocking: z.number().int(),
    expiredCount: z.number().int(),
    bestEligibleScore: z.number().nullable(),
    brandIds: z.array(z.string().uuid()),
  })
  .openapi("OpportunityStatsResponse");

export const OpportunityReplyResponseSchema = z
  .object({
    status: z.enum([
      "submitted",
      "already_submitted",
      "rate_limited",
      "error",
    ]),
    pitchId: z.string().uuid().optional(),
    deliveryMethod: z.enum(["featured_api", "email_reply"]).optional(),
    outboundMessageId: z.string().nullable().optional(),
    featuredQuestionId: z.number().int().nullable().optional(),
    retryAfter: z.number().int().optional(),
    error: z.string().optional(),
  })
  .openapi("OpportunityReplyResponse");

// ==================== Internal Worker Schemas ====================

export const ProcessInboundEmailsResponseSchema = z
  .object({
    processed: z.number().int(),
    parsed: z.number().int(),
    failed: z.number().int(),
    skipped: z.number().int(),
    silverRowsInserted: z.number().int(),
    goldClustersCreated: z.number().int(),
  })
  .openapi("ProcessInboundEmailsResponse");

// ==================== Inbound Email Webhook Schemas ====================

export const PostmarkInboundFullSchema = z.object({
  Email: z.string().min(1),
  Name: z.string().optional(),
  MailboxHash: z.string().optional(),
});

export const PostmarkInboundWebhookSchema = z
  .object({
    MessageID: z.string().min(1),
    From: z.string().min(1),
    FromFull: PostmarkInboundFullSchema.optional(),
    To: z.string().min(1),
    ToFull: z.array(PostmarkInboundFullSchema).optional(),
    Subject: z.string().optional(),
    Date: z.string().optional(),
    TextBody: z.string().optional(),
    HtmlBody: z.string().optional(),
  })
  .passthrough()
  .openapi("PostmarkInboundWebhook");

export type PostmarkInboundWebhook = z.infer<typeof PostmarkInboundWebhookSchema>;

export const InboundEmailAcceptedResponseSchema = z
  .object({
    accepted: z.boolean(),
    inboundEmailId: z.string().uuid().optional(),
    deduplicated: z.boolean().optional(),
  })
  .openapi("InboundEmailAcceptedResponse");

// ==================== Path Registrations ====================

const orgHeaders = z.object({
  "x-org-id": z.string().uuid(),
  "x-brand-id": z
    .string()
    .describe(
      "Brand UUID(s) for this call. CSV when plural — e.g. `<uuid1>,<uuid2>`. Canonicalized server-side (deduplicated + sorted). All ranking, score caching, and pitch idempotency keys use the canonical brand_ids[] set."
    ),
});

const orgHeadersOptionalBrand = z.object({
  "x-org-id": z.string().uuid(),
});

// Mandatory header set for the score-as-you-go routes (/next + /discover):
// org + brand + user + run + campaign. Both drive the LLM judge
// (tier-mirrored downstream needing x-user-id + x-run-id) and are always
// invoked inside a campaign workflow (x-campaign-id required).
const orgHeadersScoring = z.object({
  "x-org-id": z.string().uuid(),
  "x-brand-id": z
    .string()
    .describe(
      "Brand UUID(s) for this call. CSV when plural — e.g. `<uuid1>,<uuid2>`. Canonicalized server-side (deduplicated + sorted)."
    ),
  "x-user-id": z.string().uuid(),
  "x-run-id": z.string().uuid(),
  "x-campaign-id": z.string().uuid(),
});

registry.registerPath({
  method: "get",
  path: "/health",
  summary: "Health check",
  responses: {
    200: {
      description: "Service is healthy",
      content: {
        "application/json": {
          schema: z.object({
            status: z.string(),
            timestamp: z.string(),
            service: z.string(),
          }),
        },
      },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/orgs/opportunities/next",
  summary:
    "Return the single highest-scored Gold-cluster opportunity not yet pitched for the brand-set (campaign-scoped). Score-as-you-go: scores ≤10 unscored clusters then returns the best non-pitched candidate. Identity flows entirely via headers — x-brand-id (CSV when plural), x-user-id, x-run-id, x-campaign-id are ALL required (no request body). Pitch-block scope is the (brand-set, campaign) tuple. Returns { found: false } when nothing eligible remains.",
  security: [{ [apiKeyAuth.name]: [] }],
  request: {
    headers: orgHeadersScoring,
  },
  responses: {
    200: {
      description: "Next available opportunity, or { found: false }",
      content: {
        "application/json": { schema: OpportunityNextResponseSchema },
      },
    },
    400: {
      description:
        "Validation error (missing/invalid x-brand-id, x-user-id, x-run-id, or x-campaign-id header)",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    502: {
      description: "Upstream service unavailable (EQRS, chat-service)",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/orgs/opportunities/discover",
  summary:
    "Write-only batch scorer. Scores ≤10 unscored submittable clusters for the brand-set (ordered by deadline urgency), pulling Featured premium questions from EQRS when the silver pool is exhausted. Returns { scored, exhausted } — no opportunity payload; read the catalog via GET /orgs/opportunities. The caller loops `while (!exhausted)` (credit-gating between calls in its own workflow) to drain the whole submittable pool. Same mandatory headers as /next.",
  security: [{ [apiKeyAuth.name]: [] }],
  request: {
    headers: orgHeadersScoring,
  },
  responses: {
    200: {
      description:
        "Batch result: number scored this call + whether the pool is drained",
      content: {
        "application/json": { schema: OpportunityDiscoverResponseSchema },
      },
    },
    400: {
      description:
        "Validation error (missing/invalid x-brand-id, x-user-id, x-run-id, or x-campaign-id header)",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    502: {
      description: "Upstream service unavailable (EQRS, chat-service)",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/orgs/opportunities",
  summary:
    "Paginated read-only list of ALL scored Gold-cluster opportunities for the brand-set (NO relevance floor — every scored premium opp is returned with its `score` so the dashboard filters client-side), sorted by score desc. Pure-read (no scoring, no ingest) — the canonical read surface, polled by the HITL dashboard. Filters expired deadlines + restricts to submittable (premium) clusters. Query: `?campaignId=&limit=&offset=` (campaignId optional; pitchStatus annotated for that campaign when set, else brand-set wide). Brand identity via x-brand-id header (CSV when plural).",
  security: [{ [apiKeyAuth.name]: [] }],
  request: {
    headers: orgHeaders,
    query: z.object({
      campaignId: z.string().uuid().optional(),
      limit: z.coerce.number().int().min(1).optional(),
      offset: z.coerce.number().int().min(0).optional(),
    }),
  },
  responses: {
    200: {
      description: "All scored opportunities for the brand-set (no relevance floor), sorted by score desc",
      content: {
        "application/json": { schema: OpportunityRankedResponseSchema },
      },
    },
    400: {
      description: "Validation error (missing/invalid x-brand-id header or query params)",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/orgs/opportunities/stats",
  summary:
    "Brand-set scoped Gold catalog stats — silverPoolSize, scoredCount, eligibleCount, pitchedBlocking, expiredCount, bestEligibleScore. Pure-read (no scoring, no ingest). Brand identity via `x-brand-id` header (CSV when plural). When `campaign_id` query param is set, pitch-blocking + best-eligible scope to that campaign; otherwise brand-set wide.",
  security: [{ [apiKeyAuth.name]: [] }],
  request: {
    headers: orgHeaders,
    query: z.object({ campaign_id: z.string().uuid().optional() }),
  },
  responses: {
    200: {
      description: "Catalog stats for the brand-set tuple",
      content: {
        "application/json": { schema: OpportunityStatsResponseSchema },
      },
    },
    400: {
      description: "Validation error (missing/invalid x-brand-id header or campaign_id)",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/orgs/opportunities/{id}/reply",
  summary:
    "Submit a pitch reply for the given Gold-cluster opportunity. `id` = quote_opportunities.id. Brand identity via x-brand-id header (CSV when plural). Body: `{ pitchContent, campaignId?, subject? }`. The service picks a representative silver row from the cluster (Featured-API preferred, else most recently fetched email) and dispatches via Featured submitAnswer or email-gateway /orgs/send. Idempotency: exact-match on (quote_opportunity_id, sorted brand_ids[]). Co-branded pitch [A,B] is distinct from solo [A]. Block statuses: drafted/submitted/selected/published/not_selected.",
  security: [{ [apiKeyAuth.name]: [] }],
  request: {
    headers: orgHeaders,
    params: z.object({ id: z.string().uuid() }),
    body: {
      content: {
        "application/json": { schema: OpportunityReplyRequestSchema },
      },
    },
  },
  responses: {
    200: {
      description: "Pitch dispatched (or idempotent already-submitted)",
      content: {
        "application/json": { schema: OpportunityReplyResponseSchema },
      },
    },
    400: {
      description: "Validation error or unsupported opportunity",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    404: {
      description: "Opportunity not found for this org",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    502: {
      description: "Upstream service unavailable",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/internal/process-inbound-emails",
  summary:
    "Drain pending inbound_emails rows, dispatch to parser by provider, insert silver rows + fingerprint cluster",
  security: [{ [apiKeyAuth.name]: [] }],
  responses: {
    200: {
      description: "Processing result",
      content: {
        "application/json": { schema: ProcessInboundEmailsResponseSchema },
      },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/orgs/quote-requests",
  summary: "List silver quote requests for the org",
  security: [{ [apiKeyAuth.name]: [] }],
  request: { headers: orgHeadersOptionalBrand, query: QuoteRequestListQuerySchema },
  responses: {
    200: {
      description: "List of quote requests",
      content: {
        "application/json": {
          schema: z.object({
            providerQuoteRequests: z.array(QuoteRequestSchema),
          }),
        },
      },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/orgs/quote-requests/stats",
  summary: "Aggregate stats for quote requests + pitches",
  security: [{ [apiKeyAuth.name]: [] }],
  request: {
    headers: orgHeadersOptionalBrand,
    query: z.object({ campaign_id: z.string().uuid().optional() }),
  },
  responses: {
    200: {
      description: "Stats",
      content: {
        "application/json": { schema: QuoteRequestStatsSchema },
      },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/orgs/quote-requests/{id}",
  summary: "Get a single quote request",
  security: [{ [apiKeyAuth.name]: [] }],
  request: {
    headers: orgHeadersOptionalBrand,
    params: z.object({ id: z.string().uuid() }),
  },
  responses: {
    200: {
      description: "Quote request",
      content: {
        "application/json": {
          schema: z.object({ quoteRequest: QuoteRequestSchema }),
        },
      },
    },
    404: {
      description: "Not found",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/orgs/quote-pitches",
  summary: "List quote pitches for the org",
  security: [{ [apiKeyAuth.name]: [] }],
  request: { headers: orgHeadersOptionalBrand, query: QuotePitchListQuerySchema },
  responses: {
    200: {
      description: "List of quote pitches",
      content: {
        "application/json": {
          schema: z.object({ quotePitches: z.array(QuotePitchSchema) }),
        },
      },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/orgs/quote-pitches/{id}",
  summary: "Get a single quote pitch",
  security: [{ [apiKeyAuth.name]: [] }],
  request: {
    headers: orgHeadersOptionalBrand,
    params: z.object({ id: z.string().uuid() }),
  },
  responses: {
    200: {
      description: "Quote pitch",
      content: {
        "application/json": {
          schema: z.object({ quotePitch: QuotePitchSchema }),
        },
      },
    },
    404: {
      description: "Not found",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/webhooks/inbound-email",
  summary:
    "Receive inbound email forwarded by email-gateway-service (raw Postmark payload)",
  description:
    "HMAC-verified push endpoint. Header `x-eg-signature: t=<unix_seconds>,v1=<hex sha256(t + \".\" + body, secret)>` required (300s replay window). Idempotent on Postmark MessageID.",
  request: {
    headers: z.object({
      "x-eg-signature": z.string(),
    }),
    body: {
      content: {
        "application/json": { schema: PostmarkInboundWebhookSchema },
      },
    },
  },
  responses: {
    200: {
      description: "Email accepted (or deduplicated)",
      content: {
        "application/json": { schema: InboundEmailAcceptedResponseSchema },
      },
    },
    400: {
      description: "Malformed payload",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    401: {
      description: "Invalid HMAC signature",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});
