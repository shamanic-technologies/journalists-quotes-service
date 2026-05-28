import { and, eq, inArray, isNull, or, sql as drizzleSql } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  providerQuoteRequests,
  quoteOpportunities,
  quotePitches,
  quotePriorities,
} from "../db/schema.js";
import {
  FeaturedClient,
  type FeaturedCredentials,
  type FeaturedClientOptions,
  type FeaturedOpportunity,
} from "./featured-client.js";
import { getFeaturedCredentials } from "./key-service-client.js";
import { ragScore } from "./chat-client.js";
import { SHARED_EMAIL_ORG_ID } from "./inbound/process.js";
import { computeFingerprint } from "./cluster/fingerprint.js";
import { attachOrCreateCluster } from "./cluster/attach.js";

export class KeyServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeyServiceError";
  }
}

export class FeaturedListError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeaturedListError";
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

export type BuildFeaturedClient = (
  credentials: FeaturedCredentials,
  overrides?: Partial<FeaturedClientOptions>
) => FeaturedClient;

function safeParseDate(value: string | undefined | null): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function featuredExternalId(o: FeaturedOpportunity): string {
  if (typeof o.featuredQuestionId === "number")
    return String(o.featuredQuestionId);
  if (o.pitchUrl) return o.pitchUrl;
  return computeFingerprint(o.opportunity ?? "", o.mediaOutlet);
}

/**
 * Fetch live Featured opportunities and write through to silver +
 * cluster into Gold via fingerprint. Idempotent on
 * (provider, ingestion_channel, external_id) — concurrent / repeated
 * calls deduplicate via the natural-key unique constraint.
 *
 * No time-based throttle here. Featured is only re-fetched by callers
 * when their downstream silver pool is exhausted (see
 * `pickNextOpportunity` for the exhaustion-driven trigger).
 */
export async function ingestFeaturedToSilver(args: {
  orgId: string;
  userId?: string;
  runId?: string;
  callerPath: string;
  buildClient: BuildFeaturedClient;
}): Promise<void> {
  const { orgId, userId, runId, callerPath, buildClient } = args;

  let credentials: FeaturedCredentials;
  try {
    const result = await getFeaturedCredentials({
      callerMethod: "POST",
      callerPath,
      orgId,
      userId,
      runId,
    });
    credentials = { username: result.username, password: result.password };
  } catch (err) {
    if ((err as Error).name === "KeyServiceUnavailableError") {
      throw new KeyServiceError((err as Error).message);
    }
    throw err;
  }

  const client = buildClient(credentials);
  let featuredOpps: FeaturedOpportunity[];
  try {
    featuredOpps = await client.listOpportunities();
  } catch (err) {
    throw new FeaturedListError(
      `Featured listOpportunities failed: ${(err as Error).message}`
    );
  }

  const insertableOpps = featuredOpps.filter(
    (o) => typeof o.opportunity === "string" && o.opportunity.length > 0
  );

  for (const o of insertableOpps) {
    const text = o.opportunity!;
    const outlet = o.mediaOutlet ?? null;
    const fingerprint = computeFingerprint(text, outlet);
    const cluster = await attachOrCreateCluster({
      fingerprint,
      canonicalText: text,
      canonicalOutlet: outlet,
      canonicalDeadline: safeParseDate(o.deadline),
    });

    await db
      .insert(providerQuoteRequests)
      .values({
        provider: "featured",
        ingestionChannel: "api" as const,
        externalId: featuredExternalId(o),
        featuredQuestionId:
          typeof o.featuredQuestionId === "number"
            ? o.featuredQuestionId
            : null,
        mediaOutlet: outlet,
        opportunityText: text,
        pitchUrl: o.pitchUrl ?? null,
        deadline: safeParseDate(o.deadline),
        raw: o,
        quoteOpportunityId: cluster.id,
        isCanonical: cluster.created,
        fingerprint,
        orgId,
      })
      .onConflictDoNothing({
        target: [
          providerQuoteRequests.provider,
          providerQuoteRequests.ingestionChannel,
          providerQuoteRequests.externalId,
        ],
      });
  }
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
 * One /next pipeline call. Exhaustion-driven:
 *
 *   1. Try `selectUnscoredBatch` against the existing silver pool.
 *   2. If empty, ingest Featured (refetch on demand only) and re-query.
 *   3. Score whatever was found (≤ UNSCORED_BATCH_SIZE in one
 *      multi-brand chat-service call).
 *   4. Return the single best non-pitched candidate.
 *
 * No time-based TTL on Featured fetch. The Featured `/opportunities-list`
 * call only fires when there is genuinely nothing left to score for the
 * brand-set tuple — natural backpressure: callers fully consume what's
 * in silver before triggering another upstream fetch. Ingest is
 * idempotent (onConflictDoNothing on `external_id`), so a repeat call
 * when Featured has published nothing new is a cheap upsert no-op.
 */
export async function pickNextOpportunity(args: {
  orgId: string;
  brandIds: string[];
  campaignId?: string;
  userId?: string;
  runId?: string;
  scoreThreshold: number;
  callerPath: string;
  buildClient: BuildFeaturedClient;
}): Promise<RankedOpportunity | null> {
  const {
    orgId,
    brandIds,
    campaignId,
    userId,
    runId,
    scoreThreshold,
    callerPath,
    buildClient,
  } = args;

  const startedAt = Date.now();
  const brandIdsLabel = brandIds.join(",");

  let unscored = await selectUnscoredBatch(orgId, brandIds);
  console.log(
    `[journalists-quotes-service] /next stage=unscored-batch orgId=${orgId} brandIds=${brandIdsLabel} campaignId=${campaignId ?? "null"} unscoredCount=${unscored.length}`
  );

  if (unscored.length === 0) {
    // Silver pool exhausted for this brand-set tuple. Refetch Featured;
    // ingest is idempotent so this no-ops when nothing new has been
    // published since the last fetch.
    const ingestStart = Date.now();
    await ingestFeaturedToSilver({
      orgId,
      userId,
      runId,
      callerPath,
      buildClient,
    });
    unscored = await selectUnscoredBatch(orgId, brandIds);
    console.log(
      `[journalists-quotes-service] /next stage=featured-refetch orgId=${orgId} brandIds=${brandIdsLabel} unscoredAfterIngest=${unscored.length} ingestMs=${Date.now() - ingestStart}`
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
