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
} from "../lib/featured-client.js";
import { getFeaturedCredentials } from "../lib/key-service-client.js";
import {
  authorizeCredit,
  BillingServiceError,
} from "../lib/billing-client.js";
import { addCosts } from "../lib/runs-client.js";
import { ragScore } from "../lib/chat-client.js";
import { SHARED_EMAIL_ORG_ID } from "../lib/inbound/process.js";

const FEATURED_OPP_FETCH_COST = "featured-api-opportunity-fetch";

const SCORE_THRESHOLD = Number(process.env.SCORE_THRESHOLD ?? "0.5");

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

    // Authorize the Featured opportunity fetch with billing-service before
    // making any paid external call. 402 if the org cannot cover the cost.
    try {
      const auth = await authorizeCredit({
        items: [{ costName: FEATURED_OPP_FETCH_COST, quantity: 1 }],
        description: "featured opportunity fetch",
        orgId,
        userId,
        runId,
        brandId,
        campaignId,
        featureSlug: req.featureSlug,
        workflowSlug: req.workflowSlug,
      });
      if (!auth.sufficient) {
        res.status(402).json({
          error: "insufficient credit for featured opportunity fetch",
          balance_cents: auth.balance_cents,
          required_cents: auth.required_cents,
        });
        return;
      }
    } catch (err) {
      const status = err instanceof BillingServiceError ? 502 : 500;
      res.status(status).json({ error: (err as Error).message });
      return;
    }

    // Live-fetch Featured opportunities and upsert as silver rows (write-through
    // cache). Featured failures are fatal: we can't make a fair "no_match"
    // decision without seeing Featured's catalog.
    let credentials: FeaturedCredentials;
    try {
      credentials = await getFeaturedCredentials({
        callerMethod: "POST",
        callerPath: "/orgs/opportunities/next",
        runId,
      });
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

    // Record the actual cost now that the Featured call succeeded. Failure
    // here returns 500 so the upstream workflow retries instead of silently
    // dropping the cost record.
    if (runId) {
      try {
        await addCosts(
          runId,
          [
            {
              costName: FEATURED_OPP_FETCH_COST,
              costSource: "platform",
              quantity: 1,
              status: "actual",
            },
          ],
          {
            orgId,
            userId,
            brandId,
            campaignId,
            featureSlug: req.featureSlug,
            workflowSlug: req.workflowSlug,
          }
        );
      } catch (err) {
        res.status(500).json({
          error: `failed to record featured opportunity fetch cost: ${(err as Error).message}`,
        });
        return;
      }
    }

    if (featuredOpps.length > 0) {
      await db
        .insert(providerQuoteRequests)
        .values(
          featuredOpps.map((o) => ({
            provider: o.source ?? "featured",
            ingestionChannel: "api" as const,
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
