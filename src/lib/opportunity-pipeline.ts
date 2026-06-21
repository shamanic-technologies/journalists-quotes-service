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
  type EqrsPremiumQuestion,
} from "./eqrs-client.js";
import { judgeRelevance } from "./judge-client.js";
import { extractBrandContext } from "./brand-client.js";
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
 * How a Gold cluster can be acted on from the HITL dashboard:
 *   - `featured_api`: Featured PREMIUM question — submit via EQRS
 *     POST /orgs/featured/answers (carries featured_question_id).
 *   - `email_reply`: email-sourced opp (HARO etc.) — submit via
 *     email-gateway /orgs/send (carries pitch_email).
 *   - `external_manual`: Featured DISCOVERY lead (web-aggregated, no
 *     question id, no email) — NOT programmatically submittable. The
 *     operator must pitch at the source URL. Send must not be offered.
 */
export type DeliveryMethod = "featured_api" | "email_reply" | "external_manual";

/**
 * Resolve whether a representative silver row can be submitted
 * programmatically and by which method. Single source of truth for the
 * `submittable` signal exposed on /next + /ranked and for the routing
 * decision in /reply. No raw 400 ever — non-submittable opps get an
 * explicit `external_manual` contract.
 */
export function computeDelivery(rep: {
  provider: string;
  featuredQuestionId: number | null;
  pitchEmail: string | null;
}): { submittable: boolean; deliveryMethod: DeliveryMethod } {
  if (rep.provider === "featured" && rep.featuredQuestionId != null) {
    return { submittable: true, deliveryMethod: "featured_api" };
  }
  if (rep.pitchEmail != null) {
    return { submittable: true, deliveryMethod: "email_reply" };
  }
  return { submittable: false, deliveryMethod: "external_manual" };
}

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
  // Whether Send can be dispatched programmatically + by which method.
  // Discovery leads are non-submittable (external_manual).
  submittable: boolean;
  deliveryMethod: DeliveryMethod;
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
      // ON CONFLICT DO UPDATE (not DO NOTHING) so legacy silver rows
      // ingested under the prior pipeline (direct Featured fetch with
      // a different `fingerprint(text, outlet)` hash) get RE-POINTED
      // to the freshly-created Gold cluster on EQRS-driven ingest.
      //
      // Legacy state: silver rows exist with the same external_id
      // (= pitchUrl) but their `quote_opportunity_id` references an
      // OLD Gold cluster whose fingerprint hashed differently. The
      // EQRS ingest creates new Gold clusters by today's fingerprint
      // and would orphan them if silver stayed pinned to the old
      // cluster — dashboards JOIN silver⋈gold so the new clusters
      // become invisible.
      //
      // Repoint fields (quote_opportunity_id + fingerprint + outlet +
      // deadline + pitchUrl + opportunityText) to the canonical
      // post-EQRS values. PRESERVE org_id, external_id, provider,
      // ingestion_channel, raw, featured_question_id, is_canonical,
      // created_at, fetched_at on conflict — those are
      // identity/provenance fields and must not be mutated by a
      // re-ingest.
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
        .onConflictDoUpdate({
          target: [
            providerQuoteRequests.provider,
            providerQuoteRequests.ingestionChannel,
            providerQuoteRequests.externalId,
          ],
          set: {
            quoteOpportunityId: drizzleSql`excluded.quote_opportunity_id`,
            fingerprint: drizzleSql`excluded.fingerprint`,
            opportunityText: drizzleSql`excluded.opportunity_text`,
            mediaOutlet: drizzleSql`excluded.media_outlet`,
            deadline: drizzleSql`excluded.deadline`,
            pitchUrl: drizzleSql`excluded.pitch_url`,
            updatedAt: drizzleSql`now()`,
          },
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

/**
 * Pull Featured PREMIUM questions from EQRS and project them into JQS
 * silver + Gold cluster. Premium questions are the ONLY Featured feed
 * that is programmatically submittable (they carry a
 * `featured_question_id`); the discovery `/opportunities` feed is null
 * on that field and is intentionally NOT ingested here (MVP = premium
 * only — what we can answer via Featured's API).
 *
 * Differences from the discovery ingest (`ingestFeaturedToSilver`):
 *   - EQRS premium-questions is a pass-through with NO cursor/since.
 *     We pull the full current list each exhaustion tick; the upsert is
 *     idempotent so repeats are cheap no-ops. `eqrs_sync_state` is not
 *     touched.
 *   - Premium questions carry no `externalId`, so we synthesize a
 *     stable one from the question id: `featured-premium-<fqid>`.
 *
 * Idempotent: silver upsert keys on
 * (provider, ingestion_channel, external_id) and re-points to the
 * canonical Gold cluster on conflict (fingerprint drift if a question's
 * text is later edited upstream).
 */
export async function ingestPremiumQuestionsToSilver(args: {
  orgId: string;
  userId?: string;
  runId?: string;
  audienceId?: string;
  eqrsClient: EqrsClient;
}): Promise<void> {
  const { orgId, userId, runId, audienceId, eqrsClient } = args;

  let response;
  try {
    response = await eqrsClient.fetchPremiumQuestions({
      orgId,
      userId,
      runId,
      audienceId,
    });
  } catch (err) {
    throw new EqrsServiceError((err as Error).message);
  }

  const questions = response.questions;

  let newSilverCount = 0;
  if (questions.length > 0) {
    const allPrepared = questions.map((q: EqrsPremiumQuestion) => {
      const text = q.question;
      const outlet = q.mediaOutlet ?? null;
      const fingerprint = computeFingerprint(text, outlet);
      return {
        q,
        text,
        outlet,
        fingerprint,
        externalId: `featured-premium-${q.featuredQuestionId}`,
        deadline: safeParseDate(q.deadline),
      };
    });

    // Dedupe by fingerprint before the Gold upsert (Postgres errcode
    // 21000 — ON CONFLICT cannot affect the same row twice in one
    // command). Same collapse semantics as the discovery path.
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

    // 3. Bulk upsert silver rows, deduped by synthesized external_id.
    const silverRowsByExternalId = new Map<
      string,
      typeof allPrepared[number]
    >();
    for (const r of allPrepared) {
      if (!clusterIdByFingerprint.has(r.fingerprint)) continue;
      if (!silverRowsByExternalId.has(r.externalId)) {
        silverRowsByExternalId.set(r.externalId, r);
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
            externalId: r.externalId,
            featuredQuestionId: r.q.featuredQuestionId,
            mediaOutlet: r.outlet,
            opportunityText: r.text,
            pitchUrl: r.q.pitchUrl ?? null,
            deadline: r.deadline,
            raw: null,
            quoteOpportunityId: clusterIdByFingerprint.get(r.fingerprint)!,
            isCanonical: false,
            fingerprint: r.fingerprint,
            orgId,
          }))
        )
        .onConflictDoUpdate({
          target: [
            providerQuoteRequests.provider,
            providerQuoteRequests.ingestionChannel,
            providerQuoteRequests.externalId,
          ],
          set: {
            quoteOpportunityId: drizzleSql`excluded.quote_opportunity_id`,
            fingerprint: drizzleSql`excluded.fingerprint`,
            opportunityText: drizzleSql`excluded.opportunity_text`,
            mediaOutlet: drizzleSql`excluded.media_outlet`,
            deadline: drizzleSql`excluded.deadline`,
            pitchUrl: drizzleSql`excluded.pitch_url`,
            featuredQuestionId: drizzleSql`excluded.featured_question_id`,
            updatedAt: drizzleSql`now()`,
          },
        })
        .returning({ id: providerQuoteRequests.id });
      newSilverCount = silverInserted.length;
    }
  }

  console.log(
    `[journalists-quotes-service] /next stage=premium-fetch orgId=${orgId} returned=${questions.length} newSilverCount=${newSilverCount}`
  );
}

