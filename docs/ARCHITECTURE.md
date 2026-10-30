# Architecture

Status: Implemented for the MVP and unit-tested with mocked providers; not yet verified against live Supabase, Nebius, or Tavily (see `README.md`).

## System boundaries

```text
Browser: Next.js pages and UI, installable as an app
   |-- service worker (public/sw.js): offline page and notifications only;
   |   never caches pages or API responses (decision 0010)
   |
   | authenticated same-origin requests
   v
Cloudflare Worker (OpenNext): Next.js API routes
   |-- src/proxy.ts: session cookie refresh, page redirects
   |-- authentication and ownership checks (Supabase Auth, getClaims)
   |-- assistant orchestration (src/server/assistant)
   |     |-- router: picks a model tier (no model call)
   |     |-- executor: retries, fallbacks, hedge, breaker
   |     |-- tool loop: up to 2 tool hops, then a final pass with tools off
   |     |-- Nebius Token Factory: streamed model inference
   |     `-- Tavily: optional web retrieval
   `-- persistence (src/server/db) -> Supabase Postgres with row-level security
```

A single Next.js application. Its API routes form the backend, deployed as one Cloudflare Worker through the OpenNext adapter ([decision 0004](decisions/0004-cloudflare-workers-deployment.md)); there is no separate always-on API server. Sessions are Supabase Auth cookies managed by `@supabase/ssr`. The app uses only the publishable key, so every database query runs under RLS as the signed-in user ([decision 0001](decisions/0001-supabase-auth-and-database.md)). A trial user is a Supabase anonymous user that the browser creates. The server reads `is_anonymous` from the verified token and refuses a trial on routes with `requireAccount` ([decision 0015](decisions/0015-judge-demo-mode.md)).

## Intended directory structure

```text
src/
  proxy.ts                 session refresh + redirects (Next.js 16 "proxy")
  app/
    page.tsx, layout.tsx   landing page, root layout, globals.css
    manifest.ts            web app manifest (/manifest.webmanifest)
    (auth)/                login, signup, forgot-password, reset-password
    (workspace)/           today, chat, memory, workflows, connectors, action-log,
                           devices, settings (server-side auth guard in layout)
    auth/confirm/          email verification and recovery link handler
    auth/callback/         Google sign-in return (Supabase PKCE code exchange)
    api/
      chat/                POST: streamed assistant reply (NDJSON)
      conversations/       GET list; [id]/ GET detail, PATCH rename, DELETE
      tasks/               to-do items per mode
      memories/, documents/, actions/, action-log/, reminders/,
      messages/[id]/context/   decision 0009
      health/              GET liveness + configured integrations
      connectors/google/   connect, callback, disconnect (decision 0014)
  components/layout/       workspace header, navigation, mode switch
  components/ui/           LocalTime (dates in the viewer's time zone)
  features/
    auth/                  server actions, form component
    chat/                  workspace UI, API client, NDJSON reader, "What was sent",
                           placing suggestions under the reply they came from
    actions/               approval cards, action log list, display helpers
    memory/, documents/    the Memory page (memories, documents)
    reminders/, today/     reminders panel, to-do list
    connectors/            live status lines for the built-in tools, the Google card
    pwa/                   service worker registration, install prompt, notifications
  server/                  server-only modules
    config.ts              env validation (lazy; build needs no secrets)
    log.ts                 metadata-only structured logs
    auth/                  getClaims-based session, proxy helper
    assistant/             context budget, prompt assembly, orchestration,
                           model router, tiers, executor, circuit breaker
      tools/               the tool registry and one file for each tool
    providers/             model.ts (provider interface), nebius/ (SSE streaming),
                           tavily/, shared errors/timeouts
    google/                Google OAuth, AES-GCM token sealing, token store, Gmail and
                           Calendar calls with plain fetch (decision 0014)
    db/                    Supabase client, conversation repository, quota gate, spend guard
    http/                  body limits, origin check, error responses, NDJSON
  lib/                     limits, zod schemas, URL safety, Supabase public config
  types/                   API contracts shared with the browser
public/                    sw.js, offline.html, icons/, _headers (static file caching)
supabase/migrations/       schema, RLS policies, quota function
tests/
  unit/                    validation, providers, assistant, API routes
  integration/             database gate on in-memory Postgres (runs in npm test),
                           live RLS test (skipped unless configured)
  support/                 in-memory fakes and stream helpers
docs/decisions/            accepted and proposed decisions
```

Parenthesized folders are Next.js route groups and do not appear in URLs. `src/features/settings/` and `tests/e2e/` are still empty placeholders.

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
- `messages`: ID, conversation, owner, role (`user`/`assistant`), content, web-search outcome (`off`/`used`/`no_results`/`failed`), source references (`[{title, url}]`), created time, and for assistant replies the model, tier, route reason and fallback flag (nullable; `NULL` for replies saved before model routing, [decision 0007](decisions/0007-model-routing.md)). Only completed assistant replies are stored, so there is no per-message completion status; an unanswered trailing user message is what the UI offers to retry. A reply stores `reply_to`, its user message (unique: one reply for each message). A user message stores the request key and fingerprint of the send that made it, and the claim of the request that writes its reply, with a 300-second lease ([decision 0012](decisions/0012-resend-idempotency.md)). `conversations`, `memories` and `documents` also store the request key and fingerprint. All are `NULL` on older rows.
- `usage_windows`: per-user request count per fixed window, written only by `consume_chat_quota()`.
- `connected_accounts`: one row for each user and provider (Google today): the account's stable ID and address, the granted scopes, the refresh token sealed with AES-GCM under a Worker key, and a status. Owner-only RLS ([decision 0014](decisions/0014-google-sign-in-and-connection.md)).
- `spend_counters` and `spend_reservations`: global spend for Nebius (micro-dollars) and Tavily (credits) per UTC day, month and all time, plus one row per held call. No user content. Users cannot read or write them; only `reserve_provider_spend()` and `settle_provider_spend()` do ([decision 0006](decisions/0006-global-spend-guard.md)).

