import { sql } from "drizzle-orm";
import {
  pgTable,
  pgEnum,
  uuid,
  text,
  timestamp,
  numeric,
  integer,
  jsonb,
  boolean,
  uniqueIndex,
  index,
  primaryKey,
} from "drizzle-orm/pg-core";

export const pitchStatusEnum = pgEnum("pitch_status", [
  "drafted",
  "submitted",
  "selected",
  "published",
  "not_selected",
  "error",
  "length_violation",
  "template_missing",
  "brand_missing_fields",
  "insufficient_credits",
  // Terminal: the Featured question no longer exists upstream (submit
  // returned 404 "Question not found"). Unlike the retryable `error`
  // status, this is BLOCKING — it participates in the partial unique
  // index (NOT listed in the exclusion below) and in BLOCK_STATUSES, so
  // a permanently-dead question is never re-served to the same brand-set.
  "question_not_found",
]);

export const processingStatusEnum = pgEnum("processing_status", [
  "pending",
  "parsed",
  "failed",
  "skipped",
]);

export const clusterMethodEnum = pgEnum("cluster_method", [
  "fingerprint",
  "embedding",
  "manual",
]);

export const deliveryMethodEnum = pgEnum("delivery_method", [
  "featured_api",
  "email_reply",
]);

export const inboundEmails = pgTable(
  "inbound_emails",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    messageId: text("message_id").notNull(),
    fromEmail: text("from_email").notNull(),
    toEmail: text("to_email").notNull(),
    subject: text("subject"),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    rawPayload: jsonb("raw_payload").notNull(),
    provider: text("provider"),
    ingestionChannel: text("ingestion_channel").notNull().default("email"),
    sourceAlias: text("source_alias"),
    processingStatus: processingStatusEnum("processing_status")
      .notNull()
      .default("pending"),
    parseError: text("parse_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_inbound_emails_message_id").on(table.messageId),
    index("idx_inbound_emails_status_received").on(
      table.processingStatus,
      table.receivedAt
    ),
    index("idx_inbound_emails_provider_received").on(
      table.provider,
      table.receivedAt
    ),
  ]
);

export const quoteOpportunities = pgTable(
  "quote_opportunities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fingerprint: text("fingerprint").notNull(),
    canonicalText: text("canonical_text").notNull(),
    canonicalOutlet: text("canonical_outlet"),
    canonicalDeadline: timestamp("canonical_deadline", { withTimezone: true }),
    clusterMethod: clusterMethodEnum("cluster_method")
      .notNull()
      .default("fingerprint"),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_quote_opportunities_fingerprint").on(table.fingerprint),
    index("idx_quote_opportunities_last_seen").on(table.lastSeenAt),
  ]
);

export const providerQuoteRequests = pgTable(
  "provider_quote_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: text("provider").notNull(),
    ingestionChannel: text("ingestion_channel").notNull().default("api"),
    externalId: text("external_id").notNull(),
    inboundEmailId: uuid("inbound_email_id").references(() => inboundEmails.id, {
      onDelete: "set null",
    }),
    featuredQuestionId: integer("featured_question_id"),
    mediaOutlet: text("media_outlet"),
    journalistName: text("journalist_name"),
    journalistEmail: text("journalist_email"),
    pitchEmail: text("pitch_email"),
    category: text("category"),
    opportunityText: text("opportunity_text").notNull(),
    pitchUrl: text("pitch_url"),
    deadline: timestamp("deadline", { withTimezone: true }),
    fetchedAt: timestamp("fetched_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    raw: jsonb("raw"),
    quoteOpportunityId: uuid("quote_opportunity_id").references(
      () => quoteOpportunities.id,
      { onDelete: "set null" }
    ),
    isCanonical: boolean("is_canonical").notNull().default(false),
    fingerprint: text("fingerprint"),
    orgId: uuid("org_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_provider_quote_requests_provider_channel_external").on(
      table.provider,
      table.ingestionChannel,
      table.externalId
    ),
    index("idx_provider_quote_requests_org_fetched").on(
      table.orgId,
      table.fetchedAt
    ),
    index("idx_provider_quote_requests_opportunity").on(
      table.quoteOpportunityId
    ),
    index("idx_provider_quote_requests_fingerprint").on(table.fingerprint),
  ]
);

