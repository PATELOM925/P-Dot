-- Google connection and external actions, EXPAND step (decision 0014).
--
-- Adds:
-- 1. public.connected_accounts: one encrypted Google refresh token for each
--    user, under RLS, with save_connected_account to insert or replace it.
-- 2. Two action kinds that act outside P-Dot, send_email and
--    create_calendar_event, and the status 'executing'. The database cannot
--    call Google, so an approval claims the proposal ('executing'), the Worker
--    calls Google, and finish_external_action stores the outcome. A row stuck
--    in 'executing' leaves it through reclaim_external_action (calendar) or
--    settle_unknown_external_action (email, after the user answers).
--
-- The code on main does not use the new objects. Its decisions on the older
-- kinds work as before, and its proposal list skips a row that it cannot
-- parse. All writes still use the signed-in user's session. No service role.

-- ---------------------------------------------------------------------------
-- 1. Connected accounts.
-- ---------------------------------------------------------------------------
create table if not exists public.connected_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  provider text not null check (provider in ('google')),
  account_email text not null check (char_length(account_email) between 3 and 320),
  scopes text[] not null check (cardinality(scopes) between 1 and 10 and array_position(scopes, null) is null),
  token_ciphertext text not null
    check (char_length(token_ciphertext) <= 4096 and token_ciphertext ~ '^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22,}$'),
  status text not null default 'connected' check (status in ('connected', 'needs_reconnect')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, provider),
  -- The data scopes a provider may hold. A new scope needs a new migration.
  constraint connected_accounts_known_scopes check (
    provider <> 'google' or scopes <@ array[
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/calendar.events.owned',
      'https://www.googleapis.com/auth/calendar.events'
    ]::text[])
);

create trigger connected_accounts_touch_updated_at
  before update on public.connected_accounts
  for each row execute function public.touch_updated_at();

alter table public.connected_accounts enable row level security;

create policy connected_accounts_select_own on public.connected_accounts
  for select to authenticated using ((select auth.uid()) = user_id);
create policy connected_accounts_insert_own on public.connected_accounts
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy connected_accounts_update_own on public.connected_accounts
  for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy connected_accounts_delete_own on public.connected_accounts
  for delete to authenticated using ((select auth.uid()) = user_id);

-- The owner may read the own ciphertext: the Worker reads it with the user's
-- session, so a function would not keep it from the user. Only the Worker has
-- the key. No API role may change the ID, the owner, the provider or the
-- creation time.
revoke all on public.connected_accounts from anon, authenticated;
grant select, insert, delete on public.connected_accounts to authenticated;
grant update (account_email, scopes, token_ciphertext, status) on public.connected_accounts to authenticated;

-- Inserts or replaces the caller's row for one provider in one statement and
-- marks it connected. SECURITY INVOKER, so RLS and the column grants apply.
create or replace function public.save_connected_account(
  p_provider text, p_account_email text, p_scopes text[], p_token_ciphertext text
)
returns uuid
language sql
security invoker
set search_path = ''
as $$
  insert into public.connected_accounts as a (user_id, provider, account_email, scopes, token_ciphertext, status)
  values (auth.uid(), p_provider, p_account_email, p_scopes, p_token_ciphertext, 'connected')
  on conflict (user_id, provider) do update
    set account_email = excluded.account_email,
        scopes = excluded.scopes,
        token_ciphertext = excluded.token_ciphertext,
        status = 'connected'
  returning a.id;
$$;

revoke execute on function public.save_connected_account(text, text, text[], text) from public, anon;
grant execute on function public.save_connected_account(text, text, text[], text) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. External action kinds and the 'executing' status.
--
-- The constraints only get wider: every older row still passes. The payload
-- limit goes from 8,192 to 32,768 bytes, because an email body of 4,000
-- characters can need 16,000 bytes.
-- ---------------------------------------------------------------------------
alter table public.action_proposals drop constraint if exists action_proposals_kind_check;
alter table public.action_proposals add constraint action_proposals_kind_check
  check (kind in ('create_task', 'create_reminder', 'save_memory', 'send_email', 'create_calendar_event'));

alter table public.action_proposals drop constraint if exists action_proposals_status_check;
alter table public.action_proposals add constraint action_proposals_status_check
  check (status in ('proposed', 'approved', 'executing', 'rejected', 'executed', 'failed'));

alter table public.action_proposals drop constraint if exists action_proposals_payload_check;
alter table public.action_proposals add constraint action_proposals_payload_check
  check (jsonb_typeof(payload) = 'object' and pg_column_size(payload) <= 32768);

