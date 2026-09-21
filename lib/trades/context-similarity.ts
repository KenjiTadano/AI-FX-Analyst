import type { MarketTimeframe } from "../market/types";
import type { TimeframeTrend } from "../market/multi-timeframe";
import type { MarketRegimeKind, RegimeTrendDirection, VolatilityRegime } from "../market/market-regime";
import type { MarketData } from "../market/types";
import {
  CHANGE_TIMEFRAME_ORDER,
  smaRelation,
  type SmaRelation,
} from "./market-context-change";
import {
  captureMarketContextSnapshot,
  marketContextFromTrade,
  sanitizeMarketContextSnapshot,
  type MarketContextSnapshot,
  type MarketContextTechnical,
} from "./market-context-snapshot";
import {
  classifyRsiBucket,
  realizedROrNull,
  type RsiBucketKey,
} from "./performance-intelligence";
import type { Trade, TradePair } from "./types";

export const SIMILAR_HISTORICAL_TITLE = "類似する過去コンテキスト";
export const SIMILAR_HISTORICAL_EYEBROW = "SIMILAR HISTORICAL CONTEXT";
export const SIMILAR_HISTORICAL_DISCLAIMER =
  "市場コンテキストが似ていても、同じ結果になることを意味しません。";
export const SIMILAR_HISTORICAL_OUTCOME_NOTE =
  "過去の損益は類似度の計算には使用していません。";
export const SIMILAR_HISTORICAL_NOTE =
  "現在のMarket Contextと、過去トレードのEntry時Original Snapshotを比較した参考事例です。売買判断ではありません。";

/** Minimum dimensions that must be comparable before ranking. */
export const MIN_COMPARABLE_DIMENSIONS = 5;
/** Minimum match ratio to surface as “similar”. Not a quality judgment. */
export const MIN_SIMILARITY = 0.6;
export const MAX_SIMILAR_RESULTS = 5;

export type DimensionCompareStatus = "match" | "mismatch" | "not_comparable";

export type SimilarityDimensionKey =
  | "mtf_15m"
  | "mtf_1h"
  | "mtf_4h"
  | "mtf_1day"
  | "regime"
  | "trendDirection"
  | "volatility"
  | "sma20"
  | "sma75"
  | "sma200"
  | "rsiBucket";

export const SIMILARITY_DIMENSION_ORDER: readonly SimilarityDimensionKey[] = [
  "mtf_15m",
  "mtf_1h",
  "mtf_4h",
  "mtf_1day",
  "regime",
  "trendDirection",
  "volatility",
  "sma20",
  "sma75",
  "sma200",
  "rsiBucket",
] as const;

export const SIMILARITY_DIMENSION_LABELS: Record<SimilarityDimensionKey, string> = {
  mtf_15m: "15m trend",
  mtf_1h: "1H trend",
  mtf_4h: "4H trend",
  mtf_1day: "1D trend",
  regime: "Regime",
  trendDirection: "Trend Direction",
  volatility: "Volatility",
  sma20: "SMA20 relation",
  sma75: "SMA75 relation",
  sma200: "SMA200 relation",
  rsiBucket: "RSI bucket",
};

export type SimilarityDimensionResult = {
  key: SimilarityDimensionKey;
  label: string;
  status: DimensionCompareStatus;
  current: string | null;
  historical: string | null;
};

export type ContextSimilarityScore = {
  matches: number;
  comparable: number;
  totalDimensions: number;
  /** matches / comparable when comparable > 0; otherwise null */
  ratio: number | null;
  percent: number | null;
  sufficientComparable: boolean;
  meetsThreshold: boolean;
  dimensions: SimilarityDimensionResult[];
};

export type SimilarHistoricalOutcome = {
  available: boolean;
  realizedPnl: number | null;
  realizedR: number | null;
  side: Trade["side"];
  openedAt: string;
  closedAt: string | null;
  status: Trade["status"];
};

