# Architecture

Status: Implemented for the MVP and unit-tested with mocked providers; not yet verified against live Supabase, Nebius, or Tavily (see `README.md`).

## System boundaries

```text
Browser: Next.js pages and UI
   |
   | authenticated same-origin requests
   v
Cloudflare Worker (OpenNext): Next.js API routes
   |-- src/proxy.ts: session cookie refresh, page redirects
   |-- authentication and ownership checks (Supabase Auth, getClaims)
   |-- assistant orchestration (src/server/assistant)
   |     |-- Nebius Token Factory: streamed model inference
   |     `-- Tavily: optional web retrieval
   `-- persistence (src/server/db) -> Supabase Postgres with row-level security
```

A single Next.js application. Its API routes form the backend, deployed as one Cloudflare Worker through the OpenNext adapter ([decision 0004](decisions/0004-cloudflare-workers-deployment.md)); there is no separate always-on API server. Sessions are Supabase Auth cookies managed by `@supabase/ssr`. The app uses only the publishable key, so every database query runs under RLS as the signed-in user ([decision 0001](decisions/0001-supabase-auth-and-database.md)).

## Intended directory structure

```text
src/
  proxy.ts                 session refresh + redirects (Next.js 16 "proxy")
  app/
    page.tsx, layout.tsx   landing page, root layout, globals.css
    (auth)/                login, signup, forgot-password, reset-password
    (workspace)/           chat, settings (server-side auth guard in layout)
    auth/confirm/          email verification and recovery link handler
    api/
      chat/                POST: streamed assistant reply (NDJSON)
      conversations/       GET list; [id]/ GET detail, DELETE
      health/              GET liveness + configured integrations
  components/layout/       workspace header
  features/
    auth/                  server actions, form component
    chat/                  workspace UI, API client, NDJSON reader
  server/                  server-only modules
    config.ts              env validation (lazy; build needs no secrets)
    log.ts                 metadata-only structured logs
    auth/                  getClaims-based session, proxy helper
    assistant/             context budget, prompt assembly, orchestration
    providers/             nebius/ (SSE streaming), tavily/, shared errors/timeouts
    db/                    Supabase client, conversation repository, quota gate, spend guard
    http/                  body limits, origin check, error responses, NDJSON
  lib/                     limits, zod schemas, URL safety, Supabase public config
  types/                   API contracts shared with the browser
supabase/migrations/       schema, RLS policies, quota function
tests/
  unit/                    validation, providers, assistant, API routes
  integration/             live RLS test (skipped unless configured)
  support/                 in-memory fakes and stream helpers
docs/decisions/            accepted and proposed decisions
```

Parenthesized folders are Next.js route groups and do not appear in URLs. `src/components/ui/`, `src/features/settings/`, and `tests/e2e/` are still empty placeholders.

## Responsibilities

- API routes: Validate requests, verify identity, invoke application services, and translate errors into public responses.
- Assistant service: Assemble bounded conversation context, optionally retrieve search results, call inference, and associate source references with the response.
- Provider adapters: Isolate provider-specific authentication, request/response mapping, and timeouts. Mark these modules server-only when implemented.
- Database adapter: Persist private records and apply ownership checks. Do not use local files or process memory (Workers isolates are ephemeral) for durable storage.
- Feature folders: Group product-specific presentation and client state. Shared UI primitives belong in `components/ui/`.

## Data model

Defined in `supabase/migrations/20261014000000_initial_schema.sql`:

- User: `auth.users`, managed by Supabase Auth.
- `conversations`: ID, owner, title, created/updated time. A trigger bumps `updated_at` when a message is added.
- `messages`: ID, conversation, owner, role (`user`/`assistant`), content, web-search outcome (`off`/`used`/`no_results`/`failed`), source references (`[{title, url}]`), created time. Only completed assistant replies are stored, so there is no per-message completion status; an unanswered trailing user message is what the UI offers to retry.
- `usage_windows`: per-user request count per fixed window, written only by `consume_chat_quota()`.
- `spend_counters` and `spend_reservations`: global spend for Nebius (micro-dollars) and Tavily (credits) per UTC day, month and all time, plus one row per held call. No user content. Users cannot read or write them; only `reserve_provider_spend()` and `settle_provider_spend()` do ([decision 0006](decisions/0006-global-spend-guard.md)).

RLS allows each user to select and insert only their own rows and to delete only their own conversations (messages cascade). Updates are revoked. Repository methods also filter by the session user ID. Each chat request holds a worst-case Nebius cost (and one Tavily credit when search is on) before the paid call, and settles the real cost from the token usage after it. Global caps refuse a request with `budget_exhausted` before streaming ([decision 0006](decisions/0006-global-spend-guard.md)).

## Provider contracts

Nebius exposes an OpenAI-compatible API. The adapter calls `POST {NEBIUS_BASE_URL}/chat/completions` with `stream: true`, `stream_options.include_usage` (token usage for the spend guard) and `chat_template_kwargs.enable_thinking: false` (no reasoning tokens), and parses server-sent events, including errors sent mid-stream. Reasoning fields and a leading `<think>` block are never shown or saved. The base URL and model ID are configuration. Tavily `POST /search` is called with `basic` depth and at most five results, and only http(s) URLs are kept. Responses are validated with Zod, context is bounded, and both adapters have timeouts. Retrieved text goes in the final user turn inside `<web_search_results>` delimiters and is described to the model as untrusted data. The assistant has no tools, so retrieved content cannot trigger actions.

Reference documentation:

- [Next.js installation and App Router](https://nextjs.org/docs/app/getting-started/installation)
- [OpenNext for Cloudflare](https://opennext.js.org/cloudflare)
- [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Nebius API reference](https://api.tokenfactory.nebius.com/docs)
- [Tavily search API](https://docs.tavily.com/documentation/api-reference/endpoint/search)

Recheck current provider documentation and dependency versions when implementation begins.

## Deployment plan

Deploy with `npm run deploy` (OpenNext build, then `wrangler deploy`) or Cloudflare Workers Builds. Keep preview and production credentials separate. `NEXT_PUBLIC_*` values are inlined at build time; keys are Worker secrets and other settings are Worker variables read at runtime. Configure authentication redirect URLs for each intended origin. Model inference runs on Nebius infrastructure, while Tavily supplies retrieval.

Deployment configuration is `wrangler.jsonc` and `open-next.config.ts` (no R2/KV cache: every route is rendered per request). Workers have no per-route `maxDuration`; the Nebius/Tavily timeouts in code bound each request, and the Worker CPU-time limit applies to compute, not to time spent waiting on providers. Production is live at https://pdot.iampatelom.com (first deployed 2026-10-19). Merges to `main` deploy through Cloudflare Workers Builds and pull request branches get previews, once the owner connects it; see [DEPLOYMENT.md](DEPLOYMENT.md).
