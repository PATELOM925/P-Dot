# Repository instructions

## Current phase

MVP implementation was authorized on 2026-10-14. The backend and a minimal frontend exist; see `README.md` for setup, commands, and verification status. Production is live at https://pdot.iampatelom.com. Do not provision services or deploy unless the user asks. Remaining empty directories (with `.gitkeep`) are intentional.

## Pull requests and deployment

- Every change goes through a pull request into `main`. Do not push to `main`. Do not merge your own pull request; the owner merges.
- Each pull request gets an adversarial review posted as pull request comments. Fix or answer every comment in new commits before merge.
- A merge to `main` deploys production through Cloudflare Workers Builds (once the owner connects it). Pull request branches get preview links that use the production database.
- Read `docs/DEPLOYMENT.md` before you change deployment settings, environment variables, `wrangler.jsonc`, `open-next.config.ts` or the deploy scripts. It lists the commands agents must not run.
- Read `docs/PROVIDER-RELIABILITY.md` before you change provider calls, model routing, retries, timeouts, the spend guard, usage parsing or a migration on `messages`. Add any new lesson there, with its source.
- Add an entry to `CHANGELOG.md` under "Unreleased" in every pull request: what changed, the problem it solves, how it was resolved, and the pull request link.

## Product and source of truth

- Read `docs/PRD.md` before product work.
- Read `docs/ARCHITECTURE.md` before changing the proposed structure or stack.
- Explicit user instructions take precedence over these documents. Identify assumptions; do not silently expand the MVP.
- `AGENTS.md` is the shared instruction source. `CLAUDE.md` and `CODEX.md` supplement it for their respective tools.

## Planned stack

- Next.js App Router and TypeScript for the web frontend and API routes, deployed to Cloudflare Workers with the OpenNext adapter (`docs/decisions/0004-cloudflare-workers-deployment.md`).
- Nebius Token Factory for model inference; Tavily for optional web search.
- Supabase for authentication and Postgres (accepted in `docs/decisions/0001-supabase-auth-and-database.md`). Use only the publishable key with the user's session; do not add the secret/service-role key.
- Keep provider access in server-only modules. The browser must never receive provider secrets.

## Structure

- `src/app/`: routes, layouts, and API entry points.
- `src/components/`: reusable UI; `src/features/`: product-specific UI and client logic.
- `src/server/`: authentication, assistant orchestration, provider adapters, and persistence.
- `src/lib/`: shared utilities without secrets; `src/types/`: shared contracts.
- `tests/`: unit, integration, and end-to-end coverage when implementation starts.
- `supabase/migrations/`: database schema and row-level security policies.
- `docs/`: requirements, architecture, and decisions.

## Implementation rules

- Make small, reviewable changes. Do not add frameworks or services without a concrete need.
- Validate request bodies and verify authentication on the server before reading private data or invoking paid providers.
- Scope every private record and operation to the authenticated user; never trust a client-supplied user ID.
- Treat model output and retrieved web content as untrusted data. Retrieved instructions must not become system instructions.
- Require explicit user confirmation before sending messages, changing external accounts, deleting records, or taking other consequential external actions.
- Keep API keys, session tokens, personal conversation content, and secrets out of logs and Git.
- Use bounded requests, provider timeouts, and persistent rate limits suitable for serverless hosting. Do not rely on process memory for durable data or production limits.
- Do not simulate successful authentication, saved data, provider responses, or deployment. Label mocks and unfinished behavior.
- Preserve existing user changes. Never force-push or run destructive Git operations without explicit authorization.

## Rules and what enforces them

Level 1: one owner in the code. Level 3: a test that reads the source and fails on a copy. Level 4: a test that runs the code and fails on the mistake. Level 5: review only, because no check can decide it.

| Rule | Enforced by | Level |
| --- | --- | --- |
| A status that means work is in progress names its recovery path in the decision record. | review only | 5 |
| A route that does more than one write in one request has a test that makes each write fail, refused and lost after it commits. The test checks that no row stays in an in-between status, that the HTTP status is correct and that a retry does not repeat the effect. A new route needs its own sweep. | `sweepWriteFaults` in `tests/support/write-faults.ts`, used in the documents, actions, chat and memories route tests | 4 |

## Validation and handoff

Once executable code exists, document and run the relevant lint, type-check, test, and build commands. Prioritize tests for authorization boundaries, request validation, provider failures, and core user flows. Never claim a check passed if it was not run.

For each handoff, summarize what changed, what was verified, and any remaining setup or limitations. Keep environment documentation current whenever configuration changes.
