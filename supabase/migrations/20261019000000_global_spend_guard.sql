-- Global spend guard: caps on what all users together can spend on paid
-- providers (Nebius inference in micro-dollars, Tavily search in credits).
-- See docs/decisions/0006-global-spend-guard.md.
--
-- Additive only: new tables and functions. The code that is live before this
-- change does not use them.
--
-- How it works:
--   1. Before a paid call, the server calls reserve_provider_spend() with a
--      worst-case "hold". The function adds the hold to the counters only if
--      no cap is passed, and returns a reservation ID.
--   2. After the call, the server calls settle_provider_spend() with the real
--      cost. Settle can only give back part of the hold, never add to it.
--      A settle that never happens leaves the full hold counted (safe side).
--
-- Trust: any signed-in user can call these functions directly with the public
-- key and choose the parameters. So:
--   - Every parameter has hard bounds in SQL.
--   - A user can settle only their own reservations, once, between 0 and the
--     hold. The server's reservation IDs never leave the server, and users
--     cannot read these tables, so a user cannot give back the server's holds.
--   - A direct caller can still use up budget (denial of service). A hard
--     per-user daily ceiling in SQL limits how much one account can do.

-- ---------------------------------------------------------------------------
-- Tables (no user content)
-- ---------------------------------------------------------------------------
create table public.spend_counters (
  provider text not null check (provider in ('nebius', 'tavily')),
  -- 'day' (UTC), 'month' (UTC calendar month), or 'total' (all time).
  period_kind text not null check (period_kind in ('day', 'month', 'total')),
  period_start date not null,
  -- Nebius: micro-dollars (1 USD = 1,000,000). Tavily: credits.
  used bigint not null default 0 check (used >= 0),
  updated_at timestamptz not null default now(),
  primary key (provider, period_kind, period_start)
);

create table public.spend_reservations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  provider text not null check (provider in ('nebius', 'tavily')),
  usage_day date not null,
  period_kind text not null check (period_kind in ('month', 'total')),
  period_start date not null,
  held bigint not null check (held > 0),
  -- Amount that stays counted: the hold until settled, then the real cost.
  charged bigint not null check (charged >= 0 and charged <= held),
  settled_at timestamptz,
  created_at timestamptz not null default now()
);

create index spend_reservations_user_day_idx
  on public.spend_reservations (user_id, provider, usage_day);

alter table public.spend_counters enable row level security;
alter table public.spend_reservations enable row level security;
-- No policies: users cannot read or write these tables directly. Only the
-- functions below (security definer) touch them.
revoke all on public.spend_counters, public.spend_reservations from anon, authenticated;