export type SimilarHistoricalMatch = {
  tradeId: string;
  pair: TradePair;
  similarity: ContextSimilarityScore;
  outcome: SimilarHistoricalOutcome;
  historicalCapturedAt: string;
};

export type SimilarHistoricalEmptyReason =
  | "current_unavailable"
  | "no_historical_snapshot"
  | "no_same_pair_candidate"
  | "insufficient_comparable"
  | "below_threshold"
  | null;

export type SimilarHistoricalContextResult = {
  pair: TradePair;
  current: MarketContextSnapshot | null;
  matches: SimilarHistoricalMatch[];
  emptyReason: SimilarHistoricalEmptyReason;
  scannedSamePair: number;
  withOriginal: number;
};

type TrendValue = TimeframeTrend | "unavailable" | null;

function frameTrend(ctx: MarketContextSnapshot | null, timeframe: MarketTimeframe): TrendValue {
  if (!ctx?.multiTimeframe) return null;
  const frame = ctx.multiTimeframe.timeframes.find(item => item.timeframe === timeframe);
  if (!frame) return "unavailable";
  return frame.trend ?? "unavailable";
}

function compareDiscrete<T extends string>(
  current: T | null | undefined,
  historical: T | null | undefined,
  unavailable: readonly string[] = ["unavailable"],
): DimensionCompareStatus {
  const a = current ?? null;
  const b = historical ?? null;
  if (a == null || b == null) return "not_comparable";
  if (unavailable.includes(a) || unavailable.includes(b)) return "not_comparable";
  return a === b ? "match" : "mismatch";
}

function techRelation(tech: MarketContextTechnical | null, which: "sma20" | "sma75" | "sma200"): SmaRelation {
  if (!tech) return "unavailable";
  const sma = tech[which];
  return smaRelation(tech.lastClose, sma);
}

function techRsiBucket(tech: MarketContextTechnical | null): RsiBucketKey | null {
  if (!tech || tech.rsi14 == null || !Number.isFinite(tech.rsi14)) return null;
  return classifyRsiBucket(tech.rsi14);
}

function formatValue(value: string | null | undefined): string | null {
  return value == null ? null : value;
}

/**
 * Compare two MarketContextSnapshots on MTF trend / Regime / Technical state only.
 * Does not use marketRate, lastClose absolute distance, P/L, R, AI, or outcomes.
 */
