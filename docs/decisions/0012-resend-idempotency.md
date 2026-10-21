# 0012: A resend or a retry does not repeat saved or running work

- Status: Accepted for build (2026-10-21), after two rounds of review (see "Review responses").
- Related: [0006 spend guard](0006-global-spend-guard.md), [0007 model routing](0007-model-routing.md), [0009 memory and documents](0009-memory-documents-actions.md), [DEPLOYMENT.md](../DEPLOYMENT.md) ("Expand, then contract"), `tests/support/write-faults.ts`.

## Problem

Some writes commit, but the caller sees an error ("lost"). Some requests stop after an earlier write committed. The route then answers 500. The screen gives the draft back, and the user sends it again. The resend cannot see what the first request saved or is still doing, so it does the work again.

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

The review found three more defects:

- **Two replies for one message.** A request whose response was lost can still be running. A resend, or "Retry reply", that finds the user message without a reply starts a second reply. Both use quota, hold spend, call the provider and save a reply. This is also true today for two "Retry reply" requests.
- **A hold stays open when the stream never starts.** `prepareChatTurn` reserves the Nebius hold before the response exists. If the response stream is cancelled before its first pull, `toNdjsonStream` calls `events.return()`. The generator body never ran, so its `finally` (which settles the hold) never runs. This is on main today.
- **A late chunk insert can contradict a settle.** A chunk insert can time out at the caller and commit later, after a settle read no chunks and wrote `failed`.

## Decision

Six rules. Each one closes a named defect, and no rule repeats another.

1. **The client sends a request key.** The browser makes one UUID for each user action (send a message, add a memory, add a document) and sends it in the `Idempotency-Key` header. It keeps the key while the identity of the action stays the same (see "Client changes"). It clears the key when the server confirms the save, and when the server says the request does not match the saved one. It keeps the key when the server says the work is still running (see "Client changes").
2. **The row stores the key and a request fingerprint, in the same insert.** `client_request_id uuid` and `client_request_hash text` on `conversations`, `messages` (user messages), `memories` and `documents`, with a unique index on `(user_id, client_request_id)`. The fingerprint is the SHA-256 of the identity of the action (below). It is written with the first row the action creates, so no partial state exists without it. Every recovery path compares it. A different fingerprint gets 409.
3. **The route looks up the key before any quota, spend or provider call.**
4. **One reply for each user message, and one worker at a time.** A reply row stores `reply_to`, the ID of its user message, with a unique index on `(user_id, reply_to)`: the database refuses a second reply. Before any quota or paid call, a turn claims the right to write the reply with `claim_reply`, which locks the user message row and gives a claim with a lease. A new user message is inserted already claimed by the request that inserts it. A claim ends when the turn ends, or when its lease runs out (the Worker stopped). This applies to a fresh send, a resumed send and "Retry reply".
5. **Every prepared turn has one cleanup owner.** `prepareChatTurn` returns the turn with an idempotent `release()`. It gives back a hold that no attempt took, gives back a Tavily credit if the search did not start, and ends the claim. The generator's `finally` calls it, and so does the stream's `cancel()`, also before the first pull. A hold that an attempt took is settled by that attempt only, from its outcome.
6. **One database rule decides a document's status.** `settle_document(id)` locks the document row, counts its chunks and writes `ready` or `failed` only while the row is `processing`. It answers the status that the row has after the call. A trigger on `document_chunks` locks the same row and refuses chunks for a document that is not `processing`. So a chunk insert and a settle cannot pass each other. Both run as the caller (SECURITY INVOKER), so RLS applies and a caller learns nothing about another user's document.

The server picks the ID of the user message and of the reply before it inserts them. The user message ID lets a turn end its claim even when the insert response is lost. After a failed reply insert, the server reads the reply by its ID. If the reply is there, the turn writes the context record and sends `done`. After a failed memory insert with a key, it reads the memory by the key.

### Fingerprints

