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
    campaignId: z.string().uuid(),
    brandId: z.string().uuid(),
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
    ])
    .optional(),
  limit: z.string().optional(),
  offset: z.string().optional(),
});

// ==================== Opportunity Workflow Schemas ====================

export const OpportunityNextRequestSchema = z
  .object({
    campaignId: z.string().uuid(),
    brandId: z.string().uuid(),
  })
  .openapi("OpportunityNextRequest");

export const OpportunityNextResponseSchema = z
  .union([
    z.object({
      status: z.literal("match"),
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
      score: z.number(),
      whyRelevant: z.string().nullable(),
    }),
    z.object({ status: z.literal("no_match") }),
  ])
  .openapi("OpportunityNextResponse");

export const OpportunityReplyRequestSchema = z
  .object({
    pitchContent: z.string().min(1),
    brandId: z.string().uuid(),
    campaignId: z.string().uuid(),
    subject: z.string().optional(),
  })
  .openapi("OpportunityReplyRequest");

// ---------- Ranked opportunities (HITL queue) ----------

export const OpportunityRankedRequestSchema = z
  .object({
    campaignId: z.string().uuid(),
    brandId: z.string().uuid(),
    limit: z.number().int().min(1).max(50).optional(),
    offset: z.number().int().min(0).optional(),
  })
  .openapi("OpportunityRankedRequest");

export const RankedOpportunitySchema = z
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
  .openapi("RankedOpportunity");

export const OpportunityRankedResponseSchema = z
  .object({
    status: z.literal("ok"),
    opportunities: z.array(RankedOpportunitySchema),
    total: z.number().int(),
  })
  .openapi("OpportunityRankedResponse");

// ---------- Quote-request draft (HITL pitch generation) ----------

export const QuoteRequestDraftRequestSchema = z
  .object({
    brandId: z.string().uuid(),
    campaignId: z.string().uuid(),
    spokesperson: z.string().min(1),
    expertiseTopics: z.string().min(1),
    responseStyle: z.string().min(1),
    companyContext: z.string().min(1),
    valueProposition: z.string().min(1),
    additionalContext: z.string().optional(),
  })
  .openapi("QuoteRequestDraftRequest");

export const QuoteRequestDraftResponseSchema = z
  .object({
    pitch: z.string(),
    charCount: z.number().int(),
    attempts: z.number().int(),
    tokensInput: z.number(),
    tokensOutput: z.number(),
  })
  .openapi("QuoteRequestDraftResponse");

export const ExpertQuotePitchLengthErrorResponseSchema = z
  .object({
    error: z.string(),
    charCount: z.number().int(),
    minChars: z.number().int(),
    maxChars: z.number().int(),
    attempts: z.number().int(),
  })
  .openapi("ExpertQuotePitchLengthErrorResponse");

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
    "Pick the next best journalist opportunity for the (campaign, brand). Merges silver email-sourced rows with a live fetch of Featured.com opportunities, scores via RAG, returns top above SCORE_THRESHOLD.",
  security: [{ [apiKeyAuth.name]: [] }],
  request: {
    headers: orgHeaders,
    body: {
      content: {
        "application/json": { schema: OpportunityNextRequestSchema },
      },
    },
  },
  responses: {
    200: {
      description: "Top opportunity or no_match",
      content: {
        "application/json": { schema: OpportunityNextResponseSchema },
      },
    },
    400: {
      description: "Validation error",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    502: {
      description: "Upstream service unavailable (key-service, Featured)",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/orgs/opportunities/ranked",
  summary:
    "Return the top-N ranked opportunities for a (campaign, brand). Same RAG scoring pipeline as /next, paginated. Used by the HITL dashboard queue.",
  security: [{ [apiKeyAuth.name]: [] }],
  request: {
    headers: orgHeaders,
    body: {
      content: {
        "application/json": { schema: OpportunityRankedRequestSchema },
      },
    },
  },
  responses: {
    200: {
      description: "Ranked opportunities above SCORE_THRESHOLD, sorted by score desc",
      content: {
        "application/json": { schema: OpportunityRankedResponseSchema },
      },
    },
    400: {
      description: "Validation error",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    502: {
      description: "Upstream service unavailable (key-service, Featured)",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/orgs/quote-requests/{id}/draft",
  summary:
    "Generate an AI-drafted pitch for the given quote request via content-generation-service. Returns the drafted text without submitting — caller decides when/whether to submit via POST /orgs/opportunities/:id/reply.",
  security: [{ [apiKeyAuth.name]: [] }],
  request: {
    headers: orgHeaders,
    params: z.object({ id: z.string().uuid() }),
    body: {
      content: {
        "application/json": { schema: QuoteRequestDraftRequestSchema },
      },
    },
  },
  responses: {
    200: {
      description: "Drafted pitch within the configured char range",
      content: {
        "application/json": { schema: QuoteRequestDraftResponseSchema },
      },
    },
    400: {
      description:
        "Validation error or pitch length out of range after retry (passthrough from content-generation-service)",
      content: {
        "application/json": {
          schema: z.union([
            ErrorResponseSchema,
            ExpertQuotePitchLengthErrorResponseSchema,
          ]),
        },
      },
    },
    404: {
      description: "Quote request not found for this org",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    502: {
      description: "Upstream content-generation-service unavailable",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/orgs/opportunities/{id}/reply",
  summary:
    "Submit a pitch reply for the given opportunity. Dispatches to Featured submitAnswer (provider=featured) or email-gateway-service /orgs/send (other providers, e.g. haro).",
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
  summary: "List quote requests for the org",
  security: [{ [apiKeyAuth.name]: [] }],
  request: { headers: orgHeaders, query: QuoteRequestListQuerySchema },
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
    headers: orgHeaders,
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
    headers: orgHeaders,
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
  request: { headers: orgHeaders, query: QuotePitchListQuerySchema },
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
    headers: orgHeaders,
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