/**
 * EXISTS predicate: the Gold cluster (`quoteOpportunities.id` in scope)
 * has at least one SUBMITTABLE silver row in the org's pool (own or
 * SHARED_EMAIL_ORG_ID). Submittable = Featured premium (provider
 * 'featured' AND featured_question_id present) OR email-sourced
 * (pitch_email present). Discovery leads (featured, null fqid, no
 * email) fail this and are excluded from scoring + serving.
 */
function submittableSilverExists(orgId: string) {
  return drizzleSql`EXISTS (SELECT 1 FROM ${providerQuoteRequests} WHERE ${providerQuoteRequests.quoteOpportunityId} = ${quoteOpportunities.id} AND (${providerQuoteRequests.orgId} = ${orgId}::uuid OR ${providerQuoteRequests.orgId} = ${SHARED_EMAIL_ORG_ID}::uuid) AND ((${providerQuoteRequests.provider} = 'featured' AND ${providerQuoteRequests.featuredQuestionId} IS NOT NULL) OR ${providerQuoteRequests.pitchEmail} IS NOT NULL))`;
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
 * Returned rows are the minimum needed for the judge: opportunityId +
 * text. The /reply path uses pickRepresentativeSilver elsewhere — this
 * helper is a scoring-batch picker, not a UI-row builder.
 *
 * `orderBy` controls which clusters win a partial scoring sweep:
 *   - "firstSeen" (default, used by /next): oldest cluster first —
 *     deterministic FIFO.
 *   - "deadline" (used by /discover): soonest canonical_deadline first
 *     (NULLS LAST), first_seen_at as the tiebreak. When a budget-bounded
 *     /discover loop is cut short, the most urgent (soon-expiring)
 *     clusters are the ones that got scored.
 */
async function selectUnscoredBatch(
  orgId: string,
  brandIds: string[],
  orderBy: "firstSeen" | "deadline" = "firstSeen"
): Promise<{ opportunityId: string; opportunityText: string }[]> {
  const ordering =
    orderBy === "deadline"
      ? [
          drizzleSql`${quoteOpportunities.canonicalDeadline} ASC NULLS LAST`,
          drizzleSql`${quoteOpportunities.firstSeenAt} ASC`,
        ]
      : [drizzleSql`${quoteOpportunities.firstSeenAt} ASC`];

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
        submittableSilverExists(orgId)
      )
    )
    .orderBy(...ordering)
    .limit(UNSCORED_BATCH_SIZE);

  return rows;
}

