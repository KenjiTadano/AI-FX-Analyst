import { MIN_INSIGHT_SAMPLE_SIZE } from "./analysis-price";
import {
  CHANGE_TIMEFRAME_ORDER,
  compareMarketContexts,
  formatElapsed,
  type ChangeStatus,
  type MarketContextChange,
} from "./market-context-change";
import {
  marketContextRevisionsFromTrade,
  sanitizeMarketContextSnapshot,
  type MarketContextSnapshot,
} from "./market-context-snapshot";
import {
  calculateContextSummary,
  realizedROrNull,
  type ContextSummary,
} from "./performance-intelligence";
import type { Trade } from "./types";

export { MIN_INSIGHT_SAMPLE_SIZE };

export const TRADE_EVOLUTION_TITLE = "Trade Evolution";
export const TRADE_EVOLUTION_EYEBROW = "TRADE EVOLUTION";
export const TRADE_EVOLUTION_NOTE =
  "Entry後に保存したMarket Context Revisionと実現結果の記述的集計です。Entry時コンテキスト集計（Entry Performance）とは別です。";
export const TRADE_EVOLUTION_SELECTION_BIAS =
  "この分析はMarket Contextを手動で再取得したトレードのみを対象とします。全トレードを代表するとは限りません。";
export const TRADE_EVOLUTION_TIMING_CAVEAT =
  "再取得タイミングはトレードごとに異なります";
export const TRADE_EVOLUTION_SAMPLE_WARNING = `サンプル不足（n<${MIN_INSIGHT_SAMPLE_SIZE}・参考値）`;
export const MAX_EVOLUTION_OBSERVATIONS = 5;

export const EVOLUTION_STATUS_ORDER = ["changed", "unchanged", "unavailable"] as const satisfies readonly ChangeStatus[];

export const EVOLUTION_STATUS_LABELS: Record<ChangeStatus, string> = {
  changed: "changed",
  unchanged: "unchanged",
  unavailable: "unavailable",
};

const FORBIDDEN =
  /原因|効果|有効|優位|勝ちやすい|負けやすい|改善|悪化|\bshould\b|\brecommend\b|決済すべき|損切りサイン|保有を続ける|勝ちパターン|\bbest\b|\bworst\b|\btop\b|\bbottom\b|この条件で取引すると有利|トレンド相場を狙うべき|レンジを避けるべき/;

function assertSafe(text: string): string {
  if (FORBIDDEN.test(text)) throw new Error(`trade evolution wording rejected: ${text}`);
  return text;
}

export type EvolutionGroupSummary = ContextSummary & {
  positiveRCount: number;
  negativeRCount: number;
};

export type EvolutionDimensionBlock = {
  key: string;
  label: string;
  groups: EvolutionGroupSummary[];
  noDataReason: string | null;
};

export type EvolutionElapsedCoverage = {
  sampleSize: number;
  minMs: number | null;
  medianMs: number | null;
  maxMs: number | null;
  minLabel: string | null;
  medianLabel: string | null;
  maxLabel: string | null;
};

export type TradeEvolutionCoverage = {
  periodClosed: number;
  originalAvailable: number;
  revisionAvailable: number;
  evolutionEligible: number;
};

export type TradeEvolutionPerformance = {
  periodLabel: string;
  coverage: TradeEvolutionCoverage;
  elapsed: EvolutionElapsedCoverage;
  selectionBiasWarning: string;
  timingCaveat: string;
  anyContextChange: EvolutionDimensionBlock;
  timeframeTrend: EvolutionDimensionBlock[];
  regime: {
    regime: EvolutionDimensionBlock;
    trendDirection: EvolutionDimensionBlock;
    volatility: EvolutionDimensionBlock;
  };
  smaRelation: {
    sma20: EvolutionDimensionBlock;
    sma75: EvolutionDimensionBlock;
    sma200: EvolutionDimensionBlock;
  };
  rsiBucket: EvolutionDimensionBlock;
  observations: string[];
  emptyReason: "no_closed" | "no_original" | "no_revision" | "no_eligible" | null;
};

type ClassifiedTrade = {
  trade: Trade;
  change: MarketContextChange;
  elapsedMs: number | null;
};

function eligibleClosed(trades: Trade[]): Trade[] {
  return trades.filter(trade =>
    trade.status === "closed"
    && trade.realizedPnl !== null
    && Number.isFinite(trade.realizedPnl),
  );
}