The server computes them. JSON array, UTF-8, SHA-256, lower-case hex. The first element is a version, so a later change cannot match an older row by chance.

| Action | Array | Stored on |
| --- | --- | --- |
| Send a message | `["chat.send.v1", target, text]`. `target` is the conversation ID, or `"new:" + mode`. An omitted mode is `personal`, the default the route uses. `text` is the message after the schema trims it. | The conversation it creates, and the user message |
| Add a memory | `["memory.create.v1", mode, content]`, with `content` trimmed by the schema | The memory |
| Add a document | `["document.create.v1", mode, title, mediaType, text]`, with `title` trimmed by the schema and `text` exactly as the schema accepts it | The document |

The server hashes the values after schema validation, so two requests that the route treats as the same action have the same fingerprint.

`webSearch` and `effort` are not part of the chat fingerprint. A resend may change them, as "Retry reply" may.

A memory that the user edited after a lost response still matches, because the fingerprint is of the request, not of the current text. The resend gets 201 with the current memory.

### Rejected alternatives

- **The key in the JSON body.** Every request schema is `.strict()`. After a rollback, an open tab with the new script would get 400 on every send until reload. An older server ignores an unknown header.
- **Insert with `on_conflict` (upsert).** Quota, the Nebius hold and the embedding come before the insert, so a conflict at insert time is too late to save the cost. Also, PostgREST sends `ON CONFLICT (columns)` with no index predicate, so Postgres cannot use a partial unique index as the conflict target. A lookup first and a plain insert are simpler, and the unique index is the backstop.
- **A separate claim table.** It needs its own grants and RLS. Two columns on the user message do the same, under the same row lock.
- **Replay a saved reply on resend.** The client clears the key on `start`, so a keyed resend almost never finds a reply. The claim answers `answered` and the route gives 409 `answered`. The screen reloads the conversation.
- **A "still processing" answer for documents.** The settle rule makes it safe to settle a document at once, so there is no wait window.
- **Fall back to "no key" when the new column is missing.** See "Deploy order".

## Migration

`supabase/migrations/20261021020000_resend_idempotency.sql`. It only adds, and its SHA-256 is in `tests/integration/frozen-migrations.sha256`. It has four parts:

1. `client_request_id uuid` and `client_request_hash text` on `conversations`, `messages`, `memories` and `documents`. A check constraint on each table: both are NULL or both are set, and the fingerprint is 64 lower-case hex characters. A unique index on `(user_id, client_request_id)` where the key is set. On `documents`, the index also leaves out `failed` rows, so a resend can upload again after a failure.
2. `messages.reply_to uuid`, with a foreign key on `(reply_to, user_id)` to `messages (id, user_id)` and a unique index on `(user_id, reply_to)`. A reply can only point at a message of the same user, and a message has at most one reply. The index includes `user_id`, so a reply to another user's message always gets the foreign key error (23503), whether that message has a reply or not.
3. `messages.reply_claim_id uuid` and `reply_claimed_at timestamptz`, and two functions:
   - `claim_reply(message_id, lease_seconds)` answers `claimed` with a claim ID, `answered` with the reply ID, `busy`, or `not_found`. It locks the user message row. A claim is live while `coalesce(reply_claimed_at, created_at)` is newer than the lease. Another user's message, an assistant message and a missing one all get `not_found`.
   - `release_reply_claim(message_id, claim_id)` ends a claim, only for the holder of the claim ID.
   - Both are SECURITY DEFINER with an empty search path, because authenticated has no UPDATE on `messages`. They filter on `auth.uid()`, as `decide_action_proposal` does. A lease outside 60 to 900 seconds gets 22023, and no session gets 28000.