RLS allows each user to select and insert only their own rows and to delete only their own conversations (messages cascade). Updates are revoked. Repository methods also filter by the session user ID. Each chat request holds a worst-case Nebius cost (and one Tavily credit when search is on) before the paid call, and settles the real cost from the token usage after it. A hold above $0.25 is refused, never reduced; `src/server/assistant/spend.ts` computes every hold. Global caps refuse a request with `budget_exhausted` before streaming ([decision 0006](decisions/0006-global-spend-guard.md)).

## Provider contracts

Nebius exposes an OpenAI-compatible API. The adapter calls `POST {NEBIUS_BASE_URL}/chat/completions` with `stream: true`, `stream_options.include_usage` (token usage for the spend guard) and `chat_template_kwargs.enable_thinking` (off, or on with `thinking_token_budget` for the heavy tier), and parses server-sent events, including errors sent mid-stream. Reasoning fields and a leading `<think>` block are never shown or saved. The base URL and the model chains are configuration.

Model routing ([decision 0007](decisions/0007-model-routing.md)): a rule-based router picks a tier (`fast`, `standard`, `heavy` or `vision`) from the message, the conversation size, web search and the user's effort choice. The executor runs the tier's model chain through a provider interface (`src/server/providers/model.ts`). It retries and falls back only before the first visible token, uses one deadline for all attempts, hedges slow fast-tier calls once, and skips a failing model with a soft breaker in isolate memory (best effort, not shared). Each attempt holds and settles spend through the spend guard. Tavily `POST /search` is called with `basic` depth and at most five results, and only http(s) URLs are kept. Responses are validated with Zod, context is bounded, and both adapters have timeouts. Retrieved text goes in the final user turn inside `<web_search_results>` delimiters and is described to the model as untrusted data.

## Tools

Decision [0013](decisions/0013-ai-tools-and-scope.md). The assistant can call tools through the `ModelProvider` interface. The Nebius adapter sends `tools` and `tool_choice: "auto"` and joins streamed `delta.tool_calls` into whole calls. `runChatTurn` runs at most 2 tool hops, then one final pass with tools off. Each attempt of each hop holds and settles spend through the same `AttemptBudget` as a reply without tools, and all hops share the tier's deadline. A refused hold stops the turn with `budget_exhausted`.

`src/server/assistant/tools/` is the one place that defines tools. Each tool is a `ToolSpec`:

| Field | Purpose |
| --- | --- |
| `name`, `description` | What the model sees. The name is also in `AssistantToolName` (`src/types/api.ts`). |
| `args` | A zod schema. The JSON schema for the model is made from it, and a call runs only after the arguments pass it. |
| `kind` | `read` (changes nothing) or `propose` (writes a proposal that waits for approval). |
| `guidance` | One line in the system prompt when the tool is offered. |
| `maxCallsPerTurn` | Later calls get a refusal as their result. |
| `offered(flags)` | Chooses the tool from request flags (`ToolFlags`), never from the model. `prepareChatTurn` sets the flags before the hold, so the hold prices the tools. |
| `statusQuery(args)` | What the `status` event shows besides the tool name. |
| `run(args, context)` | Does the work and returns the tool message for the model. |

Tools today:

- `web_search`: offered only when the user turned search on, at most once in a turn, one Tavily credit held for each run.
- `search_documents`, `search_memories`: read the user's own documents and kept memories of the current mode, at most 5 matches, through `match_document_chunks` and `match_memories`. The IDs go in the context record.
- `propose_task`, `propose_reminder`: write an `action_proposals` row that waits for approval.
- `save_memory`: writes a proposed memory from the assistant, linked to the user message.
- `notion_search`, `notion_fetch`, `linear_search_issues`, `linear_get_issue`, `todoist_list_tasks`, `todoist_find_tasks` ([decision 0016](decisions/0016-mcp-connectors.md)): read-only reads of the user's connected apps through `src/server/mcp/`, offered only for a message where the user turned on "Use <app>" and only for tools pinned at Connect. A search argument must be one phrase of the user's message; an ID must come from a typed field of this app's results in this turn or from the user's message. Results go to the model in `<untrusted_connector_data>` blocks, at most 12,000 characters for each turn. Such a turn has no `web_search`, and its reply has route reason `connector_read`, which stops the model-written `web_search` in that conversation for good, as a `google_request` reply does.

The own-data tools are offered only when `detectToolIntent` (`src/lib/tool-intent.ts`) finds a task, reminder, memory or own-data request in the message. A plain message gets no tools and stays on the fast tier.

Before each turn, the top 4 active memories of the mode go in the final user turn, in an untrusted `<saved_memories>` block. After the reply of a new conversation, a short fast-tier call makes its title (`title` event).

To add a tool, write a `ToolSpec`, add it to `TOOLS` in `tools/index.ts`, add its name to `AssistantToolName` and a status line in `src/features/chat/tool-status.ts`. A tool that a per-message toggle controls (for example "Use Google" for Gmail and Calendar tools, decision 0014) adds a flag to `ToolFlags`, a field to the chat request schema, and sets the flag in `prepareChatTurn`. A tool that changes anything is `propose` and writes an `action_proposals` row; a tool that reads private data outside P-Dot needs an approval step first (decision 0011, step 5).

The `status` event carries only the tool name and, for a search, the query. It is never saved. Tool results are untrusted data in `tool` messages, and they cannot authorize an action: only the user's approval runs one.

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
