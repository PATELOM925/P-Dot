-- Telegram link, EXPAND step (decision 0020).
--
-- One new table and three small functions. Nothing that exists changes, so
-- the live code on main is not affected. All reads and writes use the
-- signed-in user's session. No service role. The Telegram webhook never
-- reads or writes this table.
--
-- public.telegram_links: at most one row for each user.
-- - chat_ciphertext: the user's Telegram chat ID and display name, sealed by
--   the Worker (AES-256-GCM, bound to the user ID). A user can write this
--   column with the own session, but only a value that the Worker sealed for
--   this user opens. So a user cannot point P-Dot at another person's chat.
-- - link_code_hash and link_code_expires_at: the SHA-256 of the one-time code
--   of a link that is not finished, and when it ends. Never the code itself.
-- - last_send_key: the key of the last approved send. A second send with the
--   same key matches no row, so one approval sends at most one message.
-- An anonymous demo session cannot insert or update a row.

create table if not exists public.telegram_links (
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  chat_ciphertext text
    check (char_length(chat_ciphertext) <= 1024 and chat_ciphertext ~ '^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22,}$'),
  link_code_hash text check (link_code_hash ~ '^[0-9a-f]{64}$'),
  link_code_expires_at timestamptz,
  last_send_key uuid,
  linked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint telegram_links_code_pair check ((link_code_hash is null) = (link_code_expires_at is null)),
  constraint telegram_links_chat_pair check ((chat_ciphertext is null) = (linked_at is null))
);

create trigger telegram_links_touch_updated_at
  before update on public.telegram_links
  for each row execute function public.touch_updated_at();

alter table public.telegram_links enable row level security;

create policy telegram_links_select_own on public.telegram_links
  for select to authenticated using ((select auth.uid()) = user_id);
create policy telegram_links_insert_own on public.telegram_links
  for insert to authenticated
  with check (
    (select auth.uid()) = user_id
    and not coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false)
  );
create policy telegram_links_update_own on public.telegram_links
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check (
    (select auth.uid()) = user_id
    and not coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false)
  );
create policy telegram_links_delete_own on public.telegram_links
  for delete to authenticated using ((select auth.uid()) = user_id);

-- The owner may read the own ciphertext: only the Worker has the key.
revoke all on public.telegram_links from anon, authenticated;
grant select, delete on public.telegram_links to authenticated;
grant insert (link_code_hash, link_code_expires_at) on public.telegram_links to authenticated;
grant update (chat_ciphertext, link_code_hash, link_code_expires_at, last_send_key, linked_at)
  on public.telegram_links to authenticated;

-- Starts a link: stores the hash of a new one-time code for 10 minutes and
-- keeps a linked chat as it is. Returns when the code ends. SECURITY INVOKER,
-- so RLS, the column grants and the anonymous check apply.
create or replace function public.start_telegram_link(p_code_hash text)
returns timestamptz
language sql
security invoker
set search_path = ''
as $$
  insert into public.telegram_links as t (link_code_hash, link_code_expires_at)
  values (p_code_hash, now() + interval '10 minutes')
  on conflict (user_id) do update
    set link_code_hash = excluded.link_code_hash, link_code_expires_at = excluded.link_code_expires_at
  returning t.link_code_expires_at;
$$;

-- Finishes a link with the code it started, once, before the code ends.
-- True when the row changed. The code cannot be used again.
create or replace function public.confirm_telegram_link(p_code_hash text, p_chat_ciphertext text)
returns boolean
language sql
security invoker
set search_path = ''
as $$
  with changed as (
    update public.telegram_links
       set chat_ciphertext = p_chat_ciphertext, linked_at = now(),
           link_code_hash = null, link_code_expires_at = null, last_send_key = null
     where user_id = (select auth.uid())
       and link_code_hash = p_code_hash
       and link_code_expires_at > now()
    returning 1
  )
  select exists (select 1 from changed);
$$;

-- Claims one approved send. Returns the sealed chat, or NULL when the user
-- has no linked chat or this key was already used for the last send.
create or replace function public.claim_telegram_send(p_key uuid)
returns text
language sql
security invoker
set search_path = ''
as $$
  update public.telegram_links
     set last_send_key = p_key
   where user_id = (select auth.uid())
     and chat_ciphertext is not null
     and p_key is not null
     and last_send_key is distinct from p_key
  returning chat_ciphertext;
$$;

revoke execute on function public.start_telegram_link(text) from public, anon;
revoke execute on function public.confirm_telegram_link(text, text) from public, anon;
revoke execute on function public.claim_telegram_send(uuid) from public, anon;
grant execute on function public.start_telegram_link(text) to authenticated;
grant execute on function public.confirm_telegram_link(text, text) to authenticated;
grant execute on function public.claim_telegram_send(uuid) to authenticated;

revoke truncate, references, trigger on public.telegram_links from anon, authenticated;