4. The document rule:
   - The trigger function `check_document_chunk` runs before each chunk insert. A chunk for another user gets 42501, as RLS gives, before any read. Then it locks the document row (FOR SHARE) and goes on only while that row is the caller's and `processing`. Another user's document, a missing one, and an own `ready` or `failed` one all get the same 23514.
   - `settle_document(document_id)` locks the row (FOR UPDATE), counts chunks and writes `ready` (chunks, each with a vector) or `failed` only while the row is `processing`. It returns the status after the call, or NULL when the caller has no such document.
   - Both are SECURITY INVOKER, so RLS applies. Authenticated has `update (status)` on `documents`, which the row lock needs.

Notes:

- The code on main does not use the new objects. Its writes still work: it sets no new column, and it inserts chunks only into a document that is still `processing`. The gate runs main's repositories on the new schema.
- `add column` with no default changes only the catalog. The check constraints scan each table once; all rows are NULL. `create unique index` blocks writes while it builds; the tables are small.
- No new table. The Supabase change of 2026-10-30 (no automatic grants on new public tables) does not apply. The gate run with no default grants proves that the explicit grants cover the new columns and functions.
- A user can set the new columns on an own insert through the API (table-wide INSERT). The worst result is that the user blocks the reply to an own message until the lease ends, or makes an own document refuse chunks. It never touches another user's rows.
- The log triggers build the detail from named columns. The new columns never reach `action_log`.

## Chat turn order

The same order for every turn. A step that refuses answers before the next step runs.

1. Session, origin, body, key header (not a UUID: 400).
2. Ownership reads (conversation, recent messages).
3. Key lookup, for a send with a key only. First the user message with K. Only when no message has K, and the request is for a new conversation, the conversation with K. (A user message insert can be lost after its conversation was saved. Then the conversation has a message, and the message lookup must answer first.)
4. Claim, for a resumed send and "Retry reply": `claim_reply(message, lease)`. `answered` or `busy`: 409, and nothing else runs. A fresh send has no user message yet; it claims in step 6.
5. Quota, then the Nebius hold, then the Tavily credit if search is on. A refusal ends the claim.
6. Fresh send only: insert the conversation (if new) and the user message, with the key, the fingerprint, a server ID and `reply_claim_id`. If an insert fails, the turn's cleanup gives the holds back and ends the claim, and the route answers 500.
7. Stream. The reply insert carries `reply_to` and a server ID. The cleanup runs when the stream ends or is cancelled.

The lease is `REPLY_CLAIM_LEASE_SECONDS` in `src/lib/limits.ts`, 300 seconds. A unit test checks that it is more than the longest tier deadline (150 seconds) plus the Tavily timeout (10 seconds), with a margin.

## Per-route behavior

"K" is the request key. A request without a key (an older open tab) does no lookup. It still gets the claim, the reply link and the cleanup.

The 409 answers have three codes, so the screen can act on each:

| Code | Meaning | What the screen does |
| --- | --- | --- |
| `busy` | Another request is still writing the reply to this message. | Keeps K and the draft. Shows "P-Dot is still replying. Try again in a few minutes." |
| `answered` | This message is already saved, and it has a reply or later messages. The body has `conversationId`. | Reloads that conversation. If a saved user message has the draft text, it clears the draft and K. |
| `conflict` | K belongs to a different request. | Clears K and keeps the draft. The next send is a new action. |

### `POST /api/chat`, action `send` with K

| State that the first request left | What the resend does |
| --- | --- |
| No row with K | A fresh send. |
| A user message with K, same fingerprint, the last message of its conversation | Claims it. `claimed`: quota, holds, stream, as "Retry reply". `busy`: 409 `busy`. `answered`: 409 `answered`. |
| A user message with K that is not the last message | 409 `answered`: "This message was already sent. Reload the conversation." |
| No user message with K, a conversation with K, empty, same fingerprint | Uses that conversation. A fresh send into it. |
| No user message with K, a conversation with K that has messages, same fingerprint | Another request with K can have saved its message since the first lookup, so the route reads the message with K again. Found: the rows above (claim, `busy` or `answered`). Not found: the conversation holds other messages, so 409 `conflict`. |
| A row with K and another fingerprint | 409 `conflict`. Nothing is written. No quota, no hold. |
| Two requests with K miss the lookup at the same time | The unique index refuses the second insert. That request gives its holds back and answers 500. One user message, one claim and one provider call. Its quota unit stays used. |

