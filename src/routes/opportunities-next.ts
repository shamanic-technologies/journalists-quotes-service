import { Router } from "express";
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
import {
  IdentityHeaderError,
  requireOpportunityIdentity,
} from "../lib/identity-guard.js";

// Auto-submit floor for /next. Deliberately DECOUPLED from the judge's
// semantic bands (≥70 direct / ≥30 adjacent / <30 off-topic): the floor is the
// minimum score /next will auto-pitch, NOT a band boundary. Set to 10 so /next
// also surfaces weak-but-non-noise opportunities (10-29), not only adjacent+
// (≥30). Reads (GET /orgs/opportunities) have NO floor regardless.
const SCORE_THRESHOLD = Number(process.env.SCORE_THRESHOLD ?? "10");

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

    // x-user-id, x-run-id, x-campaign-id are mandatory on this route —
    // it drives the LLM judge (tier-mirrored downstream) and is always
    // invoked inside a campaign workflow. Fail loud, never 400 one hop
    // later downstream.
    let identity;
    try {
      identity = requireOpportunityIdentity(req);
    } catch (err) {
      if (err instanceof IdentityHeaderError) {
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }
    const { userId, campaignId, audienceId } = identity;
    const orgId = req.orgId!;
    const runId = req.runId;

    console.log(
      `[journalists-quotes-service] /next stage=request-entry orgId=${orgId} brandIds=${brandIds.join(",")} campaignId=${campaignId}`
    );

    let best;
    try {
      best = await pickNextOpportunity({
        orgId,
        brandIds,
        campaignId,
        userId,
        runId,
        audienceId,
        featureSlug: req.featureSlug,
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
        submittable: best.submittable,
        deliveryMethod: best.deliveryMethod,
        score: best.score,
        whyRelevant: best.whyRelevant,
      },
      brandIds,
    });
  });

  return router;
}

export default createOpportunitiesNextRouter();
