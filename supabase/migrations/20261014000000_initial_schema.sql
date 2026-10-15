-- P-Dot initial schema: private conversations, messages, and per-user request quotas.
--
-- Ownership is enforced twice: the application filters every query by the
-- authenticated user's ID, and row-level security (RLS) below rejects any row
-- that does not belong to auth.uid(). The application only ever talks to the
-- database with the signed-in user's JWT; no service-role key is used.

-- ---------------------------------------------------------------------------
-- Conversations
-- ---------------------------------------------------------------------------
create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title text not null check (char_length(title) between 1 and 120),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Lets messages reference (conversation, owner) together so a message can
  -- never be attached to a conversation owned by someone else.
  unique (id, user_id)
);

create index conversations_user_updated_idx
  on public.conversations (user_id, updated_at desc);

-- ---------------------------------------------------------------------------
-- Messages
-- ---------------------------------------------------------------------------
-- Only user messages and *completed* assistant replies are stored. A reply
-- that fails or is interrupted is not persisted; the client offers a retry for
-- a conversation whose latest message is from the user.
create table public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null,
  user_id uuid not null default auth.uid(),
  role text not null check (role in ('user', 'assistant')),
  content text not null check (char_length(content) between 1 and 32000),
  -- Web search outcome for assistant replies: off (not requested), used,
  -- no_results, or failed. Lets reopened conversations show the same notice.
  web_search text not null default 'off'
    check (web_search in ('off', 'used', 'no_results', 'failed')),
  -- Source references shown with an assistant reply: [{ "title", "url" }].
  sources jsonb not null default '[]'::jsonb
    check (jsonb_typeof(sources) = 'array' and jsonb_array_length(sources) <= 10),
  created_at timestamptz not null default now(),
  foreign key (conversation_id, user_id)
    references public.conversations (id, user_id) on delete cascade
);

create index messages_conversation_created_idx
  on public.messages (conversation_id, created_at);

-- Keep conversations.updated_at current so the history list sorts by activity.
create function public.touch_conversation_on_message()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.conversations
     set updated_at = now()
   where id = new.conversation_id;
  return null;
end;
$$;

revoke execute on function public.touch_conversation_on_message() from public, anon, authenticated;

create trigger messages_touch_conversation
  after insert on public.messages
  for each row execute function public.touch_conversation_on_message();

-- ---------------------------------------------------------------------------
-- Usage quotas (fixed window, per user)
-- ---------------------------------------------------------------------------
create table public.usage_windows (
  user_id uuid not null references auth.users (id) on delete cascade,
  window_start timestamptz not null,
  request_count integer not null default 0 check (request_count >= 0),
  primary key (user_id, window_start)
);

-- Atomically consumes one request from the caller's quota for the current
-- window. Returns allowed = false (without incrementing) once the limit is hit.
-- The caller is always auth.uid(); a user can only ever spend their own quota.
create function public.consume_chat_quota(p_limit integer, p_window_seconds integer)
returns table (allowed boolean, used integer, resets_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_window timestamptz;
  v_count integer;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if p_limit is null or p_limit < 1
     or p_window_seconds is null or p_window_seconds < 60 or p_window_seconds > 2678400 then
    raise exception 'invalid quota parameters' using errcode = '22023';
  end if;

  v_window := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);

  insert into public.usage_windows as u (user_id, window_start, request_count)
  values (v_user, v_window, 1)
  on conflict (user_id, window_start) do update
    set request_count = u.request_count + 1
    where u.request_count < p_limit
  returning u.request_count into v_count;

  -- Opportunistic cleanup of this user's expired windows.
  delete from public.usage_windows
   where user_id = v_user
     and window_start < now() - interval '31 days';

  if v_count is null then
    select u.request_count into v_count
      from public.usage_windows u
     where u.user_id = v_user and u.window_start = v_window;
    return query select false, v_count, v_window + make_interval(secs => p_window_seconds);
  else
    return query select true, v_count, v_window + make_interval(secs => p_window_seconds);
  end if;
end;
$$;

revoke execute on function public.consume_chat_quota(integer, integer) from public, anon;
grant execute on function public.consume_chat_quota(integer, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.usage_windows enable row level security;

create policy conversations_select_own on public.conversations
  for select to authenticated using ((select auth.uid()) = user_id);
create policy conversations_insert_own on public.conversations
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy conversations_delete_own on public.conversations
  for delete to authenticated using ((select auth.uid()) = user_id);

create policy messages_select_own on public.messages
  for select to authenticated using ((select auth.uid()) = user_id);
create policy messages_insert_own on public.messages
  for insert to authenticated with check ((select auth.uid()) = user_id);
-- No message update/delete policies: messages are removed by deleting the
-- conversation (cascade).

create policy usage_windows_select_own on public.usage_windows
  for select to authenticated using ((select auth.uid()) = user_id);
-- Writes happen only through consume_chat_quota().

-- Least-privilege table grants on top of RLS.
revoke all on public.conversations, public.messages, public.usage_windows from anon;
revoke update on public.conversations, public.messages from authenticated;
revoke insert, update, delete on public.usage_windows from authenticated;