### `POST /api/chat`, action `retry`

If the last message is a reply, the route answers 409 `answered` with the conversation: the reply is saved, but its response may have been lost, so the screen reloads. If the last message is from the user, the claim, as in step 4. An empty conversation gets 409 `conflict`, as before. Two "Retry reply" requests at the same time give one reply: the second gets 409 `busy`.

### Reply save inside the stream

| Fault | Behavior |
| --- | --- |
| Reply insert lost | Read the reply by its server ID. It is there: write the context record, send `done`. |
| Reply insert refused | The read finds nothing. The error event, as today. The claim ends; "Retry reply" works. |
| Reply insert refused by `messages_reply_to_key` | Another request saved a reply after this claim's lease ended. The error event. "Retry reply" then gets 409 `answered`, and the screen reloads. |
| Lost, and the read also fails | The error event. The claim ends. "Retry reply" gets 409 `answered`, and the screen reloads the conversation, so the reply shows. It has no context record. |

### `POST /api/memories` with K

The lookup runs before the embedding.

| State | What the request does |
| --- | --- |
| No memory with K | Embeds, inserts with K and the fingerprint, 201. |
| A memory with K, same fingerprint | 201 with that memory (its current text). No embedding, no hold. |
| A memory with K, another fingerprint | 409 `conflict`. |
| The memory was deleted since | No row with K: it is saved again. The user asked for it again. |
| The insert fails | Reads by K. A row with the same fingerprint (the insert was lost, or another request with K won): 201 with it. Otherwise 500. |
| Two requests with K miss the lookup at the same time | Both embed. The second insert is refused; it reads by K and answers 201 with the first row. Two embedding charges, each under $0.0001, are accepted. A claim before the embedding would cost a new write path for this rare case. |

### `POST /api/documents` with K

The lookup reads only rows that are not `failed`.

| State | What the request does |
| --- | --- |
| No document with K, or only `failed` ones | A normal upload with K. |
| Another fingerprint | 409 `conflict`. |
| `ready` | 201 with that document. No embedding. |
| `processing` | `settle_document`. `ready`: 201, no embedding. `failed`: a normal upload with K (the failed row left the index). If the first request is still running, its chunk insert is now refused, so it cannot make a second ready copy. Two embedding charges, each under $0.001, are accepted in this overlap. |

The upload itself:

- After the chunk insert, the route calls `settle_document` and answers 201 only for `ready`.
- On any error after the document exists, the route calls `settle_document`. `ready` (for example the chunk insert was lost, but committed): 201. Otherwise the error answer of today (429, 413, 502 or 500). If the settle call also fails, the route logs `document_status_write_failed`, answers with the first error, and the next resend or list settles the document.
- `GET /api/documents` settles stale rows with the same function. `setStatus` goes away.

## Spend and quota

- No row is saved twice for the same message, memory or document.
- No provider call is made twice for the same message while a claim is live. A claim can end early in two cases, and then a second paid call can happen: a reader that stops reading keeps the stream open past the 300-second lease, or a Worker stops and its lease runs out while it was still running. `messages_reply_to_key` still keeps one saved reply. The two accepted embedding overlaps above are the other cases.
- A resend that finds saved work (memory, ready document, answered message) uses no quota, holds no spend and calls no provider.
- A resend that does new paid work (the reply was never saved) uses one quota unit and holds spend, as "Retry reply" does. The claim comes first, so a `busy` or `answered` turn uses neither.
- The first request's quota unit is not given back: `consume_chat_quota` has no refund. A failed send and its resend count two units, as a failed send and "Retry reply" do today.
- The cleanup gives back only a hold that no attempt took, and a Tavily credit only if the search did not start. A hold that an attempt took is settled from the attempt's outcome; when the outcome is unknown, the full hold stays counted (decision 0006).
- A lost reservation response (the hold committed, the call failed) leaves that hold counted. That is the safe side.
- Only `src/server/assistant/spend.ts` computes a hold. This change adds no hold.

