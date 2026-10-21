# 0012: A resend does not repeat work that is already saved

- Status: Proposed (2026-10-21). Design only. Nothing is built yet.
- Related: [0006 spend guard](0006-global-spend-guard.md), [0009 memory and documents](0009-memory-documents-actions.md), [DEPLOYMENT.md](../DEPLOYMENT.md) ("Expand, then contract"), `tests/support/write-faults.ts`.

## Problem

Some writes commit, but the caller sees an error ("lost"). Some requests stop after an earlier write committed ("refused" on a later write). The route then answers 500. The screen gives the draft back, and the user sends it again. The resend cannot see what the first request saved, so it does the work again.

Eight `it.fails` tests record the result:

| Test | First request | Result of the resend today |
| --- | --- | --- |
| `api-routes.test.ts`, new conversation | User message insert refused | An empty conversation and a second conversation |
| `api-routes.test.ts`, new conversation | Conversation insert lost | An empty conversation and a second conversation |
| `api-routes.test.ts`, new conversation | User message insert lost | Two conversations with the same message |
| `api-routes.test.ts`, existing conversation | User message insert lost | The user message two times |
| `api-routes.test.ts`, reply | Reply insert lost | The turn ends with an error and no "what was sent" record. "Retry reply" gets 409, so the reply never gets its record. |
| `memories-routes.test.ts` | Memory insert lost | Two copies of the memory |
| `documents-routes.test.ts` (two cases) | Ready write refused or lost, fallback refused | Two ready copies of the document |

The reply case is different. It happens inside the stream, after `start`, so there is no resend. Only the server can recover it.

## Decision

Four parts.

1. **The client sends a request key.** The browser makes one UUID for each user action (send a message, add a memory, add a document). It sends the UUID in the `Idempotency-Key` header. It keeps the same key while the draft and its target stay the same, so a resend uses the same key. It makes a new key when the draft text or the target changes, and clears the key when the server confirms the save.
2. **The database stores the key on the row the action creates.** A nullable `client_request_id uuid` on `conversations`, `messages` (user messages only), `memories` and `documents`, with a unique index on `(user_id, client_request_id)`.
3. **The route looks up the key before any paid or counted step.** If a row with the key exists, the route continues from where the first request stopped. It does not consume quota, hold spend or call a provider for work that is already saved. A plain insert with the key is the backstop for two requests at the same time: the unique index refuses the second row.
4. **The server picks the reply ID before it inserts the reply.** If the insert fails, it reads the reply by that ID. If the reply is there, the turn continues: it writes the context record and sends `done`.

Rejected alternatives:

- **The key in the JSON body.** Every request schema is `.strict()`. After a rollback to code without this change, an open tab with the new script would get 400 on every send until the page reloads. An older server ignores an unknown header, so with the header a rollback only brings back today's behavior.
- **Insert with `on_conflict` (upsert).** The paid steps (quota, Nebius hold, embedding) come before the insert, so a conflict at insert time is too late to save the cost. Also, PostgREST sends `ON CONFLICT (columns)` with no index predicate, so Postgres cannot use a partial unique index as the conflict target. A lookup first and a plain insert are simpler.
- **One database function that creates the conversation and the first message in one transaction.** It removes the empty conversation. But it is a new function with its own grants, and the key is still necessary for a lost response. The key alone fixes all the recorded cases.
- **A link from each reply to its user message (`reply_to`).** It would make the "reply exists" check exact and stop two replies for one message. Today a conversation is a list in time order, and a reply is the message right after its user message. That is sufficient for this change. See "Limits".

## Migration

New file `supabase/migrations/20261021020000_resend_idempotency.sql`. It only adds. It does not change an applied migration. Add its SHA-256 to `tests/integration/frozen-migrations.sha256`.

