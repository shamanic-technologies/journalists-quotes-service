import { Router } from "express";
import { and, eq, sql as drizzleSql, isNull, or } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  quoteRequests,
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
import { getBrand, getBrandLogo } from "../lib/brand-client.js";
import { ragScore } from "../lib/chat-client.js";
import { generatePitch } from "../lib/content-generation-client.js";

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
        .insert(quoteRequests)
        .values(
          opportunities.map((o) => ({
            featuredQuestionId: o.featuredQuestionId,
            source: o.source ?? "featured",
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
        id: quoteRequests.id,
        featuredQuestionId: quoteRequests.featuredQuestionId,
        opportunityText: quoteRequests.opportunityText,
        mediaOutlet: quoteRequests.mediaOutlet,
        deadline: quoteRequests.deadline,
        pitchUrl: quoteRequests.pitchUrl,
        existingPitchStatus: quotePitches.status,
      })
      .from(quoteRequests)
      .leftJoin(
        quotePitches,
        and(
          eq(quotePitches.quoteRequestId, quoteRequests.id),
          eq(quotePitches.campaignId, campaignId)
        )
      )
      .where(eq(quoteRequests.orgId, orgId));

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

    const generated = await generatePitch(
      {
        template: "expert-quote-pitch",
        context: {
          brand,
          request: top,
          deadline: top.deadline ? top.deadline.toISOString() : null,
        },
      },
      orgId,
      userId,
      runId
    );

    let draft = generated.content;
    if (draft.length > 2500) {
      console.warn(
        `[journalists-quotes-service] pitch draft length ${draft.length} exceeds 2500, truncating`
      );
      draft = draft.slice(0, 2500);
    }
    if (draft.length < 100) {
      console.warn(
        `[journalists-quotes-service] pitch draft length ${draft.length} below 100, padding`
      );
      while (draft.length < 100) draft += " Available for follow-up.";
      draft = draft.slice(0, 2500);
    }

    try {
      await client.submitAnswer({
        answer: draft,
        featuredQuestionId: top.featuredQuestionId,
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
          status: "error",
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
        status: "submitted",
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
