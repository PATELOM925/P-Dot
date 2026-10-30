# P-Dot

P-Dot is a personal assistant that brings your email, calendar, tasks and the web into one chat, with separate Personal and Work modes. It does the legwork, but nothing happens until you approve it. It answers with NVIDIA Nemotron models on Nebius Token Factory, searches and researches the web with Tavily, knows your saved memories and documents, plans your day on the Today page, and reads Gmail, Calendar, Notion, Linear and Todoist when you connect them. Each task, reminder, memory or email is a card that you approve, edit or cancel.

**Live app:** https://pdot.iampatelom.com · **Demo video:** https://youtu.be/OhikQWepjOs · **License:** Apache 2.0 ([LICENSE](LICENSE))

**Status:** MVP, live in production since 2026-10-19. See [What works today](#what-works-today) and [Verification status](#verification-status). A global spend guard caps what all users together can spend ([Usage limits](#usage-limits)).

## Try it (for judges)

Open https://pdot.iampatelom.com. Sign in with the demo account `demo@pdot.iampatelom.com` and the password `Judge-Demo-2026`, or click **Try P-Dot now** to start with no account.

1. **Chat.** Ask "Plan a 3-day trip to Lisbon on a small budget". Under the reply, P-Dot shows the Nemotron model it used and why.
2. **Deep research.** Open the "+" menu, select **Deep research**, and ask "Compare the best e-bikes under $2,000". P-Dot searches the web, reads the top 3 pages and writes a brief with cited sources.
3. **Morning brief.** Open **Today**, check the topics and click **Make today's brief**. P-Dot searches today's news for each topic and saves the brief as a new chat.
4. **Your documents.** Open **Memory**, then **Documents**, and add a resume (PDF, Word or text). Go back to **Chat** and ask "What job roles should I apply to?". The reply uses the resume.
5. **Approval card.** Ask "Remind me to call the dentist tomorrow at 10 am". P-Dot shows a reminder card. Approve, edit or cancel it. The decision shows on **Activity**.
6. **What was sent.** Under any reply, open **What was sent**. It shows the model, the context size, the memories and documents used, web search use and tokens.
7. **Theme.** Use the theme button in the header (on a phone: **More**, then **Theme**) to switch between System, Light and Dark.

**Gmail and Calendar are already connected on the demo account.** It is linked to a demo inbox (`demo.pdot@gmail.com`) with sample emails and calendar events. Sign in as the demo account and ask "Check my latest emails and tell me what's on my calendar next week". Connecting your own Google account works only for test users, because the Google app is in testing mode. Please do not click Disconnect Google on the demo account: other judges use it too.

## What works today

**Chat**
- Streamed replies from 4 Nemotron tiers. A router picks the tier for each message ([Nemotron section](#how-p-dot-uses-nvidia-nemotron-through-nebius-token-factory)). "Think harder" always uses the heavy tier.
- Deep research: an advanced web search, the text of the top 3 pages and a cited brief.
- Web search with citation chips and a sources row.
- Rich answers: Markdown, place, table, checklist and step cards.
- "What was sent" under each reply.
- Conversation history with rename, delete, pin and model-written titles. Personal and Work modes. Dictation in browsers that support speech recognition.

**Personal context**
- Memories that you keep, edit, move between modes and delete.
- Documents: text, CSV, JSON, code, PDF, Word and images (PNG, JPEG, WebP, GIF). Video and audio files are refused. When your documents in a mode are small (12,000 characters or less in total), their full text goes into every turn. Larger sets are searched, and the best matches go in.
- When a message names a connected app (Notion, Linear, Todoist), P-Dot turns that app on for the message. When it asks about email or the calendar, P-Dot turns Google on. A message can turn on both, for example "Check my email and my Notion page". You can turn each one off before you send.
- In the "+" menu, tick any set of sources for one message: web search, Google and each connected app. Web search uses only your own words, before P-Dot reads Google or an app. Deep research turns Google and the apps off. The "+" menu also has Personal and Work, the same as the header switch.

**Actions**
- Approval cards for tasks, reminders, memories, emails and calendar events. Approve, edit then approve, or cancel. Each approved action runs once.
- Ask first or Auto approval mode.
- Activity (formerly Action log): approvals, cancellations, runs and changes, without their text.

**Today**
- Overview: a greeting, a quick ask, tiles, upcoming reminders and recent chats.
- Morning brief: news for up to 3 topics, made only when you click.
- To-do list for each mode.
- Workflows section: reminders (add, done, reopen, delete). P-Dot does not notify you when a reminder is due yet. Routines are marked "Coming soon".

**Connectors**
- Google: Gmail (search, propose emails) and Calendar (search, propose events), with one-click connect. Missing permissions are shown on the card.
- Notion, Linear and Todoist: read only, through their MCP servers.
- GitHub (off until the owner sets it up): read only, through GitHub's MCP server. Search issues, list open pull requests in a repository you name, and read a file from a link you paste.
- Telegram (off until the owner sets it up): link your own chat with a one-time code, then send a reply to it with **Send to Telegram**. Each message needs a press on Send on its card. The bot does not read or answer your messages.
- Open on your phone: a QR code of the site address on Connectors, with install steps. You sign in on the phone yourself.
- Coming soon: Vercel (Vercel must approve P-Dot as a client first), WhatsApp (needs Meta business setup and paid templates) and phone calls. See [decision 0020](docs/decisions/0020-connectors-v2.md).

**UI**
- Nav order: Chat, Today, Connectors, Memory, Activity, Settings. On a phone, Activity, Settings and Devices are under the **More** tab.
- Light, dark and system theme.
- Installable app (PWA) in Chrome on Android and desktop; on iPhone, add it to the Home Screen. No push messages are sent yet.
- Device pairing on the Devices page is a preview.

## Architecture

```mermaid
flowchart LR
  B[Browser or installed app] -->|HTTPS, NDJSON stream| W[Cloudflare Worker<br/>Next.js with OpenNext]
  W -->|session, RLS| S[(Supabase<br/>Auth, Postgres with RLS, pgvector)]
  W -->|chat, vision, embeddings| N[Nebius Token Factory<br/>Nemotron, Qwen3 embeddings]
  W -->|search, extract| T[Tavily]
  W -->|OAuth, REST| G[Google<br/>Gmail, Calendar]
  W -->|MCP| M[Notion, Linear, Todoist]
```

- One Next.js app runs on one Cloudflare Worker. Pages and API routes share it. Provider keys are Worker secrets and never reach the browser.
- Supabase holds accounts and all data. Row-level security scopes every row to its user. The app uses only the publishable key with the user's session.
- Memories and document chunks are embedded with `Qwen/Qwen3-Embedding-8B` on Token Factory and stored in pgvector.
- Web text, page text, document text and model output are untrusted. They go to the model inside delimited blocks, never as system instructions.
- A global spend guard in Postgres holds the worst-case cost before each Nebius or Tavily call and settles the real cost after it ([decision 0006](docs/decisions/0006-global-spend-guard.md)).
- Actions with an outside effect run only after an approval. Only the database writes the action log.

## Hackathon: Nebius x NVIDIA

P-Dot is entered in the Nebius x NVIDIA Global AI Hackathon, **Personal AI Track**, and for **Best Use of Tavily**. The project started on 2026-10-09, inside the submission period.

### How P-Dot uses NVIDIA Nemotron through Nebius Token Factory

Every chat reply is a runtime call to the Token Factory chat completions API (`https://api.tokenfactory.nebius.com/v1`, OpenAI-compatible, streamed). A router picks a model tier for each message without a model call ([`src/server/assistant/router.ts`](src/server/assistant/router.ts)). Each tier tries its models in order ([`src/server/assistant/tiers.ts`](src/server/assistant/tiers.ts), [decision 0007](docs/decisions/0007-model-routing.md)).

| Tier | Models, in order | Used for | Reasoning | Max output tokens |
| --- | --- | --- | --- | --- |
| fast | `nvidia/Nemotron-3_5-Lightning`, `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B`, `nvidia/nemotron-3-super-120b-a12b` | Everyday messages | Off | 1,024 |
| standard | `nvidia/nemotron-3-super-120b-a12b`, `nvidia/Nemotron-3_5-Lightning` | One reasoning signal (planning, analysis, math, code), long messages, long conversations, web search, deep research, the morning brief, tool calls and every turn with documents | Off | 2,048 |
| heavy | `nvidia/Nemotron-3-Ultra-550b-a55b`, `nvidia/nemotron-3-super-120b-a12b` | Multi-step requests, one reasoning signal in a long message, and "Think harder" | On, 1,024-token budget | 4,096 |
| vision | `nvidia/Nemotron-3.5-Super-VL` | Reads each uploaded image once: the exact text in it, then a short description, which is saved as the document text ([decision 0019](docs/decisions/0019-document-types.md)) | Off | 4,096 for an image read |

The executor ([`src/server/assistant/executor.ts`](src/server/assistant/executor.ts)) adds retries with backoff, a move to the next model on 404, a first-token timeout per tier, one deadline per reply, a hedge on the fast tier after 1.5 s, and a circuit breaker. It never switches models after the first visible token. Under each reply, the chat shows the model and the reason (for example "Nemotron 3 Super · multi-step request").

Embeddings for memories and documents use `Qwen/Qwen3-Embedding-8B` on the same Token Factory key (1,024 dimensions), stored in Supabase with pgvector.

Tool calls ([decision 0013](docs/decisions/0013-ai-tools-and-scope.md)): a tool-calling loop runs on the standard tier or above. It runs at most 2 tool steps and a final answer step, and holds spend for each step. Tools: `web_search`, `search_documents`, `search_memories`, the Gmail and Calendar tools, the read tools of the connected apps, and `propose_task`, `propose_reminder` and `save_memory`, which become approval cards. Nemotron also writes the chat titles. The own-data tools are offered only when the message asks for them, so everyday messages stay on the fast tier.

### Where Token Factory sped up the work

- **One OpenAI-compatible API.** The chat adapter is plain `fetch` with no SDK ([`src/server/providers/nebius/client.ts`](src/server/providers/nebius/client.ts)), so it runs on Cloudflare Workers as is.
- **One key for the whole family.** Five Nemotron models and an embedding model use the same key and base URL. A fallback chain is a list of model IDs in config, with no new code.
- **Public prices.** The model catalog with prices let us build the spend guard's price table ([`src/server/providers/nebius/pricing.ts`](src/server/providers/nebius/pricing.ts)) and refuse any model without a price.
- **Reasoning control per request.** `chat_template_kwargs.enable_thinking` and `thinking_token_budget` let each tier choose reasoning on or off without a different model.
- **Fast first tokens.** Measured through the executor on 2026-10-19 (small sample): 431 to 467 ms on Lightning, 502 to 530 ms on Super, 559 to 869 ms on Ultra with reasoning (a 200-token reasoning budget for the test).

### Other Nebius tools

P-Dot uses Nebius Token Factory only. It does not use Nebius AI Cloud, Serverless Endpoints or Serverless Jobs. The app runs on Cloudflare Workers, with Supabase for auth and Postgres.

### Tavily

P-Dot uses Tavily in three ways ([`src/server/providers/tavily/client.ts`](src/server/providers/tavily/client.ts), [decision 0018](docs/decisions/0018-tavily-research-and-brief.md)):

| Use | Start | Tavily calls | Credits held |
| --- | --- | --- | --- |
| Web search | "Search the web" in the "+" menu. Nemotron calls `web_search` as a tool and picks the query. | Search, basic depth, up to 5 results | 1 for each search |
| Deep research | "Deep research" in the "+" menu, for one message | Search, advanced depth, up to 8 results (news topic for recent events). Then Extract of the top 3 pages. Then Nemotron writes a cited brief: a short answer, key findings, where sources disagree, and limits. | 2 before the stream, then 1 just before the extract |
| Morning brief | "Make today's brief" on the Today page. Only a click starts it. | One news search for each topic (1 to 3), last day, 3 results each. Nemotron writes 5 cited bullets. | 1 for each topic |

- **Untrusted text.** Excerpts are cut to 1,200 characters and page text to 3,000 characters a page, at most 3 pages. Unsafe URLs are dropped. All of it goes to Nemotron inside one delimited `<web_search_results>` block marked as untrusted, and delimiter tags are removed from the text. The reply lists the sources with links.
- **Failures are told.** A failed or empty search, or a reached search budget, is shown to the user and told to the model, so it does not invent sources. A refused extract credit keeps the excerpts, and the reply goes on.
- **Caps.** Tavily credits have their own holds and caps in the spend guard: 40 credits each UTC day and 800 each month for all users, 10 each day for one user ([decision 0006](docs/decisions/0006-global-spend-guard.md)).

To run it yourself, see [Setup](#setup) and [Local development and testing (Docker)](#local-development-and-testing-docker).

## Team

- Om Patel ([@PATELOM925](https://github.com/PATELOM925))
- Awais Aziz
- Tirth

## Stack

- Next.js 16 (App Router, TypeScript) for pages and API routes, deployed to Cloudflare Workers with the OpenNext adapter ([decision 0004](docs/decisions/0004-cloudflare-workers-deployment.md))
- Supabase for authentication and Postgres (row-level security), see [decision 0001](docs/decisions/0001-supabase-auth-and-database.md)
- Nebius Token Factory (OpenAI-compatible) for inference, streamed to the browser as NDJSON, see [decision 0002](docs/decisions/0002-streaming-responses.md)
- Tavily for opt-in web search, deep research and the morning brief
- Zod for validation, Vitest for tests

## Setup

Requires Node.js 22.12 or newer.

1. **Install dependencies**

   ```bash
   npm install
   ```

2. **Create a Supabase project** and apply every migration in [`supabase/migrations/`](supabase/migrations/) in file name order with the Supabase CLI (`supabase link`, then `supabase db push`).

3. **Configure Supabase Auth** (Authentication → URL Configuration and Email Templates):
   - Site URL: your production URL (or `http://localhost:3000` for local work).
   - Redirect URLs: add `http://localhost:3000/**` and each deployed origin you use, e.g. `https://pdot.iampatelom.com/**`.
   - Recommended email links (they work even if the email is opened in a different browser):
     - Confirm signup: `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email&next=/chat`
     - Reset password: `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=recovery&next=/reset-password`

     The default `{{ .ConfirmationURL }}` templates also work, but only when the link is opened in the same browser that started the flow.

4. **Set environment variables**: copy `.env.example` to `.env.local` and fill it in. You need the Supabase URL and publishable key, a Nebius API key, and a Nebius chat model ID (list available models with `GET https://api.tokenfactory.nebius.com/v1/models`). `TAVILY_API_KEY` is optional. The three `GOOGLE_*` values are optional; see "One-time setup", item 7, in `docs/DEPLOYMENT.md`. Never use the Supabase secret/service-role key in this app.

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

# Needed only for chat replies; auth and history work without them.
# No keys yet? See "Try chat without API keys" below.
NEBIUS_API_KEY=<your Nebius key>
# Optional: the model chains for each tier have defaults (see .env.example).
TAVILY_API_KEY=
```

If the CLI prints an "anon key" instead of a publishable key, use that.

### Seed example data

`npm run seed:local` creates a demo account on your local Supabase and fills it with example data, so every screen has something to show: 8 tasks, 5 reminders, 6 memories (one waiting for approval) and 2 conversations, split across Personal and Work. Run it again any time to reset that account. It refuses to run against anything except this machine. The demo login (email and password) is at the top of [`scripts/seed-local.mjs`](scripts/seed-local.mjs); sign in at `http://localhost:3000/login`.

### Try chat without API keys (simulated Nebius and Tavily)

`npm run mock:providers` starts a small local server that stands in for Nebius Token Factory and Tavily on `http://127.0.0.1:4010`. It speaks the same wire formats the app parses (streamed chat completions with tool calls, embeddings, model list, Tavily search), so chat, streaming, web search with source chips, approval cards, memories and reminders all work end to end. **It is not a real model:** replies are rule-based and start with "Simulated reply", and its "web pages" are fake `example.com` pages. Use it to test the app, not the quality of answers.

In `.env.local`:

```env
NEBIUS_API_KEY=local-mock-key
NEBIUS_BASE_URL=http://127.0.0.1:4010/v1
TAVILY_API_KEY=local-mock-key
TAVILY_BASE_URL=http://127.0.0.1:4010/tavily
```

Then run the mock in one terminal and the app in another:

```bash
npm run mock:providers
npm run dev
```

Things the simulator reacts to: "Remind me to call the dentist tomorrow at 10 am" (a reminder card), "Remember that I prefer short answers" (a memory card), "Add a task to buy flowers" (a task card), the Search the web toggle (three simulated sources), and topics outside the current Work or Personal mode (a redirect message).

### Use the real Nebius and Tavily

Put your real keys in `.env.local`, remove `NEBIUS_BASE_URL` (the default is `https://api.tokenfactory.nebius.com/v1`) and leave `TAVILY_BASE_URL` empty. `TAVILY_BASE_URL` only accepts https, or http to this machine, so a key cannot be sent in the clear to another host. Restart `npm run dev`, then check `http://localhost:3000/api/health`: `"inference": true` and `"webSearch": true` mean the keys are present (it does not call the providers). Send one message with and without "Search the web" to confirm real replies and sources. Chat costs money on a real key; the daily caps in `.env.example` apply.

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
| Microphone button, allow the browser prompt, speak | "Listening…" with the words being heard, then English text in the message box (Chrome/Edge/Safari; button is disabled elsewhere). Esc or the button stops; Send stops it too |
| **Today** Workflows section and **Connectors** page | Reminders work in the Workflows section on Today; routines are disabled previews. Connectors shows live counts for the built-in tools and Connect and Disconnect for Google, Notion, Linear and Todoist |
| Insert a row into `action_proposals` for your user (Studio → SQL Editor, `status = 'proposed'`, with a `conversation_id`), then open that conversation | An approval card appears under the reply of the latest turn before the row was made, and the Today tab shows the count. Approve, Edit then approve, and Cancel each change its status; approved tasks and reminders appear on Today; each decision appears on **Activity**; after a reload, decided ones show as short lines |
| Insert a row into `memories` with `status = 'proposed'`, `source = 'assistant'` and `source_message_id` set to a message in that conversation | A "Remember this?" card appears under that turn's reply. Keep moves it to Remembered on the Memory page; Don't keep deletes it |
| **Memory** → add, keep, edit, move to the other mode, delete | Persists after a reload. Without a Nebius key, adding or changing text says the embedding service is not configured |
| **Memory** → Documents → choose a text, PDF, Word or image file, check the title, Add | With a Nebius key it shows "Ready". Video and audio files and empty files are refused before anything is sent |
| **What was sent** under a reply | Model, conversation size, memories, documents, web search and tokens for that reply |
| **Settings** → App and notifications (Chrome on Android) | "Install P-Dot" opens the install dialog; "Allow notifications" asks for permission; the test notification appears |
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

`npm test` also runs the database gate (`tests/integration/sql-gate.test.ts`) without any setup. It applies every migration to an in-memory Postgres (PGlite with pgvector) that has stand-ins for the Supabase roles, `auth.uid()` and the Supabase default grants, then checks grants and RLS as `anon` and as two signed-in users, and reads stored rows through the app's own parsers. `tests/integration/frozen-migrations.test.ts` fails if a migration is not listed in `tests/integration/frozen-migrations.sha256` or no longer matches its hash. The pull request that adds a migration adds its hash. After merge, never edit the file: add a new migration.

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
| `npm run lint` | ESLint (Next.js core-web-vitals + TypeScript rules), then `scripts/check-changelog.mjs` on the Unreleased entries |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Vitest unit tests and the database gate (in-memory Postgres, no setup); the live RLS integration test is skipped unless configured |
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
| `GET /api/memories?mode=&status=`, `POST /api/memories`, `PATCH`/`DELETE /api/memories/:id` | Memories the user can see, edit and delete ([decision 0009](docs/decisions/0009-memory-documents-actions.md)) |
| `GET /api/documents?mode=`, `POST /api/documents`, `DELETE /api/documents/:id` | The text of documents (text, CSV, code, PDF, Word, images), split and embedded on upload ([decision 0019](docs/decisions/0019-document-types.md)) |
| `POST /api/documents/image-text` | Reads the text in one image and describes it with one vision call, under the chat quota and spend caps. Saves nothing |
| `GET /api/actions?status=`, `POST /api/actions/:id/decision` | Action proposals; `{ decision: "approve" \| "reject", payload? }` runs an approved action once |
| `GET /api/action-log` | The action log, written only by the database (IDs, kinds, modes, counts and flags only) |
| `GET /api/reminders?mode=`, `POST /api/reminders`, `PATCH`/`DELETE /api/reminders/:id` | Reminders (no delivery yet) |
| `GET /api/messages/:id/context` | "What was sent" for one assistant reply (404 when it has no record) |
| `GET /api/health` | Liveness and configured integrations (booleans only) |
| `GET /auth/confirm` | Landing page for email verification and password-recovery links |

## Structure

| Path | Contents |
| --- | --- |
| `src/app/` | Pages (landing, `(auth)`, `(workspace)`: today, chat, memory, connectors, activity, devices, settings; `/workflows` and `/action-log` redirect), API routes, `auth/confirm`, the web app manifest (`manifest.ts`) |
| `wrangler.jsonc`, `open-next.config.ts` | Cloudflare Worker and OpenNext adapter configuration |
| `src/proxy.ts` | Session refresh and page redirects (Next.js 16 "proxy", formerly middleware) |
| `src/features/` | Auth forms and server actions, chat workspace (rename, dictation, "What was sent"), to-do list, mode switch, approval cards and the action log (`actions/`), memory, documents, reminders, connectors status, the installable app (`pwa/`) |
| `src/components/` | Shared layout components and `ui/LocalTime` (dates in the viewer's time zone) |
| `public/` | Service worker (`sw.js`), offline page, app icons, `_headers` for static files |
| `src/server/` | Server-only code: config, auth session, Supabase repositories, assistant orchestration, Nebius/Tavily adapters, HTTP helpers |
| `src/lib/`, `src/types/` | Shared limits, validation schemas, URL safety helpers, API contracts |
| `supabase/migrations/` | Database schema, RLS policies, the quota function, the modes/rename/tasks migration, and the global spend guard |
| `tests/` | Unit tests (`unit/`), the database gate and the live Supabase RLS test (`integration/`), shared fakes (`support/`) |
| `docs/` | PRD, architecture, [deployment guide](docs/DEPLOYMENT.md), [provider reliability lessons](docs/PROVIDER-RELIABILITY.md), decision records |
| `CHANGELOG.md` | What changed, the problem, and how it was resolved, for each pull request |
| `scripts/` | `check-worker-env.mjs` and `worker-env-rules.mjs`: deploy guard against secrets in the Worker bundle. `check-changelog.mjs` and `changelog-rules.mjs`: changelog entry check |
| `src/app/icon.svg`, `favicon.ico`, `apple-icon.png` | Site icon ("P." on the indigo-to-violet accent); the app icons in `public/icons/` use the same mark |

## Deploying to Cloudflare

**Read [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).** It is the full guide for people and coding agents: the branch → pull request → preview → merge → production flow, where each setting and secret lives, previews, database changes, and what agents must not do.

Short version:

- Production: https://pdot.iampatelom.com, one Cloudflare Worker named `pdot` ([`wrangler.jsonc`](wrangler.jsonc), [`open-next.config.ts`](open-next.config.ts), [decision 0004](docs/decisions/0004-cloudflare-workers-deployment.md)).
- Every change goes through a pull request into `main` with an adversarial review. When the owner merges, Cloudflare Workers Builds deploys `main`. Each pull request branch gets a preview link. (Workers Builds must first be connected by the owner; until then only the owner deploys, with `npm run deploy`.)
- `npm run preview` runs the built Worker on your computer in the Workers runtime, with no Cloudflare account. Stop `npm run dev` first.
- `NEXT_PUBLIC_*` values are put into the bundle at build time. Provider keys are Worker secrets. The OpenNext build copies `.env.local` values into the Worker bundle, so `npm run deploy` and `npm run upload` stop if a name that is not on the allow list (for example a key or password) has a value there (`scripts/check-worker-env.mjs`).
- Build and deploy from macOS, Linux, WSL or Workers Builds. Native Windows is not supported by OpenNext.

## Verification status

Done and passing locally: lint, type-check, the unit tests (request validation, auth and ownership boundaries at the route level, rename, modes and tasks, provider error/timeout handling, prompt-injection delimiting, search-off/search-failure behavior, retry and persistence rules, spend guard holds, settles and refusals), production build, and the 10 row-level-security tests against a local Supabase database (including rename and tasks privacy, which need the `SUPABASE_TEST_*` variables described below).

Deployed and checked on 2026-10-19: `/api/health` (auth configured, inference not configured), `/`, `/login`, `/signup` return 200, `/chat` redirects to `/login` when signed out, and `POST /api/chat` without a session returns 401. No CPU-limit or runtime errors in the Worker logs.

Checked on 2026-10-30: `/api/health` reports auth, inference and web search configured.

Spend guard SQL (2026-10-19): the migration was run on an in-memory Postgres (PGlite) with stand-ins for the Supabase roles and `auth.uid()`. Checked: hold and settle, settle once, no settle by another user, no negative or above-hold settle, parameter bounds, day, total and per-user caps, no direct table access for `anon` or `authenticated`. Not checked there: many requests at the same time (row locks).

Real provider checks (2026-10-19): 4 small Nebius calls to `nvidia/nemotron-3-super-120b-a12b` (`max_tokens` at most 300) and the free Tavily usage endpoint. No Tavily search was made. For model routing, about 28 more small calls (`max_tokens` at most 400, under $0.01 in total): the reasoning budget (`thinking_token_budget`) on Super, Ultra and Nano, each tier through the executor, and a 404 for an unknown model ID that moved to the next model. Numbers are in [decision 0007](docs/decisions/0007-model-routing.md).

Model routing was tested with a fake streaming provider and fake timers: router examples, retries with `Retry-After`, no retry on 400 and 401, 404 to the next model, first-token timeout, the hedge (winner, loser stopped and settled, at most one, never on heavy), the breaker, the deadline, budget refusal, Stop during a hedge, no switch after the first token, and the saved route. The new migration was run on an in-memory Postgres (PGlite) on top of existing rows.

Signed-in walkthrough of the hub screens (2026-10-19, local): in the Claude desktop app's built-in browser (Chromium) against `npm run dev` and a local Supabase with every migration, with a new test account and fixture rows inserted with SQL for what the app cannot create yet (proposals, and a saved reply with its context record). Checked: chat shows only that conversation's approval cards; Approve, Edit then approve (title and due time) and Cancel; a failed run (approving a memory without a Nebius key) shows one clear error; Today's approvals panel, its other-mode hint and the to-do list refreshing after an approval; "What was sent" for a reply with a record, an old reply without one, and a new reply whose record arrives a moment later ("Check again"); memory keep, move and delete, and the "not configured" messages for adding and editing text; the document list, delete, file checks (a PDF and an empty file refused, a `.md` without a MIME type accepted) and the upload error; the action log; reminders (add, done, overdue flag); Connectors counts; the manifest, service worker and offline page; the install button with a stand-in install event; phone width (375 px, no sideways scrolling) and dark mode. The database rows matched each action. Then, for suggestions in chat: cards under the right reply in a two-turn conversation (including one made before its reply was saved), earlier decisions as short lines, "Remember this?" keep, edit (the "not configured" message) and don't keep, and the Today count after decisions in chat and on Today, after a conversation switch and when the tab comes back into view. Dictation: the pages now send `microphone=(self)` and the browser reports the microphone as allowed; a blocked microphone shows the right message; with a stand-in recognizer, the words being heard show while speaking, finished phrases land in the message box within the length limit, Esc stops, Send and switching conversations stop it and drop any later words, and Android listens one phrase per tap. Real speech was not tried (the built-in browser blocks microphone capture). Not checked: a reply from a real model, a successful document upload or memory save (both need the Nebius key), installing on a real Android phone, and granting notification permission.

Checked on 2026-10-30: a signed-in chat through the live app (demo account) returned a real Nemotron reply, run by the owner's local check script, which is not in this repo. A real-user browser test on 2026-10-30 ran several real Tavily web searches through the live app. Not yet done: a full browser walkthrough of every page in production, dictation in real browsers, end-to-end tests, and production Supabase email setup. See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) → One-time setup. After pulling these changes, apply the new migration with `npm run db:start` (new stack) or `npx supabase migration up` (running stack). Provisional limits and behaviors that need review are listed in [decision 0003](docs/decisions/0003-provisional-defaults.md).

## Usage limits

Two kinds of limit protect the owner's paid credit:

- **Per user:** 30 chat requests each hour (`CHAT_REQUESTS_PER_WINDOW`, `CHAT_WINDOW_SECONDS`).
- **All users together (global spend guard):** Nebius $10.00 each UTC day and $25.00 in total (set for the hackathon judging period, inside the free Nebius credits); Tavily 40 credits each UTC day and 800 each month. One user can use at most $0.50 of Nebius and 10 Tavily credits each day. The settings are `NEBIUS_DAILY_CAP_USD`, `NEBIUS_TOTAL_CAP_USD`, `NEBIUS_USER_DAILY_CAP_USD`, `TAVILY_DAILY_CREDITS`, `TAVILY_MONTHLY_CREDITS` and `TAVILY_USER_DAILY_CREDITS`. When the Nebius budget is used up, chat says "P-Dot has reached its daily usage limit. Try again tomorrow." When only the Tavily budget is used up, replies come without web search and say so. Details, and how to change or reset the caps: [decision 0006](docs/decisions/0006-global-spend-guard.md).
