# journalists-quotes-service CLAUDE.md

Backend that ingests journalist quote requests (HARO emails + Featured.com Premium API), clusters them into Gold opportunities, and surfaces the next-best per brand-set tuple.

## Data layering (B/S/G)

| Layer | Table | Role |
|-------|-------|------|
| **Bronze** | `provider_quote_requests` | Raw silver-row of each source artifact. Append-only via `onConflictDoNothing(provider, ingestion_channel, external_id)`. `raw jsonb` captures the full upstream payload. |
| **Bronze** | `inbound_emails` | Raw Postmark webhook payload, `raw_payload jsonb`. Idempotent on `message_id`. Drained by `/internal/process-inbound-emails`. |
| **Silver** | `quote_opportunities` | Canonical Gold cluster keyed by `fingerprint(text, outlet)` — one row per de-duplicated opportunity. Built lazily by `attachOrCreateCluster` at ingestion time. The repo informally calls this the "Gold cluster" id because external IDs we return reference this table. Doctrinally still silver: it's the canonical entity, not a business projection. |
| **Gold** | `quote_priorities` | Scored projection. Natural key: `(quote_opportunity_id, brand_ids[])` — one row per `(opportunity, brandSet tuple)`. Materialized as a table (not a view) because scoring is expensive. Idempotent upsert. |
| **Gold** | `quote_pitches` | Submitted/drafted/error pitch record. Natural key: `(quote_opportunity_id, brand_ids[])` exact-match for the non-blocking statuses (partial unique index, see `schema.ts`). |

### Exhaustion-driven trigger (no cron, no time-based TTL)

`/orgs/opportunities/next` is the only refresh path. Each call:
1. `selectUnscoredBatch` — picks at most **10** Gold clusters with NO row in `quote_priorities` for the exact `brand_ids[]` tuple. Anti-join via `LEFT JOIN ... IS NULL`. Filters expired `canonical_deadline`. Ordered by `first_seen_at ASC` for determinism.
2. **If batch empty** → `ingestFeaturedToSilver`: pull new opportunities from **expert-quotes-requests-service** (EQRS) via `GET /orgs/featured/opportunities?since=<cursor>`, project into silver + Gold cluster, advance cursor in `eqrs_sync_state`. Idempotent on `external_id` natural key. EQRS owns Featured throttling internally so JQS can call every exhausted tick — when EQRS has nothing new, response is `items=[]` and the round-trip is sub-100ms.
3. `scoreUnscored` — **LLM relevance judge** (not RAG). Fetches the brand-set profile from `brand-service POST /orgs/brands/extract-fields` (cached 30d), then **one** `chat-service POST /complete` call (`google/flash`, temp 0.2, strict `responseSchema`) returning a **0-100** relevance score + reasoning per opportunity. Collective score for the brand-set tuple, stored one row per `(opportunity, brand_ids[])`. Score keying = tuple; serve/dedup keying = atomic per brand (see global "collective scoring, atomic exclusion").
4. `selectBestNonPitched` — SELECT MAX(score) above `SCORE_THRESHOLD` (default **30**, 0-100 scale), filtering `quote_pitches` blocking rows for the same tuple (campaign-scoped if `campaignId` provided). Tie-break: `first_seen_at ASC` (oldest cluster wins). Bands derived at read: ≥70 direct / ≥30 adjacent / <30 off-topic.

EQRS is pulled ONLY when the consumer has fully drained the silver pool for the brand-set tuple. Natural backpressure: high-throughput callers consume what landed in silver before triggering an upstream pull. No wall-clock TTL on JQS side — EQRS owns the per-org Featured.com refresh policy.

**Invariants:**
- Bronze immutable (no UPDATE; only INSERT … ON CONFLICT DO NOTHING).
- Silver/Gold rebuildable from bronze (`fingerprint` is deterministic; truncating `quote_priorities` → next `/next` re-scores).
- No score row keyed by `orgId` — `quote_priorities` is by `(opportunityId, brand_ids[])` tuple, shared across orgs that use the same brandSet. Org isolation enforced via silver-pool EXISTS check.

**Why no cron, no TTL:**
- Single Railway replica.
- Trigger frequency = campaign tick (~1/min per active campaign), bounded.
- Featured fetch (~500ms) absorbed into the /next budget only when the pool is exhausted; chat-service call (~1-2s for 10 docs × M brands) dominates anyway.
- Time-based TTL caps how fresh Featured opps can land in the catalog (5min stale-window). Exhaustion-driven trigger has zero stale-window — new opps surface on the next call after they're scored.

