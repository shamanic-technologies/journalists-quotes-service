import {
  pgTable,
  pgEnum,
  uuid,
  text,
  timestamp,
  numeric,
  integer,
  jsonb,
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
]);

export const quoteRequests = pgTable(
  "quote_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    featuredQuestionId: integer("featured_question_id").notNull(),
    source: text("source").notNull().default("featured"),
    mediaOutlet: text("media_outlet"),
    opportunityText: text("opportunity_text").notNull(),
    pitchUrl: text("pitch_url"),
    deadline: timestamp("deadline", { withTimezone: true }),
    fetchedAt: timestamp("fetched_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    raw: jsonb("raw"),
    orgId: uuid("org_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_quote_requests_source_question").on(
      table.source,
      table.featuredQuestionId
    ),
    index("idx_quote_requests_org_fetched").on(table.orgId, table.fetchedAt),
  ]
);

export const quotePriorities = pgTable(
  "quote_priorities",
  {
    quoteRequestId: uuid("quote_request_id")
      .notNull()
      .references(() => quoteRequests.id, { onDelete: "cascade" }),
    campaignId: uuid("campaign_id").notNull(),
    brandId: uuid("brand_id").notNull(),
    score: numeric("score", { precision: 5, scale: 2 }).notNull(),
    whyRelevant: text("why_relevant"),
    scoredAt: timestamp("scored_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    scoredByRunId: uuid("scored_by_run_id"),
    orgId: uuid("org_id").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.quoteRequestId, table.campaignId] }),
    index("idx_quote_priorities_campaign_score").on(
      table.campaignId,
      table.score
    ),
  ]
);

export const featuredProfiles = pgTable(
  "featured_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    brandId: uuid("brand_id").notNull(),
    featuredProfileId: integer("featured_profile_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_featured_profiles_org_brand").on(
      table.orgId,
      table.brandId
    ),
  ]
);

export const quotePitches = pgTable(
  "quote_pitches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    quoteRequestId: uuid("quote_request_id")
      .notNull()
      .references(() => quoteRequests.id, { onDelete: "cascade" }),
    featuredQuestionId: integer("featured_question_id").notNull(),
    featuredProfileId: integer("featured_profile_id").notNull(),
    campaignId: uuid("campaign_id").notNull(),
    brandId: uuid("brand_id").notNull(),
    draft: text("draft").notNull(),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    status: pitchStatusEnum("status").notNull().default("drafted"),
    featuredArticleUrl: text("featured_article_url"),
    error: text("error"),
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
  ]
);

export type QuoteRequest = typeof quoteRequests.$inferSelect;
export type NewQuoteRequest = typeof quoteRequests.$inferInsert;
export type QuotePriority = typeof quotePriorities.$inferSelect;
export type NewQuotePriority = typeof quotePriorities.$inferInsert;
export type FeaturedProfile = typeof featuredProfiles.$inferSelect;
export type NewFeaturedProfile = typeof featuredProfiles.$inferInsert;
export type QuotePitch = typeof quotePitches.$inferSelect;
export type NewQuotePitch = typeof quotePitches.$inferInsert;
