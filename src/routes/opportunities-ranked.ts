import { Router } from "express";
import { z } from "zod";
import { selectRankedPage } from "../lib/opportunity-pipeline.js";
import {
  BrandIdsHeaderError,
  parseBrandIdsHeader,
} from "../lib/brand-ids.js";

const SCORE_THRESHOLD = Number(process.env.SCORE_THRESHOLD ?? "0.5");

const OpportunityRankedRequestSchema = z.object({
  campaignId: z.string().uuid().optional(),
  limit: z.number().int().min(1).max(50).optional(),
  offset: z.number().int().min(0).optional(),
});

// Kept for test-app dependency-injection symmetry. Pure-read endpoint
// has no dependencies today — preserved as an empty object so tests can
// remain shape-stable across future additions.
export interface OpportunitiesRankedDeps {}

export function createOpportunitiesRankedRouter(
  _deps: OpportunitiesRankedDeps = {}
): Router {
  const router = Router();

  router.post("/orgs/opportunities/ranked", async (req, res) => {
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

    const parsed = OpportunityRankedRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const { campaignId } = parsed.data;
    const limit = parsed.data.limit ?? 20;
    const offset = parsed.data.offset ?? 0;
    const orgId = req.orgId!;

    const { rows, total } = await selectRankedPage({
      orgId,
      brandIds,
      campaignId,
      limit,
      offset,
      scoreThreshold: SCORE_THRESHOLD,
    });

    res.json({
      status: "ok",
      opportunities: rows.map((r) => ({
        opportunityId: r.opportunityId,
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
      brandIds,
    });
  });

  return router;
}

export default createOpportunitiesRankedRouter();
