# P-Dot

A personal assistant with a web interface, a Cloudflare Workers backend, Nebius model inference, and optional Tavily web search.

**Status: MVP implementation in progress.** Working: accounts, a streaming chat with opt-in web search, conversation history with rename and delete, Personal and Work modes, a to-do list, and browser dictation. The Workflows and Connectors pages are previews only (nothing can be connected or automated yet). Unit tests use mocked providers; the database rules were tested against a local Supabase. A few small real Nebius calls checked the token usage and reasoning format (see [decision 0006](docs/decisions/0006-global-spend-guard.md)); a full chat through the live app has not been tested yet. The app is live at https://pdot.iampatelom.com (first deployed 2026-10-19); chat replies there say "not configured" until the Nebius key is set. A global spend guard caps what all users together can spend (see [Usage limits](#usage-limits)). See [What works today](#what-works-today) and [Verification status](#verification-status).

## What works today

| Area | Status |
| --- | --- |
| Sign up, sign in, email confirmation, password reset | Works (tested with local Supabase) |
| Chat with streamed replies, retry, stop | Works once Nebius is configured |
| Web search toggle (Tavily) from the "+" menu | Works once a Tavily key is set; off by default |
| Conversation list, **rename**, delete | Works |
| **Personal / Work mode** toggle | Works: each conversation and task belongs to one mode, lists are filtered by mode, and the assistant is instructed to stay within that mode's topics |
| **Today** page: to-do list per mode | Works (add, tick, delete) |
| **Microphone** button: speech to English text | Works in browsers with speech recognition (Chrome, Edge, Safari); dictates into the message box, you press send |
| Daily brief, approvals, **Workflows**, **Connectors** | Preview pages only. They show the planned design, say "not available yet", and run nothing |
| Landing page agent example | Illustrative example, not real data |

The design for all of this is in the "P-Dot Frontend Design" canvas; planned-but-unbuilt parts are tracked in [decision 0005](docs/decisions/0005-assistant-hub-proposal.md).

## Stack

- Next.js 16 (App Router, TypeScript) for pages and API routes, deployed to Cloudflare Workers with the OpenNext adapter ([decision 0004](docs/decisions/0004-cloudflare-workers-deployment.md))
- Supabase for authentication and Postgres (row-level security) — [decision 0001](docs/decisions/0001-supabase-auth-and-database.md)
- Nebius Token Factory (OpenAI-compatible) for inference, streamed to the browser as NDJSON — [decision 0002](docs/decisions/0002-streaming-responses.md)
- Tavily for opt-in web search
- Zod for validation, Vitest for tests

## Setup

Requires Node.js 22.12 or newer.

1. **Install dependencies**

   ```bash
   npm install
   ```

2. **Create a Supabase project** and apply the schema in [`supabase/migrations/20261014000000_initial_schema.sql`](supabase/migrations/20261014000000_initial_schema.sql), either by pasting it into the Supabase SQL editor or with the Supabase CLI (`supabase link`, then `supabase db push`).

3. **Configure Supabase Auth** (Authentication → URL Configuration and Email Templates):
   - Site URL: your production URL (or `http://localhost:3000` for local work).
   - Redirect URLs: add `http://localhost:3000/**` and each deployed origin you use, e.g. `https://pdot.iampatelom.com/**`.
   - Recommended email links (they work even if the email is opened in a different browser):
     - Confirm signup: `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email&next=/chat`
     - Reset password: `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=recovery&next=/reset-password`

     The default `{{ .ConfirmationURL }}` templates also work, but only when the link is opened in the same browser that started the flow.

4. **Set environment variables**: copy `.env.example` to `.env.local` and fill it in. You need the Supabase URL and publishable key, a Nebius API key, and a Nebius chat model ID (list available models with `GET https://api.tokenfactory.nebius.com/v1/models`). `TAVILY_API_KEY` is optional. Never use the Supabase secret/service-role key in this app.

