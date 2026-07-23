/**
 * Featured/Connectively publication-outcome reconcile.
 *
 * Connectively has NO publication webhook, so a pitch's real outcome
 * (selected / published / not_selected) is only knowable by POLLING
 * EQRS's `GET /orgs/featured/submissions` pass-through. This module
 * pulls those outcomes and reconciles them onto quote_pitches, matched
 * on (featured_question_id, featured_profile_id).
 *
 * Two Connectively feeds are pulled (both via EQRS pass-throughs), matched
 * onto pitches by the same `(featured_question_id, featured_profile_id)` key:
 *
 * - `/submitted` (confirmed live 2026-07-23): status, outlet name
 *   (`publicationSource`), outlet DR (`domainAuthority`), backlink
 *   attribution (`attribution`), submissionDate. Drives the status advance +
 *   press-value enrichment. Has NO per-stage timestamp, so
 *   `outcome_observed_at` records OUR observation time.
 * - `/published` (confirmed live 2026-07-23): the published article's URL
 *   (`publishedLink`), title (`articleTitle`), and publish date
 *   (`publishDate` → `published_at`). This is the feed that carries the
 *   article link the press report links out to.
 *
 * No fabrication: a field the provider omits stays null. Fail loud: an EQRS
 * error propagates (the explicit reconcile route maps it to 502).
 * Forward-only: status never downgrades. Idempotent: a re-run with unchanged
 * upstream data issues zero writes.
 */
import { and, eq, isNotNull } from "drizzle-orm";
import { db as defaultDb } from "../db/index.js";
import { quotePitches, eqrsSyncState } from "../db/schema.js";
import type {
  EqrsClient,
  EqrsSubmittedOutcome,
  EqrsPublishedArticle,
} from "./eqrs-client.js";

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
  publicationSource?: string | null;
  outletDomainRating?: number | null;
  backlinkAttribution?: string | null;
  // Published-article placement fields (from the `/published` feed).
  featuredArticleUrl?: string | null;
  articleTitle?: string | null;
  publishedAt?: Date | null;
}

/** A pitch row's fields relevant to the reconcile decision. */
export interface ReconcilablePitch {
  id: string;
  status: string;
  publicationSource: string | null;
  outletDomainRating: number | null;
  backlinkAttribution: string | null;
  featuredArticleUrl: string | null;
  articleTitle: string | null;
  publishedAt: Date | null;
}

/** Two dates are equal if both null or same epoch ms. */
function sameDate(a: Date | null, b: Date | null): boolean {
  if (a === null || b === null) return a === b;
  return a.getTime() === b.getTime();
}

/**
 * Pure decision function: given a pitch's current state + the matching
 * Connectively `/submitted` outcome and/or `/published` article, return the
 * patch to apply, or null if nothing changed.
 *
 * - `/submitted` (`outcome`) drives the forward-only status advance + the
 *   press-value enrichment (outlet / DR / attribution).
 * - `/published` (`published`) supplies the article URL / title / publish
 *   date. These NEVER clobber an existing non-null value with null (no data
 *   loss): a field is written only when the provider gives a non-null value
 *   that differs from what's stored.
 *
 * At least one of `outcome` / `published` should be non-null; if both are
 * null the function returns null (nothing to reconcile).
 */
export function computePitchOutcomePatch(
  pitch: ReconcilablePitch,
  outcome: EqrsSubmittedOutcome | null,
  published: EqrsPublishedArticle | null,
  now: Date
): PitchOutcomePatch | null {
  const patch: PitchOutcomePatch = {};
  let changed = false;

  if (outcome) {
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

    const enrichmentChanged =
      pitch.publicationSource !== outcome.publicationSource ||
      pitch.outletDomainRating !== outcome.domainAuthority ||
      pitch.backlinkAttribution !== outcome.attribution;

    if (nextStatus !== undefined || enrichmentChanged) {
      patch.publicationSource = outcome.publicationSource;
      patch.outletDomainRating = outcome.domainAuthority;
      patch.backlinkAttribution = outcome.attribution;
      changed = true;
    }
    if (nextStatus !== undefined) {
      patch.status = nextStatus;
      // Record when WE observed this stage transition (Connectively does not
      // expose its own selected/published timestamp on the /submitted feed).
      patch.outcomeObservedAt = now;
    }
  }

  if (published) {
    // Never clobber an existing non-null value with null (no data loss).
    const nextUrl = published.articleUrl ?? pitch.featuredArticleUrl;
    const nextTitle = published.articleTitle ?? pitch.articleTitle;
    const nextPublishedAt = published.publishDate
      ? new Date(published.publishDate)
      : pitch.publishedAt;

    if (nextUrl !== pitch.featuredArticleUrl) {
      patch.featuredArticleUrl = nextUrl;
      changed = true;
    }
    if (nextTitle !== pitch.articleTitle) {
      patch.articleTitle = nextTitle;
      changed = true;
    }
    if (!sameDate(nextPublishedAt, pitch.publishedAt)) {
      patch.publishedAt = nextPublishedAt;
      changed = true;
    }
  }

  return changed ? patch : null;
}

export interface ReconcileResult {
  /** Distinct Connectively `/submitted` outcomes pulled from EQRS. */
  outcomesFetched: number;
  /** Distinct Connectively `/published` articles pulled from EQRS. */
  publishedFetched: number;
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

  const [outcomes, publishedArticles] = await Promise.all([
    args.eqrsClient.fetchSubmittedOutcomes({
      orgId: args.orgId,
      userId: args.userId,
      runId: args.runId,
      audienceId: args.audienceId,
    }),
    args.eqrsClient.fetchPublishedArticles({
      orgId: args.orgId,
      userId: args.userId,
      runId: args.runId,
      audienceId: args.audienceId,
    }),
  ]);

  const byKey = new Map<string, EqrsSubmittedOutcome>();
  for (const o of outcomes) {
    byKey.set(`${o.featuredQuestionId}:${o.profileId}`, o);
  }

  const publishedByKey = new Map<string, EqrsPublishedArticle>();
  for (const p of publishedArticles) {
    publishedByKey.set(`${p.featuredQuestionId}:${p.profileId}`, p);
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
      featuredArticleUrl: quotePitches.featuredArticleUrl,
      articleTitle: quotePitches.articleTitle,
      publishedAt: quotePitches.publishedAt,
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
    publishedFetched: publishedArticles.length,
    pitchesScanned: pitches.length,
    updated: 0,
    advanced: { selected: 0, published: 0, not_selected: 0 },
  };

  for (const pitch of pitches) {
    const key = `${pitch.featuredQuestionId}:${pitch.featuredProfileId}`;
    const outcome = byKey.get(key) ?? null;
    const published = publishedByKey.get(key) ?? null;
    if (!outcome && !published) continue;

    const patch = computePitchOutcomePatch(pitch, outcome, published, now);
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
