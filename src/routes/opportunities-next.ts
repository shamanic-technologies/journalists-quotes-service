import { Router } from "express";
import { z } from "zod";
import {
  EqrsServiceError,
  pickNextOpportunity,
} from "../lib/opportunity-pipeline.js";
import {
  createEqrsClient,
  type EqrsClient,
} from "../lib/eqrs-client.js";
import {
  BrandIdsHeaderError,
  parseBrandIdsHeader,
} from "../lib/brand-ids.js";

const SCORE_THRESHOLD = Number(process.env.SCORE_THRESHOLD ?? "30");

const OpportunityNextRequestSchema = z.object({
  campaignId: z.string().uuid().optional(),
});

export interface OpportunitiesNextDeps {
  eqrsClient?: EqrsClient;
}

export function createOpportunitiesNextRouter(
  deps: OpportunitiesNextDeps = {}
): Router {
  const router = Router();
  const eqrsClient = deps.eqrsClient ?? createEqrsClient();

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

    console.log(
      `[journalists-quotes-service] /next stage=request-entry orgId=${orgId} brandIds=${brandIds.join(",")} campaignId=${campaignId ?? "null"}`
    );

    let best;
    try {
      best = await pickNextOpportunity({
        orgId,
        brandIds,
        campaignId,
        userId,
        runId,
        scoreThreshold: SCORE_THRESHOLD,
        eqrsClient,
      });
    } catch (err) {
      if (err instanceof EqrsServiceError) {
        res.status(502).json({ error: err.message });
        return;
      }
      throw err;
    }

    if (!best) {
      res.json({ found: false });
      return;
    }

    res.json({
      found: true,
      opportunity: {
        opportunityId: best.opportunityId,
        provider: best.provider,
        ingestionChannel: best.ingestionChannel,
        featuredQuestionId: best.featuredQuestionId,
        mediaOutlet: best.mediaOutlet,
        journalistName: best.journalistName,
        opportunityText: best.opportunityText,
        deadline: best.deadline ? best.deadline.toISOString() : null,
        pitchUrl: best.pitchUrl,
        pitchEmail: best.pitchEmail,
        category: best.category,
        score: best.score,
        whyRelevant: best.whyRelevant,
      },
      brandIds,
    });
  });

  return router;
}

export default createOpportunitiesNextRouter();
