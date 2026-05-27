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
import {
  extractFields as defaultExtractFields,
  BrandServiceError,
  type ExtractFieldsResponse,
} from "../lib/brand-client.js";

const PARAMS_SCHEMA = z.object({ id: z.string().uuid() });

const BODY_SCHEMA = z
  .object({
    brandId: z.string().uuid(),
    campaignId: z.string().uuid().optional(),
    spokesperson: z.string().min(1).optional(),
    expertiseTopics: z.string().min(1).optional(),
    responseStyle: z.string().min(1).optional(),
    companyContext: z.string().min(1).optional(),
    valueProposition: z.string().min(1).optional(),
    additionalContext: z.string().optional(),
  })
  .refine(
    (data) => {
      const legacy = !!(
        data.campaignId &&
        data.spokesperson &&
        data.expertiseTopics &&
        data.responseStyle &&
        data.companyContext &&
        data.valueProposition
      );
      const brandOnly =
        !data.campaignId &&
        !data.spokesperson &&
        !data.expertiseTopics &&
        !data.responseStyle &&
        !data.companyContext &&
        !data.valueProposition;
      return legacy || brandOnly;
    },
    {
      message:
        "body must be either brand-only { brandId } or legacy { brandId, campaignId, spokesperson, expertiseTopics, responseStyle, companyContext, valueProposition }",
    }
  );

const PR_FIELD_SPECS = [
  {
    key: "spokesperson",
    description:
      "Name + title of the brand's PR spokesperson (e.g. 'Jane Doe, CEO of ErgoCorp'). Pick the founder or CEO if no PR contact is named.",
  },
  {
    key: "expertiseTopics",
    description:
      "Comma-separated topics the spokesperson can speak on for press quotes.",
  },
  {
    key: "responseStyle",
    description:
      "One-sentence guidance on tone + style for press responses (e.g. 'direct, data-driven, no fluff').",
  },
  {
    key: "companyContext",
    description:
      "1-2 sentence company elevator pitch including founding year and a notable metric.",
  },
  {
    key: "valueProposition",
    description:
      "1-sentence value proposition or unique angle the company brings to expert commentary.",
  },
] as const;

export type GenerateExpertQuotePitchFn = (
  request: GenerateExpertQuotePitchRequest,
  identity: ContentGenerationCallerIdentity
) => Promise<ExpertQuotePitchSuccessResponse>;

export type ExtractFieldsFn = (args: {
  brandIds: string[];
  fields: { key: string; description: string }[];
}) => Promise<ExtractFieldsResponse>;

export interface QuoteRequestDraftDeps {
  generateExpertQuotePitch?: GenerateExpertQuotePitchFn;
  extractFields?: ExtractFieldsFn;
}

interface ResolvedInputs {
  spokesperson: string;
  expertiseTopics: string;
  responseStyle: string;
  companyContext: string;
  valueProposition: string;
}

function coerceFieldString(
  value: unknown,
  key: string,
  brandId: string
): string {
  if (typeof value === "string" && value.length > 0) return value;
  if (Array.isArray(value)) return value.filter(Boolean).join(", ");
  if (value && typeof value === "object")
    return JSON.stringify(value);
  throw new Error(
    `brand-service extract-fields returned empty/missing value for key '${key}' on brand ${brandId}`
  );
}

async function resolveBrandInputs(
  brandId: string,
  extractFields: ExtractFieldsFn
): Promise<ResolvedInputs> {
  const result = await extractFields({
    brandIds: [brandId],
    fields: PR_FIELD_SPECS.map((f) => ({
      key: f.key,
      description: f.description,
    })),
  });
  return {
    spokesperson: coerceFieldString(
      result.fields.spokesperson?.value,
      "spokesperson",
      brandId
    ),
    expertiseTopics: coerceFieldString(
      result.fields.expertiseTopics?.value,
      "expertiseTopics",
      brandId
    ),
    responseStyle: coerceFieldString(
      result.fields.responseStyle?.value,
      "responseStyle",
      brandId
    ),
    companyContext: coerceFieldString(
      result.fields.companyContext?.value,
      "companyContext",
      brandId
    ),
    valueProposition: coerceFieldString(
      result.fields.valueProposition?.value,
      "valueProposition",
      brandId
    ),
  };
}

export function createQuoteRequestDraftRouter(
  deps: QuoteRequestDraftDeps = {}
): Router {
  const router = Router();
  const generate = deps.generateExpertQuotePitch ?? defaultGenerateExpertQuotePitch;
  const extractFields = deps.extractFields ?? defaultExtractFields;

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
    const data = bodyParsed.data;
    const orgId = req.orgId!;
    const userId = req.userId;
    const runId = req.runId;
    const brandId = data.brandId;
    const campaignId = data.campaignId;
    const isBrandOnly = !campaignId;

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

    let inputs: ResolvedInputs;
    if (isBrandOnly) {
      try {
        inputs = await resolveBrandInputs(brandId, extractFields);
      } catch (err) {
        if (err instanceof BrandServiceError) {
          res.status(502).json({ error: err.message });
          return;
        }
        res.status(502).json({ error: (err as Error).message });
        return;
      }
    } else {
      inputs = {
        spokesperson: data.spokesperson!,
        expertiseTopics: data.expertiseTopics!,
        responseStyle: data.responseStyle!,
        companyContext: data.companyContext!,
        valueProposition: data.valueProposition!,
      };
    }

    const request: GenerateExpertQuotePitchRequest = {
      variables: {
        brands: [
          {
            name: inputs.spokesperson,
            industry: inputs.companyContext,
            expertise: inputs.expertiseTopics,
            voice: inputs.responseStyle,
            targetAudience: inputs.valueProposition,
          },
        ],
        request: {
          question: row.opportunityText,
          mediaOutlet: row.mediaOutlet,
          source: row.journalistName,
          deadline: row.deadline ? row.deadline.toISOString() : null,
        },
        additionalContext:
          data.additionalContext ??
          `${inputs.companyContext}\n\n${inputs.valueProposition}`,
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
