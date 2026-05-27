-- =====================================================================
-- 0004 — Gold-cluster IDs externalised + multi-brand brand_ids[]
--
-- Refactor: quotes-service becomes a pure opportunity catalog (parity
-- with lead-service / journalists-service). All API-exposed IDs are
-- Gold cluster (quote_opportunities.id). Brand identity is plural
-- everywhere — x-brand-id header CSV → brandIds[].
--
-- Changes:
-- - quote_priorities: drop + recreate keyed by Gold opportunity id +
--   brand_ids[]. Cache loss is intentional (per user decision — cache
--   recomputable on next /ranked or /next call; was not in production
--   yet).
-- - quote_pitches: brand_id (singular UUID) → brand_ids (UUID[]).
--   Existing rows migrated as brand_ids = ARRAY[brand_id]. Partial
--   uniques rebuilt on (quote_opportunity_id, brand_ids). The legacy
--   (quote_request_id, brand_ids) partial for non-clustered rows is
--   dropped — every new pitch goes through the Gold-id path, so
--   quote_opportunity_id is always set going forward.
-- - GIN indexes on brand_ids for efficient containment lookups.
-- =====================================================================

-- quote_priorities: drop and recreate at Gold level --------------------

DROP TABLE IF EXISTS "quote_priorities" CASCADE;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "quote_priorities" (
  "quote_opportunity_id" uuid NOT NULL REFERENCES "quote_opportunities"("id") ON DELETE CASCADE,
  "brand_ids" uuid[] NOT NULL,
  "campaign_id" uuid,
  "score" numeric(5,2) NOT NULL,
  "why_relevant" text,
  "scored_at" timestamp with time zone NOT NULL DEFAULT now(),
  "scored_by_run_id" uuid,
  "org_id" uuid NOT NULL,
  CONSTRAINT "quote_priorities_quote_opportunity_id_brand_ids_pk"
    PRIMARY KEY ("quote_opportunity_id", "brand_ids")
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_quote_priorities_brand_ids"
  ON "quote_priorities" USING gin ("brand_ids");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_quote_priorities_score"
  ON "quote_priorities" USING btree ("score");
--> statement-breakpoint

-- quote_pitches: brand_id -> brand_ids[] -------------------------------

ALTER TABLE "quote_pitches" ADD COLUMN IF NOT EXISTS "brand_ids" uuid[];
--> statement-breakpoint

-- Backfill brand_ids from legacy singular brand_id (idempotent).
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'quote_pitches' AND column_name = 'brand_id'
  ) THEN
    UPDATE "quote_pitches"
       SET "brand_ids" = ARRAY["brand_id"]
     WHERE "brand_ids" IS NULL AND "brand_id" IS NOT NULL;
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE "quote_pitches" ALTER COLUMN "brand_ids" SET NOT NULL;
--> statement-breakpoint

-- Drop legacy partial uniques + brand_id column.
DROP INDEX IF EXISTS "idx_quote_pitches_opportunity_brand";
--> statement-breakpoint

DROP INDEX IF EXISTS "idx_quote_pitches_request_brand";
--> statement-breakpoint

ALTER TABLE "quote_pitches" DROP COLUMN IF EXISTS "brand_id";
--> statement-breakpoint

-- New indexes on brand_ids.
CREATE INDEX IF NOT EXISTS "idx_quote_pitches_brand_ids"
  ON "quote_pitches" USING gin ("brand_ids");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_quote_pitches_quote_opportunity"
  ON "quote_pitches" USING btree ("quote_opportunity_id");
--> statement-breakpoint

-- Partial unique: (quote_opportunity_id, brand_ids) for blocking statuses.
-- brand_ids is stored canonically (sorted unique) by application code,
-- so plain array equality is sufficient for the unique check.
CREATE UNIQUE INDEX IF NOT EXISTS "idx_quote_pitches_opportunity_brand_ids"
  ON "quote_pitches" USING btree ("quote_opportunity_id", "brand_ids")
  WHERE "quote_opportunity_id" IS NOT NULL
    AND "status" NOT IN ('error', 'length_violation', 'template_missing', 'brand_missing_fields', 'insufficient_credits');
