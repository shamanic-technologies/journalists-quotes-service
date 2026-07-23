-- Published-article placement fields (Featured/Connectively `/published`).
--
-- The publication-outcome reconcile (#101) advanced pitch status +
-- recorded outlet/DR/attribution from Connectively's `/submitted` feed, but
-- that feed exposes NO published article URL/title/date, so the press
-- report's Article column stayed blank. Those fields live on a SEPARATE
-- Connectively `/published` feed (now proxied by EQRS
-- `GET /orgs/featured/published`), matched onto a pitch by the same
-- (featured_question_id, featured_profile_id) key.
--
-- `featured_article_url` already exists (added in 0007-era schema). This adds
-- the remaining two: `article_title` and `published_at` (Connectively's real
-- `publishDate` — when the article went live, distinct from
-- `outcome_observed_at` which is OUR observation time). All nullable +
-- additive; no existing row changes. IF NOT EXISTS keeps it idempotent.
ALTER TABLE "quote_pitches" ADD COLUMN IF NOT EXISTS "article_title" text;--> statement-breakpoint
ALTER TABLE "quote_pitches" ADD COLUMN IF NOT EXISTS "published_at" timestamp with time zone;
