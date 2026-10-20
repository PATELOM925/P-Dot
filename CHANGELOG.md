# Changelog

All notable changes to P-Dot. Newest first. Each entry says what changed, the problem it solves, and how it was resolved, with the pull request and review links. Commit messages hold the line-level detail.

Every pull request adds its entry under **Unreleased**. When it merges, the entry moves under the merge date. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

Lessons about provider calls, retries, backups and spending are in [docs/PROVIDER-RELIABILITY.md](docs/PROVIDER-RELIABILITY.md).

## Unreleased

### Added
- **A database test gate that runs in `npm test`.** PR: not opened yet.
  - Problem: the same kind of database defect reached review three times. Grants let a signed-in user write rows the app trusts (`action_log` inserts, `action_proposals` updates that can reset an approved action, `context_records`). The database also accepted a nested `action_log` detail that the app's log reader refuses, so one row broke the whole list. Each time, a reviewer proved it by hand in a throwaway database.
  - Resolution:
    - `tests/integration/sql-gate.test.ts` applies every migration, unchanged and in name order, to an in-memory Postgres (PGlite 0.5.10 with pgvector 0.0.11, dev dependencies only). Stand-ins model the Supabase roles, `auth.uid()` and the Supabase default grants. A check on a new table proves that the stand-in grants are live.
    - It checks that `anon` has no access to any table or function, that one user cannot read, change, delete or insert another user's rows in every table, that `id`, `user_id` and `created_at` cannot be updated, and that search returns only the caller's rows. A new table fails the gate until it is classified.
    - It reads stored `action_log` and `action_proposals` rows, NULLs included, through the app's own repositories.
    - Three checks fail on `main` and are marked as expected failures until the memory hardening migration lands: the nested log detail, the `action_log` insert grant and the `action_proposals` update grant.
    - `tests/integration/frozen-migrations.test.ts` fails when a migration that is on `main` changes, and tells the author to add a new migration.
