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
  createEqrsClient,
  EqrsServiceError,
  type EqrsClient,
} from "../lib/eqrs-client.js";
import {
  sendTransactionalEmail,
  EmailGatewayError,
} from "../lib/email-gateway-client.js";
import { SHARED_EMAIL_ORG_ID } from "../lib/inbound/process.js";
import {
  computeDelivery,
  isDeadQuestionError,
  pickRepresentativeSilver,
} from "../lib/opportunity-pipeline.js";
import {
  BrandIdsHeaderError,
  parseBrandIdsHeader,
} from "../lib/brand-ids.js";

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
  | "question_not_found"
> = [
  "drafted",
  "submitted",
  "selected",
  "published",
  "not_selected",
  // A dead Featured question is terminal — short-circuit re-submits so we
  // never re-hit Featured's 404 for the same brand-set.
  "question_not_found",
];

export interface OpportunityReplyDeps {
  eqrsClient?: EqrsClient;
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
  const eqrsClient = deps.eqrsClient ?? createEqrsClient();

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
    const audienceId = req.audienceId;
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
      // A prior dead-question outcome is terminal, not a successful submit.
      // Surface it as `question_not_found` (410 Gone) so the caller never
      // re-attempts the vanished Featured question for this brand-set.
      if (existingPitch.status === "question_not_found") {
        res.status(410).json({
          status: "question_not_found",
          pitchId: existingPitch.id,
          deliveryMethod: existingPitch.deliveryMethod,
          featuredQuestionId: existingPitch.featuredQuestionId,
          reason:
            "Featured question no longer exists upstream (submit returned 404). Permanently excluded.",
        });
        return;
      }
      res.json({
        status: "already_submitted",
        pitchId: existingPitch.id,
        deliveryMethod: existingPitch.deliveryMethod,
        outboundMessageId: existingPitch.outboundMessageId,
        featuredQuestionId: existingPitch.featuredQuestionId,
      });
      return;
    }

    // Resolve how (and whether) this opportunity can be submitted.
    // Discovery leads (Featured, no question id, no email) are NOT
    // programmatically submittable — return an explicit non-submittable
    // contract (422), never a raw 400 missing-fqid.
    const delivery = computeDelivery(representative);
    if (!delivery.submittable) {
      res.status(422).json({
        status: "not_submittable",
        deliveryMethod: delivery.deliveryMethod,
        reason:
          "Featured discovery lead — no programmatic submit path. Pitch the journalist directly at the source URL.",
        pitchUrl: representative.pitchUrl ?? null,
      });
      return;
    }

    if (delivery.deliveryMethod === "featured_api") {
      await handleFeaturedReply({
        res,
        opportunityId,
        representative,
        pitchContent,
        brandIds,
        campaignId,
        orgId,
        userId,
        runId,
        audienceId,
        parentRunId,
        eqrsClient,
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
      audienceId,
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

/**
 * Record a permanently-dead Featured question (submit returned 404
 * "Question not found") and respond 410 Gone. The pitch is written with
 * the terminal `question_not_found` status, which is BLOCKING (in the
 * partial unique index + BLOCK_STATUSES), so `/next` never re-serves this
 * question to the same brand-set again — the campaign advances to a live
 * opportunity instead of looping on the 404. `onConflictDoNothing` guards
 * against a race / manual re-call hitting the unique blocking index.
 */
async function respondDeadQuestion(args: {
  res: import("express").Response;
  opportunityId: string;
  representative: SilverRowFull;
  pitchContent: string;
  brandIds: string[];
  campaignId?: string;
  orgId: string;
  runId?: string;
  parentRunId: string | null;
  errorMessage: string;
}) {
  const {
    res,
    opportunityId,
    representative,
    pitchContent,
    brandIds,
    campaignId,
    orgId,
    runId,
    parentRunId,
    errorMessage,
  } = args;

  const inserted = await db
    .insert(quotePitches)
    .values({
      quoteRequestId: representative.id,
      quoteOpportunityId: opportunityId,
      featuredQuestionId: representative.featuredQuestionId,
      campaignId: campaignId ?? null,
      brandIds,
      draft: pitchContent,
      status: "question_not_found",
      deliveryMethod: "featured_api",
      deliveryTarget: representative.pitchUrl ?? null,
      error: errorMessage,
      parentRunId,
      runId: runId ?? null,
      orgId,
    })
    .onConflictDoNothing()
    .returning();

  let pitchId = inserted[0]?.id;
  if (!pitchId) {
    const [existing] = await db
      .select({ id: quotePitches.id })
      .from(quotePitches)
      .where(
        and(
          eq(quotePitches.quoteOpportunityId, opportunityId),
          eq(quotePitches.brandIds, brandIds),
          eq(quotePitches.status, "question_not_found")
        )
      )
      .limit(1);
    pitchId = existing?.id;
  }

  res.status(410).json({
    status: "question_not_found",
    error: errorMessage,
    pitchId,
    deliveryMethod: "featured_api",
    featuredQuestionId: representative.featuredQuestionId,
    reason:
      "Featured question no longer exists upstream (submit returned 404). Permanently excluded from future selection.",
  });
}

async function handleFeaturedReply(args: {
  res: import("express").Response;
  opportunityId: string;
  representative: SilverRowFull;
  pitchContent: string;
  brandIds: string[];
  campaignId?: string;
  orgId: string;
  userId?: string;
  runId?: string;
  audienceId?: string;
  parentRunId: string | null;
  eqrsClient: EqrsClient;
}) {
  const {
    res,
    opportunityId,
    representative,
    pitchContent,
    brandIds,
    campaignId,
    orgId,
    userId,
    runId,
    audienceId,
    parentRunId,
    eqrsClient,
  } = args;

  // Unreachable in normal flow — the router only routes featured_api
  // here when featuredQuestionId is present. Defensive: never a raw 400.
  if (representative.featuredQuestionId == null) {
    res.status(422).json({
      status: "not_submittable",
      deliveryMethod: "external_manual",
      reason:
        "Featured discovery lead — no programmatic submit path. Pitch the journalist directly at the source URL.",
      pitchUrl: representative.pitchUrl ?? null,
    });
    return;
  }

  // Featured profile is per-spokesperson; co-branded pitch uses the first
  // brand (canonical-sorted) as the lead spokesperson identity. EQRS
  // resolves Featured credentials + bootstraps the profile internally.
  const leadBrandId = brandIds[0];

  // EQRS owns the featured-submit credit gate AND the
  // `featured-api-pitch-submit` cost declaration (provision → authorize →
  // execute → actualize, scoped to its own run) — it performs the terminal
  // Featured.com call. JQS does NOT gate or declare that cost locally;
  // doing so would double-charge. JQS surfaces EQRS's outcome instead.
  let submitResult;
  try {
    submitResult = await eqrsClient.submitAnswer({
      orgId,
      userId,
      runId,
      audienceId,
      brandId: leadBrandId,
      featuredQuestionId: representative.featuredQuestionId,
      answer: pitchContent,
    });
  } catch (err) {
    // Insufficient credit is gated by EQRS now (it declares + authorizes the
    // cost). A 402 from EQRS is a credit block, not a failed submit attempt —
    // surface it as 402 with no pitch row (re-submittable once credit lands).
    if (err instanceof EqrsServiceError && err.status === 402) {
      res.status(402).json({ error: err.message });
      return;
    }
    const message = (err as Error).message;
    // A dead Featured question (404 "Question not found") is terminal, not a
    // retryable error — mark it blocking so it is never re-served.
    if (isDeadQuestionError(message)) {
      await respondDeadQuestion({
        res,
        opportunityId,
        representative,
        pitchContent,
        brandIds,
        campaignId,
        orgId,
        runId,
        parentRunId,
        errorMessage: message,
      });
      return;
    }
    const [pitch] = await db
      .insert(quotePitches)
      .values({
        quoteRequestId: representative.id,
        quoteOpportunityId: opportunityId,
        featuredQuestionId: representative.featuredQuestionId,
        campaignId: campaignId ?? null,
        brandIds,
        draft: pitchContent,
        status: "error",
        deliveryMethod: "featured_api",
        deliveryTarget: representative.pitchUrl ?? null,
        error: message,
        parentRunId,
        runId: runId ?? null,
        orgId,
      })
      .returning();
    res.status(502).json({
      status: "error",
      error: message,
      pitchId: pitch.id,
    });
    return;
  }

  if (submitResult.status === "rate_limited") {
    res.json({
      status: "rate_limited",
      retryAfter: submitResult.retryAfter,
    });
    return;
  }

  if (submitResult.status === "error") {
    // EQRS surfaces a dead Featured question as a 200 error result whose
    // message is "Featured POST /answer-question failed (404): Question not
    // found". Treat that as terminal + blocking (never re-serve); any other
    // submit error stays a retryable `error`.
    if (isDeadQuestionError(submitResult.error)) {
      await respondDeadQuestion({
        res,
        opportunityId,
        representative,
        pitchContent,
        brandIds,
        campaignId,
        orgId,
        runId,
        parentRunId,
        errorMessage: submitResult.error,
      });
      return;
    }
    const [pitch] = await db
      .insert(quotePitches)
      .values({
        quoteRequestId: representative.id,
        quoteOpportunityId: opportunityId,
        featuredQuestionId: representative.featuredQuestionId,
        campaignId: campaignId ?? null,
        brandIds,
        draft: pitchContent,
        status: "error",
        deliveryMethod: "featured_api",
        deliveryTarget: representative.pitchUrl ?? null,
        error: submitResult.error,
        parentRunId,
        runId: runId ?? null,
        orgId,
      })
      .returning();
    res.json({
      status: "error",
      error: submitResult.error,
      pitchId: pitch.id,
    });
    return;
  }

  // submitResult.status === "submitted"
  const [pitch] = await db
    .insert(quotePitches)
    .values({
      quoteRequestId: representative.id,
      quoteOpportunityId: opportunityId,
      featuredQuestionId: representative.featuredQuestionId,
      featuredProfileId: submitResult.featuredProfileId ?? null,
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
  audienceId?: string;
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
    audienceId,
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
        audienceId,
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