/** Latest = append-order last. Never reorder by timestamp. */
export function latestMarketContextRevision(trade: Trade): MarketContextSnapshot | null {
  const revisions = marketContextRevisionsFromTrade(trade);
  if (!revisions.length) return null;
  return revisions[revisions.length - 1] ?? null;
}

export function isTradeEvolutionEligible(trade: Trade): boolean {
  if (trade.status !== "closed") return false;
  if (trade.realizedPnl === null || !Number.isFinite(trade.realizedPnl)) return false;
  const original = sanitizeMarketContextSnapshot(trade.marketContextSnapshot);
  if (!original) return false;
  return marketContextRevisionsFromTrade(trade).length >= 1;
}

/** Original → Latest via Task106 comparator. No previous/selected modes. */
export function compareOriginalToLatest(trade: Trade): MarketContextChange | null {
  const original = sanitizeMarketContextSnapshot(trade.marketContextSnapshot);
  const latest = latestMarketContextRevision(trade);
  if (!original || !latest) return null;
  const revisions = marketContextRevisionsFromTrade(trade);
  return compareMarketContexts(original, latest, {
    mode: "original_to_latest",
    fromLabel: "Original",
    toLabel: `再取得 ${revisions.length}`,
  });
}

/** Aggregate any-context status from tracked MTF trend / Regime / Technical fields. */
export function aggregateAnyContextStatus(change: MarketContextChange): ChangeStatus {
  const tracked: ChangeStatus[] = [
    ...change.timeframes.map(frame => frame.trend.status),
    change.regime.regime.status,
    change.regime.trendDirection.status,
    change.regime.volatility.status,
    change.technical.smaRelations.sma20.status,
    change.technical.smaRelations.sma75.status,
    change.technical.smaRelations.sma200.status,
    change.technical.rsiBucket.status,
  ];
  if (tracked.some(status => status === "changed")) return "changed";
  if (tracked.every(status => status === "unavailable")) return "unavailable";
  return "unchanged";
}

function summarizeEvolutionGroup(key: string, label: string, trades: Trade[]): EvolutionGroupSummary {
  const base = calculateContextSummary(key, label, trades);
  const rValues = trades.map(realizedROrNull).filter((value): value is number => value != null);
  return {
    ...base,
    positiveRCount: rValues.filter(value => value > 0).length,
    negativeRCount: rValues.filter(value => value < 0).length,
  };
}

function emptyStatusBuckets(): Record<ChangeStatus, Trade[]> {
  return { changed: [], unchanged: [], unavailable: [] };
}

function buildDimensionBlock(
  key: string,
  label: string,
  buckets: Record<ChangeStatus, Trade[]>,
  emptyReason: string,
): EvolutionDimensionBlock {
  const groups = EVOLUTION_STATUS_ORDER
    .filter(status => buckets[status].length > 0)
    .map(status => summarizeEvolutionGroup(
      `${key}:${status}`,
      `${label} ${EVOLUTION_STATUS_LABELS[status]}`,
      buckets[status],
    ));
  return {
    key,
    label,
    groups,
    noDataReason: groups.length === 0 ? emptyReason : null,
  };
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1]! + sorted[mid]!) / 2;
  }
  return sorted[mid]!;
}

function fmtMoney(n: number): string {
  return `${n > 0 ? "+" : ""}${n.toLocaleString("ja-JP", { maximumFractionDigits: 2 })}円`;
}

function fmtR(n: number): string {
  const rounded = Math.round(n * 100) / 100;
  if (rounded === 0) return "0.00R";
  return `${rounded > 0 ? "+" : ""}${rounded.toFixed(2)}R`;
}

function observationForGroup(prefix: string, group: EvolutionGroupSummary | undefined): string | null {
  if (!group || group.sampleSize < MIN_INSIGHT_SAMPLE_SIZE) return null;
  if (group.averageR != null && group.rSampleSize >= MIN_INSIGHT_SAMPLE_SIZE) {
    return assertSafe(
      `${prefix} は n=${group.sampleSize}、平均R ${fmtR(group.averageR)}でした`,
    );
  }
  if (group.winRate != null) {
    return assertSafe(
      `${prefix} は n=${group.sampleSize}、勝率${group.winRate.toFixed(1)}%でした`,
    );
  }
  if (group.averagePnl != null) {
    return assertSafe(
      `${prefix} は n=${group.sampleSize}、平均損益 ${fmtMoney(group.averagePnl)}でした`,
    );
  }
  return null;
}