- **Screens for approvals, memory, documents, "what was sent", the action log and reminders** (decisions [0009](docs/decisions/0009-memory-documents-actions.md) and [0005](docs/decisions/0005-assistant-hub-proposal.md)). PR: not opened yet.
  - Problem: the storage and routes from decision 0009 had no screens. Users could not see or edit what P-Dot keeps, approve an action, or check what went to the model.
  - Resolution:
    - Approval cards in chat (only that conversation's) and on Today: Approve, Edit then approve, Cancel. The details shown come from the stored payload, which is what runs, not from the assistant's one-line summary. A failed run, a decision made in another tab and a lost session each get a clear message.
    - A Memory page for each mode: memories (add, keep a suggestion, edit, move to the other mode, delete) and documents (`.txt` and `.md`; file type, size and empty files are checked before anything is sent; list, delete).
    - "What was sent" under each reply. The server saves the record just after the reply, so a reply under a minute old offers "Check again" instead of treating a 404 as final.
    - An action log page, grouped by the viewer's local day, without IDs or text.
    - Reminders on Workflows, and live counts for the built-in tools on Connectors. Routines and account connectors stay previews.
    - Every page says plainly that replies do not use memories or documents yet and that the assistant does not propose actions yet.
- **Chat shows P-Dot's suggestions under the reply that made them, and the Today tab counts what is waiting.** PR: not opened yet.
  - Problem: chat listed every waiting card at the end of the conversation, so in a long conversation a card was far from the reply it came from, and a decided card disappeared after a reload. Memories P-Dot suggests had no place in chat, and proposals were easy to miss on other pages.
  - Resolution:
    - Each proposal goes under the reply of the turn it was made in (by database time, since proposals have no message link). Waiting ones are cards; decided ones are short lines with the outcome.
    - Memories P-Dot suggested appear as "Remember this?" cards under the reply they came from: Keep, Edit then keep (one request, so the old text is never kept), Don't keep.
    - The Today tab shows how many proposals wait in both modes. It reloads after a decision, after a reply and when the tab comes back into view.
    - What the screens expect from the AI layer (timing, links, IDs) is written down in decision [0009](docs/decisions/0009-memory-documents-actions.md), so it can be built against them.
- **Installable app for Android (PWA) and a Devices page** ([decision 0010](docs/decisions/0010-pwa-and-device-pairing.md)). PR: not opened yet.
  - Problem: P-Dot could not be installed on a phone or ask to show notifications, though the landing page says it acts on your phone.
  - Resolution: a manifest, a service worker that caches only the offline page and icons (never pages or API responses), the install prompt, notification permission with a local test notification, and a Devices page that shows what the browser supports and previews pairing. Push delivery and pairing need the open decisions in 0010.
- **Storage and shared code for memory, documents, action proposals, the action log, reminders and "what was sent"** (decision [0009](docs/decisions/0009-memory-documents-actions.md)).
  - Problem: the pitch needs memory the user can see and edit, search over their own documents, actions that run only after approval, a record of what happened, and a view of what was sent to the model. None of this had storage.
  - Resolution: one additive migration with pgvector, RLS on every table, append-only log and context records, and similarity search that runs as the caller. Embeddings use Qwen3-Embedding-8B at 1,024 dimensions through the spend guard. Shared types, request schemas and limits for the API routes that follow.

- **"Ask first" and "Auto" approval modes in chat** ([decision 0011](docs/decisions/0011-approval-modes.md)). PR: not opened yet.
  - Problem: approving every small action is tedious, but some actions must never happen unseen.
  - Resolution:
    - Easy to find and set: a one-time card in chat asks which mode to use (Ask first recommended, or keep it with one click). After that, a button next to the microphone always shows the current mode and opens a menu that explains both (touch, mouse and keyboard; Esc closes it). Settings → Approvals has the same choice as radio cards, and the Today panel shows the mode with a Change link. The choice is saved on the device; Ask first is the default.
    - The button is kept apart from the effort switch, whose "Auto" means the model choice, not approvals.
    - One shared rule set (`src/lib/approval-policy.ts`): every action kind must name its effect, or it does not compile. In Auto only adding to P-Dot's own lists runs on its own, at most 3 per reply; saving something personal, changing or deleting, outside accounts, private data, money and settings always ask, and their cards say why.
    - Auto acts only on replies to messages sent while it was on. It approves through the existing decision route, so the server still checks and logs each action, and shows "Done on its own" with Undo (the existing task and reminder delete routes).
    - No server change. Decision 0011 holds the backend recipe: the mode in the chat request, `decided_by`, running in the tool loop before `done`, sensitive reads as proposals, and tests.

### Fixed
- **Database expand step for the memory hardening** (decision [0009](docs/decisions/0009-memory-documents-actions.md)). PR: [#18](https://github.com/PATELOM925/P-Dot/pull/18).
  - Problem: the code that makes only the database write the action log and decide action proposals (PR #13) needs a new database function and log triggers. If that code went live before its migration, its writes would succeed with no log row. The migration must also not break the code on main.
  - Resolution: migration `20261021000000_memory_hardening.sql` only adds. It adds the log triggers, `decide_action_proposal`, the `decided_by_function` trust marker, a protected `verified` column on the log (true only for a row the log triggers wrote, and for an action outcome only when the function decided it; a `verified` key in the detail is removed, so a caller cannot supply it), triggers that check new rows and changed columns only, a forward-only proposal status, explicit grants, and it removes TRUNCATE, REFERENCES and TRIGGER from the API roles. It keeps the older grants, so main keeps working. The database gate checks main's code against it. `docs/DEPLOYMENT.md` gives the order: this PR, then PR #13, then PR #17, with a check before each merge and the rollback rule.
- **Dictation was blocked by P-Dot's own security header.** PR: not opened yet.
  - Problem: `next.config.ts` sent `Permissions-Policy: microphone=()`, which turns the microphone off on every page, so the microphone button showed as available but Chrome refused it, and the message told users to change their own browser settings. Words heard after Send also landed in the next message.
  - Resolution: the header now allows the microphone for P-Dot's own pages only (`microphone=(self)`; camera and location stay off), with a test. The button is disabled when a page cannot use the microphone. While listening, the words being heard show under the message box; finished phrases are added within the message length limit; Esc, Send and switching conversations stop listening and drop any later words; stopping on purpose shows no error; Chrome on Android listens for one phrase per tap, because continuous listening there repeats words.

### Changed
- **Icons and colours follow the design palette.** The favicon, Apple icon and app icons put the "P." mark on the indigo-to-violet accent gradient instead of the old flat blue. The manifest uses the page ground colour, so the bar does not flash when the app opens, and no longer locks the screen to portrait. PR: not opened yet.

## 2026-10-19

### Added
- **Model routing for Nemotron on Nebius Token Factory** ([PR #3](https://github.com/PATELOM925/P-Dot/pull/3), merged as `6e5224d`).
  - Problem: one fixed model for every message was either too slow and costly for small questions or too weak for hard ones. A provider error ended the reply with no second try.
  - Resolution: a rule-based router picks a tier with no extra model call:
    - fast: Lightning → Nano → Super
    - standard: Super → Lightning
    - heavy: Ultra → Super, with a thinking budget
    - vision: Super VL
  - Retries happen only before the first visible token. The router uses backoff with jitter, honors `Retry-After`, caps the attempts, sends one hedged request on the fast tier only, and skips a failing model for a short time with a circuit breaker.
  - Every attempt goes through the spend guard. Each reply shows which model answered and why.
  - Decision: [0007](docs/decisions/0007-model-routing.md).
- **Fixed during review (PR #3):**
  - A failed hedge reset the other model's retry wait, so it retried too early. Each model now keeps its own wait. ([round 1](https://github.com/PATELOM925/P-Dot/pull/3#issuecomment-6257890039))
  - Error events inside the stream were misread. "Model not found" stopped instead of moving to the next model, and "out of credit" was retried. Errors are now classified by status and label. ([round 1](https://github.com/PATELOM925/P-Dot/pull/3#issuecomment-6257890039))
  - Chat failed if the code went live before its migration. Reads and inserts now fall back to the old columns, for a missing route column only. ([round 1](https://github.com/PATELOM925/P-Dot/pull/3#issuecomment-6257890039), [round 2](https://github.com/PATELOM925/P-Dot/pull/3#issuecomment-6258000501))
- **`docs/PROVIDER-RELIABILITY.md`.** Ten lessons from review findings and measurements, each with a rule and sources: retries, backup models, hedged requests, error labels, pricing, usage parsing, migrations, `waitUntil`, the circuit breaker and the deploy guard. There are also checklists for adding a model, an error rule or a migration. ([PR #4](https://github.com/PATELOM925/P-Dot/pull/4))
- **This changelog**, and a rule in `AGENTS.md` that every pull request updates it. ([PR #4](https://github.com/PATELOM925/P-Dot/pull/4))
- **Global spend guard for Nebius and Tavily** ([PR #2](https://github.com/PATELOM925/P-Dot/pull/2), merged as `00a2865`).
  - Problem: the only limit was per user, and sign-up is open for judges. Anyone could make many accounts and use up the owner's $25 Nebius credit, and then the card is charged.
  - Resolution: Postgres counters with caps for all users together:
    - Nebius: $1 a day and $20 in total
    - Tavily: 40 credits a day and 800 a month
    - each user: $0.25 and 10 credits a day
  - Each paid call reserves its worst-case cost first and settles the real cost after. Errors, Stop and missing usage keep the full hold.
  - The Supabase GitHub integration applied the migration on merge (confirmed with `supabase migration list` about 30 seconds later).
  - Decision: [0006](docs/decisions/0006-global-spend-guard.md).
- **Fixed during review (PR #2):**
  - An unknown model got a fallback price below real catalog prices, so spending could pass the cap. Unpriced models are now refused. ([round 1](https://github.com/PATELOM925/P-Dot/pull/2#issuecomment-6257586511))
  - Negative usage counts were clamped to zero, so a malformed reply was free. Invalid usage now keeps the full hold. ([round 1](https://github.com/PATELOM925/P-Dot/pull/2#issuecomment-6257586511), [round 2](https://github.com/PATELOM925/P-Dot/pull/2#issuecomment-6257656084))
- **Nemotron reasoning control** (PR #2).
  - Problem: with thinking on by default, Nemotron Nano used the whole output limit on reasoning and returned an empty reply.
  - Resolution: chat sends `enable_thinking: false`. Reasoning text is never shown or saved.
- **Apache-2.0 license, custom domain, deploy guard and deployment guide** ([PR #1](https://github.com/PATELOM925/P-Dot/pull/1), merged as `4934a80`).
  - Problem:
    - The hackathon requires a visible open-source license.
    - The site needed its own address.
    - The OpenNext build copies `.env` file values into the uploaded Worker, so a local key could ship inside the code.
  - Resolution:
    - `LICENSE` added (Apache-2.0).
    - Worker `pdot` served only on `pdot.iampatelom.com`.
    - `npm run deploy` stops when a non-allowed variable has a value in the bundle.
    - `docs/DEPLOYMENT.md` describes the PR, preview and merge flow and the rules for agents.
    - `AGENTS.md` requires a pull request and review before merge.
  - Review fixed gaps in the guard (it now uses an allow list) and the Preview settings.
- **First deploy** to https://pdot.iampatelom.com (Cloudflare Workers free plan, about 2.3 MB compressed).

### Changed
- **"Think harder" applies to one message only.**
  - Problem: the switch stayed on until the user turned it off, so a forgotten switch kept using the most expensive model (Ultra).
  - Resolution: the switch goes back to "Auto" when the server accepts the message. Owner decision, 2026-10-19.
  - PR: routing follow-ups ([PR #4](https://github.com/PATELOM925/P-Dot/pull/4)).
- **Decision 0007 (model routing) is accepted.** Web search raises an otherwise fast message to the standard tier (Nemotron 3 Super), because summarizing sources needs the better model. "Think harder" and the stronger reasoning rules can still choose the heavy tier for a search turn. Owner decision, 2026-10-19.
- **Merged Personal and Work modes, tasks, rename and dictation into `main`** (Awais's frontend, `ec3ea0e`). It was a fast-forward. Lint, types, 131 tests and the build passed before the merge (run locally on 2026-10-19). The Supabase GitHub integration applied both migrations (confirmed with `supabase migration list`).

### Security
- **Real keys were found in the tracked `.env.example` before any commit.** The values were moved to git-ignored files, and the template went back to blank values. The admin key, database password and connection strings now live only in `.env.admin.local`, which the app never reads. `git status` showed the file as changed but never committed, and nothing was pushed, so no key needed rotation.

## 2026-10-16

### Added
- Personal and Work modes, conversation rename, a to-do list for each mode, browser dictation, and preview-only Workflows and Connectors pages (Awais Aziz, `ec3ea0e`). Decision: [0005](docs/decisions/0005-assistant-hub-proposal.md).

## 2026-10-15

### Added
- Backend and minimal frontend (Awais Aziz, `792c5fc`):
  - Supabase auth and Postgres with row-level security
  - streamed chat on Nebius
  - opt-in Tavily web search
  - conversation history and deletion
  - per-user request limits
  - Cloudflare Workers deployment setup

  Decisions: [0001](docs/decisions/0001-supabase-auth-and-database.md) to [0004](docs/decisions/0004-cloudflare-workers-deployment.md).

## 2026-10-09

### Added
- Project instructions, PRD and repository scaffold (Awais Aziz, `0c98cbd`).
