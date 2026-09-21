-- Task105: append-only market context revision history.
-- Original market_context_snapshot stays immutable (Task104 rule unchanged).
-- Revisions are never used as entry original / Performance Intelligence input.
begin;

alter table public.trades
  add column if not exists market_context_revisions jsonb
  check (
    market_context_revisions is null
    or (
      jsonb_typeof(market_context_revisions) = 'array'
      and jsonb_array_length(market_context_revisions) <= 20
    )
  );

comment on column public.trades.market_context_revisions is
  'Append-only manual market context re-captures (Task105). Not entry original. Max 20. NULL for legacy.';

create or replace function public.check_trade() returns trigger language plpgsql set search_path = '' as $$
declare
  old_revs jsonb;
  new_revs jsonb;
  old_len integer;
  new_len integer;
  i integer;
begin
  if tg_op = 'UPDATE' then
    if new.user_id <> old.user_id or new.id <> old.id or new.created_at <> old.created_at or new.local_trade_id is distinct from old.local_trade_id
      or new.analysis_snapshot is distinct from old.analysis_snapshot
      or new.exit_plan is distinct from old.exit_plan
      or new.market_context_snapshot is distinct from old.market_context_snapshot then
      raise exception 'Trade ownership and registration snapshots are immutable';
    end if;

    -- market_context_revisions: append-only (prefix preserved). No edit/delete/reorder.
    old_revs := coalesce(old.market_context_revisions, '[]'::jsonb);
    new_revs := coalesce(new.market_context_revisions, '[]'::jsonb);
    if jsonb_typeof(old_revs) <> 'array' or jsonb_typeof(new_revs) <> 'array' then
      raise exception 'Invalid market context revisions type';
    end if;
    old_len := jsonb_array_length(old_revs);
    new_len := jsonb_array_length(new_revs);
    if new_len < old_len then
      raise exception 'Market context revisions are append-only';
    end if;
    if new_len > 20 then
      raise exception 'Market context revisions limit exceeded';
    end if;
    i := 0;
    while i < old_len loop
      if old_revs->i is distinct from new_revs->i then
        raise exception 'Market context revisions are append-only';
      end if;
      i := i + 1;
    end loop;

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
  if new.market_context_snapshot is not null then
    if jsonb_typeof(new.market_context_snapshot) <> 'object' then raise exception 'Invalid market context type'; end if;
    if (new.market_context_snapshot->>'version')::int is distinct from 1 then raise exception 'Unsupported market context version'; end if;
    if not (new.market_context_snapshot ?& array['version','capturedAt','pair']) then
      raise exception 'Invalid market context fields';
    end if;
    if new.market_context_snapshot ? 'aiStatus' or new.market_context_snapshot ? 'model' or new.market_context_snapshot ? 'provider' then
      raise exception 'AI fields are not allowed in market context snapshot';
    end if;
  end if;
  if new.market_context_revisions is not null then
    if jsonb_typeof(new.market_context_revisions) <> 'array' then raise exception 'Invalid market context revisions type'; end if;
    if jsonb_array_length(new.market_context_revisions) > 20 then raise exception 'Market context revisions limit exceeded'; end if;
    i := 0;
    while i < jsonb_array_length(new.market_context_revisions) loop
      if jsonb_typeof(new.market_context_revisions->i) <> 'object' then raise exception 'Invalid market context revision'; end if;
      if (new.market_context_revisions->i->>'version')::int is distinct from 1 then raise exception 'Unsupported market context revision version'; end if;
      if not (new.market_context_revisions->i ?& array['version','capturedAt','pair','reason']) then
        raise exception 'Invalid market context revision fields';
      end if;
      if new.market_context_revisions->i->>'reason' is distinct from 'manual_refresh' then
        raise exception 'Invalid market context revision reason';
      end if;
      if (new.market_context_revisions->i) ? 'aiStatus'
        or (new.market_context_revisions->i) ? 'model'
        or (new.market_context_revisions->i) ? 'provider' then
        raise exception 'AI fields are not allowed in market context revision';
      end if;
      i := i + 1;
    end loop;
  end if;
  return new;