## Client changes

- `src/lib/request-key.ts`: `RequestKey`. `keyFor(scope)` returns the current key while the scope string is the same, and a new `crypto.randomUUID()` when it changes. `clear()` forgets it.
- `src/lib/api-client.ts`: `sendJson` accepts extra headers. `ApiError` carries `conversationId` from a 409 body.
- Chat: `src/features/chat/send-key.ts` holds the key for the draft. The scope is the target (conversation ID, or "new" and the mode) and the trimmed text, the same parts as the fingerprint. It clears the key on `start` (the user message is saved) and on 409 `conflict`. It keeps the key on 409 `busy`, on a network error and on 500. On 409 `answered`, the screen reloads the conversation and reconciles: if a saved user message has the draft text, the screen clears the draft and the key. The same rules apply to "Retry reply".
- Memory: the scope is the mode and the text. Cleared on 201 and on 409 `conflict`.
- Documents: the scope is one file choice, the title and the mode. A new file choice is a new scope. Cleared on 201 and on 409 `conflict`.
- Server: `src/server/http/request-key.ts` reads the header and computes the fingerprint. `src/lib/schemas.ts` does not change. `src/types/api.ts` gets the codes `busy` and `answered` and the optional `conversationId` in the error body.
- Logs: the new events carry the request ID and the route, never the key, the fingerprint or any text. When a lookup, insert or claim fails because a new column or function is missing (42703, PGRST204, 42883 or PGRST202), the route logs `schema_missing` with the request ID and answers 500. There is no fallback.

## Also in the code PR: the open hold on early cancel

This exists on main today, without keys. `toNdjsonStream` takes an `onCancel` callback and calls it in `cancel()` after `events.return()`. The chat route passes the turn's cleanup. The cleanup is idempotent and runs under `deps.waitUntil`, like the settles, so the isolate does not end before it commits. The generator's `finally` runs it too. A test cancels the stream before its first pull, waits on the `waitUntil` promises, and checks that no Nebius hold or Tavily credit stays open and the claim ended.

## Test plan

### Test support

- `tests/support/write-faults.ts` gets a third fault, `delayed`: the call fails at once and the write commits later, when the scenario calls `flushDelayed()` (a timeout while the database still runs the statement). `wrap` can mark methods as reads; the sweep makes a read fail only as `refused`. So failed recovery reads are swept too: the reply read-back, the key lookups and `settle_document`.
- The fake repositories enforce the new unique indexes (key per user, `reply_to`), the claim rules and the chunk rule, and fail with the same error shape as the database.
- A barrier helper holds a fake (quota, provider, embedder) until the test releases it, so two requests can overlap at a chosen step.

### Unit tests

Each `it.fails` becomes a passing `it`. The tests send the same K on both requests, as the screen does.

- `api-routes.test.ts`:
  - The four resend cases and the lost reply case pass. `KNOWN_DUPLICATES` goes away: every sweep case checks for one conversation, one message and one reply.
  - Barrier: the first request is streaming (provider held), then a resend with K and a "Retry reply" each get 409 `busy`. One provider call, one quota unit, no open hold, one reply.
  - Barrier: two sends with K both miss the lookup (held at quota). One conversation, one user message, one provider call; the loser's holds are settled; quota counts two.
  - A claim whose lease ended can be claimed again. A reply insert that the `reply_to` index refuses gives the error event and no second reply.
  - Fingerprint 409 `conflict`: another text, another target, another mode; also when only the conversation with K exists. No quota, no hold.
  - A conversation with K that already has messages: 409 `conflict`.
  - A key that is not a UUID: 400. A request without a key: no lookup.
  - Bob sends Alice's K: no lookup hit, his own rows.
  - Cancel before the first pull: no open Nebius hold, no open Tavily credit, claim ended.
  - A lost reservation response, then a resend: one reply; at most one hold counted for the spend fault.
  - A lookup or claim that fails with a missing column or function: 500, `schema_missing` logged, before quota, spend and writes.
