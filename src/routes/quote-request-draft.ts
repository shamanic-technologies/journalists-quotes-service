import { Router } from "express";
import { and, eq, or } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/index.js";
import { providerQuoteRequests } from "../db/schema.js";
import { SHARED_EMAIL_ORG_ID } from "../lib/inbound/process.js";
import {
  ContentGenerationServiceError,
  ExpertQuotePitchLengthError,
  generateExpertQuotePitch as defaultGenerateExpertQuotePitch,
  type ExpertQuotePitchSuccessResponse,
  type GenerateExpertQuotePitchRequest,
  type ContentGenerationCallerIdentity,
} from "../lib/content-generation-client.js";

const PARAMS_SCHEMA = z.object({ id: z.string().uuid() });

const BODY_SCHEMA = z.object({
  brandId: z.string().uuid(),
  campaignId: z.string().uuid(),
  spokesperson: z.string().min(1),
  expertiseTopics: z.string().min(1),
  responseStyle: z.string().min(1),
  companyContext: z.string().min(1),
  valueProposition: z.string().min(1),
  additionalContext: z.string().optional(),
});

export type GenerateExpertQuotePitchFn = (
  request: GenerateExpertQuotePitchRequest,
  identity: ContentGenerationCallerIdentity
) => Promise<ExpertQuotePitchSuccessResponse>;

export interface QuoteRequestDraftDeps {
  generateExpertQuotePitch?: GenerateExpertQuotePitchFn;
}

export function createQuoteRequestDraftRouter(
  deps: QuoteRequestDraftDeps = {}
): Router {
  const router = Router();
  const generate = deps.generateExpertQuotePitch ?? defaultGenerateExpertQuotePitch;

  router.post("/orgs/quote-requests/:id/draft", async (req, res) => {
    const paramsParsed = PARAMS_SCHEMA.safeParse(req.params);
    if (!paramsParsed.success) {
      res.status(400).json({ error: paramsParsed.error.message });
      return;
    }
    const bodyParsed = BODY_SCHEMA.safeParse(req.body);
    if (!bodyParsed.success) {
      res.status(400).json({ error: bodyParsed.error.message });
      return;
    }
    const { id } = paramsParsed.data;
    const {
      brandId,
      campaignId,
      spokesperson,
      expertiseTopics,
      responseStyle,
      companyContext,
      valueProposition,
      additionalContext,
    } = bodyParsed.data;
    const orgId = req.orgId!;
    const userId = req.userId;
    const runId = req.runId;

    const rows = await db
      .select()
      .from(providerQuoteRequests)
      .where(
        and(
          eq(providerQuoteRequests.id, id),
          or(
            eq(providerQuoteRequests.orgId, orgId),
            eq(providerQuoteRequests.orgId, SHARED_EMAIL_ORG_ID)
          )
        )
      )
      .limit(1);

    const row = rows[0];
    if (!row) {
      res.status(404).json({ error: "Quote request not found" });
      return;
    }

    const request: GenerateExpertQuotePitchRequest = {
      variables: {
        brands: [
          {
            name: spokesperson,
            industry: companyContext,
            expertise: expertiseTopics,
            voice: responseStyle,
            targetAudience: valueProposition,
          },
        ],
        request: {
          question: row.opportunityText,
          mediaOutlet: row.mediaOutlet,
          source: row.journalistName,
          deadline: row.deadline ? row.deadline.toISOString() : null,
        },
        additionalContext:
          additionalContext ?? `${companyContext}\n\n${valueProposition}`,
      },
      brandIds: [brandId],
      campaignId,
      workflowSlug: req.workflowSlug,
      featureSlug: req.featureSlug,
    };

    try {
      const result = await generate(request, {
        orgId,
        userId,
        runId,
        brandId,
        campaignId,
        workflowSlug: req.workflowSlug,
        featureSlug: req.featureSlug,
      });
      res.json({
        pitch: result.pitch,
        charCount: result.charCount,
        attempts: result.attempts,
        tokensInput: result.tokensInput,
        tokensOutput: result.tokensOutput,
      });
    } catch (err) {
      if (err instanceof ExpertQuotePitchLengthError) {
        res.status(400).json(err.details);
        return;
      }
      if (err instanceof ContentGenerationServiceError) {
        res.status(502).json({ error: err.message });
        return;
      }
      throw err;
    }
  });

  return router;
}

export default createQuoteRequestDraftRouter();
