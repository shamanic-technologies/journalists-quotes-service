# journalists-quotes-service

Backend service that automates expert-quote outreach via the [Featured.com Premium API](https://featured.com).

A workflow in `workflow-service` calls this service N times per campaign; each call is one full loop:

1. Sync questions/opportunities from Featured.
2. Score against brand context (chat-service `/orgs/rag/score`).
3. Pick the top-1 above the score threshold.
4. Generate a pitch (content-generation-service `expert-quote-pitch` template).
5. Submit the answer to Featured `/answer-question`.
6. Persist a `quote_pitches` row + return the result.

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
| `JOURNALISTS_QUOTES_SERVICE_API_KEY` | Inbound API key (clients send via `x-api-key`) |
| `PORT` | Listen port (default `3050`) |
| `SENTRY_DSN` | Optional Sentry DSN |
| `SCORE_THRESHOLD` | Float, default `0.5` — minimum score to pitch a request |
| `FEATURED_USERNAME` / `FEATURED_PASSWORD` | TODO(featured-key-provider) fallback creds |
| `FEATURED_API_BASE_URL` | Default `https://featured.com/api/external-users` |
| `RUNS_SERVICE_URL` / `RUNS_SERVICE_API_KEY` | Run tracking |
| `KEY_SERVICE_URL` / `KEY_SERVICE_API_KEY` | Featured creds resolution (TODO: provider) |
| `BRAND_SERVICE_URL` / `BRAND_SERVICE_API_KEY` | Brand context + logo |
| `CHAT_SERVICE_URL` / `CHAT_SERVICE_API_KEY` | RAG scoring (TODO: endpoint) |
| `CONTENT_GENERATION_SERVICE_URL` / `CONTENT_GENERATION_SERVICE_API_KEY` | Pitch generation (TODO: template) |

## Routes

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `GET` | `/health` | Public | Liveness |
| `GET` | `/openapi.json` | Public | OpenAPI 3 spec |
| `POST` | `/orgs/expert-quote-runs` | apiKey + orgId | Run one full loop for `{ campaignId, brandId }` |
| `GET` | `/orgs/quote-requests` | apiKey + orgId | List provider quote requests (filter by `?provider=` and `?ingestion_channel=`); response key `providerQuoteRequests` |
| `GET` | `/orgs/quote-requests/:id` | apiKey + orgId | Single provider quote request |
| `GET` | `/orgs/quote-requests/stats` | apiKey + orgId | Aggregate counts |
| `GET` | `/orgs/quote-pitches` | apiKey + orgId | List pitches |
| `GET` | `/orgs/quote-pitches/:id` | apiKey + orgId | Single pitch |
| `POST` | `/internal/sync-tracking` | apiKey | Reconcile selected/published/not-selected |

`POST /orgs/expert-quote-runs` returns one of:

- `{ status: "submitted", quoteRequestId, pitchId }`
- `{ status: "no_match" }`
- `{ status: "rate_limited", retryAfter }`
- `{ status: "error", error, pitchId, quoteRequestId }`

## Featured.com integration

- Auth: `POST /login` with `{ username, password }`. JWT comes back in the JSON body field `"x-access-token"` (NOT a header). Cached for 24 h, re-fetched on 401.
- All other calls use `x-access-token: <JWT>` header.
- Submit rate limit: token-bucket, 100 / sliding hour. `submitAnswer` throws `FeaturedRateLimitError` with `retryAfter` seconds when exhausted.
- Answer length must be 100–2500 chars.
- `createProfile` uses multipart/form-data with the brand logo bytes fetched from brand-service `media-assets`.

## Run tracking

Every `/orgs/*` request creates its own child run via `runs-service`:

- Inbound `x-run-id` becomes `parentRunId`.
- Middleware calls `POST /v1/runs` and stores `req.runId`.
- Outbound calls to other services forward `x-run-id: <child run id>` and the parent service stores both `parent_run_id` and `run_id` on `quote_pitches`.
- On response finish, middleware closes the run (`completed` if status < 400, `failed` otherwise).
- If `runs-service` is unavailable, the request fails with `502` — never silently continues.

## Stub fallbacks

These mark integration points blocked on parallel tasks:

- `key-service-client.getFeaturedCredentials`: TODO(featured-key-provider) — falls back to `FEATURED_USERNAME` / `FEATURED_PASSWORD` env vars when key-service returns 404 or is unset.
- `chat-client.ragScore`: TODO(rag-endpoint) — falls back to recency-based scoring when chat-service `/orgs/rag/score` returns 404 or is unset.
- `content-generation-client.generatePitch`: TODO(pitch-template) — falls back to a placeholder pitch when `expert-quote-pitch` template is missing.

Remove each fallback once the corresponding upstream lands.

## Multi-source schema (0001 migration)

Phase 1 introduces a 4-layer model so the service can ingest opportunities from email-only providers (HARO, Source of Sources, Qwoted email digest, SourceBottle, Help-a-B2B-Writer, ResponseSource, ProfNet) alongside the existing Featured.com Premium API:

| Layer | Table | Purpose |
|-------|-------|---------|
| Bronze | `inbound_emails` | raw Postmark inbound payloads, deduped on `message_id`, parsed asynchronously |
| Silver | `provider_quote_requests` | one row per provider ingestion (ex `quote_requests`); unique on `(provider, ingestion_channel, external_id)` |
| Gold | `quote_opportunities` | global cluster of duplicate provider rows = one journalist demand; unique on `fingerprint` |
| Pitch | `quote_pitches` | response we send; `delivery_method` = `featured_api` or `email_reply`; partial unique `(quote_opportunity_id, brand_id)` excluding `status='error'` |

Legacy rows are backfilled (`provider='featured'`, `ingestion_channel='api'`, `external_id=featured_question_id::text`, `delivery_method='featured_api'`). Cluster assignment, parsers, dispatcher modes, and the new endpoint split land in subsequent PRs.

## Out of scope (handled elsewhere)

- key-service `featured` provider registration
- chat-service `/orgs/rag/score` implementation
- chat-service `/orgs/rag/embed` (phase 1.5 fuzzy dedup, separate workspace)
- content-generation-service `expert-quote-pitch` template
- features-service `pr-expert-quote-outreach` registration
- workflow-service workflow definition
- distribute.you dashboard UI
- email-gateway-service inbound forwarding + threading fields (separate workspace)
- Postmark direct integration — proxied via email-gateway-service
- Cron / scheduling — workflow-service handles

## Tests

```bash
pnpm test            # all
pnpm test:unit       # featured-client + helpers
pnpm test:integration # routes + flow
```
