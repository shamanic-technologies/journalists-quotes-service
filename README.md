# journalists-quotes-service

Backend service that matches journalist quote requests (HARO email digests + Featured.com Premium API) against brand context and dispatches expert-quote pitches. Pure opportunity catalog + submit — pitch content is generated upstream by the DAG via `content-generation-service`.

Three workflows:

- **WF1 — Email inbound ingestion**: `email-gateway-service` HMAC-pushes inbound emails into `/webhooks/inbound-email`. `/internal/process-inbound-emails` (workflow-service cron) drains the bronze table, dispatches to the per-provider parser, writes silver `provider_quote_requests`, attaches to gold `quote_opportunities` via fingerprint clustering.
- **WF2 — Opportunity catalog**: `POST /orgs/opportunities/next` returns the single highest-scored Gold-cluster opportunity not yet pitched for the brand-set (parity with `lead-service /orgs/buffer/next`). The handler is **score-as-you-go**: ingest fresh Featured.com → silver (TTL 5min in-memory cache per org), pick at most 10 Gold clusters with NO row in `quote_priorities` for the exact brand-set tuple, score those 10 in a single multi-brand chat-service call, upsert into `quote_priorities`, then SELECT the best non-pitched. Opportunities already scored for the tuple are reused — never re-scored. **Brand identity flows via `x-brand-id` CSV header**, canonicalized server-side (deduplicated + sorted). All `(opportunity, brandSet)` is the keying unit.
- **WF3 — Submit reply**: `POST /orgs/opportunities/:id/reply` — `:id` = Gold cluster id. The service picks a silver "representative" row (Featured-API preferred, else most recently fetched email) and dispatches via `FeaturedClient.submitAnswer` or `email-gateway-service /orgs/send`. Pitch content is supplied by the caller (DAG). Idempotency: exact-match on `(quote_opportunity_id, sorted brand_ids[])` — co-brand `[A,B]` is distinct from solo `[A]`.

Pitch drafting is **not** in this service. The DAG calls `content-generation-service` (e.g. `POST /generate-expert-quote-pitch` or `POST /generate` with template of its choice) and forwards the result to `POST /orgs/opportunities/:id/reply`.

## Quick start

```bash
pnpm install
cp .env.example .env
# edit .env, then:
pnpm db:generate     # only if schema changed
pnpm db:push         # apply schema to local DB
pnpm dev
```

The server boots on `PORT` (default `3050`) and runs Drizzle migrations automatically before `app.listen`.

## Environment variables

| Var | Purpose |
|-----|---------|
| `JOURNALISTS_QUOTES_SERVICE_DATABASE_URL` | Postgres URL |
| `JOURNALISTS_QUOTES_SERVICE_API_KEY` | Inbound API key (`x-api-key` from sibling services / workflows) |
| `PORT` | Listen port (default `3050`) |
| `SENTRY_DSN` | Optional Sentry DSN |
| `SCORE_THRESHOLD` | Float, default `0.5` — minimum RAG score to consider an opportunity matchable |
| `FEATURED_API_BASE_URL` | Default `https://featured.com/api/external-users` |
| `RUNS_SERVICE_URL` / `RUNS_SERVICE_API_KEY` | Run tracking |
| `KEY_SERVICE_URL` / `KEY_SERVICE_API_KEY` | Featured creds resolution — reads two scalar platform keys (`featured-username`, `featured-password`) |
| `BRAND_SERVICE_URL` / `BRAND_SERVICE_API_KEY` | Brand metadata + logo (Featured profile bootstrap) |
| `CHAT_SERVICE_URL` / `CHAT_SERVICE_API_KEY` | RAG scoring — single multi-brand call per /next tick (`POST /orgs/rag/score` with body `{ documents, brandIds }`) |
| `EMAIL_GATEWAY_SERVICE_URL` / `EMAIL_GATEWAY_SERVICE_API_KEY` | WF3 email_reply dispatch via `POST /orgs/send` |
| `BILLING_SERVICE_URL` / `BILLING_SERVICE_API_KEY` | featured-api-pitch-submit credit gate |
| `JQS_INBOUND_HMAC_SECRET` | Shared secret email-gateway uses to sign pushes into `/webhooks/inbound-email` (300s replay window, sha256) |
| `INBOUND_ALIAS_ROUTING` | JSON array `[{alias, provider}]` mapping recipient mailbox aliases to provider keys. Unknown aliases store with `provider=null` and `/internal/process-inbound-emails` marks them `skipped`. |

