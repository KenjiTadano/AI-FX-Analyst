import { summarize } from "./analytics";
import { MIN_INSIGHT_SAMPLE_SIZE } from "./analysis-price";
import { calculateRealizedR, summarizeRPerformance } from "./exit-plan";
import {
  ACTION_GROUP_LABELS,
  ACTION_GROUP_ORDER,
  DLL_GROUP_LABELS,
  DLL_GROUP_ORDER,
  EVENT_GROUP_LABELS,
  EVENT_GROUP_ORDER,
  FRESHNESS_GROUP_LABELS,
  FRESHNESS_GROUP_ORDER,
  TRIGGER_GROUP_LABELS,
  TRIGGER_GROUP_ORDER,
  buildPreTradeContextPerformance,
  contextFromTrade,
  formatContextProfitFactor,
  type ContextPerformanceGroup,
} from "./pre-trade-performance";
import {
  ALIGNMENT_GROUP_LABELS,
  ALIGNMENT_GROUP_ORDER,
  AI_MTF_GROUP_LABELS,
  AI_MTF_GROUP_ORDER,
  HTF_GROUP_LABELS,
  HTF_GROUP_ORDER,
  buildMtfPerformanceAnalysis,
  type PerformanceGroup,
} from "./mtf-performance";
import { storedMarketRegimeAnalysis } from "./regime-snapshot";
import { storedMultiTimeframeAnalysis } from "./mtf-snapshot";
import { marketContextFromTrade } from "./market-context-snapshot";
import { isRichSnapshot } from "./snapshot";
import type { Trade } from "./types";
import type { MarketRegimeKind, VolatilityRegime } from "../market/market-regime";
import {
  finiteNumber,
  type TimeframeTrend,
} from "../market/multi-timeframe";
import { type MarketTimeframe } from "../market/types";

export { MIN_INSIGHT_SAMPLE_SIZE, formatContextProfitFactor };

export const PERFORMANCE_INTELLIGENCE_TITLE = "Trading Performance Intelligence";
export const PERFORMANCE_INTELLIGENCE_EYEBROW = "PERFORMANCE INTELLIGENCE";
export const PERFORMANCE_INTELLIGENCE_DISCLAIMER =
  "この集計は保存済み取引の過去結果です。将来の勝率や利益を予測するものではなく、因果関係や優位性を示すものでもありません。";
export const PERFORMANCE_INTELLIGENCE_EMPTY = "この期間には決済済み取引がありません。";
export const MAX_PERFORMANCE_OBSERVATIONS = 5;

/** Display order for individual timeframe performance (saved MTF frames only). */
export const INDIVIDUAL_TF_ORDER = ["15m", "1h", "4h", "1day"] as const satisfies readonly MarketTimeframe[];

export const INDIVIDUAL_TF_LABELS: Record<(typeof INDIVIDUAL_TF_ORDER)[number], string> = {
  "15m": "15m",
  "1h": "1h",
  "4h": "4h",
  "1day": "1D",
};

export const TF_TREND_ORDER = ["bullish", "bearish", "neutral"] as const;

export const TF_TREND_LABELS: Record<(typeof TF_TREND_ORDER)[number], string> = {
  bullish: "bullish",
  bearish: "bearish",
  neutral: "neutral",
};

export const SMA_CONTEXT_ORDER = [
  "price_gt_sma20",
  "price_lt_sma20",
  "price_gt_sma75",
  "price_lt_sma75",
  "price_gt_sma200",
  "price_lt_sma200",
] as const;

export type SmaContextKey = (typeof SMA_CONTEXT_ORDER)[number];

export const SMA_CONTEXT_LABELS: Record<SmaContextKey, string> = {
  price_gt_sma20: "price > SMA20",
  price_lt_sma20: "price < SMA20",
  price_gt_sma75: "price > SMA75",
  price_lt_sma75: "price < SMA75",
  price_gt_sma200: "price > SMA200",
  price_lt_sma200: "price < SMA200",
};

export const RSI_BUCKET_ORDER = [
  "rsi_lt_30",
  "rsi_30_45",
  "rsi_45_55",
  "rsi_55_70",
  "rsi_gt_70",
] as const;

export type RsiBucketKey = (typeof RSI_BUCKET_ORDER)[number];

export const RSI_BUCKET_LABELS: Record<RsiBucketKey, string> = {
  rsi_lt_30: "RSI < 30",
  rsi_30_45: "RSI 30–45",
  rsi_45_55: "RSI 45–55",
  rsi_55_70: "RSI 55–70",
  rsi_gt_70: "RSI > 70",
};