If we ever scale-out to multiple replicas, in-process state for "has this org been ingested yet" becomes per-replica and inconsistent. Mitigation: idempotent upsert means the worst case is N replicas each calling Featured `listOpportunities` once per pool-drain (multiplicative on Featured rate budget). At that point introduce a DB-backed lock (`SELECT … FOR UPDATE SKIP LOCKED` on a `featured_sync_state` row) so only one replica refetches per exhaustion event.

## Routes

- `POST /orgs/opportunities/next` — score-as-you-go write+read (above)
- `POST /orgs/opportunities/ranked` — **pure-read** paginated list. SELECT-only over `quote_priorities ⋈ quote_opportunities`, filters expired deadlines, annotates with latest `pitchStatus`. Never scores. Body: `{ campaignId?, limit?, offset? }`. Used by HITL dashboard.
- `GET /orgs/opportunities/stats` — brand-set scoped catalog metrics (silverPoolSize, scoredCount, eligibleCount, pitchedBlocking, expiredCount, bestEligibleScore). Pure read.
- `POST /orgs/opportunities/:id/reply` — submit pitch. `:id` = Gold cluster id. Idempotent on `(quote_opportunity_id, brand_ids[])`.
- `POST /webhooks/inbound-email` — HMAC-verified push from email-gateway-service (bronze ingest).
- `POST /internal/process-inbound-emails` — drains pending inbound_emails, runs per-provider parser, writes silver + Gold cluster.
- `GET /orgs/quote-requests`, `/orgs/quote-pitches` — list endpoints for HITL inspection.

## Multi-brand `x-brand-id` CSV

Every `/orgs/opportunities/*` route accepts `x-brand-id: <uuid>` (solo) or `<uuid1>,<uuid2>,...` (co-brand). Server canonicalizes (deduplicates + sorts) into `brand_ids[]`. Solo `[A]`, solo `[B]`, and co-brand `[A,B]` are three independent identity scopes for scoring + pitch idempotency.

## Cross-service callers

| Outbound | Why |
|----------|-----|
| `expert-quotes-requests-service` `GET /orgs/featured/opportunities` + `POST /orgs/featured/answers` | Featured.com integration. EQRS owns JWT + rate-limit + cursor + bronze raw payload + profile bootstrap. JQS pulls + submits via HTTP. |
| `chat-service` `POST /complete` | LLM relevance judge (google/flash). One call per /next tick → 0-100 score + reasoning. |
| `brand-service` `POST /orgs/brands/extract-fields` | Brand-set profile (industry/expertise/audience/topics) for the judge prompt. Cached 30d brand-side. |
| `brand-service` | Brand metadata (HARO email signature). |
| `email-gateway-service` `POST /orgs/send` | Outbound dispatch for `email_reply` delivery method. |
| `billing-service` | Credit gate for `featured-api-pitch-submit`. |
| `runs-service` | Run tracking (`withRunTracking` middleware). |

Featured.com is no longer a direct JQS dependency — EQRS owns it.

## Tests

- `pnpm test` runs unit + integration. Integration tests need a local Postgres reachable at `JOURNALISTS_QUOTES_SERVICE_DATABASE_URL` (DB schema applied via `pnpm drizzle-kit migrate` — see `tests/setup.ts` for the default URL).
- Mock Featured client lives in `tests/helpers/mock-featured.ts` (tracks `loginCalls` + `listOpportunitiesCalls` for assertion).
- Integration tests `vi.mock` `judge-client.js` (`judgeRelevance` → high/mid/low keyword scorer 85/50/15) + `brand-client.js` (`extractBrandContext` → stub text) to avoid live chat-service / brand-service calls.

## Future evolution

- If multiple replicas: per-org TTL state moves to DB.
- If the judge `/complete` call becomes a bottleneck under bursty /next traffic: per-org concurrency cap on `pickNextOpportunity` (one in-flight call per (orgId, brandIds) at a time).
- Served-status source of truth → EQRS (per global "collective scoring, atomic exclusion"). W1 uses local `quote_pitches` block; swap to an EQRS submitted-status query once EQRS ships the endpoint (DIS follow-up).
- If Featured publishes a cursor or `since=` parameter, replace `onConflictDoNothing` idempotency with explicit Featured-cursor state (saves O(catalog) work per tick).
