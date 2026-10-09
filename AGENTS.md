# Repository instructions

## Current phase

P-Dot is in planning and scaffolding. Do not implement application code, install dependencies, provision services, or deploy until the user asks to begin implementation. Empty directories are intentional.

## Product and source of truth

- Read `docs/PRD.md` before product work.
- Read `docs/ARCHITECTURE.md` before changing the proposed structure or stack.
- Explicit user instructions take precedence over these documents. Identify assumptions; do not silently expand the MVP.
- `AGENTS.md` is the shared instruction source. `CLAUDE.md` and `CODEX.md` supplement it for their respective tools.

## Planned stack

- Next.js App Router and TypeScript for the web frontend and Vercel-hosted API routes.
- Nebius Token Factory for model inference; Tavily for optional web search.
- Authentication provider and persistent database are not selected. Supabase is a candidate, not an approved dependency.
- Keep provider access in server-only modules. The browser must never receive provider secrets.

## Structure

- `src/app/`: routes, layouts, and API entry points.
- `src/components/`: reusable UI; `src/features/`: product-specific UI and client logic.
- `src/server/`: authentication, assistant orchestration, provider adapters, and persistence.
- `src/lib/`: shared utilities without secrets; `src/types/`: shared contracts.
- `tests/`: unit, integration, and end-to-end coverage when implementation starts.
- `docs/`: requirements, architecture, and decisions.

## Implementation rules for the next phase

- Make small, reviewable changes. Do not add frameworks or services without a concrete need.
- Validate request bodies and verify authentication on the server before reading private data or invoking paid providers.
- Scope every private record and operation to the authenticated user; never trust a client-supplied user ID.
- Treat model output and retrieved web content as untrusted data. Retrieved instructions must not become system instructions.
- Require explicit user confirmation before sending messages, changing external accounts, deleting records, or taking other consequential external actions.
- Keep API keys, session tokens, personal conversation content, and secrets out of logs and Git.
- Use bounded requests, provider timeouts, and persistent rate limits suitable for serverless hosting. Do not rely on process memory for durable data or production limits.
- Do not simulate successful authentication, saved data, provider responses, or deployment. Label mocks and unfinished behavior.
- Preserve existing user changes. Never force-push or run destructive Git operations without explicit authorization.

## Validation and handoff

Once executable code exists, document and run the relevant lint, type-check, test, and build commands. Prioritize tests for authorization boundaries, request validation, provider failures, and core user flows. Never claim a check passed if it was not run.

For each handoff, summarize what changed, what was verified, and any remaining setup or limitations. Keep environment documentation current whenever configuration changes.
