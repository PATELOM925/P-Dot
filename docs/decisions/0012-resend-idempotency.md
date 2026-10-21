# 0012: A resend or a retry does not repeat saved or running work

- Status: Proposed (2026-10-21), revised after two reviews (see "Review responses"). Design only. Nothing is built yet.
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

1. **The client sends a request key.** The browser makes one UUID for each user action (send a message, add a memory, add a document) and sends it in the `Idempotency-Key` header. It keeps the key while the identity of the action stays the same (see "Client changes"). It clears the key when the server confirms the save, and on any 409.
2. **The row stores the key and a request fingerprint, in the same insert.** `client_request_id uuid` and `client_request_hash text` on `conversations`, `messages` (user messages), `memories` and `documents`, with a unique index on `(user_id, client_request_id)`. The fingerprint is the SHA-256 of the identity of the action (below). It is written with the first row the action creates, so no partial state exists without it. Every recovery path compares it. A different fingerprint gets 409.
3. **The route looks up the key before any quota, spend or provider call.**
4. **One reply for each user message, and one worker at a time.** A reply row stores `reply_to`, the ID of its user message, with a unique index: the database refuses a second reply. Before any quota or paid call, a turn claims the right to write the reply with `claim_reply`, which locks the user message row and gives a claim with a lease. A new user message is inserted already claimed by the request that inserts it. A claim ends when the turn ends, or when its lease runs out (the Worker stopped). This applies to a fresh send, a resumed send and "Retry reply".
5. **Every prepared turn has one cleanup owner.** `prepareChatTurn` returns the turn with an idempotent `release()`. It gives back a hold that no attempt took, gives back a Tavily credit if the search did not start, and ends the claim. The generator's `finally` calls it, and so does the stream's `cancel()`, also before the first pull. A hold that an attempt took is settled by that attempt only, from its outcome.
6. **One database rule decides a document's status.** `settle_document(id)` locks the document row, counts its chunks and writes `ready` or `failed` only while the row is `processing`. It answers the status that the row has after the call. A trigger on `document_chunks` locks the same row and refuses chunks for a document that is not `processing`. So a chunk insert and a settle cannot pass each other.

The server also picks the ID of each row it inserts in these flows (conversation, user message, reply, memory, document). After a failed reply insert it reads the reply by that ID. If the reply is there, the turn writes the context record and sends `done`.

### Fingerprints

The server computes them. JSON array, UTF-8, SHA-256, lower-case hex. The first element is a version, so a later change cannot match an older row by chance.

| Action | Array | Stored on |
| --- | --- | --- |
| Send a message | `["chat.send.v1", target, text]`. `target` is the conversation ID, or `"new:" + mode`. `text` is the trimmed message. | The conversation it creates, and the user message |
| Add a memory | `["memory.create.v1", mode, content]` | The memory |
| Add a document | `["document.create.v1", mode, title, mediaType, text]` | The document |

`webSearch` and `effort` are not part of the chat fingerprint. A resend may change them, as "Retry reply" may.

A memory that the user edited after a lost response still matches, because the fingerprint is of the request, not of the current text. The resend gets 201 with the current memory.

### Rejected alternatives

- **The key in the JSON body.** Every request schema is `.strict()`. After a rollback, an open tab with the new script would get 400 on every send until reload. An older server ignores an unknown header.
- **Insert with `on_conflict` (upsert).** Quota, the Nebius hold and the embedding come before the insert, so a conflict at insert time is too late to save the cost. Also, PostgREST sends `ON CONFLICT (columns)` with no index predicate, so Postgres cannot use a partial unique index as the conflict target. A lookup first and a plain insert are simpler, and the unique index is the backstop.
- **A separate claim table.** It needs its own grants and RLS. Two columns on the user message do the same, under the same row lock.
- **Replay a saved reply on resend.** The client clears the key on `start`, so a keyed resend almost never finds a reply. The claim answers `answered` and the route gives 409. The screen reloads the conversation.
- **A "still processing" answer for documents.** The settle rule makes it safe to settle a document at once, so there is no wait window.
- **Fall back to "no key" when the new column is missing.** See "Deploy order".

## Migration

New file `supabase/migrations/20261021020000_resend_idempotency.sql` (after `20261021010000`). It only adds. Add its SHA-256 to `tests/integration/frozen-migrations.sha256`.

```sql
-- Resend idempotency and one reply for each message, EXPAND step (decision 0012).
--
-- Adds a client request key and fingerprint to the rows a user action
-- creates, a reply link and a reply claim on messages, and one rule for the
-- status of a document. The code on main does not use the new columns or
-- functions. Its writes still work: its chunk inserts go only into a
-- processing document, and it sets no new column. Older rows keep NULL.
--
-- Grants: authenticated has table-wide INSERT and SELECT on these tables
-- (20261021000000_memory_hardening.sql), so it can write and read the new
-- columns on insert. UPDATE is granted only on listed columns, so no API role
-- can change a key, a fingerprint, a reply link or a claim. No log trigger
-- reads these columns.

-- 1. Request key and fingerprint.
alter table public.conversations
  add column if not exists client_request_id uuid,
  add column if not exists client_request_hash text;
alter table public.messages
  add column if not exists client_request_id uuid,
  add column if not exists client_request_hash text;
alter table public.memories
  add column if not exists client_request_id uuid,
  add column if not exists client_request_hash text;
alter table public.documents
  add column if not exists client_request_id uuid,
  add column if not exists client_request_hash text;

alter table public.conversations add constraint conversations_client_request_pair check (
  (client_request_id is null) = (client_request_hash is null)
  and (client_request_hash is null or client_request_hash ~ '^[0-9a-f]{64}$'));
alter table public.messages add constraint messages_client_request_pair check (
  (client_request_id is null) = (client_request_hash is null)
  and (client_request_hash is null or client_request_hash ~ '^[0-9a-f]{64}$'));
alter table public.memories add constraint memories_client_request_pair check (
  (client_request_id is null) = (client_request_hash is null)
  and (client_request_hash is null or client_request_hash ~ '^[0-9a-f]{64}$'));
alter table public.documents add constraint documents_client_request_pair check (
  (client_request_id is null) = (client_request_hash is null)
  and (client_request_hash is null or client_request_hash ~ '^[0-9a-f]{64}$'));

-- The user ID is part of each index, so a conflict never shows that another
-- user has a row with the same key.
create unique index if not exists conversations_user_client_request_key
  on public.conversations (user_id, client_request_id) where client_request_id is not null;
create unique index if not exists messages_user_client_request_key
  on public.messages (user_id, client_request_id) where client_request_id is not null;
create unique index if not exists memories_user_client_request_key
  on public.memories (user_id, client_request_id) where client_request_id is not null;
-- A failed document leaves the index, so a resend with the same key can
-- upload again. At most one processing or ready document has a key.
create unique index if not exists documents_user_client_request_key
  on public.documents (user_id, client_request_id)
  where client_request_id is not null and status <> 'failed';

-- 2. One reply for each user message.
alter table public.messages
  add column if not exists reply_to uuid,
  add constraint messages_reply_to_fkey foreign key (reply_to, user_id)
    references public.messages (id, user_id) on delete cascade;
create unique index if not exists messages_reply_to_key
  on public.messages (reply_to) where reply_to is not null;

-- 3. The claim to write the reply of a user message. A request that inserts
-- a user message sets reply_claim_id in the same insert; the claim time is
-- then created_at. Only claim_reply and release_reply_claim change a claim.
alter table public.messages
  add column if not exists reply_claim_id uuid,
  add column if not exists reply_claimed_at timestamptz;

-- Outcomes: claimed (with claim_id), answered (with reply_id), busy, not_found.
-- Another user's message gets not_found, the same as a missing one.
create or replace function public.claim_reply(p_message_id uuid, p_lease_seconds integer)
returns table (outcome text, claim_id uuid, reply_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_message public.messages%rowtype;
  v_reply uuid;
  v_claim uuid;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if p_lease_seconds is null or p_lease_seconds < 60 or p_lease_seconds > 900 then
    raise exception 'invalid lease' using errcode = '22023';
  end if;

  select * into v_message from public.messages
   where id = p_message_id and user_id = v_user and role = 'user'
   for update;
  if not found then
    return query select 'not_found'::text, null::uuid, null::uuid;
    return;
  end if;

  select m.id into v_reply from public.messages m where m.reply_to = v_message.id;
  if v_reply is not null then
    return query select 'answered'::text, null::uuid, v_reply;
    return;
  end if;

  if v_message.reply_claim_id is not null
     and coalesce(v_message.reply_claimed_at, v_message.created_at)
         > now() - make_interval(secs => p_lease_seconds) then
    return query select 'busy'::text, null::uuid, null::uuid;
    return;
  end if;

  v_claim := gen_random_uuid();
  update public.messages set reply_claim_id = v_claim, reply_claimed_at = now()
   where id = v_message.id;
  return query select 'claimed'::text, v_claim, null::uuid;
end;
$$;

-- Ends a claim. Only the holder of the claim ID can end it. Returns true when
-- a claim ended.
create or replace function public.release_reply_claim(p_message_id uuid, p_claim_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  update public.messages set reply_claim_id = null, reply_claimed_at = null
   where id = p_message_id and user_id = v_user and reply_claim_id = p_claim_id;
  return found;
end;
$$;

revoke execute on function public.claim_reply(uuid, integer) from public, anon;
revoke execute on function public.release_reply_claim(uuid, uuid) from public, anon;
grant execute on function public.claim_reply(uuid, integer) to authenticated;
grant execute on function public.release_reply_claim(uuid, uuid) to authenticated;

-- 4. One rule for the status of a document.
--
-- A chunk insert locks its document row (FOR SHARE) and goes on only while
-- the document is processing. settle_document locks the same row (FOR
-- UPDATE) before it counts chunks. So a settle waits for a chunk insert that
-- has the lock, then counts its chunks; and a chunk insert that comes after
-- a settle is refused.
create or replace function public.check_document_chunk()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
begin
  select d.status into v_status from public.documents d
   where d.id = new.document_id and d.user_id = new.user_id
   for share;
  if v_status is distinct from 'processing' then
    raise exception 'chunks are accepted only while the document is processing' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke execute on function public.check_document_chunk() from public, anon, authenticated;
drop trigger if exists document_chunks_check on public.document_chunks;
create trigger document_chunks_check
  before insert on public.document_chunks
  for each row execute function public.check_document_chunk();

-- Settles one processing document of the caller: ready when it has chunks
-- and every chunk has a vector, otherwise failed. A document that is not
-- processing does not change. Returns the status after the call, or null
-- when the caller has no such document. SECURITY INVOKER: RLS applies.
create or replace function public.settle_document(p_document_id uuid)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_status text;
  v_chunks integer;
  v_missing integer;
begin
  select d.status into v_status from public.documents d
   where d.id = p_document_id and d.user_id = auth.uid()
   for update;
  if not found then
    return null;
  end if;
  if v_status <> 'processing' then
    return v_status;
  end if;
  select count(*), count(*) filter (where c.embedding is null)
    into v_chunks, v_missing
    from public.document_chunks c where c.document_id = p_document_id;
  v_status := case when v_chunks > 0 and v_missing = 0 then 'ready' else 'failed' end;
  update public.documents set status = v_status where id = p_document_id;
  return v_status;
end;
$$;
revoke execute on function public.settle_document(uuid) from public, anon;
grant execute on function public.settle_document(uuid) to authenticated;
```