- `chat-resend-flow.test.ts` (client to route): the full busy sequence. The first request keeps running after its response is lost; the screen's resend gets `busy` and keeps K and the draft; after the reply is saved, the next resend gets `answered`; the screen reloads, finds the saved message and clears the draft and K. One user message, one reply, one provider call, one quota unit, no open hold.
- `memories-routes.test.ts`: the lost insert case passes. The sweep sends K and drops the duplicate exception. A replay makes no embedding call. Fingerprint 409. Edited after the lost response: 201 with the current text. Deleted, then sent again: saved again. Barrier: two requests miss the lookup; one row, both 201, two embedding charges and no open hold.
- `documents-routes.test.ts`: both resend cases pass. The sweep sends K, includes `delayed` on the chunk insert and `refused` on `settle_document`, and drops the `failedButReady` exception. A `processing` row with all chunks: 201 and no embedding. A `failed` row does not block K. Fingerprint 409. A delayed chunk commit after a settle wrote `failed` is refused, and the list never shows two ready copies.
- `request-key.test.ts`: same scope, same key; changed text, target, mode, title or file, new key; `clear()`, new key.
- `request-key.test.ts` also checks that the lease is more than the longest deadline plus the Tavily timeout, with a margin.

### Database gate (both grant modes)

`tests/integration/sql-gate-resend.test.ts` (in the database PR):

- For each of the four tables: the same user cannot insert two rows with one key (23505); two users can use the same key; many NULL rows work; a key without a fingerprint, a fingerprint without a key and a bad fingerprint are refused (23514).
- A `failed` document frees its key; `processing` and `ready` do not.
- `reply_to`: a second reply to one message is refused; a reply to another user's answered or unanswered message gets the same error as a reply to a missing one.
- `claim_reply`: `claimed`, then `busy`, then `answered` after a reply; a message inserted with a claim ID is busy from its insert time; an ended lease can be claimed again; only the holder can release; another user's message, an assistant message and a missing one give the same `not_found`; a lease outside 60 to 900, no session and anon are refused.
- `settle_document` and the chunk rule: chunks then settle gives `ready`; settle then chunks refuses the chunks; a chunk without a vector settles `failed`; a `ready` or `failed` document does not change and writes no log row; another user's document gives NULL; a chunk for another user gets 42501; a chunk for another user's `processing`, `ready` or `failed` document and for a missing one gets the same 23514 with the same message.
- Memory and document inserts with a key write log rows without the key or the fingerprint.
- No API role has UPDATE on the new columns.
- The new calls work with only the explicit grants.
- Upgrade: rows from before the migration keep NULL, read through the app's repositories, and an older processing document settles.

`tests/integration/sql-gate.test.ts`: `PROTECTED_COLUMNS` gets the five new columns. The seed makes each document `processing`, inserts its chunk, then sets it `ready`, because the chunk rule refuses chunks for a `ready` document. The cross-user checks stay.

The gate has one connection. It checks the two orders of a chunk insert and a settle one after the other, not two live sessions. The lock order (FOR SHARE in the trigger, FOR UPDATE in the settle) is what serializes them.

In the code PR, `tests/support/sql-gate.ts` gets a `stopBefore` option, and a test runs the new repositories against the schema without this migration. It checks that the lookup and the claim fail with a missing-schema error, before any write.

## Deploy order

Two pull requests, like PR #18 then PR #13. No contract step: nothing is removed.