export const TECHNICAL_NO_PRICE = "保存データなし（価格がsnapshotにありません）";
export const TECHNICAL_NO_SMA = "保存データなし（SMA値がsnapshotにありません）";
export const TECHNICAL_NO_RSI = "保存データなし（RSIがsnapshotにありません）";
export const TIMEFRAME_NO_MTF = "保存データなし（MTF snapshotがありません）";
export const TIMEFRAME_NO_FRAME = "この時間軸の保存データなし";

export const R_DISTRIBUTION_ORDER = [
  "r_le_minus_1",
  "r_minus_1_to_0",
  "r_0_to_1",
  "r_1_to_2",
  "r_ge_2",
] as const;

export type RDistributionBucket = typeof R_DISTRIBUTION_ORDER[number];

export const R_DISTRIBUTION_LABELS: Record<RDistributionBucket, string> = {
  r_le_minus_1: "R ≤ -1",
  r_minus_1_to_0: "-1 < R < 0",
  r_0_to_1: "0 ≤ R < 1",
  r_1_to_2: "1 ≤ R < 2",
  r_ge_2: "R ≥ 2",
};

export type AiDirectionKey = "BUY" | "SELL" | "WAIT" | "unavailable";

export const AI_DIRECTION_ORDER = ["BUY", "SELL", "WAIT", "unavailable"] as const;

export const AI_DIRECTION_LABELS: Record<AiDirectionKey, string> = {
  BUY: "BUY",
  SELL: "SELL",
  WAIT: "WAIT",
  unavailable: "unavailable",
};

export type RegimeGroupKey = MarketRegimeKind | "context_missing";

export const REGIME_GROUP_ORDER = ["trending", "range", "transition", "unavailable", "context_missing"] as const;

export const REGIME_GROUP_LABELS: Record<RegimeGroupKey, string> = {
  trending: "trending",
  range: "range",
  transition: "transition",
  unavailable: "unavailable（保存時点）",
  context_missing: "context_missing（未保存）",
};

export const VOLATILITY_GROUP_ORDER = ["high", "normal", "low", "unavailable"] as const;

export const VOLATILITY_GROUP_LABELS: Record<VolatilityRegime, string> = {
  high: "high",
  normal: "normal",
  low: "low",
  unavailable: "unavailable",
};

export type CoverageMetric = {
  present: number;
  eligible: number;
  missing: number;
  rate: number | null;
};

export type ContextSummary = {
  key: string;
  label: string;
  sampleSize: number;
  wins: number;
  losses: number;
  breakEven: number;
  winRate: number | null;
  totalPnl: number;
  averagePnl: number | null;
  profitFactor: number | null;
  sufficientSample: boolean;
  rSampleSize: number;
  totalR: number | null;
  averageR: number | null;
};

export type TradingPerformanceIntelligence = {
  periodLabel: string;
  overview: {
    closedTrades: number;
    totalPnl: number;
    averagePnl: number | null;
    winRate: number | null;
    profitFactor: number | null;
    rCoverage: CoverageMetric;
    totalR: number | null;
    averageR: number | null;
  };
  coverage: {
    preTrade: CoverageMetric;
    mtf: CoverageMetric;
    regime: CoverageMetric & { unavailableSaved: number; contextMissing: number };
    r: CoverageMetric;
  };
  rPerformance: {
    coverage: CoverageMetric;
    totalR: number | null;
    averageR: number | null;
    positiveRCount: number;
    negativeRCount: number;
    distribution: Record<RDistributionBucket, number>;
  };
  aiDirection: {
    groups: ContextSummary[];
  };
  preTrade: {
    coverage: CoverageMetric;
    byTrigger: ContextPerformanceGroup[];
    byAction: ContextPerformanceGroup[];
    byFreshness: ContextPerformanceGroup[];
    byEventRisk: ContextPerformanceGroup[];
    byDll: ContextPerformanceGroup[];
  };
  mtf: {
    coverage: CoverageMetric;
    byAlignment: PerformanceGroup[];
    byHigherTimeframeBias: PerformanceGroup[];
    byAiDirectionContext: PerformanceGroup[];
  };
  regime: {
    coverage: CoverageMetric & { unavailableSaved: number; contextMissing: number };
    byRegime: ContextSummary[];
    byVolatility: ContextSummary[];
  };
  cross: {
    regimeMtf: ContextSummary[];
  };
  timeframe: {
    coverage: CoverageMetric;
    missingMtf: number;
    byTimeframe: IndividualTimeframePerformance[];
  };
  technical: {
    sma: {
      coverage: CoverageMetric;
      groups: ContextSummary[];
      noDataReason: string | null;
    };
    rsi: {
      coverage: CoverageMetric;
      groups: ContextSummary[];
      noDataReason: string | null;
    };
  };
  observations: string[];
};

