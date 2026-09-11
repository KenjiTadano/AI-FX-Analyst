-- Task013: extend analysis_snapshot validation for versioned AI/chart snapshots.
-- Column already exists as jsonb nullable; this only relaxes/extends check_trade.
-- No DROP, no data rewrite. Existing legacy snapshots remain valid.
begin;

create or replace function public.check_trade() returns trigger language plpgsql set search_path = '' as $$
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
    if jsonb_typeof(new.analysis_snapshot) <> 'object' then raise exception 'Invalid snapshot type'; end if;
    -- Shared required fields for legacy and version=1 snapshots.
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
    -- Task013 versioned snapshot: require action/direction/isFallback when version=1.
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
  return new;
end; $$;

comment on column public.trades.analysis_snapshot is 'Immutable AI analysis snapshot at trade registration. Legacy (no version) or Task013 version=1 with optional chartEvidence/chartAnalysis.';

commit;
