import { Router } from "express";
import { z } from "zod";
import {
  selectOpportunitiesStats,
  selectRankedPage,
} from "../lib/opportunity-pipeline.js";
import {
  BrandIdsHeaderError,
  parseBrandIdsHeader,
} from "../lib/brand-ids.js";

const SCORE_THRESHOLD = Number(process.env.SCORE_THRESHOLD ?? "30");

const OpportunityRankedRequestSchema = z.object({
  campaignId: z.string().uuid().optional(),
  limit: z.number().int().min(1).max(50).optional(),
  offset: z.number().int().min(0).optional(),
});

// GET variant of the ranked read: same filter + shape, params from the
// query string. limit/offset arrive as strings → coerce.
const OpportunitiesGetQuerySchema = z.object({
  campaignId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const OpportunityStatsQuerySchema = z.object({
  campaign_id: z.string().uuid().optional(),
});

function buildRankedResponse(
  rows: Awaited<ReturnType<typeof selectRankedPage>>["rows"],
  total: number,
  brandIds: string[]
) {
  return {
    status: "ok" as const,
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
      submittable: r.submittable,
      deliveryMethod: r.deliveryMethod,
      score: r.score,
      whyRelevant: r.whyRelevant,
      pitchStatus: r.pitchStatus,
    })),
    total,
    brandIds,
  };
}

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

    res.json(buildRankedResponse(rows, total, brandIds));
  });

  // GET /orgs/opportunities — canonical pure-read list (renamed read
  // surface). Same filter + body shape as POST /ranked, params from the
  // query string. Dashboard polls this; POST /ranked is kept as a
  // deprecated alias until consumers migrate.
  router.get("/orgs/opportunities", async (req, res) => {
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

    const parsed = OpportunitiesGetQuerySchema.safeParse(req.query);
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

    res.json(buildRankedResponse(rows, total, brandIds));
  });

  router.get("/orgs/opportunities/stats", async (req, res) => {
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

    const parsed = OpportunityStatsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const orgId = req.orgId!;
    const campaignId = parsed.data.campaign_id;

    const stats = await selectOpportunitiesStats({
      orgId,
      brandIds,
      campaignId,
      scoreThreshold: SCORE_THRESHOLD,
    });

    console.log(
      `[journalists-quotes-service] /opportunities/stats orgId=${orgId} brandIds=${brandIds.join(",")} campaignId=${campaignId ?? "null"} silver=${stats.silverPoolSize} scored=${stats.scoredCount} eligible=${stats.eligibleCount} pitched=${stats.pitchedBlocking} expired=${stats.expiredCount} bestScore=${stats.bestEligibleScore ?? "null"}`
    );

    res.json({
      ...stats,
      brandIds,
    });
  });

  return router;
}

export default createOpportunitiesRankedRouter();