export type IndividualTimeframePerformance = {
  timeframe: (typeof INDIVIDUAL_TF_ORDER)[number];
  label: string;
  eligibleWithFrame: number;
  missingFrame: number;
  byTrend: ContextSummary[];
  noDataReason: string | null;
};

const FORBIDDEN =
  /この条件で取引すると有利|トレンド相場を狙うべき|レンジを避けるべき|勝ちパターン|今後も期待できる|優位性がある|\bbest\b|\bworst\b|good context|bad context|high quality|\bscore\b|有意に高い|統計的に優位|統計的有意|良いR|悪いR|理想|最低2R/;

function assertSafe(text: string): string {
  if (FORBIDDEN.test(text)) throw new Error(`performance intelligence wording rejected: ${text}`);
  return text;
}

function eligibleClosed(trades: Trade[]): Trade[] {
  return trades.filter(trade =>
    trade.status === "closed"
    && trade.realizedPnl !== null
    && Number.isFinite(trade.realizedPnl),
  );
}

function coverage(present: number, eligible: number): CoverageMetric {
  return {
    present,
    eligible,
    missing: Math.max(0, eligible - present),
    rate: eligible ? (present / eligible) * 100 : null,
  };
}

export function formatCoverage(metric: CoverageMetric): string {
  if (!metric.eligible) return "—";
  const pct = metric.rate == null || !Number.isFinite(metric.rate) ? "—" : `${metric.rate.toFixed(1)}%`;
  return `${metric.present} / ${metric.eligible}（${pct}）`;
}

/** Task031 realized R only. No custom formula. */
export function realizedROrNull(trade: Trade): number | null {
  const value = calculateRealizedR(trade);
  return value != null && Number.isFinite(value) ? value : null;
}

export function classifyRDistributionBucket(r: number): RDistributionBucket {
  if (r <= -1) return "r_le_minus_1";
  if (r > -1 && r < 0) return "r_minus_1_to_0";
  if (r >= 0 && r < 1) return "r_0_to_1";
  if (r >= 1 && r < 2) return "r_1_to_2";
  return "r_ge_2";
}

/** Saved snapshot.action only. Does not invent direction from live AI. */
export function classifySavedAiDirection(trade: Trade): AiDirectionKey {
  const snap = trade.analysisSnapshot;
  if (!isRichSnapshot(snap)) return "unavailable";
  if (snap.action === "BUY" || snap.action === "SELL" || snap.action === "WAIT") return snap.action;
  return "unavailable";
}

/**
 * Regime grouping from saved snapshot only.
 * missing snapshot → context_missing
 * saved unavailable regime → unavailable
 */
export function classifySavedRegimeGroup(trade: Trade): RegimeGroupKey {
  const regime = storedMarketRegimeAnalysis(trade);
  if (!regime) return "context_missing";
  if (regime.regime === "trending" || regime.regime === "range" || regime.regime === "transition") return regime.regime;
  return "unavailable";
}

export function classifySavedVolatility(trade: Trade): VolatilityRegime | null {
  const regime = storedMarketRegimeAnalysis(trade);
  if (!regime) return null;
  if (regime.volatility === "high" || regime.volatility === "normal" || regime.volatility === "low") return regime.volatility;
  return "unavailable";
}

/**
 * Saved 1h technicals only (MTF 1h frame preferred, else Regime evidence).
 * Never recomputes from live market data.
 */
export type SavedTechnicalPoint = {
  close: number;
  sma20: number | null;
  sma75: number | null;
  sma200: number | null;
  rsi14: number | null;
  source: "mtf_1h" | "regime_1h";
};

