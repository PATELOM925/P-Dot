# Changelog

All notable changes to P-Dot. Newest first. Each entry says what changed, the problem it solves, and how it was resolved, with the pull request and review links. Commit messages hold the line-level detail.

Every pull request adds its entry under **Unreleased**. When it merges, the entry moves under the merge date. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

Lessons about provider calls, retries, backups and spending are in [docs/PROVIDER-RELIABILITY.md](docs/PROVIDER-RELIABILITY.md).

## Unreleased

### Changed
- **"Think harder" applies to one message only.**
  - Problem: the switch stayed on until the user turned it off, so a forgotten switch kept using the most expensive model (Ultra).
  - Resolution: the switch goes back to "Auto" when the server accepts the message. Owner decision, 2026-10-19.
  - PR: routing follow-ups (PR_FOLLOWUPS).
- **Decision 0007 (model routing) is accepted.** Web search turns stay on the standard tier (Nemotron 3 Super), because summarizing sources needs the better model. Owner decision, 2026-10-19.

### Added
- **`docs/PROVIDER-RELIABILITY.md`.** Ten lessons from review findings and measurements, each with a rule and sources: retries, backup models, hedged requests, error labels, pricing, usage parsing, migrations, `waitUntil`, the circuit breaker and the deploy guard. There are also checklists for adding a model, an error rule or a migration. (PR_FOLLOWUPS)
- **This changelog**, and a rule in `AGENTS.md` that every pull request updates it. (PR_FOLLOWUPS)

### Added (in review: [PR #3](https://github.com/PATELOM925/P-Dot/pull/3))
- **Model routing for Nemotron on Nebius Token Factory.**
  - Problem: one fixed model for every message was either too slow and costly for small questions or too weak for hard ones. A provider error ended the reply with no second try.
  - Resolution: a rule-based router picks a tier with no extra model call:
    - fast: Lightning → Nano → Super
    - standard: Super → Lightning
    - heavy: Ultra → Super, with a thinking budget
    - vision: Super VL
  - Retries happen only before the first visible token. The router uses backoff with jitter, honors `Retry-After`, caps the attempts, sends one hedged request on the fast tier only, and skips a failing model for a short time with a circuit breaker.
  - Every attempt goes through the spend guard. Each reply shows which model answered and why.
  - Decision: [0007](docs/decisions/0007-model-routing.md).
- **Fixed during review:**
  - A failed hedge reset the other model's retry wait, so it retried too early. Each model now keeps its own wait. ([round 1](https://github.com/PATELOM925/P-Dot/pull/3#issuecomment-6257890039))
  - Error events inside the stream were misread. "Model not found" stopped instead of moving to the next model, and "out of credit" was retried. Errors are now classified by status and label. ([round 1](https://github.com/PATELOM925/P-Dot/pull/3#issuecomment-6257890039))
  - Chat failed if the code went live before its migration. Reads and inserts now fall back to the old columns, for a missing route column only. ([round 1](https://github.com/PATELOM925/P-Dot/pull/3#issuecomment-6257890039), [round 2](https://github.com/PATELOM925/P-Dot/pull/3#issuecomment-6258000501))

## 2026-10-19

### Added
- **Global spend guard for Nebius and Tavily** ([PR #2](https://github.com/PATELOM925/P-Dot/pull/2), merged as `00a2865`).
  - Problem: the only limit was per user, and sign-up is open for judges. Anyone could make many accounts and use up the owner's $25 Nebius credit, and then the card is charged.
  - Resolution: Postgres counters with caps for all users together:
    - Nebius: $1 a day and $20 in total
    - Tavily: 40 credits a day and 800 a month
    - each user: $0.25 and 10 credits a day
  - Each paid call reserves its worst-case cost first and settles the real cost after. Errors, Stop and missing usage keep the full hold.
  - The migration was applied by the Supabase GitHub integration on merge.
  - Decision: [0006](docs/decisions/0006-global-spend-guard.md).
- **Fixed during review:**
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
- **Merged Personal and Work modes, tasks, rename and dictation into `main`** (Awais's frontend, `ec3ea0e`). It was a fast-forward. Lint, types, 131 tests and the build passed before the merge. The Supabase GitHub integration applied both migrations.

### Security
- **Real keys were found in the tracked `.env.example` before any commit.** The values were moved to git-ignored files, and the template went back to blank values. The admin key, database password and connection strings now live only in `.env.admin.local`, which the app never reads. Nothing was pushed, so no key needed rotation.

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
