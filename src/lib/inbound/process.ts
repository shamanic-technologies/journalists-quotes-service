import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { inboundEmails, providerQuoteRequests } from "../../db/schema.js";
import { PostmarkInboundWebhookSchema } from "../../schemas.js";
import { getParser } from "./parsers/index.js";
import { computeFingerprint } from "../cluster/fingerprint.js";
import { attachOrCreateCluster } from "../cluster/attach.js";

/**
 * Sentinel org_id for email-sourced opportunities. The same HARO query is
 * visible to every org, so silver rows live in a shared pool keyed by this
 * UUID. The ranked-queue pipeline (`/orgs/opportunities/ranked`) queries
 * `WHERE org_id IN (req.orgId, SHARED_EMAIL_ORG_ID)` to merge the org's
 * API-sourced rows with the shared email pool.
 */
export const SHARED_EMAIL_ORG_ID = "00000000-0000-0000-0000-000000000000";

export interface ProcessInboundEmailsResult {
  processed: number;
  parsed: number;
  failed: number;
  skipped: number;
  silverRowsInserted: number;
  goldClustersCreated: number;
}

/**
 * Drain pending `inbound_emails` rows: dispatch to parser by `provider`,
 * insert silver `provider_quote_requests` rows, attach or create gold
 * `quote_opportunities` cluster via fingerprint, mark status.
 *
 * Idempotent: re-running processes the same rows safely
 * (unique constraints + onConflictDoNothing).
 */
export async function processInboundEmails(
  options: { batchSize?: number } = {}
): Promise<ProcessInboundEmailsResult> {
  const batchSize = options.batchSize ?? 50;

  const pending = await db
    .select()
    .from(inboundEmails)
    .where(eq(inboundEmails.processingStatus, "pending"))
    .limit(batchSize);

  let parsed = 0;
  let failed = 0;
  let skipped = 0;
  let silverRowsInserted = 0;
  let goldClustersCreated = 0;

  for (const email of pending) {
    const parser = getParser(email.provider);
    if (!parser) {
      await db
        .update(inboundEmails)
        .set({
          processingStatus: "skipped",
          parseError: email.provider
            ? `No parser registered for provider="${email.provider}"`
            : "Provider unresolved (no alias match)",
        })
        .where(eq(inboundEmails.id, email.id));
      skipped++;
      continue;
    }

    try {
      const webhook = PostmarkInboundWebhookSchema.parse(email.rawPayload);
      const result = parser(webhook);

      for (const q of result.queries) {
        const fingerprint = computeFingerprint(q.opportunityText, q.mediaOutlet);

        const opportunityId = await attachOrCreateCluster({
          fingerprint,
          canonicalText: q.opportunityText,
          canonicalOutlet: q.mediaOutlet,
          canonicalDeadline: q.deadline,
        });
        if (opportunityId.created) goldClustersCreated++;

        const inserted = await db
          .insert(providerQuoteRequests)
          .values({
            provider: email.provider!,
            ingestionChannel: "email",
            externalId: q.externalId,
            inboundEmailId: email.id,
            mediaOutlet: q.mediaOutlet,
            journalistName: q.journalistName,
            journalistEmail: null,
            pitchEmail: q.pitchEmail,
            category: q.category,
            opportunityText: q.opportunityText,
            pitchUrl: null,
            deadline: q.deadline,
            raw: {
              summary: q.summary,
              deadlineRaw: q.deadlineRaw,
              journalistProfileUrl: q.journalistProfileUrl,
              rawSection: q.rawSection,
            },
            quoteOpportunityId: opportunityId.id,
            isCanonical: opportunityId.created,
            fingerprint,
            orgId: SHARED_EMAIL_ORG_ID,
          })
          .onConflictDoNothing({
            target: [
              providerQuoteRequests.provider,
              providerQuoteRequests.ingestionChannel,
              providerQuoteRequests.externalId,
            ],
          })
          .returning({ id: providerQuoteRequests.id });

        if (inserted.length > 0) silverRowsInserted++;
      }

      await db
        .update(inboundEmails)
        .set({ processingStatus: "parsed", parseError: null })
        .where(eq(inboundEmails.id, email.id));
      parsed++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[journalists-quotes-service] failed to parse inbound email ${email.id}: ${message}`
      );
      await db
        .update(inboundEmails)
        .set({ processingStatus: "failed", parseError: message })
        .where(eq(inboundEmails.id, email.id));
      failed++;
    }
  }

  return {
    processed: pending.length,
    parsed,
    failed,
    skipped,
    silverRowsInserted,
    goldClustersCreated,
  };
}

