import { Router } from "express";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { quotePitches } from "../db/schema.js";
import { QuotePitchListQuerySchema } from "../schemas.js";
import { createEqrsClient, type EqrsClient } from "../lib/eqrs-client.js";
import { EqrsServiceError } from "../lib/eqrs-client.js";
import {
  reconcilePitchOutcomes,
  reconcileOnReadIfStale,
} from "../lib/pitch-outcome-reconcile.js";

export interface QuotePitchesDeps {
  eqrsClient?: EqrsClient;
}

export function createQuotePitchesRouter(deps: QuotePitchesDeps = {}): Router {
  const router = Router();
  const eqrsClient = deps.eqrsClient ?? createEqrsClient();

  router.get("/orgs/quote-pitches", async (req, res) => {
    const parsed = QuotePitchListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const orgId = req.orgId!;
    const { campaign_id, status, limit, offset } = parsed.data;
    const limitN = limit ? Number(limit) : 100;
    const offsetN = offset ? Number(offset) : 0;

    // Best-effort, throttled publication-outcome refresh. The report polls
    // this endpoint; Connectively has no webhook, so this is where the
    // outcome poll is triggered (at most once / throttle window per org).
    // Fire-and-forget so the read stays fast — fresh status lands on the
    // next poll. The explicit POST /reconcile-outcomes is the fail-loud
    // path. `runId` is always set by withRunTracking; skip if EQRS is not
    // configured (throws synchronously at requireEnv) — never crash a read.
    void reconcileOnReadIfStale({
      orgId,
      userId: req.userId,
      runId: req.runId,
      eqrsClient,
    }).catch((err) => {
      console.error(
        "[journalists-quotes-service] on-read pitch-outcome reconcile failed:",
        err
      );
    });

    const conditions = [eq(quotePitches.orgId, orgId)];
    if (campaign_id) conditions.push(eq(quotePitches.campaignId, campaign_id));
    if (status) conditions.push(eq(quotePitches.status, status));

    const rows = await db
      .select()
      .from(quotePitches)
      .where(and(...conditions))
      .orderBy(desc(quotePitches.createdAt))
      .limit(limitN)
      .offset(offsetN);

    res.json({ quotePitches: rows });
  });

  /**
   * Explicit, fail-loud publication-outcome reconcile. Pulls the org's
   * Connectively submission outcomes from EQRS and advances matching
   * pitches (submitted → selected / published / not_selected) + records
   * outlet / DR / backlink attribution. Idempotent. Ignores the on-read
   * throttle. Callers: report generation / the auto-reply workflow tick.
   */
  router.post("/orgs/quote-pitches/reconcile-outcomes", async (req, res) => {
    const orgId = req.orgId!;
    try {
      const result = await reconcilePitchOutcomes({
        orgId,
        userId: req.userId,
        runId: req.runId,
        audienceId: req.audienceId,
        eqrsClient,
      });
      res.json(result);
    } catch (err) {
      if (err instanceof EqrsServiceError) {
        res.status(502).json({ error: err.message });
        return;
      }
      throw err;
    }
  });

  router.get("/orgs/quote-pitches/:id", async (req, res) => {
    const orgId = req.orgId!;
    const { id } = req.params;
    const [row] = await db
      .select()
      .from(quotePitches)
      .where(and(eq(quotePitches.orgId, orgId), eq(quotePitches.id, id)))
      .limit(1);
    if (!row) {
      res.status(404).json({ error: "Quote pitch not found" });
      return;
    }
    res.json({ quotePitch: row });
  });

  return router;
}

export default createQuotePitchesRouter();
