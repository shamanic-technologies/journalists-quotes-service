CREATE TYPE "public"."pitch_status" AS ENUM('drafted', 'submitted', 'selected', 'published', 'not_selected', 'error');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "featured_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"featured_profile_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "quote_pitches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"quote_request_id" uuid NOT NULL,
	"featured_question_id" integer NOT NULL,
	"featured_profile_id" integer NOT NULL,
	"campaign_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"draft" text NOT NULL,
	"submitted_at" timestamp with time zone,
	"status" "pitch_status" DEFAULT 'drafted' NOT NULL,
	"featured_article_url" text,
	"error" text,
	"parent_run_id" uuid,
	"run_id" uuid,
	"org_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "quote_priorities" (
	"quote_request_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"score" numeric(5, 2) NOT NULL,
	"why_relevant" text,
	"scored_at" timestamp with time zone DEFAULT now() NOT NULL,
	"scored_by_run_id" uuid,
	"org_id" uuid NOT NULL,
	CONSTRAINT "quote_priorities_quote_request_id_campaign_id_pk" PRIMARY KEY("quote_request_id","campaign_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "quote_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"featured_question_id" integer NOT NULL,
	"source" text DEFAULT 'featured' NOT NULL,
	"media_outlet" text,
	"opportunity_text" text NOT NULL,
	"pitch_url" text,
	"deadline" timestamp with time zone,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"raw" jsonb,
	"org_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "quote_pitches" ADD CONSTRAINT "quote_pitches_quote_request_id_quote_requests_id_fk" FOREIGN KEY ("quote_request_id") REFERENCES "public"."quote_requests"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "quote_priorities" ADD CONSTRAINT "quote_priorities_quote_request_id_quote_requests_id_fk" FOREIGN KEY ("quote_request_id") REFERENCES "public"."quote_requests"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_featured_profiles_org_brand" ON "featured_profiles" USING btree ("org_id","brand_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_quote_pitches_org_campaign_status" ON "quote_pitches" USING btree ("org_id","campaign_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_quote_pitches_quote_request" ON "quote_pitches" USING btree ("quote_request_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_quote_priorities_campaign_score" ON "quote_priorities" USING btree ("campaign_id","score");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_quote_requests_source_question" ON "quote_requests" USING btree ("source","featured_question_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_quote_requests_org_fetched" ON "quote_requests" USING btree ("org_id","fetched_at");