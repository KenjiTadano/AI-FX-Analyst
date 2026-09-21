import { mtfTimeframes, type MarketTimeframe } from "../market/types";
import { TIMEFRAME_LABEL, type MarketStructure, type TimeframeTrend } from "../market/multi-timeframe";
import type { MarketRegimeKind, RegimeTrendDirection, VolatilityRegime } from "../market/market-regime";
import {
  classifyRsiBucket,
  RSI_BUCKET_LABELS,
  type RsiBucketKey,
} from "./performance-intelligence";
import {
  marketContextRevisionsFromTrade,
  sanitizeMarketContextSnapshot,
  type MarketContextRevision,
  type MarketContextSnapshot,
  type MarketContextTechnical,
} from "./market-context-snapshot";
import type { Trade } from "./types";

/** Display order for change UI (15m → 1D). Does not reorder stored arrays. */
export const CHANGE_TIMEFRAME_ORDER = ["15m", "1h", "4h", "1day"] as const satisfies readonly MarketTimeframe[];

export const MARKET_CONTEXT_CHANGE_TITLE = "市場変化";
export const MARKET_CONTEXT_CHANGE_EYEBROW = "MARKET CHANGE";
export const MARKET_CONTEXT_CHANGE_NO_ORIGINAL =
  "エントリー時Market Contextが保存されていないため変化比較できません";
export const MARKET_CONTEXT_CHANGE_NO_REVISIONS = "再取得履歴がありません";
export const MARKET_CONTEXT_CHANGE_NOTE =
  "保存済みの原本と再取得履歴の差分です。売買の案内ではありません。";
export const MARKET_CONTEXT_CHANGE_DISCLAIMER =
  "市場状態の変化という事実のみを表示します。評価や売買判断ではありません。";

export type ChangeStatus = "changed" | "unchanged" | "unavailable";
export type SmaRelation = "above" | "below" | "equal" | "unavailable";
export type ChangeMode = "original_to_latest" | "previous_to_latest" | "original_to_selected";

export type FieldChange<T> = {
  before: T | null;
  after: T | null;
  status: ChangeStatus;
};

export type NumericChange = {
  before: number | null;
  after: number | null;
  delta: number | null;
  status: ChangeStatus;
};

export type RateChange = {
  before: number | null;
  after: number | null;
  absolute: number | null;
  percent: number | null;
  status: ChangeStatus;
};

export type TimeframeChange = {
  timeframe: MarketTimeframe;
  label: string;
  trend: FieldChange<TimeframeTrend | "unavailable">;
  structure: FieldChange<MarketStructure>;
  sufficientData: FieldChange<boolean | null>;
  status: ChangeStatus;
};

export type RegimeChange = {
  regime: FieldChange<MarketRegimeKind | null>;
  trendDirection: FieldChange<RegimeTrendDirection | null>;
  volatility: FieldChange<VolatilityRegime | null>;
  status: ChangeStatus;
};

export type TechnicalChange = {
  lastClose: NumericChange;
  sma20: NumericChange;
  sma75: NumericChange;
  sma200: NumericChange;
  rsi14: NumericChange;
  smaRelations: {
    sma20: FieldChange<SmaRelation>;
    sma75: FieldChange<SmaRelation>;
    sma200: FieldChange<SmaRelation>;
  };
  rsiBucket: FieldChange<RsiBucketKey | null>;
  status: ChangeStatus;
};

export type ElapsedTime = {
  ms: number | null;
  label: string | null;
  invalid: boolean;
};

export type MarketContextChange = {
  mode: ChangeMode;
  fromLabel: string;
  toLabel: string;
  fromCapturedAt: string | null;
  toCapturedAt: string | null;
  elapsed: ElapsedTime;
  timestampAnomaly: boolean;
  rate: RateChange;
  timeframes: TimeframeChange[];
  timeframeSummary: { total: number; changed: number; unchanged: number; unavailable: number };
  regime: RegimeChange;
  technical: TechnicalChange;
};

