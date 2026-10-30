-- MCP connectors for Notion, Linear and Todoist, EXPAND step (decision 0016).
--
-- connected_accounts gets three more providers. The checks only get wider for
-- Google: every Google row and every Google write of the live code still
-- passes. No table, column, function or grant is added.
--
-- 1. provider: 'google', 'notion', 'linear' or 'todoist'.
-- 2. account_email: still required for Google. An MCP row has no address.
-- 3. Known scopes for each provider. P-Dot asks only for read access.
-- 4. Ciphertext: at most 4,096 characters for Google (unchanged) and 12,288
--    for an MCP bundle, which holds the access token, the refresh token, the
--    endpoints and the tool pins.
-- 5. An anonymous demo session cannot insert or update an MCP row. Google
--    keeps its policies as they are; the routes refuse anonymous sessions.

alter table public.connected_accounts drop constraint connected_accounts_provider_check;
alter table public.connected_accounts add constraint connected_accounts_provider_check
  check (provider in ('google', 'notion', 'linear', 'todoist'));

alter table public.connected_accounts alter column account_email drop not null;
alter table public.connected_accounts add constraint connected_accounts_google_email
  check (provider <> 'google' or account_email is not null);

alter table public.connected_accounts drop constraint connected_accounts_known_scopes;
alter table public.connected_accounts add constraint connected_accounts_known_scopes check (
  case provider
    when 'google' then scopes <@ array[
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/calendar.events.owned',
      'https://www.googleapis.com/auth/calendar.events'
    ]::text[]
    when 'notion' then scopes <@ array['default']::text[]
    when 'linear' then scopes <@ array['read']::text[]
    when 'todoist' then scopes <@ array['data:read', 'data:read_write']::text[]
    else false
  end);

alter table public.connected_accounts drop constraint connected_accounts_token_ciphertext_check;
alter table public.connected_accounts add constraint connected_accounts_token_ciphertext_check
  check (token_ciphertext ~ '^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22,}$'
    and char_length(token_ciphertext) <= case when provider = 'google' then 4096 else 12288 end);

drop policy connected_accounts_insert_own on public.connected_accounts;
create policy connected_accounts_insert_own on public.connected_accounts
  for insert to authenticated
  with check (
    (select auth.uid()) = user_id
    and (provider = 'google' or not coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false))
  );

drop policy connected_accounts_update_own on public.connected_accounts;
create policy connected_accounts_update_own on public.connected_accounts
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check (
    (select auth.uid()) = user_id
    and (provider = 'google' or not coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false))
  );