export function savedTechnicalPoint(trade: Trade): SavedTechnicalPoint | null {
  const independent = marketContextFromTrade(trade)?.technicalContext;
  if (independent && finiteNumber(independent.lastClose)) {
    return {
      close: independent.lastClose,
      sma20: finiteNumber(independent.sma20) ? independent.sma20 : null,
      sma75: finiteNumber(independent.sma75) ? independent.sma75 : null,
      sma200: finiteNumber(independent.sma200) ? independent.sma200 : null,
      rsi14: finiteNumber(independent.rsi14) ? independent.rsi14 : null,
      source: independent.source,
    };
  }
  const mtf = storedMultiTimeframeAnalysis(trade);
  const frame1h = mtf?.timeframes.find(frame => frame.timeframe === "1h");
  if (frame1h && frame1h.sufficientData && finiteNumber(frame1h.lastClose)) {
    return {
      close: frame1h.lastClose,
      sma20: finiteNumber(frame1h.sma20) ? frame1h.sma20 : null,
      sma75: finiteNumber(frame1h.sma75) ? frame1h.sma75 : null,
      sma200: finiteNumber(frame1h.sma200) ? frame1h.sma200 : null,
      rsi14: finiteNumber(frame1h.rsi14) ? frame1h.rsi14 : null,
      source: "mtf_1h",
    };
  }
  const regime = storedMarketRegimeAnalysis(trade);
  if (regime && finiteNumber(regime.evidence.close)) {
    const e = regime.evidence;
    return {
      close: e.close!,
      sma20: finiteNumber(e.sma20) ? e.sma20 : null,
      sma75: finiteNumber(e.sma75) ? e.sma75 : null,
      sma200: finiteNumber(e.sma200) ? e.sma200 : null,
      rsi14: finiteNumber(e.rsi14) ? e.rsi14 : null,
      source: "regime_1h",
    };
  }
  return null;
}

/** Saved MTF frame trend for one timeframe. Missing/unavailable → null (exclude from that TF analysis). */
export function savedTimeframeTrend(trade: Trade, timeframe: MarketTimeframe): TimeframeTrend | null {
  const mtf = storedMultiTimeframeAnalysis(trade);
  if (!mtf) return null;
  const frame = mtf.timeframes.find(item => item.timeframe === timeframe);
  if (!frame || !frame.sufficientData || frame.trend === "unavailable") return null;
  if (frame.trend === "bullish" || frame.trend === "bearish" || frame.trend === "neutral") return frame.trend;
  return null;
}

/** Deterministic RSI buckets from saved value only. */
export function classifyRsiBucket(rsi: number): RsiBucketKey {
  if (rsi < 30) return "rsi_lt_30";
  if (rsi < 45) return "rsi_30_45";
  if (rsi < 55) return "rsi_45_55";
  if (rsi <= 70) return "rsi_55_70";
  return "rsi_gt_70";
}

/** SMA relation buckets from saved close + SMA. Equal → empty (not guessed). */
export function classifySmaContexts(point: SavedTechnicalPoint): SmaContextKey[] {
  const keys: SmaContextKey[] = [];
  const push = (gt: SmaContextKey, lt: SmaContextKey, sma: number | null) => {
    if (!finiteNumber(sma)) return;
    if (point.close > sma) keys.push(gt);
    else if (point.close < sma) keys.push(lt);
  };
  push("price_gt_sma20", "price_lt_sma20", point.sma20);
  push("price_gt_sma75", "price_lt_sma75", point.sma75);
  push("price_gt_sma200", "price_lt_sma200", point.sma200);
  return keys;
}

export function calculateContextSummary(key: string, label: string, trades: Trade[]): ContextSummary {
  const stats = summarize(trades);
  const rValues = trades.map(realizedROrNull).filter((value): value is number => value != null);
  const rSampleSize = rValues.length;
  const totalR = rSampleSize ? rValues.reduce((sum, value) => sum + value, 0) : null;
  return {
    key,
    label,
    sampleSize: stats.count,
    wins: stats.wins,
    losses: stats.losses,
    breakEven: stats.draws,
    winRate: stats.winRate,
    totalPnl: stats.totalPnl,
    averagePnl: stats.count ? stats.totalPnl / stats.count : null,
    profitFactor: stats.profitFactor,
    sufficientSample: stats.count >= MIN_INSIGHT_SAMPLE_SIZE,
    rSampleSize,
    totalR,
    averageR: rSampleSize && totalR != null ? totalR / rSampleSize : null,
  };
}

function emptyBuckets<K extends string>(keys: readonly K[]): Record<K, Trade[]> {
  return Object.fromEntries(keys.map(key => [key, [] as Trade[]])) as Record<K, Trade[]>;
}

function fmtMoney(n: number): string {
  return `${n > 0 ? "+" : ""}${n.toLocaleString("ja-JP", { maximumFractionDigits: 2 })}円`;
}

function fmtR(n: number): string {
  const rounded = Math.round(n * 100) / 100;
  if (rounded === 0) return "0.00R";
  return `${rounded > 0 ? "+" : ""}${rounded.toFixed(2)}R`;
}