```sql
-- Resend idempotency, EXPAND step (decision 0012).
--
-- Adds a nullable client request key to the rows that a user action creates.
-- The code on main does not read or write these columns, so it keeps working
-- during and after this migration. Older rows keep NULL.
--
-- Grants: authenticated has table-wide INSERT and SELECT on these tables
-- (20261021000000_memory_hardening.sql), so it can write and read the new
-- columns. UPDATE is granted only on listed columns, so no API role can
-- change a key. No log trigger reads these columns.

alter table public.conversations add column if not exists client_request_id uuid;
alter table public.messages add column if not exists client_request_id uuid;
alter table public.memories add column if not exists client_request_id uuid;
alter table public.documents add column if not exists client_request_id uuid;

-- One row for each key and user. The user ID is part of the key, so a
-- conflict never shows that another user has a row.
create unique index if not exists conversations_user_client_request_key
  on public.conversations (user_id, client_request_id)
  where client_request_id is not null;

create unique index if not exists messages_user_client_request_key
  on public.messages (user_id, client_request_id)
  where client_request_id is not null;

create unique index if not exists memories_user_client_request_key
  on public.memories (user_id, client_request_id)
  where client_request_id is not null;

-- A failed document leaves the index, so a resend with the same key can
-- upload again. At most one document for each key is processing or ready.
create unique index if not exists documents_user_client_request_key
  on public.documents (user_id, client_request_id)
  where client_request_id is not null and status <> 'failed';
```

Notes:

- `add column` with no default changes only the catalog. `create unique index` blocks writes to the table while it builds. The tables are small. `concurrently` cannot run inside the migration transaction.
- No new table, policy, function or trigger. The Supabase change of 2026-10-30 (no automatic grants on new public tables) does not apply. The gate run with no default grants proves that the explicit table grants cover the new columns.
- The log triggers build the detail from named columns (`log_memory_change`, `log_document_change`). The key never reaches `action_log`.
- `messages` has no check that only user messages carry a key. A user can already insert any message into an own conversation through the API, so the check would protect nothing. The lookup filters on `role = 'user'`.

## Per-route behavior

"K" is the request key. A request with no key (an older open tab) works as today and does no lookup.

### `POST /api/chat`, action `send`

The route reads the key only for `send`. `retry` ignores it.

| State that the first request left | What the resend with K does |
| --- | --- |
| No row with K (refused before any insert) | A normal send. The conversation (if new) and the user message are inserted with K. |
| A conversation with K and no user message with K (conversation insert lost, or user message insert refused) | Uses that conversation. Checks that its mode is the requested mode. Inserts the user message with K. Then quota, hold, stream, as a normal send. |
| A user message with K that is the last message of its conversation (user message insert lost, or the stream did not start) | Checks the text and the conversation. Then it acts as "Retry reply" for that message: quota, hold, stream. No second user message. |
| A user message with K, followed by its reply, and the reply is the last message | Replays the turn: `start` with the saved user message, then `done` with the saved reply. No quota, no hold, no provider call, no new context record. |
| A user message with K, and later messages after its reply | 409 `conflict`: "This message was already sent. Reload the conversation." Nothing is written. |
| A row with K, but another text, conversation or mode | 409 `conflict`. Nothing is written. No quota or hold. |
| Another request with K inserts at the same time | The unique index refuses the second insert. That request answers 500 and gives its holds back (the existing `prepareChatTurn` catch). The next resend finds the row. |

The lookup runs after the ownership check and before `consume_chat_quota`. A lookup that fails answers 500 with no quota used and no hold.

### Reply save inside the stream

| Fault | Behavior |
| --- | --- |
| Reply insert lost | The server picked the reply ID. It reads the reply by that ID, finds it, writes the context record and sends `done`. |
| Reply insert refused | The read finds nothing. The turn ends with the error event, as today. "Retry reply" works. |
| Reply insert lost and the read also fails | The turn ends with the error event. "Retry reply" gets 409 and the reply has no record. See "Limits". |

### `POST /api/memories`

The fingerprint is `(mode, content)`. The embedding runs only after the lookup.

