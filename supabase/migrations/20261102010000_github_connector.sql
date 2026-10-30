-- GitHub connector, EXPAND step (decision 0020).
--
-- connected_accounts accepts one more provider, 'github'. The checks only get
-- wider: every row and every write of the live code still passes. No table,
-- column, function, policy or grant changes. The insert and update policies
-- of 20261031000000_mcp_connectors.sql already refuse an anonymous session
-- for every provider except Google.
--
-- A GitHub App token has no OAuth scopes. P-Dot stores the label 'read' for
-- the read-only GitHub App that the owner registers.

alter table public.connected_accounts drop constraint connected_accounts_provider_check;
alter table public.connected_accounts add constraint connected_accounts_provider_check
  check (provider in ('google', 'notion', 'linear', 'todoist', 'github'));

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
    when 'github' then scopes <@ array['read']::text[]
    else false
  end);