function buildObservations(input: {
  closed: Trade[];
  rSummary: ReturnType<typeof summarizeRPerformance>;
  regimeSummaries: ContextSummary[];
  regimeMtf: ContextSummary[];
  mtf: ReturnType<typeof buildMtfPerformanceAnalysis>;
  aiDirection: ContextSummary[];
  preTrade: ReturnType<typeof buildPreTradeContextPerformance>;
  timeframeSummaries: ContextSummary[];
  smaGroups: ContextSummary[];
  rsiGroups: ContextSummary[];
}): string[] {
  const items: string[] = [];
  const { closed, rSummary, regimeSummaries, regimeMtf, mtf, aiDirection, preTrade, timeframeSummaries, smaGroups, rsiGroups } = input;

  if (!closed.length) {
    return [assertSafe(PERFORMANCE_INTELLIGENCE_EMPTY)];
  }

  if (rSummary.eligibleCount > 0 && rSummary.sampleSize < rSummary.eligibleCount) {
    items.push(assertSafe(
      `R Coverageは${rSummary.sampleSize} / ${rSummary.eligibleCount}でした。R未算出の取引は0Rではなく missing として扱っています。`,
    ));
  }

  if (rSummary.sampleSize >= MIN_INSIGHT_SAMPLE_SIZE && rSummary.averageR != null) {
    items.push(assertSafe(
      `保存済みExit Planから算出できた取引の平均Rは${fmtR(rSummary.averageR)}でした（R n=${rSummary.sampleSize}）。`,
    ));
  }

  const trending = regimeSummaries.find(group => group.key === "trending");
  const range = regimeSummaries.find(group => group.key === "range");
  if (
    trending
    && range
    && (trending.rSampleSize ?? 0) >= MIN_INSIGHT_SAMPLE_SIZE
    && (range.rSampleSize ?? 0) >= MIN_INSIGHT_SAMPLE_SIZE
    && trending.averageR != null
    && range.averageR != null
  ) {
    items.push(assertSafe(
      `保存済みRegimeがtrendingだった取引の平均Rは${fmtR(trending.averageR)}（R n=${trending.rSampleSize}）、rangeだった取引の平均Rは${fmtR(range.averageR)}（R n=${range.rSampleSize}）でした。`,
    ));
  }

  const trendingAligned = regimeMtf.find(group => group.key === "trending_aligned");
  const trendingMixed = regimeMtf.find(group => group.key === "trending_mixed");
  if (
    trendingAligned
    && trendingMixed
    && trendingAligned.sufficientSample
    && trendingMixed.sufficientSample
    && trendingAligned.averagePnl != null
    && trendingMixed.averagePnl != null
  ) {
    items.push(assertSafe(
      `RegimeがtrendingかつMTFが一致していた取引の平均損益は${fmtMoney(trendingAligned.averagePnl)}（n=${trendingAligned.sampleSize}）、MTFがmixedだった取引の平均損益は${fmtMoney(trendingMixed.averagePnl)}（n=${trendingMixed.sampleSize}）でした。`,
    ));
  }

  const alignedBull = mtf.byAlignment.find(group => group.key === "aligned_bullish");
  const mixed = mtf.byAlignment.find(group => group.key === "mixed");
  if (alignedBull && mixed && alignedBull.sufficientSample && mixed.sufficientSample
    && alignedBull.averagePnl != null && mixed.averagePnl != null) {
    items.push(assertSafe(
      `保存済みMTFが全時間軸で上向きだった取引の平均損益は${fmtMoney(alignedBull.averagePnl)}（n=${alignedBull.sampleSize}）、時間軸混在は${fmtMoney(mixed.averagePnl)}（n=${mixed.sampleSize}）でした。`,
    ));
  }

  const fourHourBull = timeframeSummaries.find(group => group.key === "4h:bullish");
  if (fourHourBull && fourHourBull.sufficientSample && fourHourBull.averageR != null && fourHourBull.rSampleSize >= MIN_INSIGHT_SAMPLE_SIZE) {
    items.push(assertSafe(
      `4H bullish contextではn=${fourHourBull.sampleSize}、平均Rは${fmtR(fourHourBull.averageR)}でした。`,
    ));
  }

  const wait = aiDirection.find(group => group.key === "WAIT");
  const buy = aiDirection.find(group => group.key === "BUY");
  if (wait && buy && wait.sufficientSample && buy.sufficientSample
    && wait.averagePnl != null && buy.averagePnl != null) {
    items.push(assertSafe(
      `保存済みActionがWAITだった取引の平均損益は${fmtMoney(wait.averagePnl)}（n=${wait.sampleSize}）、BUYだった取引は${fmtMoney(buy.averagePnl)}（n=${buy.sampleSize}）でした。`,
    ));
  }

  const met = preTrade.triggerGroups.find(group => group.key === "met");
  const notMet = preTrade.triggerGroups.find(group => group.key === "not_met");
  if (met && notMet && met.sufficientSample && notMet.sufficientSample
    && met.averagePnl != null && notMet.averagePnl != null) {
    items.push(assertSafe(
      `保存済みTriggerが成立だった取引の平均損益は${fmtMoney(met.averagePnl)}（n=${met.sampleSize}）、未成立は${fmtMoney(notMet.averagePnl)}（n=${notMet.sampleSize}）でした。`,
    ));
  }

  const gtSma20 = smaGroups.find(group => group.key === "price_gt_sma20");
  if (gtSma20 && gtSma20.sufficientSample && gtSma20.averagePnl != null) {
    items.push(assertSafe(
      `保存済み1hでprice > SMA20だった取引の平均損益は${fmtMoney(gtSma20.averagePnl)}（n=${gtSma20.sampleSize}）でした。`,
    ));
  }

  const rsiMid = rsiGroups.find(group => group.key === "rsi_45_55");
  if (rsiMid && rsiMid.sufficientSample && rsiMid.averagePnl != null) {
    items.push(assertSafe(
      `保存済み1h RSIが45–55だった取引の平均損益は${fmtMoney(rsiMid.averagePnl)}（n=${rsiMid.sampleSize}）でした。`,
    ));
  }

  const missing = regimeSummaries.find(group => group.key === "context_missing");
  const unavailable = regimeSummaries.find(group => group.key === "unavailable");
  if ((missing?.sampleSize ?? 0) > 0 || (unavailable?.sampleSize ?? 0) > 0) {
    items.push(assertSafe(
      `Regime context_missing は${missing?.sampleSize ?? 0}件、保存時点unavailableは${unavailable?.sampleSize ?? 0}件でした。両者は区別しています。`,
    ));
  }

  return items.slice(0, MAX_PERFORMANCE_OBSERVATIONS);
}

