-- Featured/Connectively publication-outcome reconcile.
--
-- Advancing a pitch's `status` submitted -> selected / published /
-- not_selected already works (those enum values + BLOCK_STATUSES exist).
-- These columns carry the press-value metadata Connectively exposes on its
-- `/submitted` pass-through alongside the outcome, matched onto a pitch by
-- (featured_question_id, featured_profile_id).
--
-- Connectively's payload does NOT expose the published article URL, the
-- article title, or a per-stage timestamp -- only status + outlet + DR +
-- backlink attribution. So `featured_article_url` stays null from this path
-- (no fabrication) and `outcome_observed_at` records OUR observation time,
-- not Connectively's stage time. All columns nullable + additive; no
-- existing row changes. IF NOT EXISTS keeps the migration idempotent.
ALTER TABLE "quote_pitches" ADD COLUMN IF NOT EXISTS "outcome_observed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "quote_pitches" ADD COLUMN IF NOT EXISTS "publication_source" text;--> statement-breakpoint
ALTER TABLE "quote_pitches" ADD COLUMN IF NOT EXISTS "outlet_domain_rating" integer;--> statement-breakpoint
ALTER TABLE "quote_pitches" ADD COLUMN IF NOT EXISTS "backlink_attribution" text;--> statement-breakpoint
ALTER TABLE "eqrs_sync_state" ADD COLUMN IF NOT EXISTS "last_outcome_reconciled_at" timestamp with time zone;