export const quotePriorities = pgTable(
  "quote_priorities",
  {
    quoteOpportunityId: uuid("quote_opportunity_id")
      .notNull()
      .references(() => quoteOpportunities.id, { onDelete: "cascade" }),
    brandIds: uuid("brand_ids").array().notNull(),
    campaignId: uuid("campaign_id"),
    score: numeric("score", { precision: 5, scale: 2 }).notNull(),
    whyRelevant: text("why_relevant"),
    scoredAt: timestamp("scored_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    scoredByRunId: uuid("scored_by_run_id"),
    orgId: uuid("org_id").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.quoteOpportunityId, table.brandIds] }),
    index("idx_quote_priorities_brand_ids").using("gin", table.brandIds),
    index("idx_quote_priorities_score").on(table.score),
  ]
);

/**
 * Per-org cursor state for incremental fetches from
 * expert-quotes-requests-service GET /orgs/featured/opportunities.
 * `last_synced_at` is the ISO timestamp passed as `?since=…` on the
 * next pull (advance after a successful fetch).
 */
export const eqrsSyncState = pgTable("eqrs_sync_state", {
  orgId: uuid("org_id").primaryKey(),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
  lastCursor: text("last_cursor"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const quotePitches = pgTable(
  "quote_pitches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    quoteRequestId: uuid("quote_request_id")
      .notNull()
      .references(() => providerQuoteRequests.id, { onDelete: "cascade" }),
    quoteOpportunityId: uuid("quote_opportunity_id").references(
      () => quoteOpportunities.id,
      { onDelete: "set null" }
    ),
    featuredQuestionId: integer("featured_question_id"),
    featuredProfileId: integer("featured_profile_id"),
    campaignId: uuid("campaign_id"),
    brandIds: uuid("brand_ids").array().notNull(),
    draft: text("draft"),
    pitchCharCount: integer("pitch_char_count"),
    pitchAttempts: integer("pitch_attempts"),
    contentGenRunId: uuid("content_gen_run_id"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    status: pitchStatusEnum("status").notNull().default("drafted"),
    deliveryMethod: deliveryMethodEnum("delivery_method").notNull(),
    deliveryTarget: text("delivery_target"),
    outboundMessageId: text("outbound_message_id"),
    replyInThreadMessageId: text("reply_in_thread_message_id"),
    bounceStatus: text("bounce_status"),
    featuredArticleUrl: text("featured_article_url"),
    error: text("error"),
    errorDetails: jsonb("error_details"),
    parentRunId: uuid("parent_run_id"),
    runId: uuid("run_id"),
    orgId: uuid("org_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_quote_pitches_org_campaign_status").on(
      table.orgId,
      table.campaignId,
      table.status
    ),
    index("idx_quote_pitches_quote_request").on(table.quoteRequestId),
    index("idx_quote_pitches_quote_opportunity").on(table.quoteOpportunityId),
    index("idx_quote_pitches_brand_ids").using("gin", table.brandIds),
    uniqueIndex("idx_quote_pitches_opportunity_brand_ids")
      .on(table.quoteOpportunityId, table.brandIds)
      .where(sql`quote_opportunity_id IS NOT NULL AND status NOT IN ('error', 'length_violation', 'template_missing', 'brand_missing_fields', 'insufficient_credits')`),
  ]
);

export type InboundEmail = typeof inboundEmails.$inferSelect;
export type NewInboundEmail = typeof inboundEmails.$inferInsert;
export type QuoteOpportunity = typeof quoteOpportunities.$inferSelect;
export type NewQuoteOpportunity = typeof quoteOpportunities.$inferInsert;
export type ProviderQuoteRequest = typeof providerQuoteRequests.$inferSelect;
export type NewProviderQuoteRequest = typeof providerQuoteRequests.$inferInsert;
export type QuotePriority = typeof quotePriorities.$inferSelect;
export type NewQuotePriority = typeof quotePriorities.$inferInsert;
export type EqrsSyncState = typeof eqrsSyncState.$inferSelect;
export type NewEqrsSyncState = typeof eqrsSyncState.$inferInsert;
export type QuotePitch = typeof quotePitches.$inferSelect;
export type NewQuotePitch = typeof quotePitches.$inferInsert;
