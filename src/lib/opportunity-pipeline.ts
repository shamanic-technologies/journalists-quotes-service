import { and, eq, inArray, isNull, or, sql as drizzleSql } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  eqrsSyncState,
  providerQuoteRequests,
  quoteOpportunities,
  quotePitches,
  quotePriorities,
} from "../db/schema.js";
import {
  createEqrsClient,
  type EqrsClient,
  type EqrsOpportunity,
} from "./eqrs-client.js";
import { ragScore } from "./chat-client.js";
import { SHARED_EMAIL_ORG_ID } from "./inbound/process.js";
import { computeFingerprint } from "./cluster/fingerprint.js";

export class EqrsServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EqrsServiceError";
  }
}

export type PitchStatusValue =
  | "drafted"
  | "submitted"
  | "selected"
  | "published"
  | "not_selected"
  | "error"
  | "length_violation"
  | "template_missing"
  | "brand_missing_fields"
  | "insufficient_credits";

export const BLOCK_STATUSES: PitchStatusValue[] = [
  "drafted",
  "submitted",
  "selected",
  "published",
  "not_selected",
];

/**
 * A Gold cluster surfaced to the API. The visible text + outlet +
 * deadline + delivery hints come from the silver "representative" row
 * (picked per pickRepresentativeSilver — Featured-API capable rows
 * preferred, then most recent email row).
 */
export interface EligibleOpportunity {
  opportunityId: string;
  representativeSilverId: string;
  provider: string;
  ingestionChannel: string;
  featuredQuestionId: number | null;
  mediaOutlet: string | null;
  journalistName: string | null;
  opportunityText: string;
  deadline: Date | null;
  pitchUrl: string | null;
  pitchEmail: string | null;
  category: string | null;
  pitchStatus: PitchStatusValue | null;
}

export interface RankedOpportunity extends EligibleOpportunity {
  score: number;
  whyRelevant: string | null;
}

function safeParseDate(value: string | undefined | null): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Pull new Featured opportunities from expert-quotes-requests-service
 * (EQRS) since the org's last cursor, project them into JQS silver +
 * Gold cluster, advance cursor. EQRS owns the Featured.com HTTP /
 * JWT / rate-limit / bronze raw payload responsibilities; JQS only
 * keeps the silver projection + clustering.
 *
 * Idempotent: silver insert uses
 * ON CONFLICT (provider, ingestion_channel, external_id) DO NOTHING.
 * Repeat calls when EQRS has nothing new are cheap no-ops.
 */
