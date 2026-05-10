import { Router } from "express";
import { and, eq, sql as drizzleSql, isNull, or } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  providerQuoteRequests,
  quotePriorities,
  quotePitches,
  featuredProfiles,
} from "../db/schema.js";
import { ExpertQuoteRunRequestSchema } from "../schemas.js";
import {
  FeaturedClient,
  FeaturedRateLimitError,
  type FeaturedCredentials,
  type FeaturedClientOptions,
} from "../lib/featured-client.js";
import { getFeaturedCredentials } from "../lib/key-service-client.js";
import {
  getBrand,
  getBrandLogo,
  extractBrandFields,
} from "../lib/brand-client.js";
import { ragScore } from "../lib/chat-client.js";
import {
  generateExpertQuotePitch,
  ContentGenLengthError,
  ContentGenTemplateMissingError,
  ContentGenInsufficientCreditsError,
  type ExpertQuotePitchBrandInput,
} from "../lib/content-generation-client.js";

export interface ExpertQuoteRunsDeps {
  buildClient?: (
    credentials: FeaturedCredentials,
    overrides?: Partial<FeaturedClientOptions>
  ) => FeaturedClient;
  fetchLogoBytes?: (url: string) => Promise<{
    bytes: Uint8Array;
    contentType: string;
    filename: string;
  }>;
}

function defaultBuildClient(
  credentials: FeaturedCredentials,
  overrides?: Partial<FeaturedClientOptions>
): FeaturedClient {
  return new FeaturedClient({ credentials, ...overrides });
}

