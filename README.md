# journalists-quotes-service

Backend service that matches journalist quote requests (HARO email digests + Featured.com Premium API) against brand context and dispatches expert-quote pitches.

Three workflows:

- **WF1 — Email inbound ingestion**: `email-gateway-service` HMAC-pushes inbound emails into `/webhooks/inbound-email`. `/internal/process-inbound-emails` (workflow-service cron) drains the bronze table, dispatches to the per-provider parser, writes silver `provider_quote_requests`, attaches to gold `quote_opportunities` via fingerprint clustering.
- **WF2 — Ranked queue**: `POST /orgs/opportunities/ranked` merges silver email rows (shared pool) with a live Featured `listOpportunities` fetch (write-through cache to silver), scores every candidate via chat-service RAG, returns the paginated list of those above `SCORE_THRESHOLD` annotated with the latest `pitchStatus` seen for the brand. `campaignId` is optional — when present, dedup + score cache scope to that campaign; when absent, scope is brand-wide (used by the public HITL report at `/report/{orgId}/{brandId}/pr-expert-quote-opportunities`).
- **WF3 — Submit reply**: `POST /orgs/opportunities/:id/reply` branches by provider — Featured → `FeaturedClient.submitAnswer`, email-source → `email-gateway-service /orgs/send` with the journalist's HARO reply alias. Pitch content is provided by the caller. Idempotency: brand-scoped when `campaignId` absent (any non-retryable pitch by ANY campaign of the brand returns `already_submitted`), campaign-scoped when present.
- **WF4 — Draft pitch (HITL)**: `POST /orgs/quote-requests/:id/draft` proxies content-generation-service `POST /generate-expert-quote-pitch`. Body is either brand-only `{ brandId }` — 5 PR inputs (`spokesperson`, `expertiseTopics`, `responseStyle`, `companyContext`, `valueProposition`) are resolved via brand-service `POST /internal/brands/extract-fields` — or legacy `{ brandId, campaignId, spokesperson, expertiseTopics, responseStyle, companyContext, valueProposition, additionalContext? }`. Returns the drafted text and token usage; caller decides when to submit via WF3.

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
| `CHAT_SERVICE_URL` / `CHAT_SERVICE_API_KEY` | RAG scoring (TODO: endpoint) |
| `CONTENT_GENERATION_SERVICE_URL` / `CONTENT_GENERATION_SERVICE_API_KEY` | WF4 HITL pitch draft generation via `POST /generate-expert-quote-pitch` |
| `EMAIL_GATEWAY_SERVICE_URL` / `EMAIL_GATEWAY_SERVICE_API_KEY` | WF3 email_reply dispatch via `POST /orgs/send` |
| `JQS_INBOUND_HMAC_SECRET` | Shared secret email-gateway uses to sign pushes into `/webhooks/inbound-email` (300s replay window, sha256) |
| `INBOUND_ALIAS_ROUTING` | JSON array `[{alias, provider}]` mapping recipient mailbox aliases to provider keys. Unknown aliases store with `provider=null` and `/internal/process-inbound-emails` marks them `skipped`. |

## Routes

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `GET` | `/health` | Public | Liveness |
| `GET` | `/openapi.json` | Public | OpenAPI 3 spec |
| `POST` | `/webhooks/inbound-email` | HMAC `x-eg-signature` | Receive Postmark inbound payload pushed by email-gateway. Idempotent on `MessageID`. |
| `POST` | `/internal/process-inbound-emails` | apiKey | Drain pending bronze emails, parse, write silver + gold cluster. |
| `POST` | `/orgs/opportunities/ranked` | apiKey + orgId | Ranked HITL queue for `{ brandId, campaignId?, limit?, offset? }`. Returns ALL candidates above `SCORE_THRESHOLD` with `pitchStatus` field — no exclusion. |
| `POST` | `/orgs/opportunities/:id/reply` | apiKey + orgId | Submit pitch reply for the opportunity. Body: `{ pitchContent, brandId, campaignId?, subject? }`. Idempotency: brand-scoped when `campaignId` absent, campaign-scoped when present. Block statuses: `drafted, submitted, selected, published, not_selected`. |
| `POST` | `/orgs/quote-requests/:id/draft` | apiKey + orgId | Generate an AI-drafted pitch via content-generation-service (no submit). Body: `{ brandId }` (brand-only — fields resolved via brand-service extract-fields) OR `{ brandId, campaignId, spokesperson, expertiseTopics, responseStyle, companyContext, valueProposition, additionalContext? }` (legacy). |
| `GET` | `/orgs/quote-requests` | apiKey + orgId | List silver rows (filter by `?provider=` / `?ingestion_channel=`). |
| `GET` | `/orgs/quote-requests/:id` | apiKey + orgId | Single silver row. |
| `GET` | `/orgs/quote-requests/stats` | apiKey + orgId | Aggregate counts. |
| `GET` | `/orgs/quote-pitches` | apiKey + orgId | List pitches. |
| `GET` | `/orgs/quote-pitches/:id` | apiKey + orgId | Single pitch. |

`POST /orgs/opportunities/ranked` returns:

- `200 { status: "ok", total, opportunities: [{ opportunityId, provider, ingestionChannel, featuredQuestionId, mediaOutlet, journalistName, opportunityText, deadline, pitchUrl, pitchEmail, category, score, whyRelevant, pitchStatus }] }`
- `502` if Featured `listOpportunities` or key-service fails (no silent fallback)

`pitchStatus` is the latest pitch status for the `(quote_request_id, brand_id)` pair across all campaigns of the brand (or scoped to `campaignId` when provided), or `null` if never pitched.

`POST /orgs/opportunities/:id/reply` returns one of:

- `200 { status: "submitted", pitchId, deliveryMethod, outboundMessageId? | featuredQuestionId? }`
- `200 { status: "already_submitted", pitchId, ... }` — idempotent replay
- `200 { status: "rate_limited", retryAfter }` — Featured rate limit
- `200 { status: "error", pitchId, error }` — Featured submitAnswer rejected (pitch row persisted with `status='error'`)
- `502 { status: "error", pitchId?, error }` — upstream `email-gateway-service` or Featured/key-service unavailable

## Data layering

| Layer | Table | Owner |
|-------|-------|-------|
| Bronze | `inbound_emails` | WF1 ingestion (raw Postmark payload, dedup on `message_id`) |
| Silver | `provider_quote_requests` | WF1 (from email parsers) + WF2 (Featured live-fetch write-through). Unique on `(provider, ingestion_channel, external_id)`. Email rows use the sentinel `SHARED_EMAIL_ORG_ID` org_id; Featured rows are per-org. |
| Gold | `quote_opportunities` | WF1 fingerprint clustering. Unique on `fingerprint`. |
| Pitch | `quote_pitches` | WF3. `delivery_method` ∈ `{featured_api, email_reply}`. `campaign_id` nullable (forensic). Two partial uniques: `(quote_opportunity_id, brand_id)` when clustered, `(quote_request_id, brand_id)` when non-clustered — both filter retryable statuses (`error, length_violation, template_missing, brand_missing_fields, insufficient_credits`). |
| Score cache | `quote_priorities` | WF2 RAG score persistence. PK `(quote_request_id, brand_id)`. `campaign_id` nullable. |

## Featured.com integration

- Auth: `POST /login` → JWT in JSON body field `"x-access-token"`. Cached for 24 h, refreshed on 401.
- All other calls use `x-access-token: <JWT>` header.
- Submit rate limit: token-bucket, 100 / sliding hour. WF3 returns `status="rate_limited"` with `retryAfter` seconds when exhausted.
- Answer length must be 100–2500 chars (FeaturedClient.submitAnswer throws if out of bounds — caller responsibility).
- `createProfile` (lazy, inside WF3 Featured path) uses multipart/form-data with brand logo bytes fetched from `brand.logoUrl` returned by brand-service `GET /internal/brands/{id}` (deterministic logo.dev URL, lazy-filled).

## Email-gateway integration

- WF1 inbound: `email-gateway-service` posts Postmark inbound payloads to `/webhooks/inbound-email` with `x-eg-signature: t=<unix_seconds>,v1=<hex sha256(t+"."+body, JQS_INBOUND_HMAC_SECRET)>`. 300s replay window.
- WF3 outbound: this service calls `email-gateway-service POST /orgs/send` (transactional type) for email_reply pitches. For HARO, the journalist's anonymized reply alias (`reply+<uuid>@helpareporter.com`) routes responses back automatically — RFC2822 `In-Reply-To` headers are not required.

## Run tracking

Every `/orgs/*` request creates its own child run via `runs-service`:

- Inbound `x-run-id` becomes `parentRunId`.
- Middleware calls `POST /v1/runs` and stores `req.runId`.
- Outbound calls to other services forward `x-run-id: <child run id>`.
- On response finish, middleware closes the run (`completed` if status < 400, `failed` otherwise).
- If `runs-service` is unavailable, the request fails with `502` — never silently continues.

## Stub fallbacks

These mark integration points blocked on parallel tasks:

- `chat-client.ragScore`: TODO(rag-endpoint) — falls back to recency-based scoring when chat-service `/orgs/rag/score` returns 404 or is unset.

Remove each fallback once the corresponding upstream lands.

## Out of scope

- Outcome tracking (`selected` / `published` / `not_selected` reconciliation, journalist reply classification, bounce handling) — handled by `replies-service` and shared outreach-tracking infra.
- Pitch content generation — handled by workflow-service via content-generation-service before calling `/orgs/opportunities/:id/reply`.
- Email-gateway-service inbound infrastructure (Postmark webhook receiver, outbox, fan-out worker) — separate repo `email-gateway-service-v1`.
- workflow-service DAG configuration — operator-managed.
- Postmark MX / DNS setup — operator-managed.

## Tests

```bash
pnpm test            # all
pnpm test:unit       # parsers, fingerprint, featured-client, alias-routing
pnpm test:integration # routes + flow
```

Integration tests require a local Postgres at `JOURNALISTS_QUOTES_SERVICE_DATABASE_URL` with the `drizzle/` migrations applied. CI provides this automatically.
