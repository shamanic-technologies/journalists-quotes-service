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
    totalSelected: z.number().int(),
    totalPublished: z.number().int(),
    totalNotSelected: z.number().int(),
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

// ==================== Expert Quote Run Schemas ====================

export const ExpertQuoteRunRequestSchema = z
  .object({
    campaignId: z.string().uuid(),
    brandId: z.string().uuid(),
  })
  .openapi("ExpertQuoteRunRequest");

export const ExpertQuoteRunResponseSchema = z
  .object({
    status: z.enum([
      "submitted",
      "no_match",
      "rate_limited",
      "error",
    ]),
    quoteRequestId: z.string().uuid().optional(),
    pitchId: z.string().uuid().optional(),
    retryAfter: z.number().int().optional(),
    error: z.string().optional(),
    missing: z.array(z.string()).optional(),
    balance_cents: z.number().int().optional(),
    required_cents: z.number().int().optional(),
  })
  .openapi("ExpertQuoteRunResponse");

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

export const InboundEmailAcceptedResponseSchema = z
  .object({
    accepted: z.boolean(),
    inboundEmailId: z.string().uuid().optional(),
    deduplicated: z.boolean().optional(),
  })
  .openapi("InboundEmailAcceptedResponse");

// ==================== Sync Tracking Schemas ====================

export const SyncTrackingResponseSchema = z
  .object({
    selectedUpdated: z.number().int(),
    publishedUpdated: z.number().int(),
    notSelectedUpdated: z.number().int(),
  })
  .openapi("SyncTrackingResponse");

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
  path: "/orgs/expert-quote-runs",
  summary: "Run one full expert-quote loop for the given campaign+brand",
  security: [{ [apiKeyAuth.name]: [] }],
  request: {
    headers: orgHeaders,
    body: {
      content: {
        "application/json": { schema: ExpertQuoteRunRequestSchema },
      },
    },
  },
  responses: {
    200: {
      description: "Run result",
      content: {
        "application/json": { schema: ExpertQuoteRunResponseSchema },
      },
    },
    400: {
      description: "Validation error",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    402: {
      description: "Insufficient credits in content-generation-service",
      content: {
        "application/json": { schema: ExpertQuoteRunResponseSchema },
      },
    },
    424: {
      description:
        "Required precondition failed (brand fields missing or content-generation template missing)",
      content: {
        "application/json": { schema: ExpertQuoteRunResponseSchema },
      },
    },
    502: {
      description: "Upstream service unavailable",
      content: { "application/json": { schema: ErrorResponseSchema } },
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
    "Service-to-service endpoint. Headers required: x-api-key (shared with caller), x-service-name=email-gateway-service. Idempotent on Postmark MessageID.",
  security: [{ [apiKeyAuth.name]: [] }],
  request: {
    headers: z.object({
      "x-service-name": z.string(),
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
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/internal/sync-tracking",
  summary: "Poll Featured /selected /published /not-selected and reconcile",
  security: [{ [apiKeyAuth.name]: [] }],
  responses: {
    200: {
      description: "Sync results",
      content: {
        "application/json": { schema: SyncTrackingResponseSchema },
      },
    },
  },
});
