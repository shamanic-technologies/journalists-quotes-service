import { Router } from "express";
import {
  EqrsServiceError,
  scoreNextBatch,
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

export interface OpportunitiesDiscoverDeps {
  eqrsClient?: EqrsClient;
}

/**
 * POST /orgs/opportunities/discover — write-only batch scorer.
 *
 * Scores at most one batch (UNSCORED_BATCH_SIZE) of unscored submittable
 * clusters for the brand-set tuple, ordered by deadline urgency, pulling
 * Featured premium questions from EQRS when the silver pool is exhausted.
 * Returns `{ scored, exhausted }` — no opportunity payload; the caller
 * reads the catalog via GET /orgs/opportunities.
 *
 * The credit gate lives in the caller's workflow: each call costs exactly
 * one judge call, so the caller loops `while (!exhausted)` (re-checking its
 * own budget between calls) to drain the whole submittable pool. Same
 * mandatory headers as /next.
 */
export function createOpportunitiesDiscoverRouter(
  deps: OpportunitiesDiscoverDeps = {}
): Router {
  const router = Router();
  const eqrsClient = deps.eqrsClient ?? createEqrsClient();

  router.post("/orgs/opportunities/discover", async (req, res) => {
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
      `[journalists-quotes-service] /discover stage=request-entry orgId=${orgId} brandIds=${brandIds.join(",")} campaignId=${campaignId}`
    );

    let result;
    try {
      result = await scoreNextBatch({
        orgId,
        brandIds,
        campaignId,
        userId,
        runId,
        audienceId,
        eqrsClient,
      });
    } catch (err) {
      if (err instanceof EqrsServiceError) {
        res.status(502).json({ error: err.message });
        return;
      }
      throw err;
    }

    res.json({
      scored: result.scored,
      exhausted: result.exhausted,
      brandIds,
    });
  });

  return router;
}

export default createOpportunitiesDiscoverRouter();
