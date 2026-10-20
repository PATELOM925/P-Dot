# 0009 — Memory, documents, action proposals, the action log, reminders and "what was sent"

- Status: Accepted for build (owner, 2026-10-19). Shapes may change during review.
- Related: [0006 spend guard](0006-global-spend-guard.md), [0007 model routing](0007-model-routing.md), [PROVIDER-RELIABILITY.md](../PROVIDER-RELIABILITY.md).

## Why

The pitch is a private assistant that remembers what you let it, shows what it sent to the model, and does nothing without your approval. This decision adds the storage and APIs for that. The AI logic that uses them (when to save a memory, how to retrieve, the tool loop) belongs to the AI layer and calls these modules.

## Storage

Migrations `supabase/migrations/20261020000000_memory_documents_actions.sql` and `20261021000000_memory_hardening.sql` (review fixes, see below). Every table has `user_id = auth.uid()` with RLS, no access for `anon`, and column-level update grants.

| Table | Purpose | Notes |
| --- | --- | --- |
| `memories` | Facts the user can see, edit and delete | `status`: `proposed` (from the assistant, waiting) or `active` (used in replies). `source`: `user` or `assistant`. `embedding vector(1024)`. Optional link to the source message (same user only; deleting the message keeps the memory). |
| `documents` | Uploaded plain text or Markdown | `status`: `processing`, `ready`, `failed`. Up to 100,000 characters. |
| `document_chunks` | Searchable parts of a document | About 2,000 characters with 200 overlap. Deleted with the document. |
| `action_proposals` | Actions the assistant proposes | `kind`: `create_task`, `create_reminder`, `save_memory`. Inserted only as `proposed`, with no decision and no result. The payload names the same kind. The user cannot update or delete one; only `decide_action_proposal` changes it. |
| `action_log` | Record of what happened | Written only by database triggers. The user can read it but cannot insert, update or delete a row. The detail is a flat object of IDs, kinds, modes, counts and flags, never message or memory text. |
| `reminders` | Reminders with a due time | Delivery (scheduled jobs, notifications) is a later change. |
| `context_records` | "What was sent" for each assistant reply | Model, history size, memory IDs, document chunk IDs, web source count, prompt version, token counts. No copied text. The app writes it with the user's session, so it is the user's own record of what the app sent, not proof that a model received it. |

Similarity search: `match_memories(query, mode, count)` and `match_document_chunks(query, mode, count)`. Both are `SECURITY INVOKER`, so RLS applies, and both cap the count at 20.

Tested on 2026-10-19 on an in-memory Postgres 17 with pgvector (all migrations in order): users cannot read, change, link to or search another user's rows; `anon` has no access; proposals cannot be inserted as executed or deleted; the log cannot be changed or deleted; search returns only the caller's rows and at most 20.

## Embeddings

- Model `Qwen/Qwen3-Embedding-8B` on Nebius Token Factory with `dimensions: 1024` (checked on 2026-10-19: 1,024 numbers, length 1). It costs $0.01 per million tokens.
- `src/server/providers/nebius/embeddings.ts` calls the API. `src/server/assistant/embed.ts` wraps it with the spend guard: each batch of up to 32 texts reserves its worst case first and settles the real cost after. Invalid or missing usage keeps the full hold.
- `src/server/db/retrieval.ts` runs the similarity search.

## API (shapes for the frontend and the AI layer)

All routes need a session. Write routes need a same-origin request. Errors use the usual `{ error: { code, message, requestId } }`. Types are in `src/types/api.ts` and request schemas in `src/lib/schemas.ts`.

| Method and path | Body | Result |
| --- | --- | --- |
| `GET /api/memories?mode=&status=` | | `{ memories: MemoryDTO[] }` |
| `POST /api/memories` | `{ mode, content }` | `MemoryDTO`, 201. Embeds the text. |
| `PATCH /api/memories/:id` | `{ content?, mode?, status?: "active" }` | `MemoryDTO`. Re-embeds when the text changes. |
| `DELETE /api/memories/:id` | | 204 |
| `GET /api/documents?mode=` | | `{ documents: DocumentDTO[] }` |
| `POST /api/documents` | `{ mode, title, mediaType, text }` | `DocumentDTO`, 201. Chunks and embeds the text. |
| `DELETE /api/documents/:id` | | 204 |
| `GET /api/actions?status=` | | `{ actions: ActionProposalDTO[] }` |
| `POST /api/actions/:id/decision` | `{ decision: "approve" \| "reject", payload? }` | `ActionProposalDTO` after it runs |
| `GET /api/action-log` | | `{ entries: ActionLogEntryDTO[] }` |
| `GET /api/reminders?mode=` | | `{ reminders: ReminderDTO[] }` |
| `POST /api/reminders` | `{ mode, title, dueAt }` | `ReminderDTO`, 201 |
| `PATCH /api/reminders/:id` | `{ title?, dueAt?, status? }` | `ReminderDTO` |
| `DELETE /api/reminders/:id` | | 204 |
| `GET /api/messages/:id/context` | | `ContextRecordDTO` |

