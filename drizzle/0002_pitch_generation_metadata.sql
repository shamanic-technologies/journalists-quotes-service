-- =====================================================================
-- 0002 — pitch generation metadata + content-gen error states
--
-- - extend pitch_status enum with length_violation, template_missing,
--   brand_missing_fields, insufficient_credits
-- - drop notNull on quote_pitches.draft so error rows can persist without
--   pitch text
-- - add quote_pitches.pitch_char_count, pitch_attempts, content_gen_run_id,
--   error_details for content-generation-service result tracking
-- =====================================================================

ALTER TYPE "public"."pitch_status" ADD VALUE IF NOT EXISTS 'length_violation';--> statement-breakpoint
ALTER TYPE "public"."pitch_status" ADD VALUE IF NOT EXISTS 'template_missing';--> statement-breakpoint
ALTER TYPE "public"."pitch_status" ADD VALUE IF NOT EXISTS 'brand_missing_fields';--> statement-breakpoint
ALTER TYPE "public"."pitch_status" ADD VALUE IF NOT EXISTS 'insufficient_credits';--> statement-breakpoint

ALTER TABLE "quote_pitches" ALTER COLUMN "draft" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "quote_pitches" ADD COLUMN IF NOT EXISTS "pitch_char_count" integer;--> statement-breakpoint
ALTER TABLE "quote_pitches" ADD COLUMN IF NOT EXISTS "pitch_attempts" integer;--> statement-breakpoint
ALTER TABLE "quote_pitches" ADD COLUMN IF NOT EXISTS "content_gen_run_id" uuid;--> statement-breakpoint
ALTER TABLE "quote_pitches" ADD COLUMN IF NOT EXISTS "error_details" jsonb;
