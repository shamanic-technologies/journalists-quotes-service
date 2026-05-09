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
    featuredQuestionId: z.number().int(),
    source: z.string(),
    mediaOutlet: z.string().nullable(),
    opportunityText: z.string(),
    pitchUrl: z.string().nullable(),
    deadline: z.string().nullable(),
    fetchedAt: z.string(),
    orgId: z.string().uuid(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("QuoteRequest");

export const QuoteRequestListQuerySchema = z.object({
  campaign_id: z.string().uuid().optional(),
  source: z.string().optional(),
  limit: z.string().optional(),
  offset: z.string().optional(),
});

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
    featuredQuestionId: z.number().int(),
    featuredProfileId: z.number().int(),
    campaignId: z.string().uuid(),
    brandId: z.string().uuid(),
    draft: z.string(),
    submittedAt: z.string().nullable(),
    status: z.enum([
      "drafted",
      "submitted",
      "selected",
      "published",
      "not_selected",
      "error",
    ]),
    featuredArticleUrl: z.string().nullable(),
    error: z.string().nullable(),
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
  })
  .openapi("ExpertQuoteRunResponse");

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
            quoteRequests: z.array(QuoteRequestSchema),
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