function buildEvolutionObservations(input: {
  eligible: number;
  any: EvolutionDimensionBlock;
  timeframeTrend: EvolutionDimensionBlock[];
  regime: TradeEvolutionPerformance["regime"];
  sma: TradeEvolutionPerformance["smaRelation"];
  rsi: EvolutionDimensionBlock;
}): string[] {
  const items: string[] = [];
  if (input.eligible === 0) return items;

  const candidates: Array<() => string | null> = [
    () => observationForGroup("Any context changed", input.any.groups.find(g => g.key.endsWith(":changed"))),
    () => observationForGroup("Any context unchanged", input.any.groups.find(g => g.key.endsWith(":unchanged"))),
    () => {
      const oneH = input.timeframeTrend.find(block => block.key === "trend:1h");
      return observationForGroup("1H trend changed", oneH?.groups.find(g => g.key.endsWith(":changed")));
    },
    () => {
      const oneH = input.timeframeTrend.find(block => block.key === "trend:1h");
      return observationForGroup("1H trend unchanged", oneH?.groups.find(g => g.key.endsWith(":unchanged")));
    },
    () => observationForGroup("Regime changed", input.regime.regime.groups.find(g => g.key.endsWith(":changed"))),
    () => observationForGroup("Regime unchanged", input.regime.regime.groups.find(g => g.key.endsWith(":unchanged"))),
    () => observationForGroup(
      "TrendDirection changed",
      input.regime.trendDirection.groups.find(g => g.key.endsWith(":changed")),
    ),
    () => observationForGroup(
      "Volatility changed",
      input.regime.volatility.groups.find(g => g.key.endsWith(":changed")),
    ),
    () => observationForGroup("SMA20 relation changed", input.sma.sma20.groups.find(g => g.key.endsWith(":changed"))),
    () => observationForGroup("RSI bucket changed", input.rsi.groups.find(g => g.key.endsWith(":changed"))),
    () => observationForGroup("RSI bucket unchanged", input.rsi.groups.find(g => g.key.endsWith(":unchanged"))),
  ];

  for (const next of candidates) {
    if (items.length >= MAX_EVOLUTION_OBSERVATIONS) break;
    const text = next();
    if (text) items.push(text);
  }
  return items;
}

function classifyEligible(trades: Trade[]): ClassifiedTrade[] {
  const out: ClassifiedTrade[] = [];
  for (const trade of trades) {
    if (!isTradeEvolutionEligible(trade)) continue;
    const change = compareOriginalToLatest(trade);
    if (!change) continue;
    out.push({
      trade,
      change,
      elapsedMs: change.elapsed.invalid ? null : change.elapsed.ms,
    });
  }
  return out;
}

/**
 * Descriptive Original→Latest outcome aggregation.
 * Reuses Task106 compareMarketContexts. Does not prescribe actions.
 */
