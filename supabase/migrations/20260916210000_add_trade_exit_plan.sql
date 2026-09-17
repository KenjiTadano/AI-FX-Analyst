-- Task031: persist registration-time Exit Plan as nullable JSONB.
-- Legacy rows stay NULL. RLS unchanged. Immutable after insert like analysis_snapshot.
begin;

alter table public.trades
  add column if not exists exit_plan jsonb
  check (exit_plan is null or jsonb_typeof(exit_plan) = 'object');

comment on column public.trades.exit_plan is
  'Immutable Exit Plan captured at trade registration. version=1 JSON. NULL for legacy or missing SL.';

create or replace function public.check_trade() returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then
    if new.user_id <> old.user_id or new.id <> old.id or new.created_at <> old.created_at or new.local_trade_id is distinct from old.local_trade_id or new.analysis_snapshot is distinct from old.analysis_snapshot or new.exit_plan is distinct from old.exit_plan then
      raise exception 'Trade ownership, registration snapshot and exit plan are immutable';
    end if;
    new.updated_at := clock_timestamp(); new.version := old.version + 1;
  end if;
  if new.status = 'closed' then
    new.realized_pnl := round((case when new.side='long' then new.exit_price-new.entry_price else new.entry_price-new.exit_price end) * new.quantity, 2);
  else new.realized_pnl := null; end if;
  if new.analysis_snapshot is not null then
    if jsonb_typeof(new.analysis_snapshot) <> 'object' then raise exception 'Invalid snapshot type'; end if;
    if not (new.analysis_snapshot ?& array['pair','signal','score','confidence','summary','dataQualityScore','analyzedAt','capturedAt','expiresAt','aiStatus','model','bullishReasons','bearishReasons']) then
      raise exception 'Invalid snapshot fields';
    end if;
    if new.analysis_snapshot->>'signal' not in ('strong_buy','buy','wait','sell','strong_sell')
      or jsonb_typeof(new.analysis_snapshot->'score') <> 'number'
      or (new.analysis_snapshot->>'score')::numeric not between -100 and 100
      or jsonb_typeof(new.analysis_snapshot->'confidence') <> 'number'
      or (new.analysis_snapshot->>'confidence')::numeric not between 0 and 100
      or jsonb_typeof(new.analysis_snapshot->'dataQualityScore') <> 'number'
      or (new.analysis_snapshot->>'dataQualityScore')::numeric not between 0 and 100
      or jsonb_typeof(new.analysis_snapshot->'summary') <> 'string' then
      raise exception 'Invalid snapshot values';
    end if;
    if new.analysis_snapshot ? 'version' then
      if (new.analysis_snapshot->>'version')::int <> 1 then raise exception 'Unsupported snapshot version'; end if;
      if not (new.analysis_snapshot ?& array['directionSignal','action','isFallback','capturedAt']) then
        raise exception 'Invalid versioned snapshot fields';
      end if;
      if new.analysis_snapshot->>'action' not in ('BUY','SELL','WAIT') then raise exception 'Invalid snapshot action'; end if;
      if new.analysis_snapshot->>'directionSignal' not in ('strong_buy','buy','wait','sell','strong_sell') then raise exception 'Invalid snapshot direction'; end if;
      if jsonb_typeof(new.analysis_snapshot->'isFallback') <> 'boolean' then raise exception 'Invalid snapshot fallback flag'; end if;
    end if;
  end if;
  if new.exit_plan is not null then
    if jsonb_typeof(new.exit_plan) <> 'object' then raise exception 'Invalid exit plan type'; end if;
  end if;
  return new;
end; $$;

create or replace function public.import_local_trades(payload jsonb) returns integer language plpgsql security invoker set search_path = '' as $$
declare imported integer;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if jsonb_typeof(payload) <> 'array' or jsonb_array_length(payload) > 100 then raise exception 'Invalid import batch'; end if;
  if exists(select 1 from jsonb_array_elements(payload) x where x->>'local_trade_id' is null or x->>'user_id' is distinct from auth.uid()::text) then raise exception 'Invalid import owner or source id'; end if;
  insert into public.trades(user_id, local_trade_id, pair, side, status, quantity, entry_price, exit_price, opened_at, closed_at, stop_loss, take_profit, realized_pnl, notes, analysis_snapshot, exit_plan, created_at, updated_at)
  select auth.uid(), r.local_trade_id, r.pair, r.side, r.status, r.quantity, r.entry_price, r.exit_price, r.opened_at, r.closed_at, r.stop_loss, r.take_profit, r.realized_pnl, r.notes, r.analysis_snapshot, r.exit_plan, r.created_at, r.updated_at
  from jsonb_to_recordset(payload) as r(local_trade_id text, pair text, side text, status text, quantity integer, entry_price numeric, exit_price numeric, opened_at timestamptz, closed_at timestamptz, stop_loss numeric, take_profit numeric, realized_pnl numeric, notes text, analysis_snapshot jsonb, exit_plan jsonb, created_at timestamptz, updated_at timestamptz)
  on conflict (user_id, local_trade_id) do nothing;
  get diagnostics imported = row_count;
  return imported;
end; $$;

revoke all on function public.import_local_trades(jsonb) from public, anon;
grant execute on function public.import_local_trades(jsonb) to authenticated;

commit;
