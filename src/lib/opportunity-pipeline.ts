import { and, eq, inArray, or, sql as drizzleSql } from "drizzle-orm";
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
 * (provider, ingestion_channel, external_id).
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
  if (insertableOpps.length === 0) return;

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

/**
 * Return every Gold cluster (quote_opportunities) reachable from the
 * org's silver pool (own org_id OR SHARED_EMAIL_ORG_ID), collapsed to
 * one row per Gold id via pickRepresentativeSilver. Each Gold row is
 * annotated with the latest pitchStatus seen for the brandSet — exact
 * canonical-sorted match. When campaignId is provided, status scope
 * narrows to that campaign.
 */
export async function fetchEligibleOpportunities(args: {
  orgId: string;
  brandIds: string[];
  campaignId?: string;
}): Promise<EligibleOpportunity[]> {
  const { orgId, brandIds, campaignId } = args;

  const silverRows = await db
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
      or(
        eq(providerQuoteRequests.orgId, orgId),
        eq(providerQuoteRequests.orgId, SHARED_EMAIL_ORG_ID)
      )
    );

  const grouped = new Map<string, SilverRow[]>();
  for (const r of silverRows) {
    if (!r.quoteOpportunityId) continue;
    const list = grouped.get(r.quoteOpportunityId) ?? [];
    list.push(r);
    grouped.set(r.quoteOpportunityId, list);
  }

  if (grouped.size === 0) return [];

  const opportunityIds = Array.from(grouped.keys());

  const goldRows = await db
    .select({
      id: quoteOpportunities.id,
      canonicalText: quoteOpportunities.canonicalText,
      canonicalOutlet: quoteOpportunities.canonicalOutlet,
      canonicalDeadline: quoteOpportunities.canonicalDeadline,
    })
    .from(quoteOpportunities)
    .where(inArray(quoteOpportunities.id, opportunityIds));

  const goldById = new Map(goldRows.map((g) => [g.id, g]));

  // Pitch lookup: exact-match on brand_ids canonical-sorted.
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

  const latestByGold = new Map<
    string,
    { status: PitchStatusValue; updatedAt: Date }
  >();
  for (const p of pitches) {
    if (!p.quoteOpportunityId) continue;
    const prev = latestByGold.get(p.quoteOpportunityId);
    if (!prev || prev.updatedAt < p.updatedAt) {
      latestByGold.set(p.quoteOpportunityId, {
        status: p.status,
        updatedAt: p.updatedAt,
      });
    }
  }

  const out: EligibleOpportunity[] = [];
  for (const [goldId, silvers] of grouped) {
    const gold = goldById.get(goldId);
    if (!gold) continue;
    const rep = pickRepresentativeSilver(silvers);
    out.push({
      opportunityId: goldId,
      representativeSilverId: rep.id,
      provider: rep.provider,
      ingestionChannel: rep.ingestionChannel,
      featuredQuestionId: rep.featuredQuestionId,
      mediaOutlet: rep.mediaOutlet ?? gold.canonicalOutlet,
      journalistName: rep.journalistName,
      opportunityText: rep.opportunityText ?? gold.canonicalText,
      deadline: rep.deadline ?? gold.canonicalDeadline,
      pitchUrl: rep.pitchUrl,
      pitchEmail: rep.pitchEmail,
      category: rep.category,
      pitchStatus: latestByGold.get(goldId)?.status ?? null,
    });
  }

  return out;
}

const RAG_SCORE_BATCH_SIZE = 100;

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

/**
 * Rank Gold-level candidates against the brandSet. Score is per
 * (opportunity, brandSet) — one row per opportunity. Persisted into
 * quote_priorities keyed by (quote_opportunity_id, brand_ids[]).
 */
export async function rankOpportunities(args: {
  candidates: EligibleOpportunity[];
  orgId: string;
  brandIds: string[];
  campaignId?: string;
  userId?: string;
  runId?: string;
  scoreThreshold: number;
}): Promise<RankedOpportunity[]> {
  const {
    candidates,
    orgId,
    brandIds,
    campaignId,
    userId,
    runId,
    scoreThreshold,
  } = args;

  if (candidates.length === 0) return [];

  const batches = chunk(candidates, RAG_SCORE_BATCH_SIZE);
  const batchResponses = await Promise.all(
    batches.map((batch) =>
      ragScore(
        {
          documents: batch.map((c) => ({
            id: c.opportunityId,
            text: c.opportunityText,
          })),
          brandIds,
        },
        orgId,
        userId,
        runId
      )
    )
  );
  const mergedResults = batchResponses.flatMap((r) => r.results);

  if (mergedResults.length > 0) {
    await db
      .insert(quotePriorities)
      .values(
        mergedResults.map((r) => ({
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

  const resultById = new Map(mergedResults.map((r) => [r.id, r]));

  return candidates
    .map((c) => {
      const result = resultById.get(c.opportunityId);
      return {
        ...c,
        score: result?.score ?? 0,
        whyRelevant: result?.whyRelevant ?? null,
      };
    })
    .filter((c) => c.score >= scoreThreshold)
    .sort((a, b) => b.score - a.score);
}