export function compareContextSimilarity(
  current: MarketContextSnapshot | null,
  historical: MarketContextSnapshot | null,
): ContextSimilarityScore {
  const dimensions: SimilarityDimensionResult[] = [];

  for (const tf of CHANGE_TIMEFRAME_ORDER) {
    const key = (`mtf_${tf}`) as SimilarityDimensionKey;
    const cur = frameTrend(current, tf);
    const hist = frameTrend(historical, tf);
    const status = compareDiscrete(cur, hist);
    dimensions.push({
      key,
      label: SIMILARITY_DIMENSION_LABELS[key],
      status,
      current: formatValue(cur),
      historical: formatValue(hist),
    });
  }

  const curRegime = current?.marketRegime ?? null;
  const histRegime = historical?.marketRegime ?? null;
  const regimeDims: Array<{
    key: SimilarityDimensionKey;
    cur: MarketRegimeKind | RegimeTrendDirection | VolatilityRegime | null;
    hist: MarketRegimeKind | RegimeTrendDirection | VolatilityRegime | null;
  }> = [
    { key: "regime", cur: curRegime?.regime ?? null, hist: histRegime?.regime ?? null },
    { key: "trendDirection", cur: curRegime?.trendDirection ?? null, hist: histRegime?.trendDirection ?? null },
    { key: "volatility", cur: curRegime?.volatility ?? null, hist: histRegime?.volatility ?? null },
  ];
  for (const dim of regimeDims) {
    const status = compareDiscrete(dim.cur, dim.hist);
    dimensions.push({
      key: dim.key,
      label: SIMILARITY_DIMENSION_LABELS[dim.key],
      status,
      current: formatValue(dim.cur),
      historical: formatValue(dim.hist),
    });
  }

  const curTech = current?.technicalContext ?? null;
  const histTech = historical?.technicalContext ?? null;
  for (const which of ["sma20", "sma75", "sma200"] as const) {
    const cur = techRelation(curTech, which);
    const hist = techRelation(histTech, which);
    const status = compareDiscrete(cur, hist, ["unavailable"]);
    dimensions.push({
      key: which,
      label: SIMILARITY_DIMENSION_LABELS[which],
      status,
      current: formatValue(cur),
      historical: formatValue(hist),
    });
  }

  const curBucket = techRsiBucket(curTech);
  const histBucket = techRsiBucket(histTech);
  const rsiStatus = compareDiscrete(curBucket, histBucket);
  dimensions.push({
    key: "rsiBucket",
    label: SIMILARITY_DIMENSION_LABELS.rsiBucket,
    status: rsiStatus,
    current: formatValue(curBucket),
    historical: formatValue(histBucket),
  });

  const comparable = dimensions.filter(d => d.status !== "not_comparable").length;
  const matches = dimensions.filter(d => d.status === "match").length;
  const ratio = comparable > 0 ? matches / comparable : null;
  const sufficientComparable = comparable >= MIN_COMPARABLE_DIMENSIONS;
  const meetsThreshold = sufficientComparable && ratio != null && ratio >= MIN_SIMILARITY;

  return {
    matches,
    comparable,
    totalDimensions: SIMILARITY_DIMENSION_ORDER.length,
    ratio,
    percent: ratio == null ? null : Math.round(ratio * 1000) / 10,
    sufficientComparable,
    meetsThreshold,
    dimensions,
  };
}

/** Build current context from already-fetched MarketData. No extra market API. */
export function buildCurrentMarketContext(input: {
  pair: string;
  capturedAt: string;
  market?: MarketData | null;
  marketRate?: number | null;
}): MarketContextSnapshot | null {
  return captureMarketContextSnapshot({
    pair: input.pair,
    capturedAt: input.capturedAt,
    market: input.market ?? null,
    marketRate: input.marketRate ?? null,
  });
}

/**
 * CLOSED-only candidates with Original snapshot on the same pair.
 * Revisions and legacy AI snapshots are never used as historical Entry context.
 * OPEN excluded: outcome reference is the product purpose; OPEN adds little without P/L.
 */
export function isSimilarHistoricalCandidate(trade: Trade, pair: TradePair): boolean {
  if (trade.pair !== pair) return false;
  if (trade.status !== "closed") return false;
  if (trade.realizedPnl === null || !Number.isFinite(trade.realizedPnl)) return false;
  return marketContextFromTrade(trade) != null;
}

/** Rank by similarity only — never P/L, R, win/loss, or AI. */
export function rankSimilarMatches(a: SimilarHistoricalMatch, b: SimilarHistoricalMatch): number {
  const ratioA = a.similarity.ratio ?? -1;
  const ratioB = b.similarity.ratio ?? -1;
  if (ratioB !== ratioA) return ratioB - ratioA;
  if (b.similarity.comparable !== a.similarity.comparable) {
    return b.similarity.comparable - a.similarity.comparable;
  }
  const timeA = Date.parse(a.outcome.openedAt);
  const timeB = Date.parse(b.outcome.openedAt);
  const safeA = Number.isFinite(timeA) ? timeA : 0;
  const safeB = Number.isFinite(timeB) ? timeB : 0;
  if (safeB !== safeA) return safeB - safeA;
  return b.tradeId.localeCompare(a.tradeId);
}

function buildOutcome(trade: Trade): SimilarHistoricalOutcome {
  return {
    available: trade.status === "closed" && trade.realizedPnl !== null && Number.isFinite(trade.realizedPnl),
    realizedPnl: trade.status === "closed" && trade.realizedPnl !== null && Number.isFinite(trade.realizedPnl)
      ? trade.realizedPnl
      : null,
    realizedR: realizedROrNull(trade),
    side: trade.side,
    openedAt: trade.openedAt,
    closedAt: trade.closedAt,
    status: trade.status,
  };
}

