import { Router } from "express";
import { and, eq, inArray, or } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/index.js";
import {
  providerQuoteRequests,
  quoteOpportunities,
  quotePitches,
} from "../db/schema.js";
import {
  FeaturedClient,
  FeaturedRateLimitError,
  type FeaturedCredentials,
  type FeaturedClientOptions,
} from "../lib/featured-client.js";
import { getFeaturedCredentials } from "../lib/key-service-client.js";
import {
  authorizeCredit,
  BillingServiceError,
} from "../lib/billing-client.js";
import { addCosts } from "../lib/runs-client.js";
import {
  ensureFeaturedProfile,
  type FetchLogoBytes,
} from "../lib/featured-profile-bootstrap.js";
import {
  sendTransactionalEmail,
  EmailGatewayError,
} from "../lib/email-gateway-client.js";
import { SHARED_EMAIL_ORG_ID } from "../lib/inbound/process.js";
import { pickRepresentativeSilver } from "../lib/opportunity-pipeline.js";
import {
  BrandIdsHeaderError,
  parseBrandIdsHeader,
} from "../lib/brand-ids.js";

const FEATURED_PITCH_SUBMIT_COST = "featured-api-pitch-submit";

const PARAMS_SCHEMA = z.object({ id: z.string().uuid() });

const BODY_SCHEMA = z.object({
  pitchContent: z.string().min(1),
  campaignId: z.string().uuid().optional(),
  subject: z.string().optional(),
});

const BLOCK_STATUSES: Array<
  | "drafted"
  | "submitted"
  | "selected"
  | "published"
  | "not_selected"
> = ["drafted", "submitted", "selected", "published", "not_selected"];

export interface OpportunityReplyDeps {
  buildClient?: (
    credentials: FeaturedCredentials,
    overrides?: Partial<FeaturedClientOptions>
  ) => FeaturedClient;
  fetchLogoBytes?: FetchLogoBytes;
}

function defaultBuildClient(
  credentials: FeaturedCredentials,
  overrides?: Partial<FeaturedClientOptions>
): FeaturedClient {
  return new FeaturedClient({ credentials, ...overrides });
}

function splitName(name: string | null): { first: string; last: string } {
  if (!name) return { first: "(unknown)", last: "(unknown)" };
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: "(unknown)", last: "(unknown)" };
  if (parts.length === 1) return { first: parts[0], last: "(unknown)" };
  return {
    first: parts[0],
    last: parts.slice(1).join(" "),
  };
}

export function createOpportunityReplyRouter(
  deps: OpportunityReplyDeps = {}
): Router {
  const router = Router();
  const buildClient = deps.buildClient ?? defaultBuildClient;
  const fetchLogoBytes = deps.fetchLogoBytes;

  router.post("/orgs/opportunities/:id/reply", async (req, res) => {
    const paramsParsed = PARAMS_SCHEMA.safeParse(req.params);
    if (!paramsParsed.success) {
      res.status(400).json({ error: paramsParsed.error.message });
      return;
    }
    const bodyParsed = BODY_SCHEMA.safeParse(req.body);
    if (!bodyParsed.success) {
      res.status(400).json({ error: bodyParsed.error.message });
      return;
    }
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

    const { id: opportunityId } = paramsParsed.data;
    const { pitchContent, campaignId, subject } = bodyParsed.data;
    const orgId = req.orgId!;
    const userId = req.userId;
    const runId = req.runId;
    const parentRunId = req.parentRunId ?? null;

    const goldRows = await db
      .select()
      .from(quoteOpportunities)
      .where(eq(quoteOpportunities.id, opportunityId))
      .limit(1);
    const gold = goldRows[0];
    if (!gold) {
      res.status(404).json({ error: "Opportunity not found" });
      return;
    }

    const silverRows = await db
      .select()
      .from(providerQuoteRequests)
      .where(
        and(
          eq(providerQuoteRequests.quoteOpportunityId, opportunityId),
          or(
            eq(providerQuoteRequests.orgId, orgId),
            eq(providerQuoteRequests.orgId, SHARED_EMAIL_ORG_ID)
          )
        )
      );

    if (silverRows.length === 0) {
      res.status(404).json({
        error:
          "Opportunity has no silver rows accessible to this org",
      });
      return;
    }

    const representative = pickRepresentativeSilver(silverRows);

    // Idempotency: exact-match on (quote_opportunity_id, brand_ids[]).
    // brandIds is canonical-sorted by parseBrandIdsHeader.
    const existingPitch = (
      await db
        .select()
        .from(quotePitches)
        .where(
          and(
            eq(quotePitches.quoteOpportunityId, opportunityId),
            eq(quotePitches.brandIds, brandIds),
            inArray(quotePitches.status, BLOCK_STATUSES)
          )
        )
        .limit(1)
    )[0];

    if (existingPitch) {
      res.json({
        status: "already_submitted",
        pitchId: existingPitch.id,
        deliveryMethod: existingPitch.deliveryMethod,
        outboundMessageId: existingPitch.outboundMessageId,
        featuredQuestionId: existingPitch.featuredQuestionId,
      });
      return;
    }

    if (representative.provider === "featured") {
      await handleFeaturedReply({
        req,
        res,
        opportunityId,
        representative,
        pitchContent,
        brandIds,
        campaignId,
        orgId,
        userId,
        runId,
        parentRunId,
        buildClient,
        fetchLogoBytes,
      });
      return;
    }

    await handleEmailReply({
      req,
      res,
      opportunityId,
      representative,
      pitchContent,
      subject,
      brandIds,
      campaignId,
      orgId,
      userId,
      runId,
      parentRunId,
    });
  });

  return router;
}