1. **Database (expand).** Branch `om/resend-expand-db`, base `main`. The migration, the hash line, the gate tests and the seed change, this record, the steps in `docs/DEPLOYMENT.md` and a CHANGELOG entry. The code on main does not use the new objects.
   - Check 1: Om confirms in the Supabase dashboard that `20261021020000_resend_idempotency` is in the migration history, and that these exist: the eight new columns on four tables plus `reply_to`, `reply_claim_id` and `reply_claimed_at`; the five indexes; the four functions `claim_reply`, `release_reply_claim`, `settle_document` and `check_document_chunk`; and the trigger `document_chunks_check`.
2. **Code.** Branch `om/resend-idempotency`, base `main`, made from the tip of step 1, so its tests have the migration. After step 1 merges, its diff shows only the code. Merge only after check 1. It holds the server, the client, the unit tests, the early cancel fix, and updates to decision 0009 and `ARCHITECTURE.md`, with a CHANGELOG entry.

Each step merges and deploys on its own, not in one batch with other pull requests (`docs/DEPLOYMENT.md`, "Merging several pull requests").

Before the migration, the new code fails closed. A keyed send and "Retry reply" answer 500 at the lookup or the claim, before quota, spend and writes. A send without a key (an older tab) fails at the user message insert, which sets `reply_claim_id`. Its cleanup gives the holds back, its quota unit stays used, and in a new conversation the empty conversation stays. Do not use a Preview of the step 2 branch before check 1, because Previews use the production database.

I chose no fallback to "no key" when a column is missing. The new code uses five new message and key columns and three functions. A fallback for only the key column would still fail at the claim, and a fallback for all of them would run chat without the reply claim, which brings back two replies for one message without a sign. Lesson 6 in `docs/PROVIDER-RELIABILITY.md` asks new code to work on the old schema because a migration and its code usually merge together. Here the expand step merges first and check 1 comes before the code merges, so the code never meets the old schema in production. The route logs `schema_missing` so that a wrong order is visible at once. The gate proves both combinations: main's code on the new schema (step 1), and the new code on the old schema fails before any write (step 2).

Rollback: a Worker version from before step 2 ignores the header and the new objects, so it is safe. Its replies have no `reply_to` and it does not claim, so it can again make two replies for one message. Never undo the migration by hand.

## Limits

- **A crashed Worker holds its claim until the lease ends.** If a Worker stops while it writes a reply, a resend or "Retry reply" of that message gets 409 `busy` for up to 300 seconds.
- **A paused stream can outlive its lease.** The stream is pull-based. If a reader stops reading but keeps the connection open, the reply save waits. After 300 seconds a second request can claim the message and pay for a second reply. `messages_reply_to_key` still allows only one saved reply.
- **Quota.** A failed send and its resend count two units. The loser of two overlapping keyed sends uses one unit with no reply.
- **Lost reply and failed read.** The reply shows after a reload but has no context record.
- **Empty conversation.** If the user never sends again after a refused first message, the empty conversation stays. A resend with the same draft uses it.
- **Embedding overlaps.** Two overlapping memory or document requests with one key can each pay for an embedding. Only one row is kept.
- **Older replies have no `reply_to`.** `claim_reply` cannot see them, so "Retry reply" keeps its precondition that the last message is from the user.
- **The gate has one connection.** It checks the document lock rule in both orders, not as two live sessions.
- **Older open tabs** send no key. Their resends behave as today until the page reloads, but they still get the claim and one reply for each message.

## Review responses

### Round 1