The routes do not write the action log. Database triggers write one row for each change to a memory, a document, a reminder or an action proposal, whatever the path of the change.

## Rules

- **Approval first.** The AI layer creates `action_proposals` only. An action runs only after `POST /api/actions/:id/decision` with `approve`. The kinds today change only P-Dot's own data. A kind that changes an outside account (email, calendar, devices) needs its own decision.
- **The user edits before approving.** The decision can carry an edited payload of the same kind, checked with `actionPayloadSchema` in the route and with the same limits again in the database.
- **Memory from the assistant starts as `proposed`.** It is not used in replies until the user approves it.
- **Retrieved text is untrusted.** Memories and document chunks go into the prompt inside delimiters, like web results, and cannot authorize actions.
- **Privacy.** The log and context records hold IDs and counts, not text. Deleting a memory or a document removes its text and vector at once. Deleting a memory does not remove a copy of its text inside a `save_memory` proposal payload: the user cannot delete proposals, so that copy stays until the account is deleted.
- **Cost.** Every embedding goes through the spend guard. A document upload is limited to 100,000 characters (under $0.001 to embed).

## Review fixes (2026-10-21)

The reviews of PRs #6, #12 and #13 found that a signed-in user could use the public API to forge an executed proposal or a log event, reset a proposal to `proposed` and run it twice, and store short private text or nested values in the log detail. A route that ran the action and then wrote the result in a second step could also store a false or missing outcome. All writes still use the user's own session; there is no service role key.

The fix ships in three pull requests, so the code that is live keeps working at each point. The order and the check before each merge are in `docs/DEPLOYMENT.md` ("Expand, then contract"):

1. **Database (expand), PR #18:** migration `20261021000000_memory_hardening.sql`. It only adds. The code on main keeps its grants and keeps working during and after the migration.
2. **Code, PR #13:** the code that calls `decide_action_proposal` and no longer writes the log. It merges only after step 1 is applied, so its writes always have the triggers.
3. **Contract, PR #17:** migration `20261021010000_memory_hardening_contract.sql`. It removes the old insert grant and policy on `action_log` and the old update grant and policy on `action_proposals`. It merges only after the step 2 code serves all traffic.

Between steps 1 and 3, the older code can write a second, app-written log row for a change, and a user can still move a proposal forward with the older update grant.

What the two steps do:

- **The database writes the action log.** SECURITY DEFINER trigger functions on `memories`, `documents`, `reminders` and `action_proposals` write each row. They have an empty search path, and no API role can call them. The detail holds only IDs, kinds, modes, counts and flags. A trigger refuses a new detail that is not a flat object of at most 16 keys with string values of at most 64 characters, numbers, booleans or null. A change that only writes a vector is not logged. Events: `proposed`, `approved`, `rejected`, `executed`, `failed`, `memory_added`, `memory_edited`, `memory_deleted`, `document_added`, `document_ready`, `document_failed`, `document_deleted`, `reminder_added`, `reminder_changed`, `reminder_deleted`. The deletes during an account deletion are not logged. After the contract step, users cannot insert a log row.
- **One function decides a proposal.** `decide_action_proposal(p_id, p_decision, p_payload)` is SECURITY DEFINER with an empty search path and is granted only to `authenticated`. In one transaction it reads `auth.uid()`, claims only a `proposed` row of that user, checks the payload (the same limits as `actionPayloadSchema`) and refuses a kind change, stores an edited payload, inserts the task, reminder or memory as that user, and stores `executed` with the new row's ID as the result. If the insert fails, it stores `failed` with `{ error: "execution_failed", code: <SQLSTATE> }`; it never leaves `approved`. It answers `{ outcome, proposal }`, where `outcome` is `not_found`, `already_decided`, `invalid`, `kind_mismatch`, `rejected`, `executed` or `failed`. Another user's proposal gets the same `not_found` answer as a missing one. A second decision gets `already_decided` with the stored outcome, which also recovers a lost response. After the contract step, users cannot update a proposal.
- **Only a verified outcome is a record of what ran.** The column `action_proposals.decided_by_function` is true only on a proposal that `decide_action_proposal` decided. The check trigger sets it: the function names the row in a transaction-local setting and runs as its owner, and any other write (older code, a user with the older update grant, or a manual change) sets it to false. Older rows stay false. The log has its own protected column `action_log.verified`: true only on a row that the log triggers wrote through `write_action_log`, and for an action outcome only when the proposal has the marker. A trigger sets the column and removes any `verified` key from the detail, so a caller cannot supply it; a row that main's code or a user inserted, and every older row, is false. A proposal or log event without the marker is what a caller wrote, or legacy history; it is not proof that an action ran. `ActionProposalDTO.verified` and `ActionLogEntryDTO.verified` expose it. The screens say "Done" and "Action completed" only for a confirmed outcome. An unconfirmed one shows "Marked done" in chat and "Marked as completed" in the action log, in a neutral style, with "P-Dot did not confirm this action." and no link to a result. Older rows, for example a proposal left `approved`, are handled by the procedure for older rows in this decision; do not reset such a row and run it again.
- **A status moves only forward,** already in the expand step: `proposed` to `approved` or `rejected`, `approved` to `executed` or `failed`. A decided proposal cannot change. These are the steps main's decision route uses, so main keeps working, and a reset and a replay are refused at once.
- **Older rows.** The rules are triggers that check new rows and changes to the checked columns only, not NOT VALID constraints. An update that does not touch those columns always works, for example the foreign key that clears `conversation_id` when a conversation is deleted. An older proposal whose payload names another kind is never run (`invalid`), and the user can reject it; the route then answers 200 with the ID and status only, because the payload cannot be shown. The app skips a log row that does not parse and logs its ID only.
- **The decision route** calls the function once and maps the outcome to 200, 404, 409, 400 or 502. The database saves an approved memory with no vector; the route embeds it after the response with `waitUntil`. The vector is written only if the memory still has the embedded text; the comparison is in the update. The memory edit route does not write unchanged text, writes new text and its vector in one update, and applies the update only while the stored text is the one it read; otherwise it answers 409 "This memory changed. Reload it and try again." The screens show that message and keep the edit open; they do not reload by themselves.
- **Grants.** The expand step grants each table and function the app uses only what the app needs, so a new project without automatic grants works. It revokes TRUNCATE, REFERENCES and TRIGGER from `anon` and `authenticated` on every table: TRUNCATE skips row-level security and row triggers.
- **Context records stay user-written.** Without a server secret they cannot be made unforgeable. A record is the user's own record of what the app sent, not proof that a model received it.
- **The embedder refuses a batch whose worst-case hold is above the ceiling** (`EmbeddingTooLargeError`). It checks every batch before the first reservation and never reduces a required hold. The documents route answers 413. The current upload and memory limits are far below the ceiling.
- **Proof.** The database gate (`tests/integration/sql-gate.test.ts`) applies every migration to an in-memory Postgres 18 (PGlite) with pgvector and stand-ins for `auth.users`, `auth.uid()`, `anon` and `authenticated`. It runs twice: with the older Supabase default grants and with none. It calls `decide_action_proposal` as the user, checks the trust marker, and upgrades a database that has older bad rows. `tests/integration/sql-gate-app.test.ts` runs the repositories against the same SQL. A stub of the function fails the gate. It is not a check of the hosted project, and its single connection cannot test two decisions at the same time.

