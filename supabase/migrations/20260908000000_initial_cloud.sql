-- Task008. Defaults match lib/settings/defaults.json; parity is checked by tests.
begin;
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text check (char_length(display_name) <= 100),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.user_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  current_capital numeric not null default 50000 check (current_capital >= 0 and current_capital <= 1000000000000),
  target_capital numeric not null default 100000 check (target_capital >= 0.01 and target_capital <= 1000000000000),
  risk_percent numeric not null default 1 check (risk_percent > 0 and risk_percent <= 10),
  trade_unit integer not null default 1000 check (trade_unit > 0 and trade_unit <= 100000000),
  version bigint not null default 1 check (version > 0),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.trades (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  pair text not null check (pair in ('USD/JPY','EUR/JPY','GBP/JPY')),
  side text not null check (side in ('long','short')),
  status text not null check (status in ('open','closed')),
  quantity integer not null check (quantity > 0 and quantity <= 100000000),
  entry_price numeric not null check (entry_price > 0 and entry_price <= 1000000),
  exit_price numeric check (exit_price > 0 and exit_price <= 1000000),
  opened_at timestamptz not null, closed_at timestamptz,
  stop_loss numeric check (stop_loss > 0 and stop_loss <= 1000000),
  take_profit numeric check (take_profit > 0 and take_profit <= 1000000),
  realized_pnl numeric check (realized_pnl between -1000000000 and 1000000000),
  notes text check (char_length(notes) <= 4000),
  analysis_snapshot jsonb check (analysis_snapshot is null or jsonb_typeof(analysis_snapshot) = 'object'),
  local_trade_id text check (char_length(local_trade_id) between 1 and 100),
  version bigint not null default 1 check (version > 0),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  constraint trade_dates check (opened_at >= '1000-01-01'::timestamptz and opened_at < '10000-01-01'::timestamptz and (closed_at is null or closed_at >= opened_at and closed_at < '10000-01-01'::timestamptz)),
  constraint trade_state check ((status='open' and exit_price is null and closed_at is null and realized_pnl is null) or (status='closed' and exit_price is not null and closed_at is not null and realized_pnl is not null)),
  constraint trade_storage_dates check (isfinite(created_at) and isfinite(updated_at) and updated_at >= created_at),
  unique (user_id, local_trade_id)
);
create index trades_user_id on public.trades(user_id);
create index trades_user_opened_at on public.trades(user_id, opened_at desc);
create index trades_user_status on public.trades(user_id, status);
create index trades_user_closed_at on public.trades(user_id, closed_at desc) where status='closed';

create function public.touch_updated_at() returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := clock_timestamp();
  if tg_table_name <> 'profiles' then new.version := old.version + 1; end if;
  return new;
end; $$;
create trigger profiles_updated before update on public.profiles for each row execute function public.touch_updated_at();
create trigger settings_updated before update on public.user_settings for each row execute function public.touch_updated_at();

create function public.check_trade() returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then
    if new.user_id <> old.user_id or new.id <> old.id or new.created_at <> old.created_at or new.local_trade_id is distinct from old.local_trade_id or new.analysis_snapshot is distinct from old.analysis_snapshot then
      raise exception 'Trade ownership and registration snapshot are immutable';
    end if;
    new.updated_at := clock_timestamp(); new.version := old.version + 1;
  end if;
  if new.status = 'closed' then
    new.realized_pnl := round((case when new.side='long' then new.exit_price-new.entry_price else new.entry_price-new.exit_price end) * new.quantity, 2);
  else new.realized_pnl := null; end if;
  if new.analysis_snapshot is not null then
    if not (new.analysis_snapshot ?& array['pair','signal','score','confidence','summary','dataQualityScore','analyzedAt','capturedAt','expiresAt','aiStatus','model','bullishReasons','bearishReasons']) then raise exception 'Invalid snapshot fields'; end if;
    if new.analysis_snapshot->>'signal' not in ('strong_buy','buy','wait','sell','strong_sell') or jsonb_typeof(new.analysis_snapshot->'score') <> 'number' or (new.analysis_snapshot->>'score')::numeric not between -100 and 100 or jsonb_typeof(new.analysis_snapshot->'confidence') <> 'number' or (new.analysis_snapshot->>'confidence')::numeric not between 0 and 100 or jsonb_typeof(new.analysis_snapshot->'dataQualityScore') <> 'number' or (new.analysis_snapshot->>'dataQualityScore')::numeric not between 0 and 100 or jsonb_typeof(new.analysis_snapshot->'summary') <> 'string' then raise exception 'Invalid snapshot values'; end if;
  end if;
  return new;
end; $$;
create trigger trades_checked before insert or update on public.trades for each row execute function public.check_trade();

-- Auth trigger is the only elevated function, with fixed schema-qualified targets.
create function public.handle_new_user() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles(id) values(new.id) on conflict do nothing;
  insert into public.user_settings(user_id) values(new.id) on conflict do nothing;
  return new;
end; $$;
create trigger auth_user_created after insert on auth.users for each row execute function public.handle_new_user();
insert into public.profiles(id) select id from auth.users on conflict do nothing;
insert into public.user_settings(user_id) select id from auth.users on conflict do nothing;
revoke all on function public.handle_new_user() from public, anon, authenticated;

alter table public.profiles enable row level security;
alter table public.user_settings enable row level security;
alter table public.trades enable row level security;
revoke all on public.profiles, public.user_settings, public.trades from public, anon;
grant select, insert, update, delete on public.profiles, public.user_settings, public.trades to authenticated;
create policy profiles_owner on public.profiles for all to authenticated using ((select auth.uid()) = id) with check ((select auth.uid()) = id);
create policy settings_owner on public.user_settings for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy trades_owner on public.trades for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

-- RLS still applies to every imported row. Each batch is atomic; repeated imports do not overwrite.
create function public.import_local_trades(payload jsonb) returns integer language plpgsql security invoker set search_path = '' as $$
declare imported integer;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if jsonb_typeof(payload) <> 'array' or jsonb_array_length(payload) > 100 then raise exception 'Invalid import batch'; end if;
  if exists(select 1 from jsonb_array_elements(payload) x where x->>'local_trade_id' is null or x->>'user_id' is distinct from auth.uid()::text) then raise exception 'Invalid import owner or source id'; end if;
  insert into public.trades(user_id, local_trade_id, pair, side, status, quantity, entry_price, exit_price, opened_at, closed_at, stop_loss, take_profit, realized_pnl, notes, analysis_snapshot, created_at, updated_at)
  select auth.uid(), r.local_trade_id, r.pair, r.side, r.status, r.quantity, r.entry_price, r.exit_price, r.opened_at, r.closed_at, r.stop_loss, r.take_profit, r.realized_pnl, r.notes, r.analysis_snapshot, r.created_at, r.updated_at
  from jsonb_to_recordset(payload) as r(local_trade_id text, pair text, side text, status text, quantity integer, entry_price numeric, exit_price numeric, opened_at timestamptz, closed_at timestamptz, stop_loss numeric, take_profit numeric, realized_pnl numeric, notes text, analysis_snapshot jsonb, created_at timestamptz, updated_at timestamptz)
  on conflict (user_id, local_trade_id) do nothing;
  get diagnostics imported = row_count;
  return imported;
end; $$;
revoke all on function public.import_local_trades(jsonb) from public, anon;
grant execute on function public.import_local_trades(jsonb) to authenticated;
commit;