-- ---------------------------------------------------------------------------
-- reserve_provider_spend: check the caps and hold an amount, atomically
-- ---------------------------------------------------------------------------
-- Returns allowed = true and a reservation ID, or allowed = false and the
-- first cap that would be passed: 'period' (Nebius all-time or Tavily month),
-- 'day' (all users, UTC day) or 'user' (this user, UTC day).
create function public.reserve_provider_spend(
  p_provider text,
  p_amount bigint,
  p_day_cap bigint,
  p_period_cap bigint,
  p_user_day_cap bigint
)
returns table (allowed boolean, reservation_id uuid, limit_hit text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_day date := (now() at time zone 'utc')::date;
  v_period_kind text;
  v_period_start date;
  -- Hard ceilings. Callers are untrusted, so the caps they pass must stay
  -- inside these bounds.
  v_max_amount bigint;
  v_max_day_cap bigint;
  v_max_period_cap bigint;
  v_max_user_day_cap bigint;
  v_max_user_day_count integer := 1000;
  v_day_used bigint;
  v_period_used bigint;
  v_user_used bigint;
  v_user_count integer;
  v_id uuid;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  if p_provider = 'nebius' then
    v_period_kind := 'total';
    v_period_start := date '2000-01-01';
    v_max_amount := 250000;          -- $0.25: more than one worst-case request
    v_max_day_cap := 100000000;      -- $100
    v_max_period_cap := 1000000000;  -- $1,000
    v_max_user_day_cap := 500000;    -- $0.50 for one account in one day
  elsif p_provider = 'tavily' then
    v_period_kind := 'month';
    v_period_start := date_trunc('month', v_day)::date;
    v_max_amount := 2;               -- one advanced search
    v_max_day_cap := 1000;
    v_max_period_cap := 20000;
    v_max_user_day_cap := 20;
  else
    raise exception 'invalid spend parameters' using errcode = '22023';
  end if;

  if p_amount is null or p_amount < 1 or p_amount > v_max_amount
     or p_day_cap is null or p_day_cap < 1 or p_day_cap > v_max_day_cap
     or p_period_cap is null or p_period_cap < 1 or p_period_cap > v_max_period_cap
     or p_user_day_cap is null or p_user_day_cap < 1
     or p_user_day_cap > least(p_day_cap, v_max_user_day_cap) then
    raise exception 'invalid spend parameters' using errcode = '22023';
  end if;

  -- Make sure both counter rows exist, then lock them, always day first, so
  -- concurrent reservations wait for each other and cannot both pass a cap.
  insert into public.spend_counters (provider, period_kind, period_start)
  values (p_provider, 'day', v_day), (p_provider, v_period_kind, v_period_start)
  on conflict do nothing;

  select c.used into v_day_used
    from public.spend_counters c
   where c.provider = p_provider and c.period_kind = 'day' and c.period_start = v_day
     for update;
  select c.used into v_period_used
    from public.spend_counters c
   where c.provider = p_provider and c.period_kind = v_period_kind and c.period_start = v_period_start
     for update;

  -- Safe without a lock on these rows: every reservation for this provider
  -- holds the day row lock above.
  select coalesce(sum(r.charged), 0), count(*) into v_user_used, v_user_count
    from public.spend_reservations r
   where r.user_id = v_user and r.provider = p_provider and r.usage_day = v_day;

  if v_period_used + p_amount > p_period_cap then
    return query select false, null::uuid, 'period'::text;
    return;
  end if;
  if v_day_used + p_amount > p_day_cap then
    return query select false, null::uuid, 'day'::text;
    return;
  end if;
  if v_user_used + p_amount > p_user_day_cap or v_user_count >= v_max_user_day_count then
    return query select false, null::uuid, 'user'::text;
    return;
  end if;

  update public.spend_counters c
     set used = c.used + p_amount, updated_at = now()
   where c.provider = p_provider and c.period_kind = 'day' and c.period_start = v_day;
  update public.spend_counters c
     set used = c.used + p_amount, updated_at = now()
   where c.provider = p_provider and c.period_kind = v_period_kind and c.period_start = v_period_start;

  insert into public.spend_reservations
    (user_id, provider, usage_day, period_kind, period_start, held, charged)
  values (v_user, p_provider, v_day, v_period_kind, v_period_start, p_amount, p_amount)
  returning id into v_id;

  -- Opportunistic cleanup of this user's old reservations. Counters keep the
  -- totals. Rows locked by a settle in progress are skipped.
  delete from public.spend_reservations r
   where r.id in (
     select o.id from public.spend_reservations o
      where o.user_id = v_user and o.created_at < now() - interval '40 days'
        for update skip locked
   );

  return query select true, v_id, null::text;
end;
$$;

revoke execute on function public.reserve_provider_spend(text, bigint, bigint, bigint, bigint) from public, anon;
grant execute on function public.reserve_provider_spend(text, bigint, bigint, bigint, bigint) to authenticated;

-- ---------------------------------------------------------------------------
-- settle_provider_spend: record the real cost of a reserved call
-- ---------------------------------------------------------------------------
-- Sets the reservation's cost to p_amount (0 to the hold) and gives the
-- difference back to the counters. Works once per reservation, and only for
-- the caller's own reservation. Returns false if there is nothing to settle.
create function public.settle_provider_spend(p_reservation uuid, p_amount bigint)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_res public.spend_reservations%rowtype;
  v_refund bigint;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if p_reservation is null or p_amount is null or p_amount < 0 then
    raise exception 'invalid spend parameters' using errcode = '22023';
  end if;

  select r.* into v_res
    from public.spend_reservations r
   where r.id = p_reservation and r.user_id = v_user
     for update;
  if not found or v_res.settled_at is not null then
    return false;
  end if;
  if p_amount > v_res.held then
    raise exception 'invalid spend parameters' using errcode = '22023';
  end if;

  v_refund := v_res.held - p_amount;
  update public.spend_reservations r
     set charged = p_amount, settled_at = now()
   where r.id = p_reservation;

  if v_refund > 0 then
    -- Same lock order as reserve_provider_spend: day row, then period row.
    update public.spend_counters c
       set used = greatest(c.used - v_refund, 0), updated_at = now()
     where c.provider = v_res.provider and c.period_kind = 'day' and c.period_start = v_res.usage_day;
    update public.spend_counters c
       set used = greatest(c.used - v_refund, 0), updated_at = now()
     where c.provider = v_res.provider and c.period_kind = v_res.period_kind
       and c.period_start = v_res.period_start;
  end if;
  return true;
end;
$$;

revoke execute on function public.settle_provider_spend(uuid, bigint) from public, anon;
grant execute on function public.settle_provider_spend(uuid, bigint) to authenticated;