export type MarketContextChangeAnalysis = {
  original: MarketContextSnapshot | null;
  revisions: MarketContextRevision[];
  /** Append order preserved. true if any later revision has earlier capturedAt. */
  appendOrderAnomaly: boolean;
  unavailableReason: "no_original" | "no_revisions" | null;
  comparison: MarketContextChange | null;
};

const ISO = (value: unknown): string | null =>
  typeof value === "string"
  && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
  && new Date(value).toISOString() === value
    ? value
    : null;

function fieldChange<T>(before: T | null, after: T | null, equal: (a: T, b: T) => boolean = (a, b) => a === b): FieldChange<T> {
  if (before == null && after == null) return { before, after, status: "unavailable" };
  if (before == null || after == null) return { before, after, status: "changed" };
  return { before, after, status: equal(before, after) ? "unchanged" : "changed" };
}

function numericChange(before: number | null, after: number | null): NumericChange {
  const b = typeof before === "number" && Number.isFinite(before) ? before : null;
  const a = typeof after === "number" && Number.isFinite(after) ? after : null;
  if (b == null && a == null) return { before: null, after: null, delta: null, status: "unavailable" };
  if (b == null || a == null) return { before: b, after: a, delta: null, status: "changed" };
  const delta = a - b;
  return { before: b, after: a, delta, status: delta === 0 ? "unchanged" : "changed" };
}

export function smaRelation(close: number | null, sma: number | null): SmaRelation {
  if (close == null || sma == null || !Number.isFinite(close) || !Number.isFinite(sma)) return "unavailable";
  if (close > sma) return "above";
  if (close < sma) return "below";
  return "equal";
}

export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "invalid";
  const totalMinutes = Math.floor(ms / 60_000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0 || days > 0) parts.push(`${hours}h`);
  parts.push(`${minutes}m`);
  return parts.join(" ");
}

export function elapsedBetween(fromIso: string | null, toIso: string | null): ElapsedTime {
  const from = ISO(fromIso);
  const to = ISO(toIso);
  if (!from || !to) return { ms: null, label: null, invalid: true };
  const ms = Date.parse(to) - Date.parse(from);
  if (!Number.isFinite(ms) || ms < 0) return { ms: null, label: null, invalid: true };
  return { ms, label: formatElapsed(ms), invalid: false };
}

function frameOf(ctx: MarketContextSnapshot | null, timeframe: MarketTimeframe) {
  return ctx?.multiTimeframe?.timeframes.find(frame => frame.timeframe === timeframe) ?? null;
}

function compareTimeframe(before: MarketContextSnapshot | null, after: MarketContextSnapshot | null, timeframe: MarketTimeframe): TimeframeChange {
  const b = frameOf(before, timeframe);
  const a = frameOf(after, timeframe);
  const trend = fieldChange<TimeframeTrend | "unavailable">(
    b?.trend ?? (before?.multiTimeframe ? "unavailable" : null),
    a?.trend ?? (after?.multiTimeframe ? "unavailable" : null),
  );
  const structure = fieldChange<MarketStructure>(
    b?.structure ?? null,
    a?.structure ?? null,
  );
  const sufficientData = fieldChange<boolean | null>(
    b ? b.sufficientData : null,
    a ? a.sufficientData : null,
  );
  const statuses = [trend.status, structure.status, sufficientData.status];
  let status: ChangeStatus = "unavailable";
  if (statuses.some(s => s === "changed")) status = "changed";
  else if (statuses.every(s => s === "unchanged")) status = "unchanged";
  else if (statuses.some(s => s === "unchanged")) status = "unchanged";
  return {
    timeframe,
    label: timeframe === "1day" ? "1D" : TIMEFRAME_LABEL[timeframe] ?? timeframe,
    trend,
    structure,
    sufficientData,
    status,
  };
}