export async function ingestFeaturedToSilver(args: {
  orgId: string;
  userId?: string;
  runId?: string;
  eqrsClient: EqrsClient;
}): Promise<void> {
  const { orgId, userId, runId, eqrsClient } = args;

  const [cursorRow] = await db
    .select({ lastSyncedAt: eqrsSyncState.lastSyncedAt })
    .from(eqrsSyncState)
    .where(eq(eqrsSyncState.orgId, orgId));

  const since = cursorRow?.lastSyncedAt
    ? cursorRow.lastSyncedAt.toISOString()
    : undefined;

  let response;
  try {
    response = await eqrsClient.fetchOpportunities({
      orgId,
      userId,
      runId,
      since,
    });
  } catch (err) {
    throw new EqrsServiceError((err as Error).message);
  }

  const items = response.items;

  let newSilverCount = 0;
  if (items.length > 0) {
    // Bulk path: 3 queries total regardless of EQRS page size.
    const allPrepared = items.map((o: EqrsOpportunity) => {
      const text = o.opportunityText;
      const outlet = o.mediaOutlet ?? null;
      const fingerprint = computeFingerprint(text, outlet);
      return {
        o,
        text,
        outlet,
        fingerprint,
        deadline: safeParseDate(o.deadline),
      };
    });

    // Dedupe by fingerprint within this batch. Featured.com sometimes
    // surfaces the same question across multiple Featured rows (e.g.
    // tagged for different verticals); after our fingerprint(text,
    // outlet) collapse they hash to the same Gold cluster. ON CONFLICT
    // DO UPDATE cannot affect the same row twice in one command —
    // Postgres errcode 21000 — so we must keep one per fingerprint
    // before the bulk upsert. The dropped duplicates still get a
    // silver row each (silver natural key is external_id, not
    // fingerprint), but they all point at the same Gold cluster.
    const preparedByFingerprint = new Map<string, typeof allPrepared[number]>();
    for (const r of allPrepared) {
      if (!preparedByFingerprint.has(r.fingerprint)) {
        preparedByFingerprint.set(r.fingerprint, r);
      }
    }
    const uniqueByFingerprint = Array.from(preparedByFingerprint.values());

    // 1. Bulk upsert Gold clusters by fingerprint (touch last_seen_at).
    await db
      .insert(quoteOpportunities)
      .values(
        uniqueByFingerprint.map((r) => ({
          fingerprint: r.fingerprint,
          canonicalText: r.text,
          canonicalOutlet: r.outlet,
          canonicalDeadline: r.deadline,
          clusterMethod: "fingerprint" as const,
        }))
      )
      .onConflictDoUpdate({
        target: quoteOpportunities.fingerprint,
        set: { lastSeenAt: drizzleSql`now()` },
      });

    // 2. Resolve cluster ids by fingerprint.
    const fingerprints = uniqueByFingerprint.map((r) => r.fingerprint);
    const clusterRows = await db
      .select({
        id: quoteOpportunities.id,
        fingerprint: quoteOpportunities.fingerprint,
      })
      .from(quoteOpportunities)
      .where(inArray(quoteOpportunities.fingerprint, fingerprints));
    const clusterIdByFingerprint = new Map(
      clusterRows.map((c) => [c.fingerprint, c.id])
    );

    // 3. Bulk insert silver rows. Dedupe by external_id within the
    //    batch too — silver natural key is
    //    (provider, ingestion_channel, external_id), and ON CONFLICT
    //    DO NOTHING also errors with 21000 when the VALUES list has
    //    duplicates on the conflict target. raw=null — EQRS owns the
    //    bronze raw payload; JQS only stores the projection columns
    //    it needs for clustering + representative-silver lookup in
    //    /reply.
    const silverRowsByExternalId = new Map<
      string,
      typeof allPrepared[number]
    >();
    for (const r of allPrepared) {
      if (!clusterIdByFingerprint.has(r.fingerprint)) continue;
      if (!silverRowsByExternalId.has(r.o.externalId)) {
        silverRowsByExternalId.set(r.o.externalId, r);
      }
    }
    const uniqueByExternalId = Array.from(silverRowsByExternalId.values());

    if (uniqueByExternalId.length > 0) {
      const silverInserted = await db
        .insert(providerQuoteRequests)
        .values(
          uniqueByExternalId.map((r) => ({
            provider: "featured",
            ingestionChannel: "api" as const,
            externalId: r.o.externalId,
            featuredQuestionId: r.o.featuredQuestionId,
            mediaOutlet: r.outlet,
            opportunityText: r.text,
            pitchUrl: r.o.pitchUrl ?? null,
            deadline: r.deadline,
            raw: null,
            quoteOpportunityId: clusterIdByFingerprint.get(r.fingerprint)!,
            isCanonical: false,
            fingerprint: r.fingerprint,
            orgId,
          }))
        )
        .onConflictDoNothing({
          target: [
            providerQuoteRequests.provider,
            providerQuoteRequests.ingestionChannel,
            providerQuoteRequests.externalId,
          ],
        })
        .returning({ id: providerQuoteRequests.id });
      newSilverCount = silverInserted.length;
    }
  }

  // Advance cursor — use EQRS-provided nextSince when present, else
  // bump to now() if we got items (caller already saw everything up to
  // this moment). Leave cursor unchanged if EQRS returned 0 items AND
  // no nextSince — next call will refetch from the same `since`.
  const nextSince =
    response.nextSince != null
      ? new Date(response.nextSince)
      : items.length > 0
        ? new Date()
        : null;
  if (nextSince != null) {
    await db
      .insert(eqrsSyncState)
      .values({
        orgId,
        lastSyncedAt: nextSince,
        lastCursor: null,
        updatedAt: drizzleSql`now()`,
      })
      .onConflictDoUpdate({
        target: eqrsSyncState.orgId,
        set: {
          lastSyncedAt: nextSince,
          updatedAt: drizzleSql`now()`,
        },
      });
  }

  console.log(
    `[journalists-quotes-service] /next stage=eqrs-fetch orgId=${orgId} since=${since ?? "null"} returned=${items.length} newSilverCount=${newSilverCount} nextSince=${response.nextSince ?? "null"} refreshed=${response.refreshed}`
  );
}