| Finding | Answer |
| --- | --- |
| P1: a saved user message does not claim its reply; a resend and an active request both answer it (confirmed) | Fixed. Rules 4 and 5: `reply_to` with a unique index, and `claim_reply` with a lease before quota and paid calls, for every turn, including "Retry reply". A user message is inserted already claimed. |
| P2: a stream cancelled before its first pull leaves its hold open (confirmed, on main today) | Fixed in the code PR. Rule 5: the cleanup is owned by the prepared turn and called from `cancel()` too. Only an untaken hold is given back. Test cancels before the first pull. |
| P2: a conversation with K and no message cannot check the content (confirmed) | Fixed. Rule 2: `client_request_hash` on every keyed row, written in the first insert. Test with different content when only the conversation exists. |
| P2: a late chunk commit can contradict a `failed` settle (plausible) | Fixed with one database rule (rule 6): the chunk trigger and `settle_document` lock the same row. Status changes answer the resulting status, and the route answers 201 only for `ready`. A `delayed` fault tests the late commit. |
| Test additions: overlap barriers, two memory requests, early cancel, lost reservation, delayed commit, failed recovery reads, settle conditional update lost, cross-user K, client key cases | All in the test plan. Two embedding charges for overlapping memory requests are accepted and stated. |
| P1: state each PR's base and merge order | Done in "Deploy order". |
| P1: the client must clear the key on any 409 | Replaced in round 2: the key is cleared only on `conflict`. |
| P2: missing-column fallback, or fail closed | Fail closed, with a `schema_missing` log. The argument is in "Deploy order". Both schema combinations are tested. |
| P2: refuse the keyed retry for a young unanswered message, or add `reply_to` | Covered by the claim: a running request makes the message `busy`. |
| P2: a lost document create blocks the resend for 10 minutes | Removed. The settle rule makes it safe to settle at once. |
| P3: drop the "replay saved reply" row | Done. `answered` gives 409 and the screen reloads. |
| P3: a conversation with K that has messages should get 409 | Done. |
| P3: the retry precondition could look for a reply newer than the last user message | Done in a stronger form: `claim_reply` answers `answered` from `reply_to`. The "last message is from the user" check stays for older replies. |

### Round 2

| Finding | Answer |
| --- | --- |
| P1: clearing the key on `busy` lets the user send the same draft again with a new key, which saves a second message and a second reply (confirmed) | Fixed. Three 409 codes (`busy`, `answered`, `conflict`), each with its own client rule. Only `conflict` clears the key. A client-to-route test runs the whole busy sequence. |
| P2: `check_document_chunk` as SECURITY DEFINER shows whether another user's document is processing (confirmed) | Fixed. It is SECURITY INVOKER, refuses a chunk for another user with 42501 before any read, and gives one 23514 for another user's document in any status and for a missing one. Tested. |
| P2: the chunk rule breaks the gate seed (confirmed) | Fixed. The seed makes the document `processing`, inserts the chunk, then sets `ready`. The cross-user checks stay. |
| P2: the cleanup from `cancel()` must run under `waitUntil` | Done. The early cancel test waits on the `waitUntil` promises. |
| P2: state the lookup order | Done in "Chat turn order", step 3. |
| P2: hash the validated values; qualify "no provider call twice"; name four functions in check 1 | Done in "Fingerprints", "Spend and quota" and "Deploy order". |
| P3: log `schema_missing`; add the crashed Worker case to the limits | Done. |

### Round 3 (code review of PRs #19 and #20)

| Finding | Answer |
| --- | --- |
| P1: two requests with one key overlap; the second finds the first one's conversation with messages and answers `conflict`, so the screen clears the key and sends the draft again (confirmed) | Fixed. When the conversation with the key has messages and the fingerprint matches, the route reads the message with the key again and takes the normal claim path (`busy` or `answered`). Only a different fingerprint gets `conflict`. A client-to-route barrier test covers it. |
| P3: a 409 `conflict` from "Retry reply" cleared the draft's key | Fixed. Only a send's answer can clear the key. Tested. |
| P3: the gate client answered one object for a function that returns a table, where PostgREST answers an array | Fixed. The gate client answers an array for a set-returning function, so the gate uses the production shape. |
| P2: `messages_reply_to_key` on `reply_to` alone shows whether another user's message has a reply (23503 or 23505) (confirmed) | Fixed. The index is on `(user_id, reply_to)`, so a reply to another user's message always gets 23503. The migration was not applied anywhere, so it was changed in place and its hash updated. The gate checks answered, unanswered and missing targets. |