5. **Run the app**

   ```bash
   npm run dev
   ```

   Open http://localhost:3000, create an account, confirm the email, and start a conversation. `GET /api/health` reports which integrations are configured (without checking that they are reachable).

## Local development and testing (Docker)

Run Supabase locally instead of using a hosted project. Requires Docker running. [`supabase/config.toml`](supabase/config.toml) is already configured for this app (site URL `http://localhost:3000`, redirect URLs, 8-character minimum password, email confirmations on, rate limit of 2 emails per hour).

### 1. Start Supabase

`supabase init` is already done: the config is committed in `supabase/`, so do not run it again (it refuses to overwrite `config.toml`).

```bash
npm install
npm run db:start
```

The first run downloads a few GB of images and applies the migration. It prints the API URL, a publishable key, Studio (`http://127.0.0.1:54323`, a database browser) and the fake inbox (`http://127.0.0.1:54324`). `npm run db:status` prints them again.

### Local services and links

| Service | URL | What it does |
| --- | --- | --- |
| P-Dot app | http://localhost:3000 | The Next.js app (`npm run dev`). Use `localhost`, not `127.0.0.1`, so cookies and email links share one host. |
| Health check | http://localhost:3000/api/health | Reports which integrations are configured (booleans only; does not call the providers). |
| Supabase API | http://127.0.0.1:54321 | The URL the app uses for Auth and database requests (`NEXT_PUBLIC_SUPABASE_URL`). |
| Supabase Studio | http://127.0.0.1:54323 | Admin web UI. **Authentication → Users** lists accounts (unconfirmed ones show as waiting for verification). **Table Editor** shows `conversations`, `messages` and `usage_windows`. **SQL Editor** runs queries. It shows every user's rows, because it is an admin view; the app itself only sees the signed-in user's data. |
| Mailpit (fake inbox) | http://127.0.0.1:54324 | Catches every email local Supabase would send: signup confirmation and password reset. **Nothing is sent to real addresses; look here instead of your real inbox.** |
| Postgres | `postgresql://postgres:postgres@127.0.0.1:54322/postgres` | Direct database connection for any Postgres client (local development only). |

Where is my confirmation email? After signing up, the app shows "Check your email for a confirmation link". Open Mailpit, open the "Confirm your signup" email and click the link. It returns to `/auth/confirm` and then `/chat`, signed in. Password-reset emails arrive in the same inbox. If nothing arrives, the address may already be registered (the app shows the same message either way), or the local limit of 2 emails per hour was reached (raise `email_sent` under `[auth.rate_limit]` in `supabase/config.toml`, then `npm run db:stop && npm run db:start`).

### 2. Configure `.env.local`

Create `.env.local` (git-ignored) in the project root:

```env
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<publishable key from db:start>
SITE_URL=http://localhost:3000

# Needed only for chat replies; auth and history work without them
NEBIUS_API_KEY=<your Nebius key>
# Optional: the model chains for each tier have defaults (see .env.example).
TAVILY_API_KEY=
```

If the CLI prints an "anon key" instead of a publishable key, use that.

### 3. Run the app

```bash
npm run dev
```

Open `http://localhost:3000` (not `127.0.0.1`, so cookies and email links share one host). Restart `npm run dev` after changing `.env.local`.

### 4. Manual test checklist