| State | What the resend with K does |
| --- | --- |
| No memory with K | Embeds, inserts with K, answers 201. |
| A memory with K, same mode and text | Answers 201 with that memory. No embedding and no hold. |
| A memory with K, other mode or text (edited since, or a client fault) | 409 `conflict`: "This memory was already saved with different text. Reload the page." |
| The memory was deleted since | No row with K, so it is saved again. The user asked for it again. |
| Another request with K at the same time | The second insert is refused, 500. Its embedding hold is already settled. The next resend finds the row. |

### `POST /api/documents`

The fingerprint is `(mode, title, mediaType, charCount)`. The text is not on the row; see "Limits". The lookup reads only rows that are not `failed`.

| State | What the resend with K does |
| --- | --- |
| No document with K, or only `failed` ones | A normal upload with K. |
| `ready`, same fingerprint | 201 with that document. No embedding. |
| `processing`, all chunks saved with a vector | The first request saved its work and stopped before its status write. Sets `ready` (only while `processing`) and answers 201. No embedding. |
| `processing`, no chunks, younger than `DOCUMENT_PROCESSING_STALE_MS` | The first request can still be running. 409 `conflict`: "This document is still being added. Check the list in a moment." Nothing is written. |
| `processing`, no chunks, older than `DOCUMENT_PROCESSING_STALE_MS` | No upload runs that long (4 batches with a 20 s timeout each). Sets `failed` (only while `processing`), then a normal upload with K. |
| Another fingerprint | 409 `conflict`. |

Two changes to the upload itself make this safe:

- **Status writes apply only while the row is `processing`.** Today `setStatus` writes always. A late `failed` write from the first request could then turn a document that the resend made `ready` into `failed`.
- **The error path settles by the facts.** Today the catch writes `failed`. It will use the same per-document settle as `GET /api/documents`: all chunks with a vector make it `ready`, anything else `failed`. A lost chunk insert then ends `ready`, and the resend does not pay for a second embedding. `settleStaleDocuments` uses the same per-document step.

## Spend and quota

- A replay (reply already saved, memory or document already saved) uses no quota, holds no spend and calls no provider.
- A resend that does new paid work (the reply was never saved, the document chunks were never saved) consumes one quota unit and holds spend, as "Retry reply" does today. The first request's unit is not given back: `consume_chat_quota` has no refund. A failed send and its resend count two units, as a failed send and "Retry reply" do today.
- The first request gives its holds back when it fails before the stream (the existing catch in `prepareChatTurn`). The sweep already checks that only a failed spend write leaves a hold counted. A lookup or a 409 happens before any hold.
- Only `src/server/assistant/spend.ts` computes a hold. This change adds no hold.

## Client changes

- `src/lib/request-key.ts`: a small class. `keyFor(scope)` returns the current key while the scope string is the same, and a new `crypto.randomUUID()` when it changes. `clear()` forgets it. Unit-tested.
- `src/lib/api-client.ts`: `apiRequest` and `sendJson` accept extra headers.
- Chat (`src/features/chat/ChatWorkspace.tsx`, `api.ts`): the scope is the target (conversation ID, or "new" and the mode) and the trimmed text. `webSearch` and `effort` are not part of it. The key is cleared on `start`, because the user message is then saved. After a 409 from "Retry reply", the screen reloads the conversation, so a saved reply shows.
- Memory (`src/features/memory/MemoryList.tsx`, `api.ts`): the scope is the mode and the text. Cleared on 201.
- Documents (`src/features/documents/DocumentsPanel.tsx`, `api.ts`): the scope is the chosen file, the title and the mode. Cleared on 201. On the "still being added" 409 the panel reloads the list and keeps the draft.
- Server: `src/server/http/request.ts` reads the header. A key that is not a UUID gets 400 `invalid_request`. `src/lib/schemas.ts` and `src/types/api.ts` do not change.
- Logs: new events carry the request ID and flags (`replayed`, `resumed`), never the key or any text.

## Test plan

Unit tests (each `it.fails` becomes a passing `it`; the test sends the same K on both requests, as the screen does):

