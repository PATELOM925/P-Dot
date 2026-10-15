# 0001 — Supabase for authentication and database

- Status: Accepted (user decision, 2026-10-14)
- Supersedes: the "authentication and database provider" open decision in the PRD

## Decision

Use Supabase Auth (email/password, email verification, password recovery) and Supabase Postgres for conversations, messages, and usage quotas.

## How it is used

- The app talks to Supabase only with the **publishable key plus the signed-in user's session cookie** (`@supabase/ssr`). No secret or service-role key is used anywhere, so every query runs under row-level security as that user.
- Ownership is enforced twice: repository methods filter by the session user ID, and RLS policies (`supabase/migrations/…_initial_schema.sql`) reject rows whose `user_id` is not `auth.uid()`. Messages reference `(conversation_id, user_id)` together, so a message can never be attached to another user's conversation.
- Server code verifies sessions with `supabase.auth.getClaims()` (JWT signature check), never `getSession()`.
- `src/proxy.ts` (Next.js 16's renamed middleware) refreshes the session cookie on each request and redirects signed-out users away from workspace pages. Pages and API routes still check authentication themselves.
- Usage limits are a fixed-window counter updated by the `consume_chat_quota()` database function, which identifies the caller via `auth.uid()`. Users can read but not write their counters directly.

## Consequences

- One external service for identity and data; no custom password storage.
- Sign-out uses `scope: "local"` (this browser only). An access token that was copied elsewhere remains valid until it expires (Supabase default: 1 hour), because JWTs are verified statelessly.
- Email links depend on Supabase email templates and the redirect URL allowlist (see README).
- Backup retention follows the Supabase plan and must be documented before public release.