| Test | Expected result |
| --- | --- |
| `GET http://localhost:3000/api/health` | `"auth": true` (`"inference": true` once Nebius is set) |
| Sign up | "Check your email"; open the fake inbox, click the link, you land in `/chat` |
| Sign out, then open `/chat` | Redirected to `/login` |
| Sign in with a wrong password | "Incorrect email or password…" |
| Forgot password | Email in the fake inbox; the link opens `/reset-password`; after saving you are signed in |
| Send a message without Nebius settings | "This service is not configured yet." and nothing is saved |
| Send a message with Nebius settings | Reply streams in; the conversation appears in the sidebar |
| Studio → Table Editor | `conversations`, `messages`, `usage_windows`, `tasks` hold your rows |
| Click **Work** in the header, then start a chat | The sidebar shows only Work conversations; asking a personal question (dinner, gifts) gets a reply that it belongs in Personal mode |
| Hover a conversation: pencil, then Enter | Renamed in the sidebar; the new name is stored |
| **Today** → add a task, tick it, delete it | Persists after a reload; Work and Personal lists are separate |
| Microphone button, allow the browser prompt, speak | English text appears in the message box (Chrome/Edge/Safari; button is disabled elsewhere) |
| **Workflows** and **Connectors** pages | Show "not available yet"; Connect buttons are disabled |
| Second user in a private window | Sees none of the first user's conversations |
| Delete a conversation | Gone from the sidebar and from Studio |
| Exceed `CHAT_REQUESTS_PER_WINDOW` (set it to 2 to try) | 429 "You have reached your request limit" |
| Set `NEBIUS_DAILY_CAP_USD=0.01` and send two or three messages | 429 "P-Dot has reached its daily usage limit. Try again tomorrow." |
| Set `TAVILY_DAILY_CREDITS=1`, turn on search, send two messages | The second reply says web search was not used because of the search limit |

To skip email confirmation, set `enable_confirmations = false` under `[auth.email]` in `config.toml`, then `npm run db:stop && npm run db:start`. If reset emails stop arriving, raise `email_sent` under `[auth.rate_limit]`.

### 5. Automated checks

```bash
npm run check
```

runs lint, type-check, and unit tests. To also run the row-level security tests against the local database, create two confirmed users (Studio → Authentication → Add user, with "Auto Confirm User" checked) and set these variables in the same terminal before `npm test`:

```powershell
$env:SUPABASE_TEST_URL="http://127.0.0.1:54321"
$env:SUPABASE_TEST_PUBLISHABLE_KEY="<publishable key>"
$env:SUPABASE_TEST_USER_A_EMAIL="<user A email>"
$env:SUPABASE_TEST_USER_A_PASSWORD="<user A password>"
$env:SUPABASE_TEST_USER_B_EMAIL="<user B email>"
$env:SUPABASE_TEST_USER_B_PASSWORD="<user B password>"
npm test
```

The 10 tests in `tests/integration/rls.test.ts` should then run instead of being skipped. One checks the model route columns on messages. They also reserve and give back a few micro-dollars through the spend guard functions.

### Housekeeping

| Command | Effect |
| --- | --- |
| `npm run db:reset` | Wipe the local database and re-apply the migration |
| `npm run db:stop` | Stop the Docker containers |

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Development server on port 3000 |
| `npm run build` | Production build (does not need secrets) |
| `npm run db:start` / `db:status` / `db:reset` / `db:stop` | Manage the local Supabase stack (Docker) |
| `npm run preview` | Build for Cloudflare and run the Worker locally in the Workers runtime |
| `npm run deploy` | Owner only. Build for Cloudflare, check that no secret is in the bundle, and deploy (see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)) |
| `npm run upload` | Owner only. Same as deploy, but uploads a new version without sending traffic to it |
| `npm run check:worker-env` | Check the last OpenNext build for secret values copied from `.env` files |
| `npm run lint` | ESLint (Next.js core-web-vitals + TypeScript rules) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Vitest unit tests; the live RLS integration test is skipped unless configured |
| `npm run check` | Lint, type-check, and tests |

To run the row-level security test against a **test** Supabase project, set the `SUPABASE_TEST_*` variables listed at the top of [`tests/integration/rls.test.ts`](tests/integration/rls.test.ts).

## API

All private endpoints require the Supabase session cookie and scope data to the signed-in user. Errors use `{ "error": { "code", "message", "requestId" } }`.

