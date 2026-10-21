-- On a session where nothing has called set_config, current_setting(name, true)
-- is NULL, so the two markers became NULL and owner writes failed the NOT NULL
-- check (for example confirm_executed in docs/decisions/0009-legacy-approved.sql).
-- An unset value now counts as not set. Only these two expressions change.

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

create or replace function public.set_action_log_provenance()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.detail := new.detail - 'verified';
  if tg_op = 'UPDATE' then
    new.verified := old.verified;
  else
    new.verified := coalesce(current_setting('pdot.log_verified', true), '') = 'true'
      and current_user not in ('anon', 'authenticated');
  end if;
  return new;
end;
$$;