interface SilverRowFull {
  id: string;
  provider: string;
  featuredQuestionId: number | null;
  pitchEmail: string | null;
  pitchUrl: string | null;
  mediaOutlet: string | null;
  journalistName: string | null;
  opportunityText: string;
}

async function handleFeaturedReply(args: {
  req: import("express").Request;
  res: import("express").Response;
  opportunityId: string;
  representative: SilverRowFull;
  pitchContent: string;
  brandIds: string[];
  campaignId?: string;
  orgId: string;
  userId?: string;
  runId?: string;
  parentRunId: string | null;
  buildClient: (
    credentials: FeaturedCredentials,
    overrides?: Partial<FeaturedClientOptions>
  ) => FeaturedClient;
  fetchLogoBytes?: FetchLogoBytes;
}) {
  const {
    req,
    res,
    opportunityId,
    representative,
    pitchContent,
    brandIds,
    campaignId,
    orgId,
    userId,
    runId,
    parentRunId,
    buildClient,
    fetchLogoBytes,
  } = args;

  if (representative.featuredQuestionId == null) {
    res.status(400).json({
      error:
        "Featured opportunity missing featured_question_id; cannot submit",
    });
    return;
  }

  // Featured profile is per-spokesperson; co-branded pitch uses the first
  // brand (canonical-sorted) as the lead spokesperson identity.
  const leadBrandId = brandIds[0];

  let credentials: FeaturedCredentials;
  let keySource: "org" | "platform";
  try {
    const result = await getFeaturedCredentials({
      callerMethod: "POST",
      callerPath: "/orgs/opportunities/:id/reply",
      orgId,
      userId,
      runId,
    });
    credentials = { username: result.username, password: result.password };
    keySource = result.keySource;
  } catch (err) {
    const name = (err as Error).name;
    const message = (err as Error).message;
    if (name === "KeyServiceUnavailableError") {
      res.status(502).json({ error: message });
      return;
    }
    res.status(500).json({ error: message });
    return;
  }

  if (keySource === "platform") {
    try {
      const auth = await authorizeCredit({
        items: [{ costName: FEATURED_PITCH_SUBMIT_COST, quantity: 1 }],
        description: "featured pitch submit",
        orgId,
        userId,
        runId,
        brandId: leadBrandId,
        campaignId,
        featureSlug: req.featureSlug,
        workflowSlug: req.workflowSlug,
      });
      if (!auth.sufficient) {
        res.status(402).json({
          error: "insufficient credit for featured pitch submit",
          balance_cents: auth.balance_cents,
          required_cents: auth.required_cents,
        });
        return;
      }
    } catch (err) {
      const status = err instanceof BillingServiceError ? 502 : 500;
      res.status(status).json({ error: (err as Error).message });
      return;
    }
  }

  const client = buildClient(credentials);

  let profile;
  try {
    profile = await ensureFeaturedProfile({
      orgId,
      brandId: leadBrandId,
      client,
      fetchLogoBytes,
    });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
    return;
  }

  const rateState = client.rateLimitState();
  if (rateState.remaining <= 0) {
    res.json({ status: "rate_limited", retryAfter: rateState.retryAfter });
    return;
  }

  try {
    await client.submitAnswer({
      answer: pitchContent,
      featuredQuestionId: representative.featuredQuestionId,
      profileId: profile.featuredProfileId,
    });
  } catch (err) {
    if (err instanceof FeaturedRateLimitError) {
      res.json({ status: "rate_limited", retryAfter: err.retryAfter });
      return;
    }
    const [pitch] = await db
      .insert(quotePitches)
      .values({
        quoteRequestId: representative.id,
        quoteOpportunityId: opportunityId,
        featuredQuestionId: representative.featuredQuestionId,
        featuredProfileId: profile.featuredProfileId,
        campaignId: campaignId ?? null,
        brandIds,
        draft: pitchContent,
        status: "error",
        deliveryMethod: "featured_api",
        deliveryTarget: representative.pitchUrl ?? null,
        error: (err as Error).message,
        parentRunId,
        runId: runId ?? null,
        orgId,
      })
      .returning();
    res.json({
      status: "error",
      error: (err as Error).message,
      pitchId: pitch.id,
    });
    return;
  }

  const [pitch] = await db
    .insert(quotePitches)
    .values({
      quoteRequestId: representative.id,
      quoteOpportunityId: opportunityId,
      featuredQuestionId: representative.featuredQuestionId,
      featuredProfileId: profile.featuredProfileId,
      campaignId: campaignId ?? null,
      brandIds,
      draft: pitchContent,
      status: "submitted",
      deliveryMethod: "featured_api",
      deliveryTarget: representative.pitchUrl ?? null,
      submittedAt: new Date(),
      parentRunId,
      runId: runId ?? null,
      orgId,
    })
    .returning();

  if (runId) {
    try {
      await addCosts(
        runId,
        [
          {
            costName: FEATURED_PITCH_SUBMIT_COST,
            costSource: keySource,
            quantity: 1,
            status: "actual",
          },
        ],
        {
          orgId,
          userId,
          brandId: leadBrandId,
          campaignId,
          featureSlug: req.featureSlug,
          workflowSlug: req.workflowSlug,
        }
      );
    } catch (err) {
      res.status(500).json({
        error: `failed to record featured pitch submit cost: ${(err as Error).message}`,
      });
      return;
    }
  }

  res.json({
    status: "submitted",
    pitchId: pitch.id,
    deliveryMethod: "featured_api",
    featuredQuestionId: representative.featuredQuestionId,
  });
}