interface SilverRow {
  id: string;
  provider: string;
  ingestionChannel: string;
  featuredQuestionId: number | null;
  mediaOutlet: string | null;
  journalistName: string | null;
  opportunityText: string;
  deadline: Date | null;
  pitchUrl: string | null;
  pitchEmail: string | null;
  category: string | null;
  quoteOpportunityId: string | null;
  fetchedAt: Date;
  isCanonical: boolean;
}

/**
 * Pick the silver row that best represents a Gold cluster for outbound
 * dispatch. Rule (per design decision):
 *   1. Featured-API rows preferred (so reply uses Featured submitAnswer).
 *   2. Otherwise, the most recently fetched silver row.
 */
export function pickRepresentativeSilver<T extends SilverRow>(rows: T[]): T {
  if (rows.length === 0) {
    throw new Error(
      "pickRepresentativeSilver: rows must be non-empty"
    );
  }
  const featured = rows
    .filter(
      (r) => r.provider === "featured" && r.featuredQuestionId != null
    )
    .sort((a, b) => b.fetchedAt.getTime() - a.fetchedAt.getTime());
  if (featured.length > 0) return featured[0];
  const others = [...rows].sort(
    (a, b) => b.fetchedAt.getTime() - a.fetchedAt.getTime()
  );
  return others[0];
}

const UNSCORED_BATCH_SIZE = 10;

/**
 * Pick up to UNSCORED_BATCH_SIZE Gold clusters reachable from the
 * org's silver pool that have NO row in quote_priorities for the
 * exact brand-set tuple (LEFT JOIN ... IS NULL). Filters out
 * expired (canonical_deadline < now()) clusters.
 *
 * Returned rows are the minimum needed for ragScore: opportunityId +
 * text. The /reply path uses pickRepresentativeSilver elsewhere — this
 * helper is a scoring-batch picker, not a UI-row builder.
 */
async function selectUnscoredBatch(
  orgId: string,
  brandIds: string[]
): Promise<{ opportunityId: string; opportunityText: string }[]> {
  const rows = await db
    .select({
      opportunityId: quoteOpportunities.id,
      opportunityText: quoteOpportunities.canonicalText,
    })
    .from(quoteOpportunities)
    .leftJoin(
      quotePriorities,
      and(
        eq(quotePriorities.quoteOpportunityId, quoteOpportunities.id),
        eq(quotePriorities.brandIds, brandIds)
      )
    )
    .where(
      and(
        isNull(quotePriorities.quoteOpportunityId),
        or(
          drizzleSql`${quoteOpportunities.canonicalDeadline} IS NULL`,
          drizzleSql`${quoteOpportunities.canonicalDeadline} > now()`
        ),
        drizzleSql`EXISTS (SELECT 1 FROM ${providerQuoteRequests} WHERE ${providerQuoteRequests.quoteOpportunityId} = ${quoteOpportunities.id} AND (${providerQuoteRequests.orgId} = ${orgId}::uuid OR ${providerQuoteRequests.orgId} = ${SHARED_EMAIL_ORG_ID}::uuid))`
      )
    )
    .orderBy(quoteOpportunities.firstSeenAt)
    .limit(UNSCORED_BATCH_SIZE);

  return rows;
}

/**
 * Score a batch of unscored opportunities against the brand-set tuple
 * via a single chat-service call (DIS-67 native multi-brand). Persists
 * to Gold (`quote_priorities`) keyed by (quote_opportunity_id, brand_ids[]).
 * Idempotent: upsert via onConflictDoUpdate.
 */
