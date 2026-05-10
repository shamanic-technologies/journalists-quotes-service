-- =====================================================================
-- 0001 — multi-source opportunity ingestion + dedup clusters + dispatcher
--
-- - rename quote_requests -> provider_quote_requests, rename source -> provider
-- - add inbound_emails (bronze), quote_opportunities (gold)
-- - add provider/ingestion_channel/external_id and journalist + cluster fields
--   to provider_quote_requests
-- - add delivery_method + outbound tracking fields to quote_pitches
-- - drop notNull on Featured-coupled columns
-- - backfill: existing rows -> provider='featured', ingestion_channel='api',
--   external_id = featured_question_id::text, delivery_method='featured_api'
-- =====================================================================

-- New enums --------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE "public"."processing_status" AS ENUM('pending', 'parsed', 'failed', 'skipped');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."cluster_method" AS ENUM('fingerprint', 'embedding', 'manual');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."delivery_method" AS ENUM('featured_api', 'email_reply');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint

-- inbound_emails (bronze) ------------------------------------------------

CREATE TABLE IF NOT EXISTS "inbound_emails" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "message_id" text NOT NULL,
  "from_email" text NOT NULL,
  "to_email" text NOT NULL,
  "subject" text,
  "received_at" timestamp with time zone DEFAULT now() NOT NULL,
  "raw_payload" jsonb NOT NULL,
  "provider" text,
  "ingestion_channel" text DEFAULT 'email' NOT NULL,
  "source_alias" text,
  "processing_status" "processing_status" DEFAULT 'pending' NOT NULL,
  "parse_error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_inbound_emails_message_id" ON "inbound_emails" USING btree ("message_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_inbound_emails_status_received" ON "inbound_emails" USING btree ("processing_status", "received_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_inbound_emails_provider_received" ON "inbound_emails" USING btree ("provider", "received_at");
--> statement-breakpoint

-- quote_opportunities (gold) --------------------------------------------

CREATE TABLE IF NOT EXISTS "quote_opportunities" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "fingerprint" text NOT NULL,
  "canonical_text" text NOT NULL,
  "canonical_outlet" text,
  "canonical_deadline" timestamp with time zone,
  "cluster_method" "cluster_method" DEFAULT 'fingerprint' NOT NULL,
  "first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_quote_opportunities_fingerprint" ON "quote_opportunities" USING btree ("fingerprint");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_quote_opportunities_last_seen" ON "quote_opportunities" USING btree ("last_seen_at");
--> statement-breakpoint

-- provider_quote_requests (silver, ex quote_requests) -------------------

ALTER TABLE IF EXISTS "quote_requests" RENAME TO "provider_quote_requests";
--> statement-breakpoint
ALTER TABLE "provider_quote_requests" RENAME COLUMN "source" TO "provider";
--> statement-breakpoint
-- drop default 'featured' on provider; new rows must specify provider explicitly
ALTER TABLE "provider_quote_requests" ALTER COLUMN "provider" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "provider_quote_requests" ADD COLUMN IF NOT EXISTS "ingestion_channel" text DEFAULT 'api' NOT NULL;
--> statement-breakpoint
ALTER TABLE "provider_quote_requests" ADD COLUMN IF NOT EXISTS "external_id" text;
--> statement-breakpoint
-- backfill external_id from featured_question_id for legacy rows
UPDATE "provider_quote_requests" SET "external_id" = "featured_question_id"::text WHERE "external_id" IS NULL AND "featured_question_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "provider_quote_requests" ALTER COLUMN "external_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "provider_quote_requests" ALTER COLUMN "featured_question_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "provider_quote_requests" ADD COLUMN IF NOT EXISTS "inbound_email_id" uuid;
--> statement-breakpoint
ALTER TABLE "provider_quote_requests" ADD COLUMN IF NOT EXISTS "journalist_name" text;
--> statement-breakpoint
ALTER TABLE "provider_quote_requests" ADD COLUMN IF NOT EXISTS "journalist_email" text;
--> statement-breakpoint
ALTER TABLE "provider_quote_requests" ADD COLUMN IF NOT EXISTS "pitch_email" text;
--> statement-breakpoint
ALTER TABLE "provider_quote_requests" ADD COLUMN IF NOT EXISTS "category" text;
--> statement-breakpoint
ALTER TABLE "provider_quote_requests" ADD COLUMN IF NOT EXISTS "quote_opportunity_id" uuid;
--> statement-breakpoint
ALTER TABLE "provider_quote_requests" ADD COLUMN IF NOT EXISTS "is_canonical" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "provider_quote_requests" ADD COLUMN IF NOT EXISTS "fingerprint" text;
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "provider_quote_requests" ADD CONSTRAINT "provider_quote_requests_inbound_email_id_inbound_emails_id_fk"
    FOREIGN KEY ("inbound_email_id") REFERENCES "public"."inbound_emails"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "provider_quote_requests" ADD CONSTRAINT "provider_quote_requests_quote_opportunity_id_quote_opportunities_id_fk"
    FOREIGN KEY ("quote_opportunity_id") REFERENCES "public"."quote_opportunities"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint

-- Replace old unique index (source, featured_question_id) with new one
DROP INDEX IF EXISTS "idx_quote_requests_source_question";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_quote_requests_org_fetched";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_provider_quote_requests_provider_channel_external" ON "provider_quote_requests" USING btree ("provider", "ingestion_channel", "external_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_provider_quote_requests_org_fetched" ON "provider_quote_requests" USING btree ("org_id", "fetched_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_provider_quote_requests_opportunity" ON "provider_quote_requests" USING btree ("quote_opportunity_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_provider_quote_requests_fingerprint" ON "provider_quote_requests" USING btree ("fingerprint");
--> statement-breakpoint

-- quote_pitches: dispatcher fields + nullable Featured cols -------------

ALTER TABLE "quote_pitches" ALTER COLUMN "featured_question_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "quote_pitches" ALTER COLUMN "featured_profile_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "quote_pitches" ADD COLUMN IF NOT EXISTS "quote_opportunity_id" uuid;
--> statement-breakpoint
ALTER TABLE "quote_pitches" ADD COLUMN IF NOT EXISTS "delivery_method" "delivery_method";
--> statement-breakpoint
-- backfill delivery_method for legacy rows
UPDATE "quote_pitches" SET "delivery_method" = 'featured_api' WHERE "delivery_method" IS NULL;
--> statement-breakpoint
ALTER TABLE "quote_pitches" ALTER COLUMN "delivery_method" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "quote_pitches" ADD COLUMN IF NOT EXISTS "delivery_target" text;
--> statement-breakpoint
ALTER TABLE "quote_pitches" ADD COLUMN IF NOT EXISTS "outbound_message_id" text;
--> statement-breakpoint
ALTER TABLE "quote_pitches" ADD COLUMN IF NOT EXISTS "reply_in_thread_message_id" text;
--> statement-breakpoint
ALTER TABLE "quote_pitches" ADD COLUMN IF NOT EXISTS "bounce_status" text;
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "quote_pitches" ADD CONSTRAINT "quote_pitches_quote_opportunity_id_quote_opportunities_id_fk"
    FOREIGN KEY ("quote_opportunity_id") REFERENCES "public"."quote_opportunities"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "idx_quote_pitches_opportunity_brand" ON "quote_pitches" USING btree ("quote_opportunity_id", "brand_id") WHERE "quote_opportunity_id" IS NOT NULL AND "status" <> 'error';