async function handleEmailReply(args: {
  req: import("express").Request;
  res: import("express").Response;
  opportunityId: string;
  representative: SilverRowFull;
  pitchContent: string;
  subject?: string;
  brandIds: string[];
  campaignId?: string;
  orgId: string;
  userId?: string;
  runId?: string;
  parentRunId: string | null;
}) {
  const {
    req,
    res,
    opportunityId,
    representative,
    pitchContent,
    subject,
    brandIds,
    campaignId,
    orgId,
    userId,
    runId,
    parentRunId,
  } = args;

  if (!representative.pitchEmail) {
    res.status(400).json({
      error:
        "Email-source opportunity missing pitch_email; cannot deliver reply",
    });
    return;
  }

  const leadBrandId = brandIds[0];
  const { first, last } = splitName(representative.journalistName);
  const company = representative.mediaOutlet ?? "(unknown outlet)";
  const finalSubject =
    subject?.trim() ||
    `Re: ${truncateForSubject(representative.opportunityText, 80)}`;

  let sendResult;
  try {
    sendResult = await sendTransactionalEmail(
      {
        to: representative.pitchEmail,
        recipientFirstName: first,
        recipientLastName: last,
        recipientCompany: company,
        subject: finalSubject,
        textBody: pitchContent,
      },
      {
        orgId,
        userId,
        runId,
        campaignId,
        brandId: leadBrandId,
        workflowSlug: req.workflowSlug,
        featureSlug: req.featureSlug,
      }
    );
  } catch (err) {
    if (err instanceof EmailGatewayError) {
      const [pitch] = await db
        .insert(quotePitches)
        .values({
          quoteRequestId: representative.id,
          quoteOpportunityId: opportunityId,
          campaignId: campaignId ?? null,
          brandIds,
          draft: pitchContent,
          status: "error",
          deliveryMethod: "email_reply",
          deliveryTarget: representative.pitchEmail,
          error: err.message,
          errorDetails: { status: err.status, details: err.details },
          parentRunId,
          runId: runId ?? null,
          orgId,
        })
        .returning();
      res.status(502).json({
        status: "error",
        error: err.message,
        pitchId: pitch.id,
      });
      return;
    }
    res.status(502).json({ error: (err as Error).message });
    return;
  }

  const [pitch] = await db
    .insert(quotePitches)
    .values({
      quoteRequestId: representative.id,
      quoteOpportunityId: opportunityId,
      campaignId: campaignId ?? null,
      brandIds,
      draft: pitchContent,
      status: "submitted",
      deliveryMethod: "email_reply",
      deliveryTarget: representative.pitchEmail,
      outboundMessageId: sendResult.messageId ?? null,
      submittedAt: new Date(),
      parentRunId,
      runId: runId ?? null,
      orgId,
    })
    .returning();

  res.json({
    status: "submitted",
    pitchId: pitch.id,
    deliveryMethod: "email_reply",
    outboundMessageId: sendResult.messageId,
  });
}

function truncateForSubject(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return oneLine.slice(0, max - 1) + "…";
}

export default createOpportunityReplyRouter();