-- The claim of the request that calls Google. Set only while 'executing'.
alter table public.action_proposals
  add column if not exists execution_claim_id uuid,
  add column if not exists execution_started_at timestamptz;

alter table public.action_proposals add constraint action_proposals_execution_claim check (
  (status = 'executing') = (execution_claim_id is not null)
  and (status <> 'executing' or execution_started_at is not null));

-- Checks new rows and changes to the checked columns. Unchanged from
-- 20261021000500_marker_unset_setting.sql, plus:
-- - only send_email and create_calendar_event may be 'executing', and they
--   never use 'approved';
-- - proposed to executing, and executing to executed or failed;
-- - an executing row keeps its payload, kind and decision time, and has no result.
create or replace function public.check_action_proposal()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_external boolean := new.kind in ('send_email', 'create_calendar_event');
begin
  if tg_op = 'INSERT' then
    new.decided_by_function := false;
  else
    new.decided_by_function :=
      coalesce(current_setting('pdot.deciding_proposal', true), '') = new.id::text
      and current_user not in ('anon', 'authenticated');
  end if;

  if (tg_op = 'INSERT' or new.payload is distinct from old.payload or new.kind is distinct from old.kind)
    and (new.payload ->> 'kind') is distinct from new.kind then
    raise exception 'action proposal payload must name the same kind' using errcode = '23514';
  end if;
  if new.status = 'proposed' and (new.decided_at is not null or new.result is not null) then
    raise exception 'a waiting action proposal has no decision or result' using errcode = '23514';
  end if;
  if new.status = 'executing' and (not v_external or new.result is not null or new.decided_at is null) then
    raise exception 'only an approved external action is executing, and it has no result' using errcode = '23514';
  end if;
  if new.status = 'approved' and v_external then
    raise exception 'an external action is never approved without a claim' using errcode = '23514';
  end if;
  if tg_op = 'UPDATE' then
    if old.status in ('rejected', 'executed', 'failed') and (
      new.status is distinct from old.status or new.payload is distinct from old.payload
      or new.kind is distinct from old.kind or new.result is distinct from old.result
      or new.decided_at is distinct from old.decided_at) then
      raise exception 'a decided action proposal cannot change' using errcode = '23514';
    end if;
    if old.status = 'executing' and (
      new.payload is distinct from old.payload or new.kind is distinct from old.kind
      or new.decided_at is distinct from old.decided_at) then
      raise exception 'an executing action proposal keeps its payload' using errcode = '23514';
    end if;
    if new.status is distinct from old.status and not (
      (old.status = 'proposed' and new.status in ('approved', 'rejected', 'executing'))
      or (old.status = 'approved' and new.status in ('executed', 'failed'))
      or (old.status = 'executing' and new.status in ('executed', 'failed'))) then
      raise exception 'action proposal status cannot move from % to %', old.status, new.status using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

revoke execute on function public.check_action_proposal() from public, anon, authenticated;

-- Proposal events. Unchanged from 20261021000000_memory_hardening.sql, plus:
-- entering 'executing' writes 'approved'; an executed external action copies
-- the Gmail message ID or the Calendar event ID; a failed one copies a reason
-- from a fixed list. Never an address, a subject, a title or a body.
create or replace function public.log_proposal_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uuid constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  v_google_id constant text := '^[A-Za-z0-9_-]{1,64}$';
  v_mode text := case when new.payload ->> 'mode' in ('personal', 'work') then new.payload ->> 'mode' end;
  v_detail jsonb := jsonb_build_object('kind', new.kind, 'mode', v_mode);
  v_event text := new.status;
begin
  if tg_op = 'INSERT' then
    perform public.write_action_log(new.user_id, 'proposed', new.id, v_detail);
    return new;
  end if;

  if new.status in ('approved', 'executing') then
    v_event := 'approved';
    v_detail := v_detail || jsonb_build_object('edited', old.payload is distinct from new.payload);
  elsif new.status = 'executed' then
    v_detail := v_detail || jsonb_build_object(
      'taskId', case when new.result ->> 'taskId' ~ v_uuid then new.result ->> 'taskId' end,
      'reminderId', case when new.result ->> 'reminderId' ~ v_uuid then new.result ->> 'reminderId' end,
      'memoryId', case when new.result ->> 'memoryId' ~ v_uuid then new.result ->> 'memoryId' end,
      'messageId', case when new.result ->> 'messageId' ~ v_google_id then new.result ->> 'messageId' end,
      'eventId', case when new.result ->> 'eventId' ~ v_google_id then new.result ->> 'eventId' end,
      'userConfirmed', case when new.result -> 'userConfirmed' = 'true'::jsonb then true end);
  elsif new.status = 'failed' then
    v_detail := v_detail || jsonb_build_object(
      'error', 'execution_failed',
      'code', case when new.result ->> 'code' ~ '^[0-9A-Z]{5}$' then new.result ->> 'code' end,
      'reason', case when new.result ->> 'reason' in (
        'not_connected', 'needs_reconnect', 'scope_missing', 'google_rejected', 'not_sent')
        then new.result ->> 'reason' end);
  elsif new.status <> 'rejected' then
    return new;
  end if;
  -- Verified only when a decision function wrote this change.
  perform public.write_action_log(new.user_id, v_event, new.id, v_detail, new.decided_by_function);
  return new;
