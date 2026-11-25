# Controls follow-up assessment

Status: assessment only. These are bounded future slices, not accepted product decisions or implemented controls.

## Memory expiry

**Current state:** memories have active/deleted status and explicit user deletion, but no expiry timestamp or automatic expiry. The PRD still lists account and data retention decisions as open.

**Bounded slice:** decide whether expiry is user-configurable per memory or a single product retention period; then add a nullable expiry field, a server-side expiry check so expired memories cannot enter search/chat before cleanup runs, and a scheduled cleanup that deletes the row and embedding under the user's retention rules. Keep the Activity record limited to a metadata event. Add SQL/RLS coverage, search exclusion tests, cleanup idempotency tests and backup-retention copy.

**Dependencies:** product decision on expiry semantics and whether expiry is reversible; owner approval for a durable scheduler/cron mechanism; a narrowly scoped database-owned cleanup function or other approved privileged path (do not add a Supabase service-role key to the Worker); safe migration and deployment sequencing; policy for backups and related document chunks. Do not infer a default duration.

## Pause connected tools

**Current state:** users can disconnect. There is no separate local pause state. Disconnect attempts provider revocation and deletes P-Dot's stored credential when its row still matches.

**Bounded slice:** add an account-scoped pause bit or timestamp per connected provider, expose Pause/Resume on each card, and make every server path that offers or opens a connector credential check pause state before reading/decrypting the token and before provider calls. Add tests for paused chat, status, reconnect races and already-running calls.

**Dependencies:** schema and user-facing semantics; all connector entry points must share the same check; a write path and RLS rule; an explicit resume flow. Pause only stops new P-Dot calls once the server sees the persisted state. It does not revoke provider tokens, cancel in-flight calls, or prevent provider-side use by other apps. Provider revocation remains Disconnect or the provider's own account settings.