export function buildTradeEvolutionPerformance(
  trades: Trade[],
  periodLabel = "全期間",
): TradeEvolutionPerformance {
  const closed = eligibleClosed(trades);
  const originalAvailable = closed.filter(trade => sanitizeMarketContextSnapshot(trade.marketContextSnapshot) != null).length;
  const revisionAvailable = closed.filter(trade => marketContextRevisionsFromTrade(trade).length >= 1).length;
  const classified = classifyEligible(closed);
  const eligible = classified.map(row => row.trade);

  const coverage: TradeEvolutionCoverage = {
    periodClosed: closed.length,
    originalAvailable,
    revisionAvailable,
    evolutionEligible: eligible.length,
  };

  const elapsedValues = classified
    .map(row => row.elapsedMs)
    .filter((value): value is number => value != null && Number.isFinite(value));
  const minMs = elapsedValues.length ? Math.min(...elapsedValues) : null;
  const maxMs = elapsedValues.length ? Math.max(...elapsedValues) : null;
  const medianMs = median(elapsedValues);
  const elapsed: EvolutionElapsedCoverage = {
    sampleSize: elapsedValues.length,
    minMs,
    medianMs,
    maxMs,
    minLabel: minMs == null ? null : formatElapsed(minMs),
    medianLabel: medianMs == null ? null : formatElapsed(medianMs),
    maxLabel: maxMs == null ? null : formatElapsed(maxMs),
  };

  let emptyReason: TradeEvolutionPerformance["emptyReason"] = null;
  if (closed.length === 0) emptyReason = "no_closed";
  else if (eligible.length === 0 && originalAvailable === 0) emptyReason = "no_original";
  else if (eligible.length === 0 && revisionAvailable === 0) emptyReason = "no_revision";
  else if (eligible.length === 0) emptyReason = "no_eligible";

  const anyBuckets = emptyStatusBuckets();
  const tfBuckets = Object.fromEntries(
    CHANGE_TIMEFRAME_ORDER.map(tf => [tf, emptyStatusBuckets()]),
  ) as Record<(typeof CHANGE_TIMEFRAME_ORDER)[number], Record<ChangeStatus, Trade[]>>;
  const regimeBuckets = emptyStatusBuckets();
  const trendDirBuckets = emptyStatusBuckets();
  const volBuckets = emptyStatusBuckets();
  const sma20Buckets = emptyStatusBuckets();
  const sma75Buckets = emptyStatusBuckets();
  const sma200Buckets = emptyStatusBuckets();
  const rsiBuckets = emptyStatusBuckets();

  for (const row of classified) {
    const { trade, change } = row;
    anyBuckets[aggregateAnyContextStatus(change)].push(trade);
    for (const frame of change.timeframes) {
      const buckets = tfBuckets[frame.timeframe as (typeof CHANGE_TIMEFRAME_ORDER)[number]];
      if (buckets) buckets[frame.trend.status].push(trade);
    }
    regimeBuckets[change.regime.regime.status].push(trade);
    trendDirBuckets[change.regime.trendDirection.status].push(trade);
    volBuckets[change.regime.volatility.status].push(trade);
    sma20Buckets[change.technical.smaRelations.sma20.status].push(trade);
    sma75Buckets[change.technical.smaRelations.sma75.status].push(trade);
    sma200Buckets[change.technical.smaRelations.sma200.status].push(trade);
    rsiBuckets[change.technical.rsiBucket.status].push(trade);
  }

  const emptyDim = "比較可能なデータがありません";
  const anyContextChange = buildDimensionBlock("any", "Any Context Change", anyBuckets, emptyDim);
  const timeframeTrend = CHANGE_TIMEFRAME_ORDER.map(tf => {
    const label = tf === "1day" ? "1D" : tf === "15m" ? "15m" : tf === "1h" ? "1H" : "4H";
    return buildDimensionBlock(`trend:${tf}`, `${label} trend`, tfBuckets[tf], emptyDim);
  });
  const regime = {
    regime: buildDimensionBlock("regime", "Regime", regimeBuckets, emptyDim),
    trendDirection: buildDimensionBlock("trendDirection", "Trend Direction", trendDirBuckets, emptyDim),
    volatility: buildDimensionBlock("volatility", "Volatility", volBuckets, emptyDim),
  };
  const smaRelation = {
    sma20: buildDimensionBlock("sma20", "SMA20 relation", sma20Buckets, emptyDim),
    sma75: buildDimensionBlock("sma75", "SMA75 relation", sma75Buckets, emptyDim),
    sma200: buildDimensionBlock("sma200", "SMA200 relation", sma200Buckets, emptyDim),
  };
  const rsiBucket = buildDimensionBlock("rsiBucket", "RSI Bucket", rsiBuckets, emptyDim);

  const observations = buildEvolutionObservations({
    eligible: eligible.length,
    any: anyContextChange,
    timeframeTrend,
    regime,
    sma: smaRelation,
    rsi: rsiBucket,
  });

  return {
    periodLabel,
    coverage,
    elapsed,
    selectionBiasWarning: assertSafe(TRADE_EVOLUTION_SELECTION_BIAS),
    timingCaveat: assertSafe(TRADE_EVOLUTION_TIMING_CAVEAT),
    anyContextChange,
    timeframeTrend,
    regime,
    smaRelation,
    rsiBucket,
    observations,
    emptyReason,
  };
}

export function evolutionEmptyMessage(reason: TradeEvolutionPerformance["emptyReason"]): string {
  switch (reason) {
    case "no_closed":
      return "この期間には決済済み取引がありません";
    case "no_original":
      return "エントリー時Market Context（Original）が保存された決済がありません";
    case "no_revision":
      return "Market Context再取得履歴がある決済がありません";
    case "no_eligible":
      return "Originalと再取得履歴の両方がある決済がないため、Trade Evolution集計の対象がありません";
    default:
      return "比較可能なデータがありません";
  }
}