end;
$$;

revoke execute on function public.log_proposal_change() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Payload check. Unchanged from 20261021000000_memory_hardening.sql for the
-- older kinds. The two new kinds have the same limits as actionPayloadSchema
-- in src/lib/schemas.ts. Addresses use the WHATWG email form with a dot in
-- the domain: ASCII only, so no space, CR or LF can reach a mail header.
-- ---------------------------------------------------------------------------
create or replace function public.action_payload_email_list(p_value jsonb, p_min integer, p_max integer)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_item jsonb;
  v_out jsonb := '[]'::jsonb;
  v_address text;
begin
  if p_value is null or jsonb_typeof(p_value) <> 'array'
    or jsonb_array_length(p_value) not between p_min and p_max then
    return null;
  end if;
  for v_item in select value from jsonb_array_elements(p_value) loop
    v_address := public.action_payload_text(v_item, 254);
    if v_address is null or v_address !~
      '^[A-Za-z0-9.!#$%&''*+/=?^_`{|}~-]+@[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$' then
      return null;
    end if;
    v_out := v_out || to_jsonb(v_address);
  end loop;
  return v_out;
end;
$$;

create or replace function public.action_payload_time(p_value jsonb)
returns timestamptz
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_text text;
begin
  if p_value is null or jsonb_typeof(p_value) <> 'string' then
    return null;
  end if;
  v_text := p_value #>> '{}';
  if v_text !~ '^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d+)?(Z|[+-]([01]\d|2[0-3]):[0-5]\d)$' then
    return null;
  end if;
  return v_text::timestamptz;
exception when others then
  -- For example 30 February.
  return null;
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
  v_body text;
  v_due text;
  v_list jsonb;
  v_start timestamptz;
  v_end timestamptz;
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
      return null;
    end;
    return jsonb_build_object('kind', p_kind, 'mode', v_mode, 'title', v_text, 'dueAt', v_due);
  elsif p_kind = 'save_memory' then
    v_text := public.action_payload_text(p_payload -> 'content', 1000);
    if v_keys <> array['content', 'kind', 'mode'] or v_text is null then
      return null;
    end if;
    return jsonb_build_object('kind', p_kind, 'mode', v_mode, 'content', v_text);
  elsif p_kind = 'send_email' then
    v_list := public.action_payload_email_list(p_payload -> 'to', 1, 10);
    v_text := public.action_payload_text(p_payload -> 'subject', 200);
    v_body := public.action_payload_text(p_payload -> 'body', 4000);
    if v_keys <> array['body', 'kind', 'mode', 'subject', 'to'] or v_list is null or v_text is null
      or v_text ~ '[[:cntrl:]]' or v_body is null then
      return null;
    end if;
    return jsonb_build_object('kind', p_kind, 'mode', v_mode, 'to', v_list, 'subject', v_text, 'body', v_body);
  elsif p_kind = 'create_calendar_event' then
    v_list := public.action_payload_email_list(p_payload -> 'attendees', 0, 20);
    v_text := public.action_payload_text(p_payload -> 'title', 200);
    v_start := public.action_payload_time(p_payload -> 'start');
    v_end := public.action_payload_time(p_payload -> 'end');
    if v_keys <> array['attendees', 'end', 'kind', 'mode', 'start', 'title'] or v_list is null
      or v_text is null or v_text ~ '[[:cntrl:]]' or v_start is null or v_end is null
      or v_end <= v_start or v_end - v_start > interval '31 days' then
      return null;
    end if;
    return jsonb_build_object('kind', p_kind, 'mode', v_mode, 'title', v_text,
      'start', p_payload ->> 'start', 'end', p_payload ->> 'end', 'attendees', v_list);
  end if;
  return null;
end;
$$;