## Routes

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `GET` | `/health` | Public | Liveness |
| `GET` | `/openapi.json` | Public | OpenAPI 3 spec |
| `POST` | `/webhooks/inbound-email` | HMAC `x-eg-signature` | Receive Postmark inbound payload pushed by email-gateway. Idempotent on `MessageID`. |
| `POST` | `/internal/process-inbound-emails` | apiKey | Drain pending bronze emails, parse, write silver + gold cluster. |
| `POST` | `/orgs/opportunities/next` | apiKey + orgId + x-brand-id | Single highest-scored Gold opportunity not yet pitched for the brand-set. Score-as-you-go: ingests fresh Featured, scores at most 10 unscored, returns best non-pitched. Body: `{ campaignId? }`. Returns `{ found: true, opportunity, brandIds }` or `{ found: false }`. |
| `POST` | `/orgs/opportunities/:id/reply` | apiKey + orgId + x-brand-id | Submit pitch reply. `:id` = `quote_opportunities.id` (Gold). Body: `{ pitchContent, campaignId?, subject? }`. Service picks silver representative (Featured > most recent email). Idempotency: exact-match on `(quote_opportunity_id, sorted brand_ids[])`. Block statuses: `drafted, submitted, selected, published, not_selected`. |
| `GET` | `/orgs/quote-requests` | apiKey + orgId | List silver rows. Filters: `?provider=`, `?ingestion_channel=`, `?campaign_id=` (returns rows pitched under that campaign). |
| `GET` | `/orgs/quote-requests/:id` | apiKey + orgId | Single silver row. |
| `GET` | `/orgs/quote-requests/stats` | apiKey + orgId | Aggregate counts. |
| `GET` | `/orgs/quote-pitches` | apiKey + orgId | List pitches. |
| `GET` | `/orgs/quote-pitches/:id` | apiKey + orgId | Single pitch. |

### Multi-brand convention

`x-brand-id` is a CSV header on every `/orgs/opportunities/*` route:

```
x-brand-id: <uuid>                       # single brand
x-brand-id: <uuid1>,<uuid2>,<uuid3>      # co-branded
```

Server-side: deduplicated + sorted into a canonical `brand_ids[]` array. Score cache, ranking, and pitch idempotency all key on this canonical set. Solo `[A]`, solo `[B]`, and co-brand `[A,B]` are three independent identity scopes.

### `POST /orgs/opportunities/next` response

```json
{ "found": true, "opportunity": { "opportunityId": "<gold-uuid>", "provider": "featured|haro|sos|qwoted", "ingestionChannel": "api|email", "featuredQuestionId": 12345, "mediaOutlet": "...", "journalistName": "...", "opportunityText": "...", "deadline": "...", "pitchUrl": "...", "pitchEmail": "...", "category": "...", "score": 0.87, "whyRelevant": "..." }, "brandIds": ["<sorted-uuid>", "..."] }
```

or `{ "found": false }` when the buffer is exhausted for this brand-set.

### `POST /orgs/opportunities/:id/reply` returns one of

- `200 { status: "submitted", pitchId, deliveryMethod, outboundMessageId? | featuredQuestionId? }`
- `200 { status: "already_submitted", pitchId, ... }` — idempotent replay on `(opportunity, brand-set)`
- `200 { status: "rate_limited", retryAfter }` — Featured rate limit
- `200 { status: "error", pitchId, error }` — Featured submitAnswer rejected (pitch row persisted with `status='error'`)
- `402 { error, balance_cents, required_cents }` — insufficient credit (platform-key Featured pitch only)
- `502 { status: "error", pitchId?, error }` — upstream `email-gateway-service` / Featured / key-service unavailable

## Data layering

