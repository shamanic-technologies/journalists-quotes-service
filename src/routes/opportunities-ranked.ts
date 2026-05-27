import { Router } from "express";
import { z } from "zod";
import {
  FeaturedListError,
  KeyServiceError,
  fetchEligibleCandidates,
  ingestFeaturedToSilver,
  rankCandidates,
  type BuildFeaturedClient,
} from "../lib/opportunity-pipeline.js";
import {
  FeaturedClient,
  type FeaturedCredentials,
  type FeaturedClientOptions,
} from "../lib/featured-client.js";

const SCORE_THRESHOLD = Number(process.env.SCORE_THRESHOLD ?? "0.5");

const OpportunityRankedRequestSchema = z.object({
  brandId: z.string().uuid(),
  campaignId: z.string().uuid().optional(),
  limit: z.number().int().min(1).max(50).optional(),
  offset: z.number().int().min(0).optional(),
});

export interface OpportunitiesRankedDeps {
  buildClient?: BuildFeaturedClient;
}

function defaultBuildClient(
  credentials: FeaturedCredentials,
  overrides?: Partial<FeaturedClientOptions>
): FeaturedClient {
  return new FeaturedClient({ credentials, ...overrides });
}

export function createOpportunitiesRankedRouter(
  deps: OpportunitiesRankedDeps = {}
): Router {
  const router = Router();
  const buildClient = deps.buildClient ?? defaultBuildClient;

  router.post("/orgs/opportunities/ranked", async (req, res) => {
    const parsed = OpportunityRankedRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const { brandId, campaignId } = parsed.data;
    const limit = parsed.data.limit ?? 20;
    const offset = parsed.data.offset ?? 0;
    const orgId = req.orgId!;
    const userId = req.userId;
    const runId = req.runId;

    try {
      await ingestFeaturedToSilver({
        orgId,
        userId,
        runId,
        callerPath: "/orgs/opportunities/ranked",
        buildClient,
      });
    } catch (err) {
      if (err instanceof KeyServiceError || err instanceof FeaturedListError) {
        res.status(502).json({ error: err.message });
        return;
      }
      res.status(500).json({ error: (err as Error).message });
      return;
    }

    const eligible = await fetchEligibleCandidates({
      orgId,
      brandId,
      campaignId,
    });
    const ranked = await rankCandidates({
      candidates: eligible,
      orgId,
      brandId,
      campaignId,
      userId,
      runId,
      scoreThreshold: SCORE_THRESHOLD,
    });

    const total = ranked.length;
    const page = ranked.slice(offset, offset + limit);

    res.json({
      status: "ok",
      opportunities: page.map((r) => ({
        opportunityId: r.id,
        provider: r.provider,
        ingestionChannel: r.ingestionChannel,
        featuredQuestionId: r.featuredQuestionId,
        mediaOutlet: r.mediaOutlet,
        journalistName: r.journalistName,
        opportunityText: r.opportunityText,
        deadline: r.deadline ? r.deadline.toISOString() : null,
        pitchUrl: r.pitchUrl,
        pitchEmail: r.pitchEmail,
        category: r.category,
        score: r.score,
        whyRelevant: r.whyRelevant,
        pitchStatus: r.pitchStatus,
      })),
      total,
    });
  });

  return router;
}

export default createOpportunitiesRankedRouter();
