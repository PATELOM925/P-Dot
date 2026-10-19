# Changelog

All notable changes to P-Dot. Newest first. Each entry says what changed, the problem it solves, and how it was resolved, with the pull request and review links. Commit messages hold the line-level detail.

Every pull request adds its entry under **Unreleased**. When it merges, the entry moves under the merge date. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

Lessons about provider calls, retries, backups and spending are in [docs/PROVIDER-RELIABILITY.md](docs/PROVIDER-RELIABILITY.md).

## Unreleased

### Fixed
- **Automatic deploys from GitHub (Workers Builds) failed on every merge.**
  - Problem: the build settings were empty, so Cloudflare used its defaults (`npm run build`, `npx wrangler deploy`). The plain Next.js build does not make the OpenNext Worker, so each deploy failed after about 45 seconds. The first three builds on 2026-10-19 failed this way, and PR #3 and #4 were deployed by hand.
  - Resolution: the commands from `docs/DEPLOYMENT.md` and the two public Supabase build variables were set on both the Production and Previews Base tabs. A rerun of `main` (`9a8bea2`) then built and deployed in 1 minute 42 seconds. A live sign-up and chat worked after it, and the reply showed "Nemotron 3.5 Lightning · everyday request". The fix itself is a dashboard setting. [PR #5](https://github.com/PATELOM925/P-Dot/pull/5) records it ([review, round 1](https://github.com/PATELOM925/P-Dot/pull/5#issuecomment-6258531931)).

### Changed
- **Merge several pull requests first, then deploy once.** Owner rule, 2026-10-19: when pull requests or a stack are ready at about the same time, merge them all and let one build deploy them. Added to `AGENTS.md` and `docs/DEPLOYMENT.md`, with checks before each merge, cancelling older builds, and confirming that production runs the final `main`. ([PR #5](https://github.com/PATELOM925/P-Dot/pull/5), [review, round 1](https://github.com/PATELOM925/P-Dot/pull/5#issuecomment-6258531931))
- `docs/DEPLOYMENT.md` now records which one-time setup steps are done and the Workers Builds failure above. ([PR #5](https://github.com/PATELOM925/P-Dot/pull/5))

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
