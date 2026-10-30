-- Feedback requests, EXPAND step: "What should P-Dot connect to next?"
--
-- One new table, one trigger and its function. Nothing that exists changes, so
-- the live code on main is not affected. All reads and writes use the
-- signed-in user's session. No service role.
--
-- public.feedback_requests: one row for each request a user sends.
-- - kind: a suggestion the app offers (for example 'slack') or 'other'.
-- - text: what the user typed, at most 500 characters. Required for 'other'.
-- A user can insert only own rows and read only own rows. No update, no delete.
-- A trial (anonymous) session can send a request too; the daily cap applies.
--
-- Daily cap: at most 10 rows for each user in any 24 hours. A BEFORE INSERT
-- trigger counts them, so a direct insert cannot skip the cap. A per-user
-- advisory lock makes two requests at the same time count one after the other.
-- The trigger refuses with SQLSTATE 54000 (program_limit_exceeded); the app
-- shows it as "rate_limited".

create table if not exists public.feedback_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  kind text not null check (kind ~ '^[a-z][a-z0-9_]{0,31}$'),
  text text check (char_length(text) between 1 and 500 and btrim(text) <> ''),
  created_at timestamptz not null default now(),
  constraint feedback_requests_other_needs_text check (kind <> 'other' or text is not null)
);

create index if not exists feedback_requests_user_created_idx
  on public.feedback_requests (user_id, created_at desc);

alter table public.feedback_requests enable row level security;

create policy feedback_requests_select_own on public.feedback_requests
  for select to authenticated using ((select auth.uid()) = user_id);
create policy feedback_requests_insert_own on public.feedback_requests
  for insert to authenticated with check ((select auth.uid()) = user_id);

revoke all on public.feedback_requests from anon, authenticated;
grant select on public.feedback_requests to authenticated;
grant insert (kind, text) on public.feedback_requests to authenticated;

-- SECURITY INVOKER: the count reads only the caller's own rows through RLS,
-- which are the rows the cap is about.
create or replace function public.limit_feedback_requests()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('public.feedback_requests:' || new.user_id::text, 0));
  if (
    select count(*) from public.feedback_requests
     where user_id = new.user_id and created_at > now() - interval '24 hours'
  ) >= 10 then
    raise exception 'feedback request limit reached' using errcode = '54000';
  end if;
  return new;
end;
$$;

create trigger feedback_requests_daily_cap
  before insert on public.feedback_requests
  for each row execute function public.limit_feedback_requests();

revoke execute on function public.limit_feedback_requests() from public, anon, authenticated;
revoke truncate, references, trigger on public.feedback_requests from anon, authenticated;