## Not in this change

Scheduled reminder delivery and push notifications, the tool loop that creates proposals, using memories and documents in the chat prompt, and the frontend screens. They build on these shapes.

## Frontend (2026-10-19)

The screens now use these routes: approval cards in chat and on Today (approve, edit then approve, cancel), the Memory page (memories and documents: add, keep, edit, move, delete), "What was sent" under each reply, the action log page, reminders on Workflows, and live counts on Connectors. The pages say plainly that replies do not use memories or documents yet and that the assistant does not propose actions yet. The server saves a reply's context record just after it sends `done`, so "What was sent" offers "Check again" for a reply under a minute old instead of treating a 404 as final. Push delivery and device pairing are in [0010](0010-pwa-and-device-pairing.md).

In chat, each suggestion appears under the reply of the turn it came from: action proposals waiting for approval as cards, earlier decisions as short lines, and memories P-Dot suggested as "Remember this?" cards (Keep, Edit then keep, Don't keep). The Today tab shows how many proposals are waiting, in both modes.

### What the screens expect from the AI layer

Checked with proposals and memories inserted directly into a local database, since nothing creates them yet.

- **Proposals.** Set `conversation_id`, and create the proposal while handling the turn (after its user message is saved). Chat places a proposal under the reply of the last user message saved before it, using the database times. Save it before sending `done`: the chat reloads proposals, and the Today count, when `done` arrives, and not again until the next reply or conversation switch. Write the summary as one plain sentence; the card shows it as P-Dot's words and lists the details from the payload, which is what runs. A `message_id` column on proposals would make the placement exact instead of time-based.
- **Suggested memories.** Use `status: "proposed"`, `source: "assistant"` and `source_message_id` set to the reply (or the user message) the fact came from. Chat shows them under that turn's reply; the Memory page lists them under "Suggested by P-Dot". Keep means `PATCH` to `active`, Edit then keep sends the new text and `active` together, Don't keep deletes the row. Save them before `done`, like proposals. A `save_memory` proposal also works; it appears as an approval card instead.
- **Memories used in a reply.** Put the IDs actually sent in the context record (`memoryIds`, `documentChunkIds`; `service.ts` passes empty lists today). "What was sent" shows their current text. A small count on `MessageDTO` (memories and documents used) would let a reply show "Used 2 memories" without opening the panel; the screens do not depend on it.
- **Approval modes.** Ask first and Auto, the rule for which kinds may run on their own, and the server-side steps are in [0011](0011-approval-modes.md).
- **Copy to update when this lands:** the notice on the Memory page, the Built in note and the Documents card on Connectors, the Memory and Documents lines in Settings → How your data is used, and the note on the landing page. Each says the step is not built yet.