Notes:

- `add column` with no default changes only the catalog. The new check constraints scan each table once; all rows are NULL. `create unique index` blocks writes to the table while it builds; the tables are small. `concurrently` cannot run inside the migration transaction.
- No new table. The Supabase change of 2026-10-30 (no automatic grants on new public tables) does not apply. The gate run with no default grants proves that the explicit grants cover the new columns and functions.
- `claim_reply` and `release_reply_claim` are SECURITY DEFINER because authenticated has no UPDATE on `messages`. They filter on `auth.uid()` themselves, as `decide_action_proposal` does. `settle_document` is SECURITY INVOKER: authenticated has `update (status)` on `documents`, and RLS applies.
- A user can set the new columns on an own insert through the API (table-wide INSERT). The worst result is that the user blocks the reply to an own message until the lease ends, or makes an own document refuse chunks. It never touches another user's rows. The foreign key on `reply_to` includes `user_id`.
- The log triggers build the detail from named columns. The new columns never reach `action_log`.

## Chat turn order

The same order for every turn. A step that refuses answers before the next step runs.

1. Session, origin, body, key header (not a UUID: 400).
2. Ownership reads (conversation, recent messages).
3. Key lookup (send with a key only). See the table below.
4. Claim (resumed send and "Retry reply"): `claim_reply(userMessageId, lease)`. `answered` or `busy`: 409, nothing else runs. A fresh send has no user message yet; it claims in step 6.
5. Quota, then the Nebius hold, then the Tavily credit if search is on. A refusal ends the claim (`release()`).
6. Fresh send only: insert the conversation (if new) and the user message, with the key, the fingerprint, a server ID and `reply_claim_id`. If an insert fails, `release()` gives the holds back and ends the claim, and the route answers 500.
7. Stream. The reply insert carries `reply_to` and a server ID. `release()` runs when the stream ends or is cancelled.