/**
 * Aggregate historical Performance Intelligence from already period-filtered trades.
 * Does not apply its own date window. Does not read live AI/MTF/Regime.
 */
export function buildPerformanceIntelligence(
  trades: Trade[],
  periodLabel = "全期間",
): TradingPerformanceIntelligence {
  const closed = eligibleClosed(trades);
  const rSummary = summarizeRPerformance(closed);
  const rCoverage = coverage(rSummary.sampleSize, rSummary.eligibleCount);

  const distribution = Object.fromEntries(R_DISTRIBUTION_ORDER.map(key => [key, 0])) as Record<RDistributionBucket, number>;
  for (const trade of closed) {
    const r = realizedROrNull(trade);
    if (r == null) continue;
    distribution[classifyRDistributionBucket(r)] += 1;
  }

  const preTradeAnalysis = buildPreTradeContextPerformance(closed, periodLabel);
  const mtfAnalysis = buildMtfPerformanceAnalysis(closed, periodLabel);

  const aiBuckets = emptyBuckets(AI_DIRECTION_ORDER);
  const regimeBuckets = emptyBuckets(REGIME_GROUP_ORDER);
  const volatilityBuckets = emptyBuckets(VOLATILITY_GROUP_ORDER);
  const crossBuckets: Record<string, Trade[]> = {
    trending_aligned: [],
    trending_mixed: [],
  };

  let regimePresent = 0;
  let regimeUnavailableSaved = 0;
  let regimeContextMissing = 0;
  let mtfPresent = 0;
  let preTradePresent = 0;

  for (const trade of closed) {
    aiBuckets[classifySavedAiDirection(trade)].push(trade);

    if (contextFromTrade(trade)) preTradePresent += 1;
    if (storedMultiTimeframeAnalysis(trade)) mtfPresent += 1;

    const regimeGroup = classifySavedRegimeGroup(trade);
    regimeBuckets[regimeGroup].push(trade);
    if (regimeGroup === "context_missing") {
      regimeContextMissing += 1;
    } else {
      regimePresent += 1;
      if (regimeGroup === "unavailable") regimeUnavailableSaved += 1;
      const vol = classifySavedVolatility(trade);
      if (vol) volatilityBuckets[vol].push(trade);

      const mtf = storedMultiTimeframeAnalysis(trade);
      if (regimeGroup === "trending" && mtf) {
        if (mtf.alignment === "aligned_bullish" || mtf.alignment === "aligned_bearish") {
          crossBuckets.trending_aligned.push(trade);
        } else if (mtf.alignment === "mixed") {
          crossBuckets.trending_mixed.push(trade);
        }
      }
    }
  }

  const aiDirectionGroups = AI_DIRECTION_ORDER
    .map(key => calculateContextSummary(key, AI_DIRECTION_LABELS[key], aiBuckets[key]))
    .filter(group => group.sampleSize > 0);

  const regimeSummaries = REGIME_GROUP_ORDER
    .map(key => calculateContextSummary(key, REGIME_GROUP_LABELS[key], regimeBuckets[key]))
    .filter(group => group.sampleSize > 0);

  const volatilitySummaries = VOLATILITY_GROUP_ORDER
    .map(key => calculateContextSummary(key, VOLATILITY_GROUP_LABELS[key], volatilityBuckets[key]))
    .filter(group => group.sampleSize > 0);

  const regimeMtf = [
    calculateContextSummary("trending_aligned", "trending × MTF一致", crossBuckets.trending_aligned),
    calculateContextSummary("trending_mixed", "trending × MTF混在", crossBuckets.trending_mixed),
  ].filter(group => group.sampleSize > 0);

  // --- Task103: individual timeframe / SMA / RSI from saved snapshots only ---
  const tfTrendBuckets: Record<string, Trade[]> = {};
  for (const tf of INDIVIDUAL_TF_ORDER) {
    for (const trend of TF_TREND_ORDER) {
      tfTrendBuckets[`${tf}:${trend}`] = [];
    }
  }
  const smaBuckets = emptyBuckets(SMA_CONTEXT_ORDER);
  const rsiBuckets = emptyBuckets(RSI_BUCKET_ORDER);
  let smaPresent = 0;
  let rsiPresent = 0;
  let technicalPricePresent = 0;

  for (const trade of closed) {
    for (const tf of INDIVIDUAL_TF_ORDER) {
      const trend = savedTimeframeTrend(trade, tf);
      if (trend) tfTrendBuckets[`${tf}:${trend}`]!.push(trade);
    }
    const point = savedTechnicalPoint(trade);
    if (!point) continue;
    technicalPricePresent += 1;
    const smaKeys = classifySmaContexts(point);
    if (smaKeys.length) {
      smaPresent += 1;
      for (const key of smaKeys) smaBuckets[key].push(trade);
    }
    if (finiteNumber(point.rsi14)) {
      rsiPresent += 1;
      rsiBuckets[classifyRsiBucket(point.rsi14)].push(trade);
    }
  }

  const byTimeframe: IndividualTimeframePerformance[] = INDIVIDUAL_TF_ORDER.map(tf => {
    const byTrend = TF_TREND_ORDER
      .map(trend => calculateContextSummary(
        `${tf}:${trend}`,
        `${INDIVIDUAL_TF_LABELS[tf]} ${TF_TREND_LABELS[trend]}`,
        tfTrendBuckets[`${tf}:${trend}`] ?? [],
      ))
      .filter(group => group.sampleSize > 0);
    const eligibleWithFrame = byTrend.reduce((sum, group) => sum + group.sampleSize, 0);
    const missingFrame = Math.max(0, closed.length - eligibleWithFrame);
    const noDataReason = !mtfPresent
      ? TIMEFRAME_NO_MTF
      : eligibleWithFrame === 0
        ? TIMEFRAME_NO_FRAME
        : null;
    return {
      timeframe: tf,
      label: INDIVIDUAL_TF_LABELS[tf],
      eligibleWithFrame,
      missingFrame,
      byTrend,
      noDataReason,
    };
  });

  const timeframeTrendSummaries = byTimeframe.flatMap(block => block.byTrend);

  const smaGroups = SMA_CONTEXT_ORDER
    .map(key => calculateContextSummary(key, SMA_CONTEXT_LABELS[key], smaBuckets[key]))
    .filter(group => group.sampleSize > 0);
  const rsiGroups = RSI_BUCKET_ORDER
    .map(key => calculateContextSummary(key, RSI_BUCKET_LABELS[key], rsiBuckets[key]))
    .filter(group => group.sampleSize > 0);

  const smaNoData = !technicalPricePresent
    ? TECHNICAL_NO_PRICE
    : smaPresent === 0
      ? TECHNICAL_NO_SMA
      : null;
  const rsiNoData = !technicalPricePresent
    ? TECHNICAL_NO_PRICE
    : rsiPresent === 0
      ? TECHNICAL_NO_RSI
      : null;

  const stats = summarize(closed);
  const regimeCoverage = {
    ...coverage(regimePresent, closed.length),
    unavailableSaved: regimeUnavailableSaved,
    contextMissing: regimeContextMissing,
  };

  const observations = buildObservations({
    closed,
    rSummary,
    regimeSummaries,
    regimeMtf,
    mtf: mtfAnalysis,
    aiDirection: aiDirectionGroups,
    preTrade: preTradeAnalysis,
    timeframeSummaries: timeframeTrendSummaries,
    smaGroups,
    rsiGroups,
  });

  return {
    periodLabel,
    overview: {
      closedTrades: stats.count,
      totalPnl: stats.totalPnl,
      averagePnl: stats.count ? stats.totalPnl / stats.count : null,
      winRate: stats.winRate,
      profitFactor: stats.profitFactor,
      rCoverage,
      totalR: rSummary.totalR,
      averageR: rSummary.averageR,
    },
    coverage: {
      preTrade: coverage(preTradePresent, closed.length),
      mtf: coverage(mtfPresent, closed.length),
      regime: regimeCoverage,
      r: rCoverage,
    },
    rPerformance: {
      coverage: rCoverage,
      totalR: rSummary.totalR,
      averageR: rSummary.averageR,
      positiveRCount: rSummary.positiveR,
      negativeRCount: rSummary.negativeR,
      distribution,
    },
    aiDirection: { groups: aiDirectionGroups },
    preTrade: {
      coverage: coverage(preTradePresent, closed.length),
      byTrigger: presentGroups(TRIGGER_GROUP_ORDER, TRIGGER_GROUP_LABELS, preTradeAnalysis.triggerGroups),
      byAction: presentGroups(ACTION_GROUP_ORDER, ACTION_GROUP_LABELS, preTradeAnalysis.actionGroups),
      byFreshness: presentGroups(FRESHNESS_GROUP_ORDER, FRESHNESS_GROUP_LABELS, preTradeAnalysis.freshnessGroups),
      byEventRisk: presentGroups(EVENT_GROUP_ORDER, EVENT_GROUP_LABELS, preTradeAnalysis.eventRiskGroups),
      byDll: presentGroups(DLL_GROUP_ORDER, DLL_GROUP_LABELS, preTradeAnalysis.dailyLossLimitGroups),
    },
    mtf: {
      coverage: coverage(mtfPresent, closed.length),
      byAlignment: presentPerf(ALIGNMENT_GROUP_ORDER, ALIGNMENT_GROUP_LABELS, mtfAnalysis.byAlignment),
      byHigherTimeframeBias: presentPerf(HTF_GROUP_ORDER, HTF_GROUP_LABELS, mtfAnalysis.byHigherTimeframeBias),
      byAiDirectionContext: presentPerf(AI_MTF_GROUP_ORDER, AI_MTF_GROUP_LABELS, mtfAnalysis.byAiDirectionContext),
    },
    regime: {
      coverage: regimeCoverage,
      byRegime: regimeSummaries,
      byVolatility: volatilitySummaries,
    },
    cross: { regimeMtf },
    timeframe: {
      coverage: coverage(mtfPresent, closed.length),
      missingMtf: Math.max(0, closed.length - mtfPresent),
      byTimeframe,
    },
    technical: {
      sma: {
        coverage: coverage(smaPresent, closed.length),
        groups: smaGroups,
        noDataReason: smaNoData,
      },
      rsi: {
        coverage: coverage(rsiPresent, closed.length),
        groups: rsiGroups,
        noDataReason: rsiNoData,
      },
    },
    observations,
  };
}

function presentGroups<K extends string>(
  order: readonly K[],
  labels: Record<K, string>,
  groups: ContextPerformanceGroup[],
): ContextPerformanceGroup[] {
  const byKey = new Map(groups.map(group => [group.key, group]));
  return order
    .map(key => byKey.get(key) ?? {
      key,
      label: labels[key],
      sampleSize: 0,
      wins: 0,
      losses: 0,
      breakEven: 0,
      winRate: null,
      totalPnl: 0,
      averagePnl: null,
      profitFactor: null,
      sufficientSample: false,
    })
    .filter(group => group.sampleSize > 0);
}

function presentPerf<K extends string>(
  order: readonly K[],
  labels: Record<K, string>,
  groups: PerformanceGroup[],
): PerformanceGroup[] {
  return presentGroups(order, labels, groups);
}
