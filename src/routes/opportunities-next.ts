import { Router } from "express";
import { and, eq, or, sql as drizzleSql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/index.js";
import {
  providerQuoteRequests,
  quotePitches,
  quotePriorities,
} from "../db/schema.js";
import {
  FeaturedClient,
  type FeaturedCredentials,
  type FeaturedClientOptions,
  type FeaturedOpportunity,
} from "../lib/featured-client.js";
import { getFeaturedCredentials } from "../lib/key-service-client.js";
import { ragScore } from "../lib/chat-client.js";
import { SHARED_EMAIL_ORG_ID } from "../lib/inbound/process.js";
import { computeFingerprint } from "../lib/cluster/fingerprint.js";

const SCORE_THRESHOLD = Number(process.env.SCORE_THRESHOLD ?? "0.5");

function safeParseDate(value: string | undefined | null): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function featuredExternalId(o: FeaturedOpportunity): string {
  if (typeof o.featuredQuestionId === "number") return String(o.featuredQuestionId);
  if (o.pitchUrl) return o.pitchUrl;
  return computeFingerprint(o.opportunity ?? "", o.mediaOutlet);
}

const OpportunityNextRequestSchema = z.object({
  campaignId: z.string().uuid(),
  brandId: z.string().uuid(),
});

export interface OpportunitiesNextDeps {
  buildClient?: (
    credentials: FeaturedCredentials,
    overrides?: Partial<FeaturedClientOptions>
  ) => FeaturedClient;
}

function defaultBuildClient(
  credentials: FeaturedCredentials,
  overrides?: Partial<FeaturedClientOptions>
): FeaturedClient {
  return new FeaturedClient({ credentials, ...overrides });
}

export function createOpportunitiesNextRouter(
  deps: OpportunitiesNextDeps = {}
): Router {
  const router = Router();
  const buildClient = deps.buildClient ?? defaultBuildClient;

  router.post("/orgs/opportunities/next", async (req, res) => {
    const parsed = OpportunityNextRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const { campaignId, brandId } = parsed.data;
    const orgId = req.orgId!;
    const userId = req.userId;
    const runId = req.runId;

    // Featured opportunity fetches are free and unlimited on the Premium plan,
    // so we skip billing-service authorize and runs-service addCosts here.
    // Only pitch submissions are billed (see opportunity-reply.ts).
    let credentials: FeaturedCredentials;
    try {
      const result = await getFeaturedCredentials({
        callerMethod: "POST",
        callerPath: "/orgs/opportunities/next",
        orgId,
        userId,
        runId,
      });
      credentials = { username: result.username, password: result.password };
    } catch (err) {
      const name = (err as Error).name;
      const message = (err as Error).message;
      if (name === "KeyServiceUnavailableError") {
        res.status(502).json({ error: message });
        return;
      }
      res.status(500).json({ error: message });
      return;
    }

    const client = buildClient(credentials);
    let featuredOpps;
    try {
      featuredOpps = await client.listOpportunities();
    } catch (err) {
      res.status(502).json({
        error: `Featured listOpportunities failed: ${(err as Error).message}`,
      });
      return;
    }

    const insertableOpps = featuredOpps.filter(
      (o) => typeof o.opportunity === "string" && o.opportunity.length > 0
    );
    if (insertableOpps.length > 0) {
      await db
        .insert(providerQuoteRequests)
        .values(
          insertableOpps.map((o) => ({
            provider: "featured",
            ingestionChannel: "api" as const,
            externalId: featuredExternalId(o),
            featuredQuestionId:
              typeof o.featuredQuestionId === "number"
                ? o.featuredQuestionId
                : null,
            mediaOutlet: o.mediaOutlet ?? null,
            opportunityText: o.opportunity,
            pitchUrl: o.pitchUrl ?? null,
            deadline: safeParseDate(o.deadline),
            raw: o,
            orgId,
          }))
        )
        .onConflictDoNothing({
          target: [
            providerQuoteRequests.provider,
            providerQuoteRequests.ingestionChannel,
            providerQuoteRequests.externalId,
          ],
        });
    }

    // Eligible candidates: silver rows for this org OR the shared email pool,
    // not yet pitched on this campaign (or only with status='error').
    const candidates = await db
      .select({
        id: providerQuoteRequests.id,
        provider: providerQuoteRequests.provider,
        ingestionChannel: providerQuoteRequests.ingestionChannel,
        featuredQuestionId: providerQuoteRequests.featuredQuestionId,
        mediaOutlet: providerQuoteRequests.mediaOutlet,
        journalistName: providerQuoteRequests.journalistName,
        opportunityText: providerQuoteRequests.opportunityText,
        deadline: providerQuoteRequests.deadline,
        pitchUrl: providerQuoteRequests.pitchUrl,
        pitchEmail: providerQuoteRequests.pitchEmail,
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
      .where(
        or(
          eq(providerQuoteRequests.orgId, orgId),
          eq(providerQuoteRequests.orgId, SHARED_EMAIL_ORG_ID)
        )
      );

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
          target: [quotePriorities.quoteRequestId, quotePriorities.campaignId],
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
        return {
          ...c,
          score: result?.score ?? 0,
          whyRelevant: result?.whyRelevant ?? null,
        };
      })
      .filter((c) => c.score >= SCORE_THRESHOLD)
      .sort((a, b) => b.score - a.score);

    if (ranked.length === 0) {
      res.json({ status: "no_match" });
      return;
    }

    const top = ranked[0];
    res.json({
      status: "match",
      opportunityId: top.id,
      provider: top.provider,
      ingestionChannel: top.ingestionChannel,
      featuredQuestionId: top.featuredQuestionId,
      mediaOutlet: top.mediaOutlet,
      journalistName: top.journalistName,
      opportunityText: top.opportunityText,
      deadline: top.deadline ? top.deadline.toISOString() : null,
      pitchUrl: top.pitchUrl,
      pitchEmail: top.pitchEmail,
      score: top.score,
      whyRelevant: top.whyRelevant,
    });
  });

  return router;
}

export default createOpportunitiesNextRouter();