The lease is `REPLY_CLAIM_LEASE_MS` in `src/lib/limits.ts`, 300 seconds, passed to `claim_reply`. A unit test checks that it is more than the longest tier deadline (150 seconds) plus the search timeout (10 seconds), with a margin. The function refuses a lease outside 60 to 900 seconds.

## Per-route behavior

"K" is the request key. A request without a key (an older open tab) does no lookup. It still gets the claim, the reply link and the cleanup owner.

### `POST /api/chat`, action `send` with K

| State that the first request left | What the resend does |
| --- | --- |
| No row with K | A fresh send. |
| A conversation with K, no user message with K, the conversation is empty, same fingerprint | Uses that conversation. A fresh send into it. |
| A conversation with K that has messages | 409. Nothing is written. |
| A user message with K, same fingerprint, it is the last message of its conversation | Claims it. `claimed`: quota, holds, stream, as "Retry reply". `busy` (the first request is still running): 409. `answered`: 409. |
| A user message with K that is not the last message | 409: "This message was already sent. Reload the conversation." |
| A row with K and another fingerprint | 409. Nothing is written. No quota, no hold. |
| Another request with K inserts at the same time (both lookups missed) | The unique index refuses the second insert. That request releases its holds and answers 500. Only one user message, one claim and one provider call exist. Its quota unit stays used. |

### `POST /api/chat`, action `retry`

The precondition does not change: the last message must be from the user. Then the claim, as in step 4. Two "Retry reply" requests at the same time give one reply: the second gets `busy`, 409.

### Reply save inside the stream

| Fault | Behavior |
| --- | --- |
| Reply insert lost | Read the reply by its server ID. It is there: write the context record, send `done`. |
| Reply insert refused | The read finds nothing. The error event, as today. The claim ends; "Retry reply" works. |
| Reply insert refused by `messages_reply_to_key` | Another worker saved a reply after this claim's lease ended. The error event says to reload. |
| Lost, and the read also fails | The error event. The claim ends. "Retry reply" gets 409 (`answered`), and the screen reloads the conversation, so the reply shows. It has no context record. |

### `POST /api/memories` with K

The lookup runs before the embedding.

| State | What the resend does |
| --- | --- |
| No memory with K | Embeds, inserts with K and the fingerprint, 201. |
| A memory with K, same fingerprint | 201 with that memory (its current text). No embedding, no hold. |
| A memory with K, another fingerprint | 409. |
| The memory was deleted since | No row with K: it is saved again. The user asked for it again. |
| Two requests with K miss the lookup at the same time | Both embed. The unique index refuses the second insert; that request reads by K and answers 201 with the first row. Two embedding charges, each under $0.0001, are accepted. A claim before the embedding would cost a new write path for this rare case. |

### `POST /api/documents` with K

The lookup reads only rows that are not `failed`.

| State | What the resend does |
| --- | --- |
| No document with K, or only `failed` ones | A normal upload with K. |
| Another fingerprint | 409. |
| `ready` | 201 with that document. No embedding. |
| `processing` | `settle_document`. `ready`: 201, no embedding. `failed`: a normal upload with K (the failed row left the index). If the first request is still running, its chunk insert is now refused, so it cannot make a second ready copy. Two embedding charges, each under $0.001, are accepted in this overlap. |

The upload itself:

- After the chunk insert, the route calls `settle_document` and answers from its result. 201 only for `ready`.
- On any error after the document exists, the route calls `settle_document`. `ready` (for example the chunk insert was lost, but committed): 201. `failed`: the error answer of today (429, 413, 502 or 500). If the settle call also fails: 500, and the next resend or list settles it.
- `GET /api/documents` settles stale rows with the same function. `setStatus` and the three queries of `settleStaleDocuments` go away.

## Spend and quota

- No row and no provider call is made twice for the same message, memory or document, except the two accepted embedding overlaps above.
- A resend that finds saved work (memory, ready document, answered message) uses no quota, holds no spend and calls no provider.
- A resend that does new paid work (the reply was never saved) uses one quota unit and holds spend, as "Retry reply" does. The claim comes first, so a `busy` or `answered` turn uses neither.
- The first request's quota unit is not given back: `consume_chat_quota` has no refund. A failed send and its resend count two units, as a failed send and "Retry reply" do today.
- `release()` gives back only a hold that no attempt took, and a Tavily credit only if the search did not start. A hold that an attempt took is settled from the attempt's outcome; when the outcome is unknown, the full hold stays counted (decision 0006).
- A lost reservation response (the hold committed, the call failed) leaves that hold counted. That is the safe side, and the sweep allows one open hold for each spend write fault.
- Only `src/server/assistant/spend.ts` computes a hold. This change adds no hold.

## Client changes

- `src/lib/request-key.ts`: `RequestKey`. `keyFor(scope)` returns the current key while the scope string is the same, and a new `crypto.randomUUID()` when it changes. `clear()` forgets it. Pure scope builders for each action are in the same file and are unit-tested.
- `src/lib/api-client.ts`: `apiRequest` and `sendJson` accept extra headers.
- Chat: the scope is the target (conversation ID, or "new" and the mode) and the trimmed text, the same parts as the fingerprint. Cleared on `start` (the user message is saved) and on any 409. On a 409, the screen reloads the conversation list and the open conversation, and keeps the draft. After a 409 from "Retry reply", it reloads the conversation.
- Memory: the scope is the mode and the text. Cleared on 201 and on 409.
- Documents: the scope is the chosen file (name, size, last change time), the title and the mode. A new file choice is a new scope. Cleared on 201 and on 409.
- Server: `src/server/http/request.ts` reads the header. `src/lib/schemas.ts` and `src/types/api.ts` do not change.
- Logs: new events carry the request ID and flags (`resumed`, `claim_busy`, `claim_answered`), never the key, the fingerprint or any text.

## Also in the code PR: the open hold on early cancel

This exists on main today, without keys. `toNdjsonStream` gets the turn's `release()` and calls it in `cancel()` after `events.return()`. `release()` is idempotent, and the generator's `finally` calls it too. A test cancels the stream before its first pull and checks that no Nebius hold or Tavily credit stays open and the claim ended.

## Test plan

### Test support

- `tests/support/write-faults.ts` gets a third fault, `delayed`: the call fails at once and the write commits later, when the scenario calls `flushDelayed()` (a timeout while the database still runs the statement). `wrap` can mark read methods as faultable (`refused` only), so a failed recovery read is swept too: the reply read-back, the key lookups and `settle_document`.
- The fake repositories enforce the new unique indexes (key per user, `reply_to`) and the claim rules, and fail with the same error shape as the database.
- A barrier helper holds a fake (quota, provider, embedder) until the test releases it, so two requests can overlap at a chosen step.

### Unit tests

Each `it.fails` becomes a passing `it`. The tests send the same K on both requests, as the screen does.

- `api-routes.test.ts`:
  - The four resend cases and the lost reply case pass. `KNOWN_DUPLICATES` goes away: every sweep case checks for one conversation, one message and one reply.
  - Barrier: the first request is streaming (provider held), then a resend with K and a "Retry reply" each get 409 `busy`. One provider call, one quota unit for the stream, no open hold, one reply.
  - Barrier: two sends with K both miss the lookup (held at quota). One conversation, one user message, one provider call; the loser's holds are settled; quota counts two.
  - A claim whose lease ended (clock moved past it) can be claimed again; a reply insert that the `reply_to` index refuses gives the error event and no second reply.
  - Fingerprint 409: another text, another target, another mode; also when only the conversation with K exists (the case the title could not check). No quota, no hold.
  - A conversation with K that already has messages: 409.
  - A key that is not a UUID: 400. A request without a key: no lookup.
  - Bob sends Alice's K: no lookup hit, his own rows.
  - Cancel before the first pull: no open Nebius hold, no open Tavily credit, claim ended.
  - A lost reservation response, then a resend: one reply; at most one hold counted for the spend fault.
  - New code against a database without the migration (the lookup and claim calls fail with a missing column or function): 500 before quota, spend and writes for a keyed send and for "Retry reply".