async function defaultFetchLogoBytes(url: string) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch brand logo at ${url} (${response.status})`
    );
  }
  const contentType = response.headers.get("content-type") || "image/png";
  const buffer = await response.arrayBuffer();
  const ext = contentType.split("/")[1]?.split(";")[0] || "png";
  return {
    bytes: new Uint8Array(buffer),
    contentType,
    filename: `brand-logo.${ext}`,
  };
}

const SCORE_THRESHOLD = Number(process.env.SCORE_THRESHOLD ?? "0.5");

export function createExpertQuoteRunsRouter(
  deps: ExpertQuoteRunsDeps = {}
): Router {
  const router = Router();
  const buildClient = deps.buildClient ?? defaultBuildClient;
  const fetchLogoBytes = deps.fetchLogoBytes ?? defaultFetchLogoBytes;

  router.post("/orgs/expert-quote-runs", async (req, res) => {
    const parsed = ExpertQuoteRunRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const { campaignId, brandId } = parsed.data;
    const orgId = req.orgId!;
    const userId = req.userId;
    const runId = req.runId;
    const parentRunId = req.parentRunId ?? null;

    let credentials: FeaturedCredentials;
    try {
      credentials = await getFeaturedCredentials(orgId, userId, runId);
    } catch (err) {
      const message = (err as Error).message;
      if ((err as Error).name === "KeyServiceUnavailableError") {
        res.status(502).json({ error: message });
        return;
      }
      res.status(500).json({ error: message });
      return;
    }

    const client = buildClient(credentials);

    let brand;
    try {
      brand = await getBrand(brandId, orgId, userId, runId);
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
      return;
    }

    let profileRow = (
      await db
        .select()
        .from(featuredProfiles)
        .where(
          and(
            eq(featuredProfiles.orgId, orgId),
            eq(featuredProfiles.brandId, brandId)
          )
        )
        .limit(1)
    )[0];

    if (!profileRow) {
      const logo = await getBrandLogo(brandId, orgId, userId, runId);
      if (!logo) {
        res
          .status(400)
          .json({ error: "Brand has no logo media asset; cannot create Featured profile" });
        return;
      }
      const { bytes, contentType, filename } = await fetchLogoBytes(
        logo.permanentUrl
      );
      const form = new FormData();
      form.set("name", brand.name);
      const ab = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength
      ) as ArrayBuffer;
      const blob = new Blob([ab], { type: contentType });
      form.set("image", blob, filename);
      const created = await client.createProfile(form);
      [profileRow] = await db
        .insert(featuredProfiles)
        .values({
          orgId,
          brandId,
          featuredProfileId: created.profileId,
        })
        .returning();
    }

    const opportunities = await client.listOpportunities();
    if (opportunities.length > 0) {
      await db
        .insert(providerQuoteRequests)
        .values(
          opportunities.map((o) => ({
            provider: o.source ?? "featured",
            ingestionChannel: "api",
            externalId: String(o.featuredQuestionId),
            featuredQuestionId: o.featuredQuestionId,
            mediaOutlet: o.mediaOutlet ?? null,
            opportunityText: o.opportunity,
            pitchUrl: o.pitchUrl ?? null,
            deadline: o.deadline ? new Date(o.deadline) : null,
            raw: o,
            orgId,
          }))
        )
        .onConflictDoNothing();
    }

    const candidates = await db
      .select({
        id: providerQuoteRequests.id,
        featuredQuestionId: providerQuoteRequests.featuredQuestionId,
        opportunityText: providerQuoteRequests.opportunityText,
        mediaOutlet: providerQuoteRequests.mediaOutlet,
        deadline: providerQuoteRequests.deadline,
        pitchUrl: providerQuoteRequests.pitchUrl,
        existingPitchStatus: quotePitches.status,
      })
      .from(providerQuoteRequests)
      .leftJoin(
        quotePitches,
        and(
          eq(quotePitches.quoteRequestId, providerQuoteRequests.id),
          eq(quotePitches.campaignId, campaignId)
        )
      )
      .where(eq(providerQuoteRequests.orgId, orgId));

    const eligible = candidates.filter(
      (c) =>
        c.existingPitchStatus === null || c.existingPitchStatus === "error"
    );

    if (eligible.length === 0) {
      res.json({ status: "no_match" });
      return;
    }

    const scoreResp = await ragScore(
      {
        documents: eligible.map((c) => ({ id: c.id, text: c.opportunityText })),
        brandId,
        campaignId,
      },
      orgId,
      userId,
      runId
    );

    if (scoreResp.results.length > 0) {
      await db
        .insert(quotePriorities)
        .values(
          scoreResp.results.map((r) => ({
            quoteRequestId: r.id,
            campaignId,
            brandId,
            score: r.score.toFixed(2),
            whyRelevant: r.whyRelevant ?? null,
            scoredByRunId: runId ?? null,
            orgId,
          }))
        )
        .onConflictDoUpdate({
          target: [
            quotePriorities.quoteRequestId,
            quotePriorities.campaignId,
          ],
          set: {
            score: drizzleSql`excluded.score`,
            whyRelevant: drizzleSql`excluded.why_relevant`,
            scoredAt: drizzleSql`now()`,
            scoredByRunId: drizzleSql`excluded.scored_by_run_id`,
            brandId: drizzleSql`excluded.brand_id`,
          },
        });
    }

    const ranked = eligible
      .map((c) => {
        const result = scoreResp.results.find((r) => r.id === c.id);
        return { ...c, score: result?.score ?? 0 };
      })
      .filter((c) => c.score >= SCORE_THRESHOLD)
      .sort((a, b) => b.score - a.score);

    if (ranked.length === 0) {
      res.json({ status: "no_match" });
      return;
    }

    const top = ranked[0];

    const rateState = client.rateLimitState();
    if (rateState.remaining <= 0) {
      res.json({ status: "rate_limited", retryAfter: rateState.retryAfter });
      return;
    }

    // ---- Hydrate brand fields required by content-generation-service ----
    const requiredBrandFields = [
      { key: "industry", description: "The brand's primary industry vertical" },
      {
        key: "expertise",
        description:
          "The specific expertise this brand or its expert is qualified to speak on",
      },
      {
        key: "voice",
        description:
          "Voice and tone descriptor (e.g. 'plainspoken, no jargon, slightly contrarian')",
      },
      {
        key: "targetAudience",
        description: "The audience this brand normally speaks to",
      },
    ];

    let brandInput: ExpertQuotePitchBrandInput;
    try {
      const extracted = await extractBrandFields(brandId, requiredBrandFields, {
        orgId,
        userId,
        runId,
        campaignId,
        workflowSlug: req.workflowSlug,
        featureSlug: req.featureSlug,
      });
      const brandMeta = extracted.brands.find((b) => b.brandId === brandId);
      const name = brandMeta?.name ?? (brand as { name?: string }).name;
      const industry = extracted.fields.industry?.value;
      const expertise = extracted.fields.expertise?.value;
      const voice = extracted.fields.voice?.value;
      const targetAudience = extracted.fields.targetAudience?.value;

      const missing: string[] = [];
      if (!name || typeof name !== "string") missing.push("name");
      if (!industry || typeof industry !== "string") missing.push("industry");
      if (!expertise || typeof expertise !== "string") missing.push("expertise");
      if (!voice || typeof voice !== "string") missing.push("voice");
      if (!targetAudience || typeof targetAudience !== "string")
        missing.push("targetAudience");

      if (missing.length > 0) {
        const errorMsg = `brand-service returned missing/invalid required fields: ${missing.join(", ")}`;
        console.error(
          `[journalists-quotes-service] ${errorMsg} (brandId=${brandId})`
        );
        const [pitch] = await db
          .insert(quotePitches)
          .values({
            quoteRequestId: top.id,
            featuredQuestionId: top.featuredQuestionId,
            featuredProfileId: profileRow.featuredProfileId,
            campaignId,
            brandId,
            status: "brand_missing_fields",
            deliveryMethod: "featured_api",
            deliveryTarget: top.pitchUrl ?? null,
            error: errorMsg,
            errorDetails: { missing },
            parentRunId,
            runId: runId ?? null,
            orgId,
          })
          .returning();
        res.status(424).json({
          status: "error",
          error: errorMsg,
          missing,
          pitchId: pitch.id,
          quoteRequestId: top.id,
        });
        return;
      }

      brandInput = {
        name: name as string,
        industry: industry as string,
        expertise: expertise as string,
        voice: voice as string,
        targetAudience: targetAudience as string,
      };
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
      return;
    }

    // ---- Call content-generation-service ----
    let pitchResult;
    try {
      pitchResult = await generateExpertQuotePitch(
        {
          brand: brandInput,
          request: {
            question: top.opportunityText,
            mediaOutlet: top.mediaOutlet ?? "",
            source: (top.mediaOutlet ?? "the publication") + " journalist",
            deadline: top.deadline ? top.deadline.toISOString() : undefined,
          },
          campaignId,
          workflowSlug: req.workflowSlug,
          featureSlug: req.featureSlug,
        },
        {
          orgId,
          userId: userId ?? "",
          runId: runId ?? "",
          brandId,
          campaignId,
          workflowSlug: req.workflowSlug,
          featureSlug: req.featureSlug,
        }
      );
    } catch (err) {
      if (err instanceof ContentGenLengthError) {
        const [pitch] = await db
          .insert(quotePitches)
          .values({
            quoteRequestId: top.id,
            featuredQuestionId: top.featuredQuestionId,
            featuredProfileId: profileRow.featuredProfileId,
            campaignId,
            brandId,
            status: "length_violation",
            deliveryMethod: "featured_api",
            deliveryTarget: top.pitchUrl ?? null,
            pitchCharCount: err.charCount,
            pitchAttempts: err.attempts,
            error: err.message,
            errorDetails: {
              charCount: err.charCount,
              minChars: err.minChars,
              maxChars: err.maxChars,
              attempts: err.attempts,
            },
            parentRunId,
            runId: runId ?? null,
            orgId,
          })
          .returning();
        res.status(200).json({
          status: "error",
          error: err.message,
          pitchId: pitch.id,
          quoteRequestId: top.id,
        });
        return;
      }
      if (err instanceof ContentGenTemplateMissingError) {
        console.error(
          `[journalists-quotes-service] expert-quote-pitch template missing in content-generation-service: ${err.message}`
        );
        const [pitch] = await db
          .insert(quotePitches)
          .values({
            quoteRequestId: top.id,
            featuredQuestionId: top.featuredQuestionId,
            featuredProfileId: profileRow.featuredProfileId,
            campaignId,
            brandId,
            status: "template_missing",
            deliveryMethod: "featured_api",
            deliveryTarget: top.pitchUrl ?? null,
            error: err.message,
            parentRunId,
            runId: runId ?? null,
            orgId,
          })
          .returning();
        res.status(424).json({
          status: "error",
          error: err.message,
          pitchId: pitch.id,
          quoteRequestId: top.id,
        });
        return;
      }
      if (err instanceof ContentGenInsufficientCreditsError) {
        const [pitch] = await db
          .insert(quotePitches)
          .values({
            quoteRequestId: top.id,
            featuredQuestionId: top.featuredQuestionId,
            featuredProfileId: profileRow.featuredProfileId,
            campaignId,
            brandId,
            status: "insufficient_credits",
            deliveryMethod: "featured_api",
            deliveryTarget: top.pitchUrl ?? null,
            error: err.message,
            errorDetails: {
              balance_cents: err.balanceCents,
              required_cents: err.requiredCents,
            },
            parentRunId,
            runId: runId ?? null,
            orgId,
          })
          .returning();
        res.status(402).json({
          status: "error",
          error: err.message,
          balance_cents: err.balanceCents,
          required_cents: err.requiredCents,
          pitchId: pitch.id,
          quoteRequestId: top.id,
        });
        return;
      }
      res.status(502).json({ error: (err as Error).message });
      return;
    }

    const draft = pitchResult.pitch;

    if (top.featuredQuestionId == null) {
      res.status(500).json({
        error:
          "Selected request has no featured_question_id; Featured API submission requires it",
      });
      return;
    }
    const featuredQuestionId = top.featuredQuestionId;
    try {
      await client.submitAnswer({
        answer: draft,
        featuredQuestionId,
        profileId: profileRow.featuredProfileId,
      });
    } catch (err) {
      if (err instanceof FeaturedRateLimitError) {
        res.json({ status: "rate_limited", retryAfter: err.retryAfter });
        return;
      }
      const [pitch] = await db
        .insert(quotePitches)
        .values({
          quoteRequestId: top.id,
          featuredQuestionId: top.featuredQuestionId,
          featuredProfileId: profileRow.featuredProfileId,
          campaignId,
          brandId,
          draft,
          pitchCharCount: pitchResult.charCount,
          pitchAttempts: pitchResult.attempts,
          contentGenRunId: pitchResult.contentGenRunId ?? null,
          status: "error",
          deliveryMethod: "featured_api",
          deliveryTarget: top.pitchUrl ?? null,
          error: (err as Error).message,
          parentRunId,
          runId: runId ?? null,
          orgId,
        })
        .returning();
      res.json({
        status: "error",
        error: (err as Error).message,
        pitchId: pitch.id,
        quoteRequestId: top.id,
      });
      return;
    }

    const [pitch] = await db
      .insert(quotePitches)
      .values({
        quoteRequestId: top.id,
        featuredQuestionId: top.featuredQuestionId,
        featuredProfileId: profileRow.featuredProfileId,
        campaignId,
        brandId,
        draft,
        pitchCharCount: pitchResult.charCount,
        pitchAttempts: pitchResult.attempts,
        contentGenRunId: pitchResult.contentGenRunId ?? null,
        status: "submitted",
        deliveryMethod: "featured_api",
        deliveryTarget: top.pitchUrl ?? null,
        submittedAt: new Date(),
        parentRunId,
        runId: runId ?? null,
        orgId,
      })
      .returning();

    res.json({
      status: "submitted",
      quoteRequestId: top.id,
      pitchId: pitch.id,
    });
  });

  return router;
}

export default createExpertQuoteRunsRouter();
