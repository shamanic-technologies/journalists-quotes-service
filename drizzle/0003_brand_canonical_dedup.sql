-- =====================================================================
-- 0003 — brand-canonical dedup + score cache
--
-- HITL PR-expert-quote-opportunities feature drives a public report at
-- /report/{orgId}/{brandId}/pr-expert-quote-opportunities (no campaignId
-- in path). Dedup + score caching must collapse across all campaigns of
-- the brand.
--
-- Changes:
-- - quote_priorities PK: (quote_request_id, campaign_id) ->
--   (quote_request_id, brand_id). Pre-collapse multi-campaign rows by
--   keeping max(scored_at) per (qr_id, brand_id). campaign_id becomes
--   nullable (forensic tracing).
-- - quote_priorities campaign-keyed score index dropped; brand-keyed
--   score index added.
-- - quote_pitches.campaign_id becomes nullable (forensic).
-- - quote_pitches partial unique on (quote_opportunity_id, brand_id)
--   broadens its status filter to exclude all retryable statuses, not
--   just 'error'.
-- - New partial unique on (quote_request_id, brand_id) for non-clustered
--   rows (quote_opportunity_id IS NULL), same retryable status filter.
-- =====================================================================

-- quote_priorities: collapse duplicates per (qr_id, brand_id) ----------

DELETE FROM "quote_priorities" qp1
USING "quote_priorities" qp2
WHERE qp1.quote_request_id = qp2.quote_request_id
  AND qp1.brand_id = qp2.brand_id
  AND qp1.scored_at < qp2.scored_at;
--> statement-breakpoint

-- quote_priorities: PK swap (campaign -> brand). Idempotent. -----------

DO $$
DECLARE
  pk_name text;
  pk_def  text;
BEGIN
  SELECT con.conname, pg_get_constraintdef(con.oid)
    INTO pk_name, pk_def
  FROM pg_constraint con
  WHERE con.conrelid = '"quote_priorities"'::regclass
    AND con.contype  = 'p';

  IF pk_name IS NOT NULL AND pk_def LIKE '%campaign_id%' AND pk_def NOT LIKE '%brand_id%' THEN
    EXECUTE format('ALTER TABLE "quote_priorities" DROP CONSTRAINT %I', pk_name);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con2
    WHERE con2.conrelid = '"quote_priorities"'::regclass
      AND con2.contype  = 'p'
  ) THEN
    ALTER TABLE "quote_priorities"
      ADD CONSTRAINT "quote_priorities_quote_request_id_brand_id_pk"
      PRIMARY KEY ("quote_request_id", "brand_id");
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE "quote_priorities" ALTER COLUMN "campaign_id" DROP NOT NULL;
--> statement-breakpoint

DROP INDEX IF EXISTS "idx_quote_priorities_campaign_score";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_quote_priorities_brand_score" ON "quote_priorities" USING btree ("brand_id", "score");
--> statement-breakpoint

-- quote_pitches: campaign_id nullable + broaden status filters ---------

ALTER TABLE "quote_pitches" ALTER COLUMN "campaign_id" DROP NOT NULL;
--> statement-breakpoint

DROP INDEX IF EXISTS "idx_quote_pitches_opportunity_brand";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_quote_pitches_opportunity_brand"
  ON "quote_pitches" USING btree ("quote_opportunity_id", "brand_id")
  WHERE "quote_opportunity_id" IS NOT NULL
    AND "status" NOT IN ('error', 'length_violation', 'template_missing', 'brand_missing_fields', 'insufficient_credits');
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "idx_quote_pitches_request_brand"
  ON "quote_pitches" USING btree ("quote_request_id", "brand_id")
  WHERE "quote_opportunity_id" IS NULL
    AND "status" NOT IN ('error', 'length_violation', 'template_missing', 'brand_missing_fields', 'insufficient_credits');
