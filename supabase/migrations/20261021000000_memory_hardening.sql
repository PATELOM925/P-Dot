-- Memory hardening, EXPAND step (decision 0009, reviews of PRs #6, #12, #13).
--
-- 20261020000000_memory_documents_actions.sql is already on main and may be
-- applied. This file only adds to it, and the code on main keeps working
-- during and after it:
-- - Triggers write the action log with IDs, kinds, modes, counts and flags.
-- - public.decide_action_proposal claims, runs and records a decision in one
--   transaction.
-- - Validation triggers check new and changed rows only. An update that does
--   not touch the checked columns (for example the foreign key that clears
--   conversation_id) always works, also on older rows.
-- - A proposal status moves only forward: proposed to approved or rejected,
--   approved to executed or failed. A decided proposal cannot change again.
--   main's decision route uses exactly these steps.
-- - Explicit grants for every table and function the app uses, so a new
--   project without automatic grants works. TRUNCATE, REFERENCES and TRIGGER
--   are removed from the API roles.
--
-- The old insert grant and policy on action_log, and the old update grant
-- and policy on action_proposals, stay until the CONTRACT step
-- (20261021010000_memory_hardening_contract.sql). Apply that only after the
-- code that uses decide_action_proposal is live. Until then, main's code may
-- write a second log row for a change; the trigger row is the trusted one.
-- All writes still use the signed-in user's session. No service role key.

-- ---------------------------------------------------------------------------
-- Action proposals. The insert policy also refuses a decision or a result.
-- (main's code inserts only 'proposed' rows with neither.)
-- ---------------------------------------------------------------------------
drop policy if exists action_proposals_insert_own on public.action_proposals;
create policy action_proposals_insert_own on public.action_proposals
  for insert to authenticated
  with check ((select auth.uid()) = user_id and status = 'proposed' and decided_at is null and result is null);

-- Trust marker. decided_by_function is true only on a proposal that
-- public.decide_action_proposal decided. Only such a row is a record of an
-- action the database ran. A row decided by other updates (the older code,
-- or a user with the older update grant) stays false: its outcome is only
-- what a caller wrote. Rows from before this migration stay false.
alter table public.action_proposals
  add column if not exists decided_by_function boolean not null default false;

-- Checks new rows, and changes to the checked columns of any row:
-- - the payload names the row's kind (only when the payload or kind is written);
-- - a waiting proposal has no decision and no result;
-- - the status moves only forward, and a decided proposal does not change.
-- - decided_by_function is set here, never by the caller. It becomes true
--   only when public.decide_action_proposal writes the row: that function
--   names the row in a transaction-local setting, and it runs as its owner,
--   not as an API role. Any other write of the checked columns sets it false.
-- Older rows that fail a rule stay as they are. They can still be rejected
-- through decide_action_proposal, and their conversation can still be deleted.
--
-- SECURITY INVOKER on purpose: current_user is the role that wrote the row.
create or replace function public.check_action_proposal()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.decided_by_function := false;
  else
    new.decided_by_function :=
      current_setting('pdot.deciding_proposal', true) = new.id::text
      and current_user not in ('anon', 'authenticated');
  end if;

  if (tg_op = 'INSERT' or new.payload is distinct from old.payload or new.kind is distinct from old.kind)
    and (new.payload ->> 'kind') is distinct from new.kind then
    raise exception 'action proposal payload must name the same kind' using errcode = '23514';
  end if;
  if new.status = 'proposed' and (new.decided_at is not null or new.result is not null) then
    raise exception 'a waiting action proposal has no decision or result' using errcode = '23514';
  end if;
  if tg_op = 'UPDATE' then
    if old.status in ('rejected', 'executed', 'failed') and (
      new.status is distinct from old.status or new.payload is distinct from old.payload
      or new.kind is distinct from old.kind or new.result is distinct from old.result
      or new.decided_at is distinct from old.decided_at) then
      raise exception 'a decided action proposal cannot change' using errcode = '23514';
    end if;
    if new.status is distinct from old.status and not (
      (old.status = 'proposed' and new.status in ('approved', 'rejected'))
      or (old.status = 'approved' and new.status in ('executed', 'failed'))) then
      raise exception 'action proposal status cannot move from % to %', old.status, new.status using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

revoke execute on function public.check_action_proposal() from public, anon, authenticated;

drop trigger if exists action_proposals_check on public.action_proposals;
create trigger action_proposals_check
  before insert or update of kind, payload, status, result, decided_at, decided_by_function on public.action_proposals
  for each row execute function public.check_action_proposal();

-- ---------------------------------------------------------------------------
-- Action log. The detail of a new row is a flat object of short values: at
-- most 16 keys, and every value is a string of at most 64 characters, a
-- number, a boolean or null. main's code writes only such details.
-- ---------------------------------------------------------------------------
create or replace function public.is_flat_log_detail(p_detail jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case
    when p_detail is null or jsonb_typeof(p_detail) <> 'object' then false
    else (select count(*) from jsonb_each(p_detail)) <= 16
      and not exists (
        select 1
        from jsonb_each(p_detail) e
        where char_length(e.key) not between 1 and 32
          or jsonb_typeof(e.value) not in ('string', 'number', 'boolean', 'null')
          or (jsonb_typeof(e.value) = 'string' and char_length(e.value #>> '{}') > 64)
      )
  end;
$$;

-- SECURITY DEFINER: the inserting role cannot call is_flat_log_detail itself.
create or replace function public.check_action_log_detail()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_flat_log_detail(new.detail) or pg_column_size(new.detail) > 2048 then
    raise exception 'action log detail must be a flat object of short values' using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke execute on function public.is_flat_log_detail(jsonb) from public, anon, authenticated;
revoke execute on function public.check_action_log_detail() from public, anon, authenticated;

drop trigger if exists action_log_check_detail on public.action_log;
create trigger action_log_check_detail
  before insert or update of detail on public.action_log
  for each row execute function public.check_action_log_detail();

-- The new event names. Every older row uses a name from the old list, which
-- is part of the new one, so this check is valid at once.
alter table public.action_log drop constraint if exists action_log_event_check;
alter table public.action_log
  add constraint action_log_event_check check (event in (
    'proposed', 'approved', 'rejected', 'executed', 'failed',
    'memory_added', 'memory_edited', 'memory_deleted',
    'document_added', 'document_ready', 'document_failed', 'document_deleted',
    'reminder_added', 'reminder_changed', 'reminder_deleted'
  ));

-- clock_timestamp, so two events in one transaction keep their order.
alter table public.action_log alter column created_at set default clock_timestamp();

-- ---------------------------------------------------------------------------
-- Action log writers. Triggers on the source tables write every log row, so
-- the app cannot write, skip or change one. Each trigger builds the detail
-- from IDs, kinds, modes, counts and flags only. It never copies content,
-- titles, summaries or payload text.
--
-- The functions are SECURITY DEFINER with an empty search path, and no API
-- role can call them directly.
-- ---------------------------------------------------------------------------
create or replace function public.write_action_log(p_user_id uuid, p_event text, p_proposal_id uuid, p_detail jsonb)
returns void
language plpgsql
set search_path = ''
as $$
begin
  -- When an account is deleted, its rows go with it. Do not log those deletes.
  if not exists (select 1 from auth.users u where u.id = p_user_id) then
    return;
  end if;
  insert into public.action_log (user_id, event, proposal_id, detail)
  values (p_user_id, p_event, p_proposal_id, jsonb_strip_nulls(coalesce(p_detail, '{}'::jsonb)));
end;
$$;

create or replace function public.log_memory_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    perform public.write_action_log(new.user_id, 'memory_added', null, jsonb_build_object(
      'memoryId', new.id, 'mode', new.mode, 'source', new.source, 'status', new.status));
    return new;
  elsif tg_op = 'UPDATE' then
    perform public.write_action_log(new.user_id, 'memory_edited', null, jsonb_build_object(
      'memoryId', new.id, 'mode', new.mode, 'source', new.source, 'status', new.status,
      'contentChanged', old.content is distinct from new.content,
      'modeChanged', old.mode is distinct from new.mode,
      'statusChanged', old.status is distinct from new.status));
    return new;
  else
    perform public.write_action_log(old.user_id, 'memory_deleted', null, jsonb_build_object(
      'memoryId', old.id, 'mode', old.mode, 'source', old.source));
    return old;
  end if;
end;
$$;

create or replace function public.log_document_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    perform public.write_action_log(new.user_id, 'document_added', null, jsonb_build_object(
      'documentId', new.id, 'mode', new.mode, 'status', new.status));
    return new;
  elsif tg_op = 'UPDATE' then
    if new.status = 'ready' then
      perform public.write_action_log(new.user_id, 'document_ready', null, jsonb_build_object(
        'documentId', new.id, 'mode', new.mode,
        'chunkCount', (select count(*) from public.document_chunks c where c.document_id = new.id)));
    elsif new.status = 'failed' then
      perform public.write_action_log(new.user_id, 'document_failed', null, jsonb_build_object(
        'documentId', new.id, 'mode', new.mode));
    end if;
    return new;
  else
    perform public.write_action_log(old.user_id, 'document_deleted', null, jsonb_build_object(
      'documentId', old.id, 'mode', old.mode));
    return old;
  end if;
end;
$$;

create or replace function public.log_reminder_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    perform public.write_action_log(new.user_id, 'reminder_added', new.proposal_id, jsonb_build_object(
      'reminderId', new.id, 'mode', new.mode, 'status', new.status,
      'fromProposal', new.proposal_id is not null));
    return new;
  elsif tg_op = 'UPDATE' then
    perform public.write_action_log(new.user_id, 'reminder_changed', null, jsonb_build_object(
      'reminderId', new.id, 'mode', new.mode, 'status', new.status,
      'titleChanged', old.title is distinct from new.title,
      'dueChanged', old.due_at is distinct from new.due_at,
      'modeChanged', old.mode is distinct from new.mode,
      'statusChanged', old.status is distinct from new.status));
    return new;
  else
    perform public.write_action_log(old.user_id, 'reminder_deleted', null, jsonb_build_object(
      'reminderId', old.id, 'mode', old.mode));
    return old;
  end if;
end;
$$;

-- Proposal events: 'proposed' on insert, then the new status on each change.
-- Result values are copied only when they have the shape the decision
-- function writes (an ID, or the fixed error code and a five-character SQLSTATE).
create or replace function public.log_proposal_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uuid constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  v_mode text := case when new.payload ->> 'mode' in ('personal', 'work') then new.payload ->> 'mode' end;
  v_detail jsonb := jsonb_build_object('kind', new.kind, 'mode', v_mode);
begin
  if tg_op = 'INSERT' then
    perform public.write_action_log(new.user_id, 'proposed', new.id, v_detail);
    return new;
  end if;

  -- verified: true only when decide_action_proposal wrote this change.
  v_detail := v_detail || jsonb_build_object('verified', new.decided_by_function);

  if new.status = 'approved' then
    v_detail := v_detail || jsonb_build_object('edited', old.payload is distinct from new.payload);
  elsif new.status = 'executed' then
    v_detail := v_detail || jsonb_build_object(
      'taskId', case when new.result ->> 'taskId' ~ v_uuid then new.result ->> 'taskId' end,
      'reminderId', case when new.result ->> 'reminderId' ~ v_uuid then new.result ->> 'reminderId' end,
      'memoryId', case when new.result ->> 'memoryId' ~ v_uuid then new.result ->> 'memoryId' end);
  elsif new.status = 'failed' then
    v_detail := v_detail || jsonb_build_object(
      'error', 'execution_failed',
      'code', case when new.result ->> 'code' ~ '^[0-9A-Z]{5}$' then new.result ->> 'code' end);
  elsif new.status <> 'rejected' then
    return new;
  end if;
  perform public.write_action_log(new.user_id, new.status, new.id, v_detail);
  return new;
end;
$$;

revoke execute on function public.write_action_log(uuid, text, uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.log_memory_change() from public, anon, authenticated;
revoke execute on function public.log_document_change() from public, anon, authenticated;
revoke execute on function public.log_reminder_change() from public, anon, authenticated;
revoke execute on function public.log_proposal_change() from public, anon, authenticated;

drop trigger if exists memories_log_insert_delete on public.memories;
create trigger memories_log_insert_delete
  after insert or delete on public.memories
  for each row execute function public.log_memory_change();
-- Only a visible change is logged. Writing a vector alone is not.
drop trigger if exists memories_log_update on public.memories;
create trigger memories_log_update
  after update of content, mode, status on public.memories
  for each row
  when (old.content is distinct from new.content
    or old.mode is distinct from new.mode
    or old.status is distinct from new.status)
  execute function public.log_memory_change();

drop trigger if exists documents_log_insert_delete on public.documents;
create trigger documents_log_insert_delete
  after insert or delete on public.documents
  for each row execute function public.log_document_change();
drop trigger if exists documents_log_update on public.documents;
create trigger documents_log_update
  after update of status on public.documents
  for each row when (old.status is distinct from new.status)
  execute function public.log_document_change();

drop trigger if exists reminders_log_insert_delete on public.reminders;
create trigger reminders_log_insert_delete
  after insert or delete on public.reminders
  for each row execute function public.log_reminder_change();
drop trigger if exists reminders_log_update on public.reminders;
create trigger reminders_log_update
  after update of mode, title, due_at, status on public.reminders
  for each row
  when (old.mode is distinct from new.mode
    or old.title is distinct from new.title
    or old.due_at is distinct from new.due_at
    or old.status is distinct from new.status)
  execute function public.log_reminder_change();

drop trigger if exists action_proposals_log_insert on public.action_proposals;
create trigger action_proposals_log_insert
  after insert on public.action_proposals
  for each row execute function public.log_proposal_change();
drop trigger if exists action_proposals_log_update on public.action_proposals;
create trigger action_proposals_log_update
  after update of status on public.action_proposals
  for each row when (old.status is distinct from new.status)
  execute function public.log_proposal_change();

-- ---------------------------------------------------------------------------
-- Action payload check. The same rules as actionPayloadSchema in
-- src/lib/schemas.ts: the exact keys for the kind, a known mode, trimmed text
-- within the length limits (task and reminder titles 200, memory 1,000) and an
-- ISO 8601 date-time with seconds and a time zone offset. Returns the
-- normalized payload, or null when the payload is not valid.
-- ---------------------------------------------------------------------------
create or replace function public.action_payload_text(p_value jsonb, p_max integer)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when jsonb_typeof(p_value) <> 'string' then null
    else (
      select case when char_length(t) between 1 and p_max then t end
      from (
        select regexp_replace(
          p_value #>> '{}',
          '^[\s   -     　﻿]+|[\s   -     　﻿]+$',
          '', 'g') as t
      ) trimmed
    )
  end;
$$;

create or replace function public.normalize_action_payload(p_kind text, p_payload jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_keys text[];
  v_mode text;
  v_text text;
  v_due text;
begin
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' or p_payload ->> 'kind' is distinct from p_kind then
    return null;
  end if;
  select array_agg(k order by k collate "C") into v_keys from jsonb_object_keys(p_payload) k;
  if jsonb_typeof(p_payload -> 'kind') <> 'string' or jsonb_typeof(p_payload -> 'mode') is distinct from 'string' then
    return null;
  end if;
  v_mode := p_payload ->> 'mode';
  if v_mode not in ('personal', 'work') then
    return null;
  end if;

  if p_kind = 'create_task' then
    v_text := public.action_payload_text(p_payload -> 'title', 200);
    if v_keys <> array['kind', 'mode', 'title'] or v_text is null then
      return null;
    end if;
    return jsonb_build_object('kind', p_kind, 'mode', v_mode, 'title', v_text);
  elsif p_kind = 'create_reminder' then
    v_text := public.action_payload_text(p_payload -> 'title', 200);
    if v_keys <> array['dueAt', 'kind', 'mode', 'title'] or v_text is null
      or jsonb_typeof(p_payload -> 'dueAt') <> 'string' then
      return null;
    end if;
    v_due := p_payload ->> 'dueAt';
    if v_due !~ '^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d+)?(Z|[+-]([01]\d|2[0-3]):[0-5]\d)$' then
      return null;
    end if;
    begin
      perform v_due::timestamptz;
    exception when others then
      -- For example 30 February.
      return null;
    end;
    return jsonb_build_object('kind', p_kind, 'mode', v_mode, 'title', v_text, 'dueAt', v_due);
  elsif p_kind = 'save_memory' then
    v_text := public.action_payload_text(p_payload -> 'content', 1000);
    if v_keys <> array['content', 'kind', 'mode'] or v_text is null then
      return null;
    end if;
    return jsonb_build_object('kind', p_kind, 'mode', v_mode, 'content', v_text);
  end if;
  return null;
end;
$$;

revoke execute on function public.action_payload_text(jsonb, integer) from public, anon, authenticated;
revoke execute on function public.normalize_action_payload(text, jsonb) from public, anon, authenticated;

-- The answer for a proposal that another decision claimed first.
create or replace function public.decided_action_proposal(p_id uuid, p_user_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'outcome', case when p.id is null then 'not_found' else 'already_decided' end,
    'proposal', case when p.id is null then null else to_jsonb(p) - 'user_id' end)
  from (select 1) one
  left join public.action_proposals p on p.id = p_id and p.user_id = p_user_id;
$$;

-- ---------------------------------------------------------------------------
-- Decide an action proposal: the only way a proposal changes state.
--
-- One transaction claims the proposal (only a 'proposed' row of the caller),
-- stores an edited payload, inserts the task, reminder or memory as the
-- caller, and stores the outcome. A second decision finds no 'proposed' row,
-- so an action runs at most once. If the insert fails, the proposal is
-- 'failed' with a short error code; it never stays 'approved'.
--
-- Returns { outcome, proposal }. outcome is one of: not_found,
-- already_decided, invalid, kind_mismatch, rejected, executed, failed.
-- A missing proposal and another user's proposal both give not_found.
-- proposal is the caller's row without user_id, or null for not_found.
-- A saved memory has no vector; the caller embeds it afterwards.
-- ---------------------------------------------------------------------------
create or replace function public.decide_action_proposal(p_id uuid, p_decision text, p_payload jsonb default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.action_proposals;
  v_payload jsonb;
  v_new_id uuid;
  v_result jsonb;
begin
  if v_uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;

  select * into v_row from public.action_proposals p where p.id = p_id and p.user_id = v_uid;
  if not found then
    return jsonb_build_object('outcome', 'not_found', 'proposal', null);
  end if;
  if v_row.status <> 'proposed' then
    return jsonb_build_object('outcome', 'already_decided', 'proposal', to_jsonb(v_row) - 'user_id');
  end if;
  if p_decision is null or p_decision not in ('approve', 'reject')
    or (p_decision = 'reject' and p_payload is not null) then
    return jsonb_build_object('outcome', 'invalid', 'proposal', to_jsonb(v_row) - 'user_id');
  end if;

  -- Names this row for the trust marker until the function returns.
  perform set_config('pdot.deciding_proposal', p_id::text, true);

  if p_decision = 'reject' then
    update public.action_proposals p
    set status = 'rejected', decided_at = now()
    where p.id = p_id and p.user_id = v_uid and p.status = 'proposed'
    returning * into v_row;
    if not found then
      return public.decided_action_proposal(p_id, v_uid);
    end if;
    perform set_config('pdot.deciding_proposal', '', true);
    return jsonb_build_object('outcome', 'rejected', 'proposal', to_jsonb(v_row) - 'user_id');
  end if;

  if p_payload is not null and (jsonb_typeof(p_payload) <> 'object' or p_payload ->> 'kind' is distinct from v_row.kind) then
    return jsonb_build_object('outcome', 'kind_mismatch', 'proposal', to_jsonb(v_row) - 'user_id');
  end if;
  v_payload := public.normalize_action_payload(v_row.kind, coalesce(p_payload, v_row.payload));
  if v_payload is null then
    return jsonb_build_object('outcome', 'invalid', 'proposal', to_jsonb(v_row) - 'user_id');
  end if;

  -- The claim. Only one decision can move the row out of 'proposed'.
  update public.action_proposals p
  set status = 'approved', decided_at = now(), payload = v_payload
  where p.id = p_id and p.user_id = v_uid and p.status = 'proposed'
  returning * into v_row;
  if not found then
    return public.decided_action_proposal(p_id, v_uid);
  end if;

  begin
    if v_row.kind = 'create_task' then
      insert into public.tasks (user_id, mode, title)
      values (v_uid, v_payload ->> 'mode', v_payload ->> 'title')
      returning id into v_new_id;
      v_result := jsonb_build_object('taskId', v_new_id);
    elsif v_row.kind = 'create_reminder' then
      insert into public.reminders (user_id, mode, title, due_at, proposal_id)
      values (v_uid, v_payload ->> 'mode', v_payload ->> 'title', (v_payload ->> 'dueAt')::timestamptz, p_id)
      returning id into v_new_id;
      v_result := jsonb_build_object('reminderId', v_new_id);
    elsif v_row.kind = 'save_memory' then
      -- The user approved this memory, so it is active. The source is the assistant.
      insert into public.memories (user_id, mode, content, status, source)
      values (v_uid, v_payload ->> 'mode', v_payload ->> 'content', 'active', 'assistant')
      returning id into v_new_id;
      v_result := jsonb_build_object('memoryId', v_new_id);
    else
      raise exception 'unsupported action kind' using errcode = '22023';
    end if;
  exception when others then
    -- The insert and its log rows are rolled back. Record the failure.
    update public.action_proposals p
    set status = 'failed', result = jsonb_build_object('error', 'execution_failed', 'code', sqlstate)
    where p.id = p_id
    returning * into v_row;
    perform set_config('pdot.deciding_proposal', '', true);
    return jsonb_build_object('outcome', 'failed', 'proposal', to_jsonb(v_row) - 'user_id');
  end;

  update public.action_proposals p
  set status = 'executed', result = v_result
  where p.id = p_id
  returning * into v_row;
  perform set_config('pdot.deciding_proposal', '', true);
  return jsonb_build_object('outcome', 'executed', 'proposal', to_jsonb(v_row) - 'user_id');
end;
$$;

revoke execute on function public.decided_action_proposal(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.decide_action_proposal(uuid, text, jsonb) from public, anon;
grant execute on function public.decide_action_proposal(uuid, text, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- Explicit grants. A new Supabase project no longer grants table privileges
-- to the API roles automatically, so each table and function the app uses
-- gets only the privileges the app needs. Earlier column grants for UPDATE
-- stay as they are. These grants add nothing on a project that has the
-- older automatic grants.
-- ---------------------------------------------------------------------------
grant select, insert, delete on public.conversations to authenticated;
grant select, insert on public.messages to authenticated;
grant select, insert, delete on public.tasks to authenticated;
grant select, insert, delete on public.memories to authenticated;
grant select, insert, delete on public.documents to authenticated;
grant select, insert on public.document_chunks to authenticated;
grant select, insert on public.action_proposals to authenticated;
grant select on public.action_log to authenticated;
grant select, insert, delete on public.reminders to authenticated;
grant select, insert on public.context_records to authenticated;

grant update (title) on public.conversations to authenticated;
grant update (title, done) on public.tasks to authenticated;
grant update (mode, content, status, embedding, embedding_model) on public.memories to authenticated;
grant update (status) on public.documents to authenticated;
grant update (mode, title, due_at, status) on public.reminders to authenticated;

grant execute on function public.consume_chat_quota(integer, integer) to authenticated;
grant execute on function public.match_memories(extensions.vector, text, integer) to authenticated;
grant execute on function public.match_document_chunks(extensions.vector, text, integer) to authenticated;
grant execute on function public.reserve_provider_spend(text, bigint, bigint, bigint, bigint) to authenticated;
grant execute on function public.settle_provider_spend(uuid, bigint) to authenticated;

-- No API role may empty a table, reference it from its own table or add a
-- trigger to it. TRUNCATE skips row-level security and row triggers.
revoke truncate, references, trigger on all tables in schema public from anon, authenticated;
