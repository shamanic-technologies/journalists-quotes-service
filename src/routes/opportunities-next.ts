import { Router } from "express";
import { z } from "zod";
import {
  BLOCK_STATUSES,
  FeaturedListError,
  KeyServiceError,
  fetchEligibleOpportunities,
  ingestFeaturedToSilver,
  rankOpportunities,
  type BuildFeaturedClient,
} from "../lib/opportunity-pipeline.js";
import {
  FeaturedClient,
  type FeaturedCredentials,
  type FeaturedClientOptions,
} from "../lib/featured-client.js";
import {
  BrandIdsHeaderError,
  parseBrandIdsHeader,
} from "../lib/brand-ids.js";

const SCORE_THRESHOLD = Number(process.env.SCORE_THRESHOLD ?? "0.5");

const OpportunityNextRequestSchema = z.object({
  campaignId: z.string().uuid().optional(),
});

export interface OpportunitiesNextDeps {
  buildClient?: BuildFeaturedClient;
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
    let brandIds: string[];
    try {
      brandIds = parseBrandIdsHeader(req.headers["x-brand-id"]);
    } catch (err) {
      if (err instanceof BrandIdsHeaderError) {
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }

    const parsed = OpportunityNextRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const { campaignId } = parsed.data;
    const orgId = req.orgId!;
    const userId = req.userId;
    const runId = req.runId;

    try {
      await ingestFeaturedToSilver({
        orgId,
        userId,
        runId,
        callerPath: "/orgs/opportunities/next",
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

    const eligible = await fetchEligibleOpportunities({
      orgId,
      brandIds,
      campaignId,
    });
    const ranked = await rankOpportunities({
      candidates: eligible,
      orgId,
      brandIds,
      campaignId,
      userId,
      runId,
      scoreThreshold: SCORE_THRESHOLD,
    });

    const available = ranked.find(
      (r) =>
        r.pitchStatus == null ||
        !BLOCK_STATUSES.includes(r.pitchStatus)
    );

    if (!available) {
      res.json({ found: false });
      return;
    }

    res.json({
      found: true,
      opportunity: {
        opportunityId: available.opportunityId,
        provider: available.provider,
        ingestionChannel: available.ingestionChannel,
        featuredQuestionId: available.featuredQuestionId,
        mediaOutlet: available.mediaOutlet,
        journalistName: available.journalistName,
        opportunityText: available.opportunityText,
        deadline: available.deadline
          ? available.deadline.toISOString()
          : null,
        pitchUrl: available.pitchUrl,
        pitchEmail: available.pitchEmail,
        category: available.category,
        score: available.score,
        whyRelevant: available.whyRelevant,
      },
      brandIds,
    });
  });

  return router;
}

export default createOpportunitiesNextRouter();