function compareRegime(before: MarketContextSnapshot | null, after: MarketContextSnapshot | null): RegimeChange {
  const b = before?.marketRegime ?? null;
  const a = after?.marketRegime ?? null;
  const regime = fieldChange<MarketRegimeKind | null>(b?.regime ?? null, a?.regime ?? null);
  const trendDirection = fieldChange<RegimeTrendDirection | null>(b?.trendDirection ?? null, a?.trendDirection ?? null);
  const volatility = fieldChange<VolatilityRegime | null>(b?.volatility ?? null, a?.volatility ?? null);
  const statuses = [regime.status, trendDirection.status, volatility.status];
  let status: ChangeStatus = "unavailable";
  if (statuses.every(s => s === "unavailable")) status = "unavailable";
  else if (statuses.some(s => s === "changed")) status = "changed";
  else status = "unchanged";
  return { regime, trendDirection, volatility, status };
}

function relationChange(before: SmaRelation, after: SmaRelation): FieldChange<SmaRelation> {
  if (before === "unavailable" && after === "unavailable") {
    return { before, after, status: "unavailable" };
  }
  if (before === "unavailable" || after === "unavailable") {
    return { before, after, status: "changed" };
  }
  return { before, after, status: before === after ? "unchanged" : "changed" };
}

function compareTechnical(before: MarketContextSnapshot | null, after: MarketContextSnapshot | null): TechnicalChange {
  const b: MarketContextTechnical | null = before?.technicalContext ?? null;
  const a: MarketContextTechnical | null = after?.technicalContext ?? null;
  const lastClose = numericChange(b?.lastClose ?? null, a?.lastClose ?? null);
  const sma20 = numericChange(b?.sma20 ?? null, a?.sma20 ?? null);
  const sma75 = numericChange(b?.sma75 ?? null, a?.sma75 ?? null);
  const sma200 = numericChange(b?.sma200 ?? null, a?.sma200 ?? null);
  const rsi14 = numericChange(b?.rsi14 ?? null, a?.rsi14 ?? null);
  const smaRelations = {
    sma20: relationChange(smaRelation(b?.lastClose ?? null, b?.sma20 ?? null), smaRelation(a?.lastClose ?? null, a?.sma20 ?? null)),
    sma75: relationChange(smaRelation(b?.lastClose ?? null, b?.sma75 ?? null), smaRelation(a?.lastClose ?? null, a?.sma75 ?? null)),
    sma200: relationChange(smaRelation(b?.lastClose ?? null, b?.sma200 ?? null), smaRelation(a?.lastClose ?? null, a?.sma200 ?? null)),
  };
  const beforeBucket = b?.rsi14 != null && Number.isFinite(b.rsi14) ? classifyRsiBucket(b.rsi14) : null;
  const afterBucket = a?.rsi14 != null && Number.isFinite(a.rsi14) ? classifyRsiBucket(a.rsi14) : null;
  const rsiBucket = fieldChange<RsiBucketKey | null>(beforeBucket, afterBucket);
  const statuses = [
    lastClose.status, sma20.status, sma75.status, sma200.status, rsi14.status,
    smaRelations.sma20.status, smaRelations.sma75.status, smaRelations.sma200.status, rsiBucket.status,
  ];
  let status: ChangeStatus = "unavailable";
  if (statuses.every(s => s === "unavailable")) status = "unavailable";
  else if (statuses.some(s => s === "changed")) status = "changed";
  else status = "unchanged";
  return { lastClose, sma20, sma75, sma200, rsi14, smaRelations, rsiBucket, status };
}

function compareRate(before: MarketContextSnapshot | null, after: MarketContextSnapshot | null): RateChange {
  const b = before?.marketRate ?? null;
  const a = after?.marketRate ?? null;
  if (b == null && a == null) return { before: null, after: null, absolute: null, percent: null, status: "unavailable" };
  if (b == null || a == null) return { before: b, after: a, absolute: null, percent: null, status: "changed" };
  const absolute = a - b;
  const percent = b === 0 ? null : (absolute / b) * 100;
  return {
    before: b,
    after: a,
    absolute,
    percent,
    status: absolute === 0 ? "unchanged" : "changed",
  };
}

