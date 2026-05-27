import { and, eq, or, sql as drizzleSql } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  providerQuoteRequests,
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

export interface EligibleCandidate {
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
}

export interface RankedCandidate extends EligibleCandidate {
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
  if (typeof o.featuredQuestionId === "number") return String(o.featuredQuestionId);
  if (o.pitchUrl) return o.pitchUrl;
  return computeFingerprint(o.opportunity ?? "", o.mediaOutlet);
}

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

  await db
    .insert(providerQuoteRequests)
    .values(
      insertableOpps.map((o) => ({
        provider: "featured",
        ingestionChannel: "api" as const,
        externalId: featuredExternalId(o),
        featuredQuestionId:
          typeof o.featuredQuestionId === "number"
            ? o.featuredQuestionId
            : null,
        mediaOutlet: o.mediaOutlet ?? null,
        opportunityText: o.opportunity,
        pitchUrl: o.pitchUrl ?? null,
        deadline: safeParseDate(o.deadline),
        raw: o,
        orgId,
      }))
    )
    .onConflictDoNothing({
      target: [
        providerQuoteRequests.provider,
        providerQuoteRequests.ingestionChannel,
        providerQuoteRequests.externalId,
      ],
    });
}

export async function fetchEligibleCandidates(args: {
  orgId: string;
  campaignId: string;
}): Promise<EligibleCandidate[]> {
  const { orgId, campaignId } = args;

  const candidates = await db
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
      existingPitchStatus: quotePitches.status,
    })
    .from(providerQuoteRequests)
    .leftJoin(
      quotePitches,
      and(
        eq(quotePitches.quoteRequestId, providerQuoteRequests.id),
        eq(quotePitches.campaignId, campaignId)
      )
    )
    .where(
      or(
        eq(providerQuoteRequests.orgId, orgId),
        eq(providerQuoteRequests.orgId, SHARED_EMAIL_ORG_ID)
      )
    );

  return candidates
    .filter(
      (c) =>
        c.existingPitchStatus === null || c.existingPitchStatus === "error"
    )
    .map(({ existingPitchStatus: _unused, ...rest }) => rest);
}

export async function rankCandidates(args: {
  candidates: EligibleCandidate[];
  orgId: string;
  brandId: string;
  campaignId: string;
  userId?: string;
  runId?: string;
  scoreThreshold: number;
}): Promise<RankedCandidate[]> {
  const {
    candidates,
    orgId,
    brandId,
    campaignId,
    userId,
    runId,
    scoreThreshold,
  } = args;

  if (candidates.length === 0) return [];

  const scoreResp = await ragScore(
    {
      documents: candidates.map((c) => ({ id: c.id, text: c.opportunityText })),
      brandId,
    },
    orgId,
    userId,
    runId
  );

  if (scoreResp.results.length > 0) {
    await db
      .insert(quotePriorities)
      .values(
        scoreResp.results.map((r) => ({
          quoteRequestId: r.id,
          campaignId,
          brandId,
          score: r.score.toFixed(2),
          whyRelevant: r.whyRelevant ?? null,
          scoredByRunId: runId ?? null,
          orgId,
        }))
      )
      .onConflictDoUpdate({
        target: [quotePriorities.quoteRequestId, quotePriorities.campaignId],
        set: {
          score: drizzleSql`excluded.score`,
          whyRelevant: drizzleSql`excluded.why_relevant`,
          scoredAt: drizzleSql`now()`,
          scoredByRunId: drizzleSql`excluded.scored_by_run_id`,
          brandId: drizzleSql`excluded.brand_id`,
        },
      });
  }

  return candidates
    .map((c) => {
      const result = scoreResp.results.find((r) => r.id === c.id);
      return {
        ...c,
        score: result?.score ?? 0,
        whyRelevant: result?.whyRelevant ?? null,
      };
    })
    .filter((c) => c.score >= scoreThreshold)
    .sort((a, b) => b.score - a.score);
}
