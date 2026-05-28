-- v0.10.0 — migrate Featured ownership to expert-quotes-requests-service.
--
-- featured_profiles: dropped. EQRS now owns the per-(org, brand)
--   → featured_profile_id mapping. JQS no longer bootstraps or
--   resolves Featured profiles; EQRS does this inside
--   POST /orgs/featured/answers.
--
-- eqrs_sync_state: new per-org cursor state for the GET
--   /orgs/featured/opportunities pagination. `last_synced_at` is the
--   ISO timestamp we pass as `?since=...` on the next pull.

DROP TABLE IF EXISTS "featured_profiles" CASCADE;

CREATE TABLE IF NOT EXISTS "eqrs_sync_state" (
  "org_id" uuid PRIMARY KEY,
  "last_synced_at" timestamp with time zone,
  "last_cursor" text,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