/**
 * Score a batch of unscored opportunities against the brand-set tuple
 * via an LLM relevance judge (chat-service `POST /complete`, google/flash).
 * Score is 0-100 collective relevance for the brand-set. Persists to
 * Gold (`quote_priorities`) keyed by (quote_opportunity_id, brand_ids[]).
 * Idempotent: upsert via onConflictDoUpdate.
 *
 * Brand context comes from brand-service AI extraction (cached 30d
 * brand-side), rendered into the judge system prompt.
 */
async function scoreUnscored(args: {
  candidates: { opportunityId: string; opportunityText: string }[];
  orgId: string;
  brandIds: string[];
  campaignId?: string;
  userId?: string;
  runId?: string;
  audienceId?: string;
}): Promise<void> {
  const { candidates, orgId, brandIds, campaignId, userId, runId, audienceId } =
    args;
  if (candidates.length === 0) return;

  // brand-service /orgs/brands/extract-fields is an org-route: it hard-requires
  // x-user-id AND x-run-id. /next + /discover guarantee both (userId via
  // requireOpportunityIdentity, runId via withRunTracking); guard fail-loud so
  // any other caller can't silently produce a 400 one hop later.
  if (!userId) {
    throw new Error(
      "scoreUnscored: userId is required (brand-service extract-fields needs x-user-id)"
    );
  }
  if (!runId) {
    throw new Error(
      "scoreUnscored: runId is required (brand-service extract-fields needs x-run-id)"
    );
  }

  const brandContext = await extractBrandContext(
    brandIds,
    orgId,
    userId,
    runId,
    audienceId
  );

  const response = await judgeRelevance({
    documents: candidates.map((c) => ({
      id: c.opportunityId,
      text: c.opportunityText,
    })),
    brandContext,
    orgId,
    userId,
    runId,
    audienceId,
  });

  if (response.results.length === 0) return;

  await db
    .insert(quotePriorities)
    .values(
      response.results.map((r) => ({
        quoteOpportunityId: r.id,
        brandIds,
        campaignId: campaignId ?? null,
        // Judge returns 0-100; clamp defensively + store with 2dp to
        // fit numeric(5,2).
        score: Math.max(0, Math.min(100, r.score)).toFixed(2),
        whyRelevant: r.reasoning ?? null,
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
 * Return the single best Gold cluster for (orgId, brandIds):
 *   - score >= scoreThreshold
 *   - canonical_deadline > now() OR NULL
 *   - no blocking quote_pitches row for the brand-set under ANY campaign
 *     (atomic per-brand exclusion — never campaign-scoped)
 *   - at least one silver row in the org's pool (own or SHARED_EMAIL_ORG_ID)
 *
 * Tie-break on score: oldest Gold cluster wins (first_seen_at ASC). Returns
 * null when nothing eligible remains.
 */
async function selectBestNonPitched(args: {
  orgId: string;
  brandIds: string[];
  scoreThreshold: number;
}): Promise<RankedOpportunity | null> {
  const { orgId, brandIds, scoreThreshold } = args;

  // Anti-join sub-select: which Gold cluster ids are blocked by a pitch?
  // Atomic per-brand exclusion: a brand cannot answer the same Featured
  // question twice, so once an opportunity is pitched (blocking status) for
  // the brand-set it is excluded from every future /next for that brand-set,
  // regardless of campaign. Block scope is brand-only — never campaign — to
  // stay in lockstep with /reply's brand-scoped idempotency. A campaign-scoped
  // block deadlocks: /next would re-serve an opp /reply then refuses as
  // already_submitted.
  const pitchScope = and(
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
        submittableSilverExists(orgId),
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
    ...computeDelivery(rep),
    score: Number(best.score),
    whyRelevant: best.whyRelevant,
  };
}

/**
 * Pure-read paginated ranked list for the brand-set.
 *
 *   - Reads from `quote_priorities` (Gold scored projection) joined to
 *     `quote_opportunities` (silver canonical). Annotates each row with
 *     the latest `pitchStatus` seen for the brand-set (brand-atomic — any
 *     campaign's pitch counts).
 *   - NO scoring, NO Featured ingest. Opportunities not yet scored for
 *     this brand-set tuple are simply absent from the response — the
 *     `/next` write-path is what fills them.
 *   - NO relevance gate. Every scored premium opportunity is returned
 *     with its `score`; the dashboard filters by relevance client-side.
 *   - Filters expired `canonical_deadline` + restricts to submittable
 *     (premium) clusters. Includes pitched opportunities (caller decides
 *     what to do with `pitchStatus`).
 *
 * Returns `{ rows, total }` where total is the unpaginated count.
 */
export async function selectRankedPage(args: {
  orgId: string;
  brandIds: string[];
  campaignId?: string;
  limit: number;
  offset: number;
}): Promise<{ rows: RankedOpportunity[]; total: number }> {
  const { orgId, brandIds, campaignId, limit, offset } = args;

  const filter = and(
    eq(quotePriorities.brandIds, brandIds),
    or(
      drizzleSql`${quoteOpportunities.canonicalDeadline} IS NULL`,
      drizzleSql`${quoteOpportunities.canonicalDeadline} > now()`
    ),
    submittableSilverExists(orgId)
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

  // pitchStatus annotation is brand-atomic — any campaign's blocking pitch
  // for the brand-set counts. Mirrors the atomic exclusion in /next + stats
  // (a brand cannot pitch the same Featured question twice).
  const pitchScope = and(
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
      ...computeDelivery(rep),
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
 *     tuple (any score).
 *   - eligibleCount: scored, deadline non-expired, submittable (premium),
 *     NOT in quote_pitches blocking states for the brand-set (atomic per-brand
 *     — any campaign's pitch blocks). NO relevance floor — the dashboard
 *     filters by score client-side.
 *   - pitchedBlocking: count of quote_pitches blocking rows for the
 *     brand-set (atomic per-brand — any campaign).
 *   - expiredCount: scored opportunities with canonical_deadline < now().
 *   - bestEligibleScore: highest score among eligible rows, or null.
 */
export async function selectOpportunitiesStats(args: {
  orgId: string;
  brandIds: string[];
}): Promise<{
  silverPoolSize: number;
  scoredCount: number;
  eligibleCount: number;
  pitchedBlocking: number;
  expiredCount: number;
  bestEligibleScore: number | null;
}> {
  const { orgId, brandIds } = args;

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

  // Brand-atomic block scope (any campaign) — consistent with /next.
  const pitchScope = and(
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
    or(
      drizzleSql`${quoteOpportunities.canonicalDeadline} IS NULL`,
      drizzleSql`${quoteOpportunities.canonicalDeadline} > now()`
    ),
    submittableSilverExists(orgId),
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
  audienceId?: string;
  scoreThreshold: number;
  eqrsClient: EqrsClient;
}): Promise<RankedOpportunity | null> {
  const {
    orgId,
    brandIds,
    campaignId,
    userId,
    runId,
    audienceId,
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
    // MVP = Featured PREMIUM questions only (the API-answerable feed).
    // The discovery `/opportunities` ingest (ingestFeaturedToSilver)
    // is dormant — its rows are not submittable and are filtered out of
    // scoring + serving by submittableSilverExists.
    await ingestPremiumQuestionsToSilver({
      orgId,
      userId,
      runId,
      audienceId,
      eqrsClient,
    });
    unscored = await selectUnscoredBatch(orgId, brandIds);
    console.log(
      `[journalists-quotes-service] /next stage=premium-refetch orgId=${orgId} brandIds=${brandIdsLabel} unscoredAfterIngest=${unscored.length} ingestMs=${Date.now() - ingestStart}`
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
      audienceId,
    });
    console.log(
      `[journalists-quotes-service] /next stage=scored orgId=${orgId} brandIds=${brandIdsLabel} scoredCount=${unscored.length} scoreMs=${Date.now() - scoreStart}`
    );
  }

  const best = await selectBestNonPitched({
    orgId,
    brandIds,
    scoreThreshold,
  });
  console.log(
    `[journalists-quotes-service] /next stage=result orgId=${orgId} brandIds=${brandIdsLabel} campaignId=${campaignId ?? "null"} found=${best != null} score=${best?.score ?? "null"} totalMs=${Date.now() - startedAt}`
  );

  return best;
}

/**
 * One /discover pipeline call. Write-only catalog filler — the
 * exhaustive sibling of pickNextOpportunity:
 *
 *   1. Pick at most UNSCORED_BATCH_SIZE unscored submittable clusters
 *      for the brand-set tuple, ordered by deadline urgency
 *      (soonest-first). No score is known pre-judge, so urgency is the
 *      cheap priority proxy — if a budget-bounded loop is cut short, the
 *      soon-expiring opportunities are the ones that got scored.
 *   2. If the silver pool is exhausted, pull Featured PREMIUM questions
 *      from EQRS into silver + Gold and re-pick.
 *   3. Score whatever was found (one multi-brand judge call) and persist
 *      to quote_priorities.
 *
 * Returns `{ scored, exhausted }` and nothing else — the caller reads the
 * catalog via GET /orgs/opportunities. `exhausted` is true ONLY when, after
 * an EQRS-premium ingest attempt, there is nothing left to score (scored=0).
 * The credit gate lives in the caller's workflow, NOT here: each call costs
 * exactly one judge call (≤ UNSCORED_BATCH_SIZE docs), so a `while (!exhausted)`
 * loop overshoots a budget by at most one batch. Callers loop until
 * `exhausted` to drain the whole submittable pool for the brand-set.
 */
export async function scoreNextBatch(args: {
  orgId: string;
  brandIds: string[];
  campaignId: string;
  userId?: string;
  runId?: string;
  audienceId?: string;
  eqrsClient: EqrsClient;
}): Promise<{ scored: number; exhausted: boolean }> {
  const { orgId, brandIds, campaignId, userId, runId, audienceId, eqrsClient } =
    args;

  const startedAt = Date.now();
  const brandIdsLabel = brandIds.join(",");

  // Priority = deadline urgency (soonest first) so a budget-truncated
  // /discover loop scores the most time-sensitive opportunities first.
  let unscored = await selectUnscoredBatch(orgId, brandIds, "deadline");

  if (unscored.length === 0) {
    // Silver pool exhausted for this brand-set tuple. Pull Featured
    // PREMIUM questions from EQRS (idempotent upsert; no cursor) and
    // re-pick. EqrsServiceError propagates to the route → 502.
    await ingestPremiumQuestionsToSilver({
      orgId,
      userId,
      runId,
      audienceId,
      eqrsClient,
    });
    unscored = await selectUnscoredBatch(orgId, brandIds, "deadline");
  }

  if (unscored.length === 0) {
    console.log(
      `[journalists-quotes-service] /discover stage=exhausted orgId=${orgId} brandIds=${brandIdsLabel} campaignId=${campaignId} totalMs=${Date.now() - startedAt}`
    );
    return { scored: 0, exhausted: true };
  }

  await scoreUnscored({
    candidates: unscored,
    orgId,
    brandIds,
    campaignId,
    userId,
    runId,
    audienceId,
  });

  console.log(
    `[journalists-quotes-service] /discover stage=scored orgId=${orgId} brandIds=${brandIdsLabel} campaignId=${campaignId} scoredCount=${unscored.length} totalMs=${Date.now() - startedAt}`
  );

  return { scored: unscored.length, exhausted: false };
}