/**
 * Find similar historical Entry contexts for the current live Market Context.
 * Scoring uses context fields only. Outcomes are attached after ranking.
 */
export function findSimilarHistoricalContexts(input: {
  pair: TradePair;
  current: MarketContextSnapshot | null;
  trades: Trade[];
  excludeTradeId?: string | null;
  nowIso?: string;
}): SimilarHistoricalContextResult {
  const { pair, current, trades, excludeTradeId } = input;

  if (!current || !sanitizeMarketContextSnapshot(current, pair)) {
    return {
      pair,
      current: null,
      matches: [],
      emptyReason: "current_unavailable",
      scannedSamePair: 0,
      withOriginal: 0,
    };
  }

  const samePair = trades.filter(trade => trade.pair === pair && trade.id !== excludeTradeId);
  const withOriginal = samePair.filter(trade => marketContextFromTrade(trade) != null);
  if (withOriginal.length === 0) {
    const anyOriginalAnywhere = trades.some(trade => marketContextFromTrade(trade) != null);
    return {
      pair,
      current,
      matches: [],
      emptyReason: anyOriginalAnywhere ? "no_same_pair_candidate" : "no_historical_snapshot",
      scannedSamePair: samePair.length,
      withOriginal: 0,
    };
  }

  const candidates = samePair.filter(trade => isSimilarHistoricalCandidate(trade, pair));
  if (candidates.length === 0) {
    return {
      pair,
      current,
      matches: [],
      emptyReason: "no_same_pair_candidate",
      scannedSamePair: samePair.length,
      withOriginal: withOriginal.length,
    };
  }

  const scored: SimilarHistoricalMatch[] = [];
  let sawInsufficient = false;
  let sawBelowThreshold = false;

  for (const trade of candidates) {
    const historical = marketContextFromTrade(trade);
    if (!historical) continue;
    const similarity = compareContextSimilarity(current, historical);
    if (!similarity.sufficientComparable) {
      sawInsufficient = true;
      continue;
    }
    if (!similarity.meetsThreshold) {
      sawBelowThreshold = true;
      continue;
    }
    scored.push({
      tradeId: trade.id,
      pair: trade.pair,
      similarity,
      outcome: buildOutcome(trade),
      historicalCapturedAt: historical.capturedAt,
    });
  }

  scored.sort(rankSimilarMatches);
  const matches = scored.slice(0, MAX_SIMILAR_RESULTS);

  let emptyReason: SimilarHistoricalEmptyReason = null;
  if (matches.length === 0) {
    if (sawInsufficient && !sawBelowThreshold) emptyReason = "insufficient_comparable";
    else if (sawBelowThreshold || sawInsufficient) emptyReason = "below_threshold";
    else emptyReason = "below_threshold";
  }

  return {
    pair,
    current,
    matches,
    emptyReason,
    scannedSamePair: samePair.length,
    withOriginal: withOriginal.length,
  };
}

export function similarHistoricalEmptyMessage(reason: SimilarHistoricalEmptyReason): string {
  switch (reason) {
    case "current_unavailable":
      return "現在のMarket Contextを取得できないため、類似検索できません";
    case "no_historical_snapshot":
      return "Original Market Context Snapshotがある過去トレードがありません";
    case "no_same_pair_candidate":
      return "同じ通貨ペアでOriginal Snapshotがある決済トレードがありません";
    case "insufficient_comparable":
      return `比較可能な項目が${MIN_COMPARABLE_DIMENSIONS}未満のため、類似候補を表示できません`;
    case "below_threshold":
      return `類似度${Math.round(MIN_SIMILARITY * 100)}%以上の候補がありません`;
    default:
      return "表示できる類似候補がありません";
  }
}