end; $$;

-- Atomic append with optimistic version. Does not touch market_context_snapshot.
create or replace function public.append_market_context_revision(
  p_trade_id uuid,
  p_expected_version integer,
  p_revision jsonb
) returns public.trades
language plpgsql
security invoker
set search_path = ''
as $$
declare
  row public.trades;
  current_revs jsonb;
  next_revs jsonb;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_revision is null or jsonb_typeof(p_revision) <> 'object' then raise exception 'Invalid revision'; end if;
  if (p_revision->>'reason') is distinct from 'manual_refresh' then raise exception 'Invalid revision reason'; end if;
  if p_revision ? 'aiStatus' or p_revision ? 'model' or p_revision ? 'provider' then
    raise exception 'AI fields are not allowed in market context revision';
  end if;

  select * into row from public.trades
  where id = p_trade_id and user_id = auth.uid()
  for update;
  if not found then raise exception 'Trade not found'; end if;
  if row.version is distinct from p_expected_version then raise exception 'Version conflict'; end if;
  if p_revision->>'pair' is distinct from row.pair then raise exception 'Pair mismatch'; end if;

  current_revs := coalesce(row.market_context_revisions, '[]'::jsonb);
  if jsonb_typeof(current_revs) <> 'array' then raise exception 'Invalid revisions'; end if;
  if jsonb_array_length(current_revs) >= 20 then raise exception 'Market context revisions limit exceeded'; end if;

  next_revs := current_revs || jsonb_build_array(p_revision);

  update public.trades
  set market_context_revisions = next_revs
  where id = p_trade_id and user_id = auth.uid() and version = p_expected_version
  returning * into row;
  if not found then raise exception 'Version conflict'; end if;
  return row;
end;
$$;

revoke all on function public.append_market_context_revision(uuid, integer, jsonb) from public, anon;
grant execute on function public.append_market_context_revision(uuid, integer, jsonb) to authenticated;

create or replace function public.import_local_trades(payload jsonb) returns integer language plpgsql security invoker set search_path = '' as $$
declare imported integer;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if jsonb_typeof(payload) <> 'array' or jsonb_array_length(payload) > 100 then raise exception 'Invalid import batch'; end if;
  if exists(select 1 from jsonb_array_elements(payload) x where x->>'local_trade_id' is null or x->>'user_id' is distinct from auth.uid()::text) then raise exception 'Invalid import owner or source id'; end if;
  insert into public.trades(user_id, local_trade_id, pair, side, status, quantity, entry_price, exit_price, opened_at, closed_at, stop_loss, take_profit, realized_pnl, notes, analysis_snapshot, exit_plan, market_context_snapshot, market_context_revisions, created_at, updated_at)
  select auth.uid(), r.local_trade_id, r.pair, r.side, r.status, r.quantity, r.entry_price, r.exit_price, r.opened_at, r.closed_at, r.stop_loss, r.take_profit, r.realized_pnl, r.notes, r.analysis_snapshot, r.exit_plan, r.market_context_snapshot, r.market_context_revisions, r.created_at, r.updated_at
  from jsonb_to_recordset(payload) as r(
    local_trade_id text, pair text, side text, status text, quantity integer, entry_price numeric, exit_price numeric,
    opened_at timestamptz, closed_at timestamptz, stop_loss numeric, take_profit numeric, realized_pnl numeric, notes text,
    analysis_snapshot jsonb, exit_plan jsonb, market_context_snapshot jsonb, market_context_revisions jsonb, created_at timestamptz, updated_at timestamptz
  )
  on conflict (user_id, local_trade_id) do nothing;
  get diagnostics imported = row_count;
  return imported;
end; $$;

revoke all on function public.import_local_trades(jsonb) from public, anon;
grant execute on function public.import_local_trades(jsonb) to authenticated;

commit;
