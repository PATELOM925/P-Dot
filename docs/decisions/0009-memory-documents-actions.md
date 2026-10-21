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
- **Only a verified outcome is a record of what ran.** The column `action_proposals.decided_by_function` is true only on a proposal that `decide_action_proposal` decided. The check trigger sets it: the function names the row in a transaction-local setting and runs as its owner, and any other write (older code, a user with the older update grant, or a manual change) sets it to false. Older rows stay false. The log has its own protected column `action_log.verified`: true only on a row that the log triggers wrote through `write_action_log`, and for an action outcome only when the proposal has the marker. A trigger sets the column and removes any `verified` key from the detail, so a caller cannot supply it; a row that main's code or a user inserted, and every older row, is false. A proposal or log event without the marker is what a caller wrote, or legacy history; it is not proof that an action ran. `ActionProposalDTO.verified` and `ActionLogEntryDTO.verified` expose it. The screens say "Done" and "Action completed" only for a confirmed outcome. An unconfirmed one shows "Marked done" in chat and "Marked as completed" in the action log, in a neutral style, with "P-Dot did not confirm this action." and no link to a result. Older rows, for example a proposal left `approved`, are handled by the procedure in "Recovery of in-progress statuses" below and [`0009-legacy-approved.sql`](0009-legacy-approved.sql); do not reset such a row and run it again.
- **A status moves only forward,** already in the expand step: `proposed` to `approved` or `rejected`, `approved` to `executed` or `failed`. A decided proposal cannot change. These are the steps main's decision route uses, so main keeps working, and a reset and a replay are refused at once.
- **Older rows.** The rules are triggers that check new rows and changes to the checked columns only, not NOT VALID constraints. An update that does not touch those columns always works, for example the foreign key that clears `conversation_id` when a conversation is deleted. An older proposal whose payload names another kind is never run (`invalid`), and the user can reject it; the route then answers 200 with the ID and status only, because the payload cannot be shown. The app skips a log row that does not parse and logs its ID only.
- **The decision route** calls the function once and maps the outcome to 200, 404, 409, 400 or 502. The database saves an approved memory with no vector; the route embeds it after the response with `waitUntil`. The vector is written only if the memory still has the embedded text; the comparison is in the update. The memory edit route does not write unchanged text, writes new text and its vector in one update, and applies the update only while the stored text is the one it read; otherwise it answers 409 "This memory changed. Reload it and try again." The screens show that message and keep the edit open; they do not reload by themselves.
- **Grants.** The expand step grants each table and function the app uses only what the app needs, so a new project without automatic grants works. It revokes TRUNCATE, REFERENCES and TRIGGER from `anon` and `authenticated` on every table: TRUNCATE skips row-level security and row triggers.
- **Context records stay user-written.** Without a server secret they cannot be made unforgeable. A record is the user's own record of what the app sent, not proof that a model received it.
- **The embedder refuses a batch whose worst-case hold is above the ceiling** (`NebiusHoldTooLargeError`, from `nebiusEmbeddingHoldMicroUsd` in `src/server/assistant/spend.ts`). It checks every batch before the first reservation and never reduces a required hold. The documents route answers 413. The current upload and memory limits are far below the ceiling.
- **Proof.** The database gate (`tests/integration/sql-gate.test.ts`) applies every migration to an in-memory Postgres 18 (PGlite) with pgvector and stand-ins for `auth.users`, `auth.uid()`, `anon` and `authenticated`. It runs twice: with the older Supabase default grants and with none. It calls `decide_action_proposal` as the user, checks the trust marker, and upgrades a database that has older bad rows. `tests/integration/sql-gate-app.test.ts` runs the repositories against the same SQL. A stub of the function fails the gate. It is not a check of the hosted project, and its single connection cannot test two decisions at the same time.

## Recovery of in-progress statuses

A status that means work is in progress must name how a row leaves it when a request stops halfway (`AGENTS.md`, "Rules and what enforces them").

- **`documents.status = 'processing'`.** The upload creates the row as `processing` and saves all chunks in one statement. Then it calls `settle_document` ([decision 0012](0012-resend-idempotency.md)), also after an error: a document with chunks that all have a vector becomes `ready`, any other `failed`. The function locks the row, and a trigger refuses chunks for a document that is not `processing`, so a late chunk insert cannot contradict a settle. If the settle fails or the Worker stops, the row stays `processing`. Recovery: a resend with the same request key settles it at once. `GET /api/documents` first settles up to 5 of the user's documents that are `processing` and older than 10 minutes (`DOCUMENT_PROCESSING_STALE_MS`, `STALE_DOCUMENT_SETTLE_LIMIT`) with the same function. Settling makes no embedding call. If settling fails, the list is still returned and the next list tries again. Search uses only `ready` documents, so a row that waits for settling is never searched. A resend after a 500 no longer gives two ready copies: the request key finds the first document (decision 0012).
- **`action_proposals.status = 'approved'`.** A new decision goes through `decide_action_proposal`. Its transaction ends in `executed` or `failed`, so a new decision cannot stay `approved`. This does not change older rows. The route before PR #13 could commit `approved` and then stop. The hardening migration keeps those rows, and the function answers `already_decided` for them, runs nothing and does not change them. (PR #13 also adds a `decided_by_function` marker: only a marked row is a record made by the function.) The outcome of an older `approved` row is unknown. The action may have run, and its row may since have been edited or deleted. So:
  - Never set an older `approved` row to `failed` from a search. An empty search does not prove that the action did not run, and a new approval could then make a second copy.
  - Never run the action again, and never reset the row.
  - Leave the row `approved` and treat it as "outcome unknown". The function keeps it from running.
  - Set it to `executed` only when the user confirms which row came from it.

  The statements are in [`0009-legacy-approved.sql`](0009-legacy-approved.sql). Each one is for one user (`$1`) and says if it is read-only. `find_approved` lists that user's rows. `find_reminder`, `list_tasks_near_decision` and `list_memories_near_decision` show the user the rows made near the decision time. These four only read. When the user confirms a row, `confirm_executed` writes one row: it changes only that user's proposal, only while it is `approved`, and only to a row of the same kind that belongs to the same user. It refuses a row that another proposal of that user already names as its result, and a reminder linked to another proposal. If two proposals could match one row, keep both `approved` unless the user can say which one made it. The trigger writes the `executed` log row. A row confirmed this way keeps `decided_by_function = false` and its log row has `verified = false`, because a person confirmed it, not the decision function; the screens show it as "Marked done". Limit: these checks do not prove which proposal made a row. The statement accepts a row made long after the decision, though the lists do not show one, so use only an ID from the lists and the user's answer. `tests/integration/sql-gate.test.ts` reads that file and runs the same statements with a second user's rows present.
- **Spend holds.** A reservation that is not settled keeps its full hold counted, which is the safe side ([0006](0006-global-spend-guard.md)).

`tests/support/write-faults.ts` makes the writes of a request fail, refused or lost after they commit. It also makes a write fail that runs only after an earlier write failed (up to two faults in one run), and it counts only the fakes a test wraps. The route tests check these paths, including the settle writes of `GET /api/documents`.

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