- `memories-routes.test.ts`: the lost insert case passes. The sweep sends K and drops the duplicate exception. Replay makes no embedding call. Fingerprint 409. Edited after the lost response: 201 with the current text. Deleted, then resent: saved again. Barrier: two requests miss the lookup; one row, both 201, two embedding charges and no open hold.
- `documents-routes.test.ts`: both resend cases pass. The sweep sends K, includes `delayed` on the chunk insert and `refused` on `settle_document`, and drops the `failedButReady` exception. A `processing` row with all chunks: 201 and no embedding. A `failed` row does not block K. Fingerprint 409. A delayed chunk commit after a settle wrote `failed` is refused, and the list never shows two ready copies.
- `request-key.test.ts`: same scope, same key; changed text, target, mode, title or file, new key; `clear()`, new key; a lost response keeps the key.
- `limits.test.ts` (or the nearest existing file): the lease is more than the longest deadline plus the search timeout, with a margin.

### Database gate (`tests/integration/sql-gate.test.ts`, both grant modes)

- `PROTECTED_COLUMNS` gets `client_request_id`, `client_request_hash`, `reply_to`, `reply_claim_id` and `reply_claimed_at`, so authenticated cannot update them on any table.
- For each of the four tables: the same user cannot insert two rows with one key (23505); two users can use the same key; many NULL rows work; a key without a fingerprint, or a bad fingerprint, is refused (23514).
- A `failed` document frees its key; `processing` and `ready` do not.
- `reply_to`: a second reply to one message is refused; a reply cannot point at another user's message.
- `claim_reply`: `claimed`, then `busy`, then `answered` after a reply; another user's message gives `not_found`; no session gives 28000; anon cannot call it; a lease outside 60 to 900 is refused; an ended lease can be claimed again. `release_reply_claim` ends only a claim with the right ID.
- `settle_document` and the chunk trigger: chunks then settle gives `ready`; settle then chunks refuses the chunks; a `ready` or `failed` document does not change; another user's document gives null. The gate has one connection, so it checks both orders one after the other, not two sessions at the same time. The lock order (FOR SHARE in the trigger, FOR UPDATE in the settle) is what serializes them.
- Memory and document inserts with a key write log rows whose detail has no key or fingerprint.
- New functions are added to the list of functions the app uses, and anon cannot execute them.
- Upgrade: rows inserted before the new migration keep NULL and read through the app's repositories.

`tests/integration/sql-gate-app.test.ts`: the new repository methods against the real SQL. In the expand PR, the same file runs main's repositories against the new schema, which proves that main keeps working. `tests/support/sql-gate.ts` gets a `stopBefore` option, so the code PR can run the new repositories against a schema without the migration and check that they fail before any write.

`tests/integration/frozen-migrations.test.ts`: passes with the new hash line.

## Deploy order

Two pull requests, like PR #18 then PR #13. No contract step: nothing is removed.

1. **Database (expand).** Branch `om/resend-expand-db`, base `main`. The migration, the hash line, the gate tests, this record, a DEPLOYMENT.md entry under "Expand, then contract" and a CHANGELOG entry. The code on main does not use the new objects.
   - Check 1: Om confirms in the Supabase dashboard that `20261021020000_resend_idempotency` is in the migration history, and that the new columns, the five indexes, the three functions and the trigger exist.
2. **Code.** Branch `om/resend-idempotency`, base `main`, made from the tip of step 1 so that its tests have the migration. After step 1 merges, its diff shows only the code. Merge only after check 1. It holds the server, the client, the unit tests, the early cancel fix, the updates to decision 0009 ("Known limit" under `documents.status`) and `ARCHITECTURE.md`, and a CHANGELOG entry.