| Method and path | Purpose |
| --- | --- |
| `POST /api/chat` | `{ action: "send", conversationId?, mode?, message, webSearch, effort? }` (`mode` applies to new conversations) or `{ action: "retry", conversationId, webSearch, effort? }`. `effort` is `"auto"` (default: the router picks a model tier) or `"deep"` (always the heavy tier). Streams `application/x-ndjson` events: `start` (with `route: { tier, reason }`), `search`, `delta`, `done` (its message has `route: { model, tier, reason, fallback }`), `error` (`budget_exhausted` if the spend guard refuses a fallback). Messages in `GET /api/conversations/:id` have the same `route` field, or `null` for user messages and older replies. Returns 401, 403, 404, 409, 413, 415, 429, or 503 before streaming when appropriate. A global spend cap returns `budget_exhausted` (429 for a daily cap, 503 for the total cap). |
| `GET /api/conversations[?mode=personal\|work]` | The user's conversations, most recent first, optionally for one mode |
| `PATCH /api/conversations/:id` | Rename: `{ title }` (404 for someone else's) |
| `GET /api/tasks?mode=` | The user's to-do items for a mode |
| `POST /api/tasks` | Add a task: `{ mode, title }` |
| `PATCH /api/tasks/:id` | Change `{ title?, done? }` |
| `DELETE /api/tasks/:id` | Delete a task |
| `GET /api/conversations/:id` | One conversation with its messages (404 for missing or someone else's) |
| `DELETE /api/conversations/:id` | Permanently delete a conversation and its messages |
| `GET /api/health` | Liveness and configured integrations (booleans only) |
| `GET /auth/confirm` | Landing page for email verification and password-recovery links |

## Structure

| Path | Contents |
| --- | --- |
| `src/app/` | Pages (landing, `(auth)`, `(workspace)`: today, chat, workflows, connectors, settings), API routes, `auth/confirm` |
| `wrangler.jsonc`, `open-next.config.ts` | Cloudflare Worker and OpenNext adapter configuration |
| `src/proxy.ts` | Session refresh and page redirects (Next.js 16 "proxy", formerly middleware) |
| `src/features/` | Auth forms and server actions, chat workspace (rename, dictation), to-do list, mode switch |
| `src/components/` | Shared layout components |
| `src/server/` | Server-only code: config, auth session, Supabase repositories, assistant orchestration, Nebius/Tavily adapters, HTTP helpers |
| `src/lib/`, `src/types/` | Shared limits, validation schemas, URL safety helpers, API contracts |
| `supabase/migrations/` | Database schema, RLS policies, the quota function, the modes/rename/tasks migration, and the global spend guard |
| `tests/` | Unit tests (`unit/`), live Supabase RLS test (`integration/`), shared fakes (`support/`) |
| `docs/` | PRD, architecture, [deployment guide](docs/DEPLOYMENT.md), [provider reliability lessons](docs/PROVIDER-RELIABILITY.md), decision records |
| `CHANGELOG.md` | What changed, the problem, and how it was resolved, for each pull request |
| `scripts/` | `check-worker-env.mjs` and `worker-env-rules.mjs`: deploy guard against secrets in the Worker bundle |
| `src/app/icon.svg`, `favicon.ico`, `apple-icon.png` | Site icon ("P." on the brand blue) |

## Deploying to Cloudflare

**Read [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).** It is the full guide for people and coding agents: the branch → pull request → preview → merge → production flow, where each setting and secret lives, previews, database changes, and what agents must not do.

Short version:

- Production: https://pdot.iampatelom.com, one Cloudflare Worker named `pdot` ([`wrangler.jsonc`](wrangler.jsonc), [`open-next.config.ts`](open-next.config.ts), [decision 0004](docs/decisions/0004-cloudflare-workers-deployment.md)).
- Every change goes through a pull request into `main` with an adversarial review. When the owner merges, Cloudflare Workers Builds deploys `main`. Each pull request branch gets a preview link. (Workers Builds must first be connected by the owner; until then only the owner deploys, with `npm run deploy`.)
- `npm run preview` runs the built Worker on your computer in the Workers runtime, with no Cloudflare account. Stop `npm run dev` first.
- `NEXT_PUBLIC_*` values are put into the bundle at build time. Provider keys are Worker secrets. The OpenNext build copies `.env.local` values into the Worker bundle, so `npm run deploy` and `npm run upload` stop if a name that is not on the allow list (for example a key or password) has a value there (`scripts/check-worker-env.mjs`).
- Build and deploy from macOS, Linux, WSL or Workers Builds. Native Windows is not supported by OpenNext.

## Verification status

Done and passing locally: lint, type-check, the unit tests (request validation, auth and ownership boundaries at the route level, rename, modes and tasks, provider error/timeout handling, prompt-injection delimiting, search-off/search-failure behavior, retry and persistence rules, spend guard holds, settles and refusals), production build, and the 6 row-level-security tests against a local Supabase database (including rename and tasks privacy, which need the `SUPABASE_TEST_*` variables described below).

Deployed and checked on 2026-10-19: `/api/health` (auth configured, inference not configured), `/`, `/login`, `/signup` return 200, `/chat` redirects to `/login` when signed out, and `POST /api/chat` without a session returns 401. No CPU-limit or runtime errors in the Worker logs.

Spend guard SQL (2026-10-19): the migration was run on an in-memory Postgres (PGlite) with stand-ins for the Supabase roles and `auth.uid()`. Checked: hold and settle, settle once, no settle by another user, no negative or above-hold settle, parameter bounds, day, total and per-user caps, no direct table access for `anon` or `authenticated`. Not checked there: many requests at the same time (row locks).

Real provider checks (2026-10-19): 4 small Nebius calls to `nvidia/nemotron-3-super-120b-a12b` (`max_tokens` at most 300) and the free Tavily usage endpoint. No Tavily search was made. For model routing, about 28 more small calls (`max_tokens` at most 400, under $0.01 in total): the reasoning budget (`thinking_token_budget`) on Super, Ultra and Nano, each tier through the executor, and a 404 for an unknown model ID that moved to the next model. Numbers are in [decision 0007](docs/decisions/0007-model-routing.md).

Model routing was tested with a fake streaming provider and fake timers: router examples, retries with `Retry-After`, no retry on 400 and 401, 404 to the next model, first-token timeout, the hedge (winner, loser stopped and settled, at most one, never on heavy), the breaker, the deadline, budget refusal, Stop during a hedge, no switch after the first token, and the saved route. The new migration was run on an in-memory Postgres (PGlite) on top of existing rows.

Not yet done: a real Tavily search, a full chat through the live app, a signed-in browser walkthrough (local or production), dictation in real browsers, end-to-end tests, Workers Builds (automatic deploys and previews), and production Supabase email setup. See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) → One-time setup. After pulling these changes, apply the new migration with `npm run db:start` (new stack) or `npx supabase migration up` (running stack). Provisional limits and behaviors that need review are listed in [decision 0003](docs/decisions/0003-provisional-defaults.md).

## Usage limits

Two kinds of limit protect the owner's paid credit:

- **Per user:** 30 chat requests each hour (`CHAT_REQUESTS_PER_WINDOW`, `CHAT_WINDOW_SECONDS`).
- **All users together (global spend guard):** Nebius $1.00 each UTC day and $20.00 in total; Tavily 40 credits each UTC day and 800 each month. One user can use at most $0.25 of Nebius and 10 Tavily credits each day. The settings are `NEBIUS_DAILY_CAP_USD`, `NEBIUS_TOTAL_CAP_USD`, `NEBIUS_USER_DAILY_CAP_USD`, `TAVILY_DAILY_CREDITS`, `TAVILY_MONTHLY_CREDITS` and `TAVILY_USER_DAILY_CREDITS`. When the Nebius budget is used up, chat says "P-Dot has reached its daily usage limit. Try again tomorrow." When only the Tavily budget is used up, replies come without web search and say so. Details, and how to change or reset the caps: [decision 0006](docs/decisions/0006-global-spend-guard.md).