async function scoreUnscored(args: {
  candidates: { opportunityId: string; opportunityText: string }[];
  orgId: string;
  brandIds: string[];
  campaignId?: string;
  userId?: string;
  runId?: string;
}): Promise<void> {
  const { candidates, orgId, brandIds, campaignId, userId, runId } = args;
  if (candidates.length === 0) return;

  const response = await ragScore(
    {
      documents: candidates.map((c) => ({
        id: c.opportunityId,
        text: c.opportunityText,
      })),
      brandIds,
    },
    orgId,
    userId,
    runId
  );

  if (response.results.length === 0) return;

  await db
    .insert(quotePriorities)
    .values(
      response.results.map((r) => ({
        quoteOpportunityId: r.id,
        brandIds,
        campaignId: campaignId ?? null,
        score: r.score.toFixed(2),
        whyRelevant: r.whyRelevant ?? null,
        scoredByRunId: runId ?? null,
        orgId,
      }))
    )
    .onConflictDoUpdate({
      target: [
        quotePriorities.quoteOpportunityId,
        quotePriorities.brandIds,
      ],
      set: {
        score: drizzleSql`excluded.score`,
        whyRelevant: drizzleSql`excluded.why_relevant`,
        scoredAt: drizzleSql`now()`,
        scoredByRunId: drizzleSql`excluded.scored_by_run_id`,
        campaignId: drizzleSql`excluded.campaign_id`,
      },
    });
}

/**
 * Return the single best Gold cluster for (orgId, brandIds, campaignId?):
 *   - score >= scoreThreshold
 *   - canonical_deadline > now() OR NULL
 *   - no blocking quote_pitches row on the EXACT brand-set tuple
 *     (campaign-scoped if campaignId provided, brand-only otherwise)
 *   - at least one silver row in the org's pool (own or SHARED_EMAIL_ORG_ID)
 *
 * Tie-break on score: oldest Gold cluster wins (first_seen_at ASC). Returns
 * null when nothing eligible remains.
 */
async function selectBestNonPitched(args: {
  orgId: string;
  brandIds: string[];
  campaignId?: string;
  scoreThreshold: number;
}): Promise<RankedOpportunity | null> {
  const { orgId, brandIds, campaignId, scoreThreshold } = args;

  // Anti-join sub-select: which Gold cluster ids are blocked by a pitch?
  const pitchScope = campaignId
    ? and(
        eq(quotePitches.brandIds, brandIds),
        eq(quotePitches.campaignId, campaignId),
        inArray(quotePitches.status, BLOCK_STATUSES)
      )
    : and(
        eq(quotePitches.brandIds, brandIds),
        inArray(quotePitches.status, BLOCK_STATUSES)
      );

  const blockedRows = await db
    .selectDistinct({ id: quotePitches.quoteOpportunityId })
    .from(quotePitches)
    .where(pitchScope);
  const blockedIds = blockedRows
    .map((r) => r.id)
    .filter((id): id is string => id != null);

  const candidates = await db
    .select({
      opportunityId: quoteOpportunities.id,
      canonicalText: quoteOpportunities.canonicalText,
      canonicalDeadline: quoteOpportunities.canonicalDeadline,
      score: quotePriorities.score,
      whyRelevant: quotePriorities.whyRelevant,
    })
    .from(quotePriorities)
    .innerJoin(
      quoteOpportunities,
      eq(quoteOpportunities.id, quotePriorities.quoteOpportunityId)
    )
    .where(
      and(
        eq(quotePriorities.brandIds, brandIds),
        drizzleSql`${quotePriorities.score} >= ${scoreThreshold.toFixed(2)}::numeric`,
        or(
          drizzleSql`${quoteOpportunities.canonicalDeadline} IS NULL`,
          drizzleSql`${quoteOpportunities.canonicalDeadline} > now()`
        ),
        drizzleSql`EXISTS (SELECT 1 FROM ${providerQuoteRequests} WHERE ${providerQuoteRequests.quoteOpportunityId} = ${quoteOpportunities.id} AND (${providerQuoteRequests.orgId} = ${orgId}::uuid OR ${providerQuoteRequests.orgId} = ${SHARED_EMAIL_ORG_ID}::uuid))`,
        blockedIds.length > 0
          ? drizzleSql`${quoteOpportunities.id} NOT IN (${drizzleSql.join(
              blockedIds.map((id) => drizzleSql`${id}::uuid`),
              drizzleSql`, `
            )})`
          : drizzleSql`TRUE`
      )
    )
    .orderBy(
      drizzleSql`${quotePriorities.score} DESC`,
      drizzleSql`${quoteOpportunities.firstSeenAt} ASC`
    )
    .limit(1);

  if (candidates.length === 0) return null;
  const best = candidates[0];

  // Hydrate the representative silver row for outbound delivery hints.
  const silvers = await db
    .select({
      id: providerQuoteRequests.id,
      provider: providerQuoteRequests.provider,
      ingestionChannel: providerQuoteRequests.ingestionChannel,
      featuredQuestionId: providerQuoteRequests.featuredQuestionId,
      mediaOutlet: providerQuoteRequests.mediaOutlet,
      journalistName: providerQuoteRequests.journalistName,
      opportunityText: providerQuoteRequests.opportunityText,
      deadline: providerQuoteRequests.deadline,
      pitchUrl: providerQuoteRequests.pitchUrl,
      pitchEmail: providerQuoteRequests.pitchEmail,
      category: providerQuoteRequests.category,
      quoteOpportunityId: providerQuoteRequests.quoteOpportunityId,
      fetchedAt: providerQuoteRequests.fetchedAt,
      isCanonical: providerQuoteRequests.isCanonical,
    })
    .from(providerQuoteRequests)
    .where(
      and(
        or(
          eq(providerQuoteRequests.orgId, orgId),
          eq(providerQuoteRequests.orgId, SHARED_EMAIL_ORG_ID)
        ),
        eq(providerQuoteRequests.quoteOpportunityId, best.opportunityId)
      )
    );

  if (silvers.length === 0) return null;
  const rep = pickRepresentativeSilver(silvers);

  return {
    opportunityId: best.opportunityId,
    representativeSilverId: rep.id,
    provider: rep.provider,
    ingestionChannel: rep.ingestionChannel,
    featuredQuestionId: rep.featuredQuestionId,
    mediaOutlet: rep.mediaOutlet,
    journalistName: rep.journalistName,
    opportunityText: rep.opportunityText ?? best.canonicalText,
    deadline: rep.deadline ?? best.canonicalDeadline,
    pitchUrl: rep.pitchUrl,
    pitchEmail: rep.pitchEmail,
    category: rep.category,
    pitchStatus: null,
    score: Number(best.score),
    whyRelevant: best.whyRelevant,
  };
}