/** Pure compare of two saved contexts. No market fetch. No AI. */
export function compareMarketContexts(
  before: MarketContextSnapshot | null,
  after: MarketContextSnapshot | null,
  meta: { mode: ChangeMode; fromLabel: string; toLabel: string },
): MarketContextChange {
  const timeframes = CHANGE_TIMEFRAME_ORDER.map(tf => compareTimeframe(before, after, tf));
  const timeframeSummary = {
    total: timeframes.length,
    changed: timeframes.filter(t => t.status === "changed").length,
    unchanged: timeframes.filter(t => t.status === "unchanged").length,
    unavailable: timeframes.filter(t => t.status === "unavailable").length,
  };
  const fromCapturedAt = before?.capturedAt ?? null;
  const toCapturedAt = after?.capturedAt ?? null;
  const elapsed = elapsedBetween(fromCapturedAt, toCapturedAt);
  return {
    mode: meta.mode,
    fromLabel: meta.fromLabel,
    toLabel: meta.toLabel,
    fromCapturedAt,
    toCapturedAt,
    elapsed,
    timestampAnomaly: elapsed.invalid,
    rate: compareRate(before, after),
    timeframes,
    timeframeSummary,
    regime: compareRegime(before, after),
    technical: compareTechnical(before, after),
  };
}

export function detectAppendOrderAnomaly(revisions: MarketContextRevision[]): boolean {
  for (let i = 1; i < revisions.length; i += 1) {
    const prev = ISO(revisions[i - 1]?.capturedAt);
    const curr = ISO(revisions[i]?.capturedAt);
    if (!prev || !curr) return true;
    if (Date.parse(curr) < Date.parse(prev)) return true;
  }
  return false;
}

export type BuildChangeOptions = {
  mode?: ChangeMode;
  /** 0-based revision index for original_to_selected */
  selectedRevisionIndex?: number;
};

/**
 * Build change analysis from trade provenance only.
 * Original = marketContextSnapshot (never revision).
 * Revisions = append order (never reordered by timestamp).
 */
export function buildMarketContextChangeAnalysis(
  trade: Trade,
  options: BuildChangeOptions = {},
): MarketContextChangeAnalysis {
  const original = sanitizeMarketContextSnapshot(trade.marketContextSnapshot);
  const revisions = marketContextRevisionsFromTrade(trade);
  const appendOrderAnomaly = detectAppendOrderAnomaly(revisions);

  if (!original) {
    return {
      original: null,
      revisions,
      appendOrderAnomaly,
      unavailableReason: "no_original",
      comparison: null,
    };
  }
  if (revisions.length === 0) {
    return {
      original,
      revisions,
      appendOrderAnomaly,
      unavailableReason: "no_revisions",
      comparison: null,
    };
  }

  const mode: ChangeMode = options.mode ?? "original_to_latest";
  let before: MarketContextSnapshot = original;
  let after: MarketContextSnapshot = revisions[revisions.length - 1]!;
  let fromLabel = "Original";
  let toLabel = `再取得 ${revisions.length}`;

  if (mode === "previous_to_latest") {
    if (revisions.length === 1) {
      before = original;
      after = revisions[0]!;
      fromLabel = "Original";
      toLabel = "再取得 1";
    } else {
      before = revisions[revisions.length - 2]!;
      after = revisions[revisions.length - 1]!;
      fromLabel = `再取得 ${revisions.length - 1}`;
      toLabel = `再取得 ${revisions.length}`;
    }
  } else if (mode === "original_to_selected") {
    const idx = Math.max(0, Math.min(revisions.length - 1, options.selectedRevisionIndex ?? revisions.length - 1));
    before = original;
    after = revisions[idx]!;
    fromLabel = "Original";
    toLabel = `再取得 ${idx + 1}`;
  }

  return {
    original,
    revisions,
    appendOrderAnomaly,
    unavailableReason: null,
    comparison: compareMarketContexts(before, after, { mode, fromLabel, toLabel }),
  };
}

export function rsiBucketLabel(key: RsiBucketKey | null): string {
  if (!key) return "unavailable";
  return RSI_BUCKET_LABELS[key];
}

/** Ensure CHANGE_TIMEFRAME_ORDER covers the same set as mtfTimeframes (order may differ). */
export function changeTimeframeSetMatchesMtf(): boolean {
  const a = [...CHANGE_TIMEFRAME_ORDER].sort().join(",");
  const b = [...mtfTimeframes].sort().join(",");
  return a === b;
}
