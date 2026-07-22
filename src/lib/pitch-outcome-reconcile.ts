/**
 * Featured/Connectively publication-outcome reconcile.
 *
 * Connectively has NO publication webhook, so a pitch's real outcome
 * (selected / published / not_selected) is only knowable by POLLING
 * EQRS's `GET /orgs/featured/submissions` pass-through. This module
 * pulls those outcomes and reconciles them onto quote_pitches, matched
 * on (featured_question_id, featured_profile_id).
 *
 * What Connectively exposes (confirmed live 2026-07-23): status, outlet
 * name (`publicationSource`), outlet DR (`domainAuthority`), backlink
 * attribution (`attribution`), submissionDate. What it does NOT expose:
 * the published article URL, the article title, or a per-stage
 * timestamp. So `featured_article_url` is never set from here (no
 * fabrication) and `outcome_observed_at` records OUR observation time.
 *
 * Fail loud: an EQRS error propagates (the explicit reconcile route maps
 * it to 502). Forward-only: status never downgrades. Idempotent: a
 * re-run with unchanged upstream data issues zero writes.
 */
import { and, eq, isNotNull } from "drizzle-orm";
import { db as defaultDb } from "../db/index.js";
import { quotePitches, eqrsSyncState } from "../db/schema.js";
import type { EqrsClient, EqrsSubmittedOutcome } from "./eqrs-client.js";

type Database = typeof defaultDb;

/**
 * Terminal/advanced pitch outcomes this reconcile can WRITE. These are a
 * subset of the pitch_status enum; they all participate in BLOCK_STATUSES
 * + the partial-unique-index, so advancing to them keeps the pitch
 * blocking (a brand cannot re-answer the same Featured question).
 */
export type ReconcileOutcomeStatus = "selected" | "published" | "not_selected";

/**
 * Map a Connectively `/submitted` status label to a JQS pitch status.
 * Returns null for "In Review" (still pending → keep `submitted`) and any
 * unrecognized label (never guess an outcome).
 */
export function mapConnectivelyStatus(
  raw: string
): ReconcileOutcomeStatus | null {
  switch (raw.trim().toLowerCase()) {
    case "published":
      return "published";
    case "selected":
      return "selected";
    case "not selected":
      return "not_selected";
    // "in review" (and anything else) → no advance
    default:
      return null;
  }
}

/** Rank for the forward-only guard: a pitch never moves to a lower rank. */
const STATUS_RANK: Record<string, number> = {
  drafted: 0,
  submitted: 1,
  // The three outcomes are terminal peers (rank 2). `not_selected` is a
  // terminal negative; `selected` may still advance to `published`, which
  // is handled explicitly below (published outranks selected).
  not_selected: 2,
  selected: 2,
  published: 3,
};

export interface PitchOutcomePatch {
  status?: ReconcileOutcomeStatus;
  outcomeObservedAt?: Date;
  publicationSource: string | null;
  outletDomainRating: number | null;
  backlinkAttribution: string | null;
}

/** A pitch row's fields relevant to the reconcile decision. */
export interface ReconcilablePitch {
  id: string;
  status: string;
  publicationSource: string | null;
  outletDomainRating: number | null;
  backlinkAttribution: string | null;
}

/**
 * Pure decision function: given a pitch's current state + the matching
 * Connectively outcome, return the patch to apply, or null if nothing
 * changed. Forward-only on status; always refreshes the press-value
 * enrichment columns (DR / attribution / outlet) to the latest values.
 */
export function computePitchOutcomePatch(
  pitch: ReconcilablePitch,
  outcome: EqrsSubmittedOutcome,
  now: Date
): PitchOutcomePatch | null {
  const target = mapConnectivelyStatus(outcome.status);

  // Forward-only status advance: only when the mapped target strictly
  // outranks the current status. published(3) > selected/not_selected(2)
  // > submitted(1). This lets submitted→any-outcome and selected→published
  // through, and blocks every downgrade (e.g. published→selected).
  let nextStatus: ReconcileOutcomeStatus | undefined;
  if (target !== null) {
    const currentRank = STATUS_RANK[pitch.status] ?? 0;
    if (STATUS_RANK[target] > currentRank) {
      nextStatus = target;
    }
  }

  const statusChanged = nextStatus !== undefined;
  const enrichmentChanged =
    pitch.publicationSource !== outcome.publicationSource ||
    pitch.outletDomainRating !== outcome.domainAuthority ||
    pitch.backlinkAttribution !== outcome.attribution;

  if (!statusChanged && !enrichmentChanged) return null;

  const patch: PitchOutcomePatch = {
    publicationSource: outcome.publicationSource,
    outletDomainRating: outcome.domainAuthority,
    backlinkAttribution: outcome.attribution,
  };
  if (statusChanged) {
    patch.status = nextStatus;
    // Record when WE observed this stage transition (Connectively does not
    // expose its own selected/published timestamp).
    patch.outcomeObservedAt = now;
  }
  return patch;
}