/**
 * Pure-read paginated ranked list for the brand-set.
 *
 *   - Reads from `quote_priorities` (Gold scored projection) joined to
 *     `quote_opportunities` (silver canonical). Annotates each row with
 *     the latest `pitchStatus` seen for the brand-set (campaign-scoped
 *     when campaignId provided, else any campaign).
 *   - NO scoring, NO Featured ingest. Opportunities not yet scored for
 *     this brand-set tuple are simply absent from the response — the
 *     `/next` write-path is what fills them.
 *   - Filters expired `canonical_deadline`. Includes pitched
 *     opportunities (caller decides what to do with `pitchStatus`).
 *
 * Returns `{ rows, total }` where total is the unpaginated count.
 */
export async function selectRankedPage(args: {
  orgId: string;
  brandIds: string[];
  campaignId?: string;
  limit: number;
  offset: number;
  scoreThreshold: number;
}): Promise<{ rows: RankedOpportunity[]; total: number }> {
  const { orgId, brandIds, campaignId, limit, offset, scoreThreshold } = args;

  const filter = and(
    eq(quotePriorities.brandIds, brandIds),
    drizzleSql`${quotePriorities.score} >= ${scoreThreshold.toFixed(2)}::numeric`,
    or(
      drizzleSql`${quoteOpportunities.canonicalDeadline} IS NULL`,
      drizzleSql`${quoteOpportunities.canonicalDeadline} > now()`
    ),
    drizzleSql`EXISTS (SELECT 1 FROM ${providerQuoteRequests} WHERE ${providerQuoteRequests.quoteOpportunityId} = ${quoteOpportunities.id} AND (${providerQuoteRequests.orgId} = ${orgId}::uuid OR ${providerQuoteRequests.orgId} = ${SHARED_EMAIL_ORG_ID}::uuid))`
  );

  const [totalRow] = await db
    .select({ n: drizzleSql<number>`count(*)::int` })
    .from(quotePriorities)
    .innerJoin(
      quoteOpportunities,
      eq(quoteOpportunities.id, quotePriorities.quoteOpportunityId)
    )
    .where(filter);
  const total = totalRow?.n ?? 0;

  if (total === 0) {
    return { rows: [], total: 0 };
  }

  const page = await db
    .select({
      opportunityId: quoteOpportunities.id,
      canonicalText: quoteOpportunities.canonicalText,
      canonicalDeadline: quoteOpportunities.canonicalDeadline,
      score: quotePriorities.score,
      whyRelevant: quotePriorities.whyRelevant,
    })
    .from(quotePriorities)
    .innerJoin(
      quoteOpportunities,
      eq(quoteOpportunities.id, quotePriorities.quoteOpportunityId)
    )
    .where(filter)
    .orderBy(
      drizzleSql`${quotePriorities.score} DESC`,
      drizzleSql`${quoteOpportunities.firstSeenAt} ASC`
    )
    .limit(limit)
    .offset(offset);

  if (page.length === 0) {
    return { rows: [], total };
  }

  const opportunityIds = page.map((p) => p.opportunityId);

  const silvers = await db
    .select({
      id: providerQuoteRequests.id,
      provider: providerQuoteRequests.provider,
      ingestionChannel: providerQuoteRequests.ingestionChannel,
      featuredQuestionId: providerQuoteRequests.featuredQuestionId,
      mediaOutlet: providerQuoteRequests.mediaOutlet,
      journalistName: providerQuoteRequests.journalistName,
      opportunityText: providerQuoteRequests.opportunityText,
      deadline: providerQuoteRequests.deadline,
      pitchUrl: providerQuoteRequests.pitchUrl,
      pitchEmail: providerQuoteRequests.pitchEmail,
      category: providerQuoteRequests.category,
      quoteOpportunityId: providerQuoteRequests.quoteOpportunityId,
      fetchedAt: providerQuoteRequests.fetchedAt,
      isCanonical: providerQuoteRequests.isCanonical,
    })
    .from(providerQuoteRequests)
    .where(
      and(
        or(
          eq(providerQuoteRequests.orgId, orgId),
          eq(providerQuoteRequests.orgId, SHARED_EMAIL_ORG_ID)
        ),
        inArray(providerQuoteRequests.quoteOpportunityId, opportunityIds)
      )
    );

  const silversByOppId = new Map<string, typeof silvers>();
  for (const s of silvers) {
    if (!s.quoteOpportunityId) continue;
    const list = silversByOppId.get(s.quoteOpportunityId) ?? [];
    list.push(s);
    silversByOppId.set(s.quoteOpportunityId, list);
  }

  const pitchScope = campaignId
    ? and(
        eq(quotePitches.brandIds, brandIds),
        eq(quotePitches.campaignId, campaignId),
        inArray(quotePitches.quoteOpportunityId, opportunityIds)
      )
    : and(
        eq(quotePitches.brandIds, brandIds),
        inArray(quotePitches.quoteOpportunityId, opportunityIds)
      );

  const pitches = await db
    .select({
      quoteOpportunityId: quotePitches.quoteOpportunityId,
      status: quotePitches.status,
      updatedAt: quotePitches.updatedAt,
    })
    .from(quotePitches)
    .where(pitchScope);

  const latestPitchByOppId = new Map<
    string,
    { status: PitchStatusValue; updatedAt: Date }
  >();
  for (const p of pitches) {
    if (!p.quoteOpportunityId) continue;
    const prev = latestPitchByOppId.get(p.quoteOpportunityId);
    if (!prev || prev.updatedAt < p.updatedAt) {
      latestPitchByOppId.set(p.quoteOpportunityId, {
        status: p.status,
        updatedAt: p.updatedAt,
      });
    }
  }

  const rows: RankedOpportunity[] = [];
  for (const row of page) {
    const rowSilvers = silversByOppId.get(row.opportunityId);
    if (!rowSilvers || rowSilvers.length === 0) continue;
    const rep = pickRepresentativeSilver(rowSilvers);
    rows.push({
      opportunityId: row.opportunityId,
      representativeSilverId: rep.id,
      provider: rep.provider,
      ingestionChannel: rep.ingestionChannel,
      featuredQuestionId: rep.featuredQuestionId,
      mediaOutlet: rep.mediaOutlet,
      journalistName: rep.journalistName,
      opportunityText: rep.opportunityText ?? row.canonicalText,
      deadline: rep.deadline ?? row.canonicalDeadline,
      pitchUrl: rep.pitchUrl,
      pitchEmail: rep.pitchEmail,
      category: rep.category,
      pitchStatus: latestPitchByOppId.get(row.opportunityId)?.status ?? null,
      score: Number(row.score),
      whyRelevant: row.whyRelevant,
    });
  }

  console.log(
    `[journalists-quotes-service] /ranked orgId=${orgId} brandIds=${brandIds.join(",")} campaignId=${campaignId ?? "null"} limit=${limit} offset=${offset} total=${total} returned=${rows.length}`
  );

  return { rows, total };
}