revoke execute on function public.action_payload_email_list(jsonb, integer, integer) from public, anon, authenticated;
revoke execute on function public.action_payload_time(jsonb) from public, anon, authenticated;
revoke execute on function public.normalize_action_payload(text, jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Decide an action proposal. Unchanged from
-- 20261021000000_memory_hardening.sql for the older kinds. For an external
-- kind, an approval checks the payload and claims the row: 'executing', with
-- a new execution_claim_id. It answers outcome 'executing'. The Worker then
-- calls Google and calls finish_external_action with the claim.
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

  if v_row.kind in ('send_email', 'create_calendar_event') then
    -- The claim. Only one decision can move the row out of 'proposed'.
    update public.action_proposals p
    set status = 'executing', decided_at = now(), payload = v_payload,
        execution_claim_id = gen_random_uuid(), execution_started_at = now()
    where p.id = p_id and p.user_id = v_uid and p.status = 'proposed'
    returning * into v_row;
    if not found then
      return public.decided_action_proposal(p_id, v_uid);
    end if;
    perform set_config('pdot.deciding_proposal', '', true);
    return jsonb_build_object('outcome', 'executing', 'proposal', to_jsonb(v_row) - 'user_id');
  end if;

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
      insert into public.memories (user_id, mode, content, status, source)
      values (v_uid, v_payload ->> 'mode', v_payload ->> 'content', 'active', 'assistant')
      returning id into v_new_id;
      v_result := jsonb_build_object('memoryId', v_new_id);
    else
      raise exception 'unsupported action kind' using errcode = '22023';
    end if;
  exception when others then
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

revoke execute on function public.decide_action_proposal(uuid, text, jsonb) from public, anon;
grant execute on function public.decide_action_proposal(uuid, text, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- Finish an external action with the claim from decide_action_proposal or
-- reclaim_external_action.
--
-- p_succeeded true: p_result is { messageId } for send_email or { eventId }
-- for create_calendar_event. false: { error: 'execution_failed', reason },
-- with a reason from a fixed list. Store 'failed' only when Google did not act.
--
-- Returns { outcome, proposal }. outcome: not_found, already_decided,
-- stale_claim (another request holds the claim now), invalid, executed, failed.
-- ---------------------------------------------------------------------------
create or replace function public.finish_external_action(
  p_id uuid, p_claim_id uuid, p_succeeded boolean, p_result jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.action_proposals;
  v_google_id constant text := '^[A-Za-z0-9_-]{1,64}$';
  v_keys text[];
  v_valid boolean;
begin
  if v_uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;

  select * into v_row from public.action_proposals p where p.id = p_id and p.user_id = v_uid for update;
  if not found then
    return jsonb_build_object('outcome', 'not_found', 'proposal', null);
  end if;
  if v_row.status <> 'executing' then
    return jsonb_build_object('outcome', 'already_decided', 'proposal', to_jsonb(v_row) - 'user_id');
  end if;
  if p_claim_id is null or v_row.execution_claim_id is distinct from p_claim_id then
    return jsonb_build_object('outcome', 'stale_claim', 'proposal', to_jsonb(v_row) - 'user_id');
  end if;

  if p_result is null or jsonb_typeof(p_result) <> 'object' or p_succeeded is null then
    v_valid := false;
  else
    select array_agg(k order by k collate "C") into v_keys from jsonb_object_keys(p_result) k;
    if p_succeeded then
      v_valid := case v_row.kind
        when 'send_email' then v_keys = array['messageId']
          and jsonb_typeof(p_result -> 'messageId') = 'string' and p_result ->> 'messageId' ~ v_google_id
        when 'create_calendar_event' then v_keys = array['eventId']
          and jsonb_typeof(p_result -> 'eventId') = 'string' and p_result ->> 'eventId' ~ v_google_id
        else false
      end;
    else
      v_valid := v_keys = array['error', 'reason']
        and p_result -> 'error' = '"execution_failed"'::jsonb
        and jsonb_typeof(p_result -> 'reason') = 'string'
        and p_result ->> 'reason' in ('not_connected', 'needs_reconnect', 'scope_missing', 'google_rejected');
    end if;
  end if;
  if not v_valid then
    return jsonb_build_object('outcome', 'invalid', 'proposal', to_jsonb(v_row) - 'user_id');
  end if;

  perform set_config('pdot.deciding_proposal', p_id::text, true);
  update public.action_proposals p
  set status = case when p_succeeded then 'executed' else 'failed' end,
      result = p_result,
      execution_claim_id = null
  where p.id = p_id
  returning * into v_row;
  perform set_config('pdot.deciding_proposal', '', true);
  return jsonb_build_object('outcome', v_row.status, 'proposal', to_jsonb(v_row) - 'user_id');
end;
$$;

-- ---------------------------------------------------------------------------
-- Recovery of a row left 'executing' after its lease (decision 0014).
--
-- create_calendar_event: a new claim ('claimed'). The Worker inserts the
-- event again with the same event ID, and Google refuses a second copy.
-- send_email: 'outcome_unknown' and no claim. P-Dot never sends it again.
-- A row inside the lease gets 'busy'. Returns { outcome, proposal }.
-- ---------------------------------------------------------------------------
create or replace function public.reclaim_external_action(p_id uuid, p_lease_seconds integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.action_proposals;
begin
  if v_uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if p_lease_seconds is null or p_lease_seconds < 60 or p_lease_seconds > 900 then
    raise exception 'invalid lease' using errcode = '22023';
  end if;

  select * into v_row from public.action_proposals p where p.id = p_id and p.user_id = v_uid for update;
  if not found then
    return jsonb_build_object('outcome', 'not_found', 'proposal', null);
  end if;
  if v_row.status <> 'executing' then
    return jsonb_build_object('outcome', 'already_decided', 'proposal', to_jsonb(v_row) - 'user_id');
  end if;
  if v_row.execution_started_at > now() - make_interval(secs => p_lease_seconds) then
    return jsonb_build_object('outcome', 'busy', 'proposal', to_jsonb(v_row) - 'user_id');
  end if;
  if v_row.kind <> 'create_calendar_event' then
    return jsonb_build_object('outcome', 'outcome_unknown', 'proposal', to_jsonb(v_row) - 'user_id');
  end if;

  update public.action_proposals p
  set execution_claim_id = gen_random_uuid(), execution_started_at = now()
  where p.id = p_id
  returning * into v_row;
  return jsonb_build_object('outcome', 'claimed', 'proposal', to_jsonb(v_row) - 'user_id');
end;
$$;

-- The user's answer for an email whose outcome is unknown. Only for a
-- send_email row left 'executing' after its lease. p_sent true stores
-- 'executed' with { userConfirmed: true }; false stores 'failed' with the
-- reason 'not_sent'. It does not set the trust marker: a person answered, so
-- decided_by_function and the log row's verified stay false.
-- Returns { outcome, proposal }: not_found, already_decided, busy, invalid,
-- executed or failed.
create or replace function public.settle_unknown_external_action(p_id uuid, p_lease_seconds integer, p_sent boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.action_proposals;
begin
  if v_uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if p_lease_seconds is null or p_lease_seconds < 60 or p_lease_seconds > 900 then
    raise exception 'invalid lease' using errcode = '22023';
  end if;

  select * into v_row from public.action_proposals p where p.id = p_id and p.user_id = v_uid for update;
  if not found then
    return jsonb_build_object('outcome', 'not_found', 'proposal', null);
  end if;
  if v_row.status <> 'executing' then
    return jsonb_build_object('outcome', 'already_decided', 'proposal', to_jsonb(v_row) - 'user_id');
  end if;
  if v_row.kind <> 'send_email' or p_sent is null then
    return jsonb_build_object('outcome', 'invalid', 'proposal', to_jsonb(v_row) - 'user_id');
  end if;
  if v_row.execution_started_at > now() - make_interval(secs => p_lease_seconds) then
    return jsonb_build_object('outcome', 'busy', 'proposal', to_jsonb(v_row) - 'user_id');
  end if;

  update public.action_proposals p
  set status = case when p_sent then 'executed' else 'failed' end,
      result = case when p_sent then jsonb_build_object('userConfirmed', true)
                    else jsonb_build_object('error', 'execution_failed', 'reason', 'not_sent') end,
      execution_claim_id = null
  where p.id = p_id
  returning * into v_row;
  return jsonb_build_object('outcome', v_row.status, 'proposal', to_jsonb(v_row) - 'user_id');
end;
$$;

revoke execute on function public.finish_external_action(uuid, uuid, boolean, jsonb) from public, anon;
revoke execute on function public.reclaim_external_action(uuid, integer) from public, anon;
revoke execute on function public.settle_unknown_external_action(uuid, integer, boolean) from public, anon;
grant execute on function public.finish_external_action(uuid, uuid, boolean, jsonb) to authenticated;
grant execute on function public.reclaim_external_action(uuid, integer) to authenticated;
grant execute on function public.settle_unknown_external_action(uuid, integer, boolean) to authenticated;

revoke truncate, references, trigger on public.connected_accounts from anon, authenticated;