| Layer | Table | Owner |
|-------|-------|-------|
| Bronze | `inbound_emails` | WF1 ingestion (raw Postmark payload, dedup on `message_id`) |
| Silver | `provider_quote_requests` | WF1 (from email parsers) + WF2 (Featured live-fetch write-through). Unique on `(provider, ingestion_channel, external_id)`. Email rows use the sentinel `SHARED_EMAIL_ORG_ID` org_id; Featured rows are per-org. Every silver row is clustered into Gold at insert time via fingerprint. |
| Gold | `quote_opportunities` | WF1 + WF2 fingerprint clustering. Unique on `fingerprint`. Externalized as `opportunityId` on every API response. |
| Pitch | `quote_pitches` | WF3. `brand_ids uuid[]` plural canonical-sorted. `delivery_method` ∈ `{featured_api, email_reply}`. `campaign_id` nullable (forensic). Partial unique `(quote_opportunity_id, brand_ids)` filters retryable statuses (`error, length_violation, template_missing, brand_missing_fields, insufficient_credits`). |
| Score cache | `quote_priorities` | WF2 RAG score persistence. PK `(quote_opportunity_id, brand_ids)`. `campaign_id` nullable. One score per `(Gold opportunity, brand-set)`. |

## Featured.com integration

- Auth: `POST /login` → JWT in JSON body field `"x-access-token"`. Cached for 24 h, refreshed on 401.
- All other calls use `x-access-token: <JWT>` header.
- Submit rate limit: token-bucket, 100 / sliding hour. WF3 returns `status="rate_limited"` with `retryAfter` seconds when exhausted.
- Answer length must be 100–2500 chars (`FeaturedClient.submitAnswer` throws if out of bounds — caller responsibility).
- `createProfile` (lazy, inside WF3 Featured path) uses multipart/form-data with brand logo bytes fetched from `brand.logoUrl` returned by brand-service `GET /internal/brands/{id}` (deterministic logo.dev URL, lazy-filled). **Co-brand pitch**: profile is created/looked up against the first brand in the canonical brand-set (lead spokesperson identity).

## Email-gateway integration

- WF1 inbound: `email-gateway-service` posts Postmark inbound payloads to `/webhooks/inbound-email` with `x-eg-signature: t=<unix_seconds>,v1=<hex sha256(t+"."+body, JQS_INBOUND_HMAC_SECRET)>`. 300s replay window.
- WF3 outbound: this service calls `email-gateway-service POST /orgs/send` (transactional type) for `email_reply` pitches. For HARO, the journalist's anonymized reply alias (`reply+<uuid>@helpareporter.com`) routes responses back automatically — RFC2822 `In-Reply-To` headers are not required.

## RAG scoring (chat-service)

Per-brand loop + mean aggregate: `chat-service /orgs/rag/score` is single-brand; this service calls it once per brand in the canonical set, then averages per-document scores. One `quote_priorities` row is persisted per `(opportunity, brand-set)`. Native multi-brand `rag/score` is a chat-service follow-up.

## Run tracking

Every `/orgs/*` request creates its own child run via `runs-service`:

- Inbound `x-run-id` becomes `parentRunId`.
- Middleware calls `POST /v1/runs` and stores `req.runId`.
- Outbound calls to other services forward `x-run-id: <child run id>`.
- On response finish, middleware closes the run (`completed` if status < 400, `failed` otherwise).
- If `runs-service` is unavailable, the request fails with `502` — never silently continues.

## Out of scope

- **Pitch content generation** — DAG calls `content-generation-service` directly with the template of its choice and forwards the result to `POST /orgs/opportunities/:id/reply`.
- Outcome tracking (`selected` / `published` / `not_selected` reconciliation, journalist reply classification, bounce handling) — handled by `replies-service` and shared outreach-tracking infra.
- Email-gateway-service inbound infrastructure (Postmark webhook receiver, outbox, fan-out worker) — separate repo.
- workflow-service DAG configuration — operator-managed.
- Postmark MX / DNS setup — operator-managed.

## Tests

```bash
pnpm test            # all
pnpm test:unit       # parsers, fingerprint, featured-client, alias-routing, brand-ids canon
pnpm test:integration # routes + flow + schema migration
```

Integration tests require a local Postgres at `JOURNALISTS_QUOTES_SERVICE_DATABASE_URL` with the `drizzle/` migrations applied. CI provides this automatically.
