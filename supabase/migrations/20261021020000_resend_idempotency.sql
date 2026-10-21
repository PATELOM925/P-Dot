-- Resend idempotency and one reply for each message, EXPAND step (decision 0012).
--
-- Adds a client request key and fingerprint to the rows that a user action
-- creates, a reply link and a reply claim on messages, and one rule for the
-- status of a document. The code on main does not use the new columns or
-- functions, and its writes still work: it sets no new column, and it inserts
-- chunks only into a document that is still processing. Older rows keep NULL.
--
-- Grants: authenticated has table-wide INSERT and SELECT on these tables
-- (20261021000000_memory_hardening.sql), so it can set and read the new
-- columns. UPDATE is granted only on listed columns, so no API role can change
-- a key, a fingerprint, a reply link or a claim. No log trigger reads them.

-- ---------------------------------------------------------------------------
-- 1. Request key and fingerprint (a SHA-256 of the validated request).
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- 2. One reply for each user message. The foreign key includes user_id, so a
-- reply can only point at a message of the same user. The unique index also
-- includes user_id, so a reply that points at another user's message always
-- fails the foreign key (23503), whether or not that message has a reply.
-- ---------------------------------------------------------------------------
alter table public.messages add column if not exists reply_to uuid;
alter table public.messages add constraint messages_reply_to_fkey
  foreign key (reply_to, user_id) references public.messages (id, user_id) on delete cascade;
create unique index if not exists messages_reply_to_key
  on public.messages (user_id, reply_to) where reply_to is not null;

-- ---------------------------------------------------------------------------
-- 3. The claim to write the reply of a user message. A request that inserts a
-- user message sets reply_claim_id in the same insert; the claim time is then
-- created_at. After the insert, only claim_reply and release_reply_claim
-- change a claim.
-- ---------------------------------------------------------------------------
alter table public.messages
  add column if not exists reply_claim_id uuid,
  add column if not exists reply_claimed_at timestamptz;

-- Outcomes: claimed (with claim_id), answered (with reply_id), busy and
-- not_found. Another user's message gets not_found, like a missing one.
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

  select * into v_message from public.messages m
   where m.id = p_message_id and m.user_id = v_user and m.role = 'user'
   for update;
  if not found then
    return query select 'not_found'::text, null::uuid, null::uuid;
    return;
  end if;

  select m.id into v_reply from public.messages m where m.user_id = v_user and m.reply_to = v_message.id;
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

-- ---------------------------------------------------------------------------
-- 4. One rule for the status of a document.
--
-- A chunk insert locks its document row (FOR SHARE) and goes on only while
-- the document is processing. settle_document locks the same row (FOR UPDATE)
-- before it counts chunks. So a settle waits for a chunk insert that holds the
-- lock and then counts its chunks, and a chunk insert after a settle fails.
--
-- Both are SECURITY INVOKER, so RLS applies. A chunk for another user is
-- refused as RLS refuses it (42501), before any read. A chunk for another
-- user's document gets the same answer (23514) as for a missing document or a
-- document that is not processing, so it does not show the other status.
-- ---------------------------------------------------------------------------
create or replace function public.check_document_chunk()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if auth.uid() is not null and new.user_id is distinct from auth.uid() then
    raise exception 'new row violates row-level security policy for table "document_chunks"' using errcode = '42501';
  end if;
  perform 1 from public.documents d
   where d.id = new.document_id and d.user_id = new.user_id and d.status = 'processing'
   for share;
  if not found then
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

-- Settles one processing document of the caller: ready when it has chunks and
-- every chunk has a vector, otherwise failed. A document that is not
-- processing does not change. Returns the status after the call, or null when
-- the caller has no such document.
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
    from public.document_chunks c
   where c.document_id = p_document_id;
  v_status := case when v_chunks > 0 and v_missing = 0 then 'ready' else 'failed' end;
  update public.documents set status = v_status where id = p_document_id;
  return v_status;
end;
$$;
revoke execute on function public.settle_document(uuid) from public, anon;
grant execute on function public.settle_document(uuid) to authenticated;