Before the migration, the code fails closed: a keyed send and "Retry reply" answer 500 at the lookup or the claim, before quota, spend and writes. A send without a key (an older tab) fails at the user message insert, which sets `reply_claim_id`, and `release()` gives its holds back. Its quota unit stays used, and in a new conversation the empty conversation stays. Do not use a Preview of the step 2 branch before check 1, because Previews use the production database.

I chose no fallback to "no key" when the column is missing. The new code uses two columns of the key, three more columns and three functions. A fallback for only the key column would still fail at the claim, and a fallback for all of them would run chat without the reply claim, which brings back two replies for one message without a sign. The deploy order already keeps this window closed, and the gate proves both schema combinations: main's code on the new schema (step 1), and the new code on the old schema fails before any write (step 2).

Rollback: a Worker version from before step 2 ignores the header and the new objects, so it is safe. Its replies have no `reply_to` and it does not claim, so it can again make two replies for one message. Never undo the migration by hand.

## Limits

- **A paused stream can outlive its lease.** The stream is pull-based. If a reader stops reading but keeps the connection open, the reply save waits. After 300 seconds a second request can claim the message and pay for a second reply. `messages_reply_to_key` still allows only one saved reply.
- **Quota.** A failed send and its resend count two units. The loser of two overlapping keyed sends uses one unit with no reply.
- **Lost reply and failed read.** The reply shows after a reload but has no context record.
- **Empty conversation.** If the user never sends again after a refused first message, the empty conversation stays. A resend with the same draft uses it.
- **Embedding overlaps.** Two overlapping memory or document requests with one key can each pay for an embedding. Only one row is kept.
- **The gate has one connection.** It checks the document lock rule in both orders, not as two live sessions.
- **Older open tabs** send no key. Their resends behave as today until the page reloads, but they still get the claim and one reply for each message.

## Review responses

The design was reviewed twice on 2026-10-21. Each finding and its answer:

| Finding | Answer |
| --- | --- |
| P1: a saved user message does not claim its reply; a resend and an active request both answer it (confirmed) | Fixed. Rules 4 and 5: `reply_to` with a unique index, and `claim_reply` with a lease before quota and paid calls, for every turn, including "Retry reply". A user message is inserted already claimed. |
| P2: a stream cancelled before its first pull leaves its hold open (confirmed, on main today) | Fixed in the code PR. Rule 5: `release()` is owned by the prepared turn and called from `cancel()` too. Only an untaken hold is given back. Test cancels before the first pull. |
| P2: a conversation with K and no message cannot check the content (confirmed) | Fixed. Rule 2: `client_request_hash` on every keyed row, written in the first insert. Test with different content when only the conversation exists. |
| P2: a late chunk commit can contradict a `failed` settle (plausible) | Fixed with one database rule (rule 6): the chunk trigger and `settle_document` lock the same row. Status changes answer the resulting status, and the route answers 201 only for `ready`. A `delayed` fault tests the late commit. |
| Test additions: overlap barriers, two memory requests, early cancel, lost reservation, delayed commit, failed recovery reads, settle conditional update lost, cross-user K, client key cases | All added to the test plan. Two embedding charges for overlapping memory requests are accepted and stated. |
| P1: state each PR's base and merge order | Done in "Deploy order". Both PRs target `main`; the database PR merges first. |
| P1: the client must clear the key on any 409 | Done. All three screens clear the key on 409 and keep the draft. Chat also reloads. |
| P2: missing-column fallback, or fail closed | Fail closed. The argument is in "Deploy order". Both schema combinations are tested. |
| P2: refuse the keyed retry for a young unanswered message, or add `reply_to` | Covered by the claim: a running request makes the message `busy`. |
| P2: a lost document create blocks the resend for 10 minutes | Removed. The settle rule makes it safe to settle at once, so there is no wait window and no "still processing" answer. |
| P3: drop the "replay saved reply" row | Done. `answered` gives 409 and the screen reloads. |
| P3: a conversation with K that has messages should get 409 | Done. |
| P3: the retry precondition could look for a reply newer than the last user message | Done in a stronger form: `claim_reply` answers `answered` from `reply_to`, not from times. The "last message is from the user" check stays for older replies, which have no `reply_to`. |

Rejected from the first version of this record: the replayed `done` event, the 409 "still being added" for documents, the fingerprint of document metadata only, and the readback after a lost user message insert (the key and the claim cover it).