/**
 * Brand-set scoped Gold catalog stats. Pure-read (no scoring, no
 * ingest). Used by the HITL dashboard "you have N opportunities"
 * summary + for prod debugging of catalog growth.
 *
 * Definitions:
 *   - silverPoolSize: count of provider_quote_requests for the org
 *     (own or SHARED_EMAIL_ORG_ID), regardless of scoring state.
 *   - scoredCount: count of quote_priorities rows for the brand-set
 *     tuple (some may be below threshold).
 *   - eligibleCount: scored above SCORE_THRESHOLD, deadline non-expired,
 *     NOT in quote_pitches blocking states for the brand-set
 *     (campaign-scoped if campaignId provided).
 *   - pitchedBlocking: count of quote_pitches blocking rows for the
 *     brand-set (campaign-scoped if campaignId provided).
 *   - expiredCount: scored opportunities with canonical_deadline < now().
 *   - bestEligibleScore: highest score among eligible rows, or null.
 */
export async function selectOpportunitiesStats(args: {
  orgId: string;
  brandIds: string[];
  campaignId?: string;
  scoreThreshold: number;
}): Promise<{
  silverPoolSize: number;
  scoredCount: number;
  eligibleCount: number;
  pitchedBlocking: number;
  expiredCount: number;
  bestEligibleScore: number | null;
}> {
  const { orgId, brandIds, campaignId, scoreThreshold } = args;

  const [silverRow] = await db
    .select({ n: drizzleSql<number>`count(*)::int` })
    .from(providerQuoteRequests)
    .where(
      or(
        eq(providerQuoteRequests.orgId, orgId),
        eq(providerQuoteRequests.orgId, SHARED_EMAIL_ORG_ID)
      )
    );

  const [scoredRow] = await db
    .select({ n: drizzleSql<number>`count(*)::int` })
    .from(quotePriorities)
    .where(eq(quotePriorities.brandIds, brandIds));

  const [expiredRow] = await db
    .select({ n: drizzleSql<number>`count(*)::int` })
    .from(quotePriorities)
    .innerJoin(
      quoteOpportunities,
      eq(quoteOpportunities.id, quotePriorities.quoteOpportunityId)
    )
    .where(
      and(
        eq(quotePriorities.brandIds, brandIds),
        drizzleSql`${quoteOpportunities.canonicalDeadline} IS NOT NULL`,
        drizzleSql`${quoteOpportunities.canonicalDeadline} < now()`
      )
    );

  const pitchScope = campaignId
    ? and(
        eq(quotePitches.brandIds, brandIds),
        eq(quotePitches.campaignId, campaignId),
        inArray(quotePitches.status, BLOCK_STATUSES)
      )
    : and(
        eq(quotePitches.brandIds, brandIds),
        inArray(quotePitches.status, BLOCK_STATUSES)
      );

  const [pitchedRow] = await db
    .select({ n: drizzleSql<number>`count(*)::int` })
    .from(quotePitches)
    .where(pitchScope);

  const blockedRows = await db
    .selectDistinct({ id: quotePitches.quoteOpportunityId })
    .from(quotePitches)
    .where(pitchScope);
  const blockedIds = blockedRows
    .map((r) => r.id)
    .filter((id): id is string => id != null);

  const eligibleFilter = and(
    eq(quotePriorities.brandIds, brandIds),
    drizzleSql`${quotePriorities.score} >= ${scoreThreshold.toFixed(2)}::numeric`,
    or(
      drizzleSql`${quoteOpportunities.canonicalDeadline} IS NULL`,
      drizzleSql`${quoteOpportunities.canonicalDeadline} > now()`
    ),
    drizzleSql`EXISTS (SELECT 1 FROM ${providerQuoteRequests} WHERE ${providerQuoteRequests.quoteOpportunityId} = ${quoteOpportunities.id} AND (${providerQuoteRequests.orgId} = ${orgId}::uuid OR ${providerQuoteRequests.orgId} = ${SHARED_EMAIL_ORG_ID}::uuid))`,
    blockedIds.length > 0
      ? drizzleSql`${quoteOpportunities.id} NOT IN (${drizzleSql.join(
          blockedIds.map((id) => drizzleSql`${id}::uuid`),
          drizzleSql`, `
        )})`
      : drizzleSql`TRUE`
  );

  const [eligibleRow] = await db
    .select({ n: drizzleSql<number>`count(*)::int` })
    .from(quotePriorities)
    .innerJoin(
      quoteOpportunities,
      eq(quoteOpportunities.id, quotePriorities.quoteOpportunityId)
    )
    .where(eligibleFilter);

  const [bestRow] = await db
    .select({ best: drizzleSql<number | null>`max(${quotePriorities.score})` })
    .from(quotePriorities)
    .innerJoin(
      quoteOpportunities,
      eq(quoteOpportunities.id, quotePriorities.quoteOpportunityId)
    )
    .where(eligibleFilter);

  return {
    silverPoolSize: silverRow?.n ?? 0,
    scoredCount: scoredRow?.n ?? 0,
    eligibleCount: eligibleRow?.n ?? 0,
    pitchedBlocking: pitchedRow?.n ?? 0,
    expiredCount: expiredRow?.n ?? 0,
    bestEligibleScore:
      bestRow?.best != null ? Number(bestRow.best) : null,
  };
}