- `api-routes.test.ts`: the four resend cases and the lost reply case pass. `KNOWN_DUPLICATES` goes away, so every sweep case checks for duplicates. New cases: a replay makes no quota, spend or provider call and no context record; another text, conversation or mode gets 409 with no quota; a key that is not a UUID gets 400; a later message after the reply gets 409; a request without a key behaves as today.
- `memories-routes.test.ts`: the lost insert case passes. The sweep sends K and drops the duplicate exception. New: a replay makes no embedding call; another text or mode gets 409; a deleted memory is saved again.
- `documents-routes.test.ts`: both resend cases pass. The sweep sends K and drops the `failedButReady` exception. New: fresh `processing` without chunks gets 409; stale gets a new upload; a `failed` row does not block the key; a replay makes no embedding call; another fingerprint gets 409; a late `failed` write does not change a `ready` document.
- `request-key.test.ts`: same scope gives the same key, a new scope gives a new key, `clear` gives a new key.

Database gate (`tests/integration/sql-gate.test.ts`, both grant modes):

- `client_request_id` is added to `PROTECTED_COLUMNS`, so authenticated cannot update it on any table.
- The same user cannot insert two rows with one key in each of the four tables (23505). Two users can use the same key. Many rows with NULL work.
- A `failed` document frees its key. A `processing` or `ready` one does not.
- A memory and a document inserted with a key write log rows whose detail has no key.
- Upgrade: rows inserted before the new migration keep NULL and read through the app's repositories.

`tests/integration/sql-gate-app.test.ts`: the new repository methods against the real SQL (find by key, insert with key, a second insert refused, documents lookup skips `failed`). In the expand PR this file runs main's repositories against the new schema, which proves that the code on main keeps working.

`tests/integration/frozen-migrations.test.ts`: passes with the new hash line.

## Deploy order

Two pull requests, like PR #18 then PR #13. No contract step: nothing is removed.

1. **Database (expand).** Branch `om/resend-expand-db`: the migration, the hash line, the gate tests, this record and a CHANGELOG entry. The code on main does not use the columns.
   - Check 1: Om confirms in the Supabase dashboard that `20261021020000_resend_idempotency` is in the migration history and that the four columns and four indexes exist.
2. **Code.** Branch `om/resend-idempotency`, on top of step 1: server, client, unit tests, updates to decision 0009 ("Known limit" under `documents.status`), `ARCHITECTURE.md` (data model) and a CHANGELOG entry. Merge only after check 1.
   - The new code writes and reads the new columns. Before the migration, every send with a key answers 500. So do not use a Preview of this branch before check 1. Previews use the production database.

Rollback: a Worker version from before step 2 ignores the header and the columns, so it is safe. Never undo the migration by hand.

## Limits

- **Two live requests for one message.** If the first request is still running when the resend comes (the connection dropped, but the Worker went on), both can produce a reply. The client sends one request at a time, and a closed connection stops the stream, so this needs an exact timing. A `reply_to` link with a unique index would stop it. Not in this change.
- **Lost reply and failed read.** If the reply insert response is lost and the read by ID also fails, the reply has no context record. "Retry reply" gets 409. The screen then reloads the conversation and shows the reply.
- **Read after a timeout.** If the reply insert timed out while the database was still running it, the read can come first and find nothing. The retry can then make a second reply.
- **Empty conversation.** If the user never sends again after a refused first message, the empty conversation stays. The next send with the same draft uses it.
- **Document fingerprint.** It compares mode, title, type and length, not the text. Two different files with the same title and length under one key are not told apart. The client makes a new key for each chosen file.
- **Fresh `processing` documents.** A resend within 10 minutes of a first attempt that stopped before its chunks were saved gets 409. The user can wait or choose the file again.
- **Older open tabs.** They send no key and keep today's behavior until the page reloads.
- **Quota.** A failed send and its resend count two units.
- **A replayed reply** says `truncated: false`, because the row does not store it.