export interface ReconcileResult {
  /** Distinct Connectively outcomes pulled from EQRS. */
  outcomesFetched: number;
  /** Org pitches inspected (featured_api, with question+profile ids). */
  pitchesScanned: number;
  /** Pitches whose row was updated (status and/or enrichment). */
  updated: number;
  /** Count of pitches advanced to each outcome status this run. */
  advanced: { selected: number; published: number; not_selected: number };
}

export interface ReconcileArgs {
  orgId: string;
  userId?: string;
  runId?: string;
  audienceId?: string;
  eqrsClient: EqrsClient;
  database?: Database;
  now?: Date;
}

/**
 * Reconcile all of an org's Featured-API pitches against Connectively's
 * submitted outcomes. Fail loud (EQRS errors propagate). Idempotent.
 */
export async function reconcilePitchOutcomes(
  args: ReconcileArgs
): Promise<ReconcileResult> {
  const database = args.database ?? defaultDb;
  const now = args.now ?? new Date();

  const outcomes = await args.eqrsClient.fetchSubmittedOutcomes({
    orgId: args.orgId,
    userId: args.userId,
    runId: args.runId,
    audienceId: args.audienceId,
  });

  const byKey = new Map<string, EqrsSubmittedOutcome>();
  for (const o of outcomes) {
    byKey.set(`${o.featuredQuestionId}:${o.profileId}`, o);
  }

  const pitches = await database
    .select({
      id: quotePitches.id,
      status: quotePitches.status,
      featuredQuestionId: quotePitches.featuredQuestionId,
      featuredProfileId: quotePitches.featuredProfileId,
      publicationSource: quotePitches.publicationSource,
      outletDomainRating: quotePitches.outletDomainRating,
      backlinkAttribution: quotePitches.backlinkAttribution,
    })
    .from(quotePitches)
    .where(
      and(
        eq(quotePitches.orgId, args.orgId),
        eq(quotePitches.deliveryMethod, "featured_api"),
        isNotNull(quotePitches.featuredQuestionId),
        isNotNull(quotePitches.featuredProfileId)
      )
    );

  const result: ReconcileResult = {
    outcomesFetched: outcomes.length,
    pitchesScanned: pitches.length,
    updated: 0,
    advanced: { selected: 0, published: 0, not_selected: 0 },
  };

  for (const pitch of pitches) {
    const outcome = byKey.get(
      `${pitch.featuredQuestionId}:${pitch.featuredProfileId}`
    );
    if (!outcome) continue;

    const patch = computePitchOutcomePatch(pitch, outcome, now);
    if (!patch) continue;

    await database
      .update(quotePitches)
      .set({ ...patch, updatedAt: now })
      .where(eq(quotePitches.id, pitch.id));

    result.updated++;
    if (patch.status) result.advanced[patch.status]++;
  }

  return result;
}

/** Default throttle window for the on-read reconcile (10 minutes). */
export const RECONCILE_THROTTLE_MS = 10 * 60 * 1000;

/**
 * Best-effort, throttled reconcile for the report's read path. Runs a full
 * reconcile at most once per `throttleMs` per org (tracked on
 * eqrs_sync_state.last_outcome_reconciled_at), then stamps the marker.
 * Returns the reconcile result, or null when skipped (throttled). Errors
 * propagate to the caller, which decides whether to swallow (GET) or
 * surface (explicit route).
 */
export async function reconcileOnReadIfStale(args: {
  orgId: string;
  userId?: string;
  runId?: string;
  eqrsClient: EqrsClient;
  database?: Database;
  now?: Date;
  throttleMs?: number;
}): Promise<ReconcileResult | null> {
  const database = args.database ?? defaultDb;
  const now = args.now ?? new Date();
  const throttleMs = args.throttleMs ?? RECONCILE_THROTTLE_MS;

  const [row] = await database
    .select({ lastAt: eqrsSyncState.lastOutcomeReconciledAt })
    .from(eqrsSyncState)
    .where(eq(eqrsSyncState.orgId, args.orgId))
    .limit(1);

  if (
    row?.lastAt &&
    now.getTime() - new Date(row.lastAt).getTime() < throttleMs
  ) {
    return null; // reconciled recently — skip
  }

  const result = await reconcilePitchOutcomes({
    orgId: args.orgId,
    userId: args.userId,
    runId: args.runId,
    eqrsClient: args.eqrsClient,
    database,
    now,
  });

  await database
    .insert(eqrsSyncState)
    .values({ orgId: args.orgId, lastOutcomeReconciledAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: eqrsSyncState.orgId,
      set: { lastOutcomeReconciledAt: now, updatedAt: now },
    });

  return result;
}