/**
 * One /next pipeline call. Exhaustion-driven:
 *
 *   1. Try `selectUnscoredBatch` against the existing silver pool.
 *   2. If empty, pull new opportunities from EQRS since the org's last
 *      cursor and project into silver + Gold cluster. Re-query.
 *   3. Score whatever was found (≤ UNSCORED_BATCH_SIZE in one
 *      multi-brand chat-service call).
 *   4. Return the single best non-pitched candidate.
 *
 * No time-based TTL. EQRS owns Featured throttling internally; from
 * JQS's point of view, EQRS is the upstream and we pull only when the
 * silver pool for this brand-set is exhausted. EQRS replies fast when
 * nothing new (`items=[]` + no nextSince).
 */
export async function pickNextOpportunity(args: {
  orgId: string;
  brandIds: string[];
  campaignId?: string;
  userId?: string;
  runId?: string;
  scoreThreshold: number;
  eqrsClient: EqrsClient;
}): Promise<RankedOpportunity | null> {
  const {
    orgId,
    brandIds,
    campaignId,
    userId,
    runId,
    scoreThreshold,
    eqrsClient,
  } = args;

  const startedAt = Date.now();
  const brandIdsLabel = brandIds.join(",");

  let unscored = await selectUnscoredBatch(orgId, brandIds);
  console.log(
    `[journalists-quotes-service] /next stage=unscored-batch orgId=${orgId} brandIds=${brandIdsLabel} campaignId=${campaignId ?? "null"} unscoredCount=${unscored.length}`
  );

  if (unscored.length === 0) {
    // Silver pool exhausted for this brand-set tuple. Pull from EQRS
    // since last cursor — idempotent on (provider, ingestion_channel,
    // external_id) so repeated calls when EQRS has nothing new are
    // cheap no-ops.
    const ingestStart = Date.now();
    await ingestFeaturedToSilver({
      orgId,
      userId,
      runId,
      eqrsClient,
    });
    unscored = await selectUnscoredBatch(orgId, brandIds);
    console.log(
      `[journalists-quotes-service] /next stage=eqrs-refetch orgId=${orgId} brandIds=${brandIdsLabel} unscoredAfterIngest=${unscored.length} ingestMs=${Date.now() - ingestStart}`
    );
  }

  if (unscored.length > 0) {
    const scoreStart = Date.now();
    await scoreUnscored({
      candidates: unscored,
      orgId,
      brandIds,
      campaignId,
      userId,
      runId,
    });
    console.log(
      `[journalists-quotes-service] /next stage=scored orgId=${orgId} brandIds=${brandIdsLabel} scoredCount=${unscored.length} scoreMs=${Date.now() - scoreStart}`
    );
  }

  const best = await selectBestNonPitched({
    orgId,
    brandIds,
    campaignId,
    scoreThreshold,
  });
  console.log(
    `[journalists-quotes-service] /next stage=result orgId=${orgId} brandIds=${brandIdsLabel} campaignId=${campaignId ?? "null"} found=${best != null} score=${best?.score ?? "null"} totalMs=${Date.now() - startedAt}`
  );

  return best;
}
