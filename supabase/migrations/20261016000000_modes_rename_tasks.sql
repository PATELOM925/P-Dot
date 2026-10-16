-- Personal/Work modes, conversation renaming, and a to-do list.
-- Same ownership model as the initial schema: the app uses the signed-in user's
-- JWT only, and RLS rejects any row that is not auth.uid()'s.

-- ---------------------------------------------------------------------------
-- Conversations: mode + rename
-- ---------------------------------------------------------------------------
alter table public.conversations
  add column mode text not null default 'personal'
  check (mode in ('personal', 'work'));

create index conversations_user_mode_updated_idx
  on public.conversations (user_id, mode, updated_at desc);

-- Users may change the title of their own conversations and nothing else.
-- (The initial migration revoked all UPDATE privileges; this re-grants one column.)
grant update (title) on public.conversations to authenticated;

create policy conversations_update_own on public.conversations
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- ---------------------------------------------------------------------------
-- Tasks (to-do list), separate for each mode
-- ---------------------------------------------------------------------------
create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  mode text not null check (mode in ('personal', 'work')),
  title text not null check (char_length(title) between 1 and 200),
  done boolean not null default false,
  created_at timestamptz not null default now()
);

create index tasks_user_mode_created_idx
  on public.tasks (user_id, mode, created_at);

alter table public.tasks enable row level security;

create policy tasks_select_own on public.tasks
  for select to authenticated using ((select auth.uid()) = user_id);
create policy tasks_insert_own on public.tasks
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy tasks_update_own on public.tasks
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy tasks_delete_own on public.tasks
  for delete to authenticated using ((select auth.uid()) = user_id);

revoke all on public.tasks from anon;
revoke update on public.tasks from authenticated;
grant update (title, done) on public.tasks to authenticated;
