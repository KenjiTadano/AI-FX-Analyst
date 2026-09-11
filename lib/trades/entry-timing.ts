import { summarize } from "./analytics";
import {
  JPY_PIP_SIZE,
  MIN_INSIGHT_SAMPLE_SIZE,
  analysisReferencePrice,
  priceDeltaToPips,
  type InsightKind,
  type InsightLabel,
  type InsightSeverity,
} from "./insights";
import type { Trade } from "./types";

export type EntryMoveBandKey = "0-5" | "5-10" | "10-20" | "20+";

export type EntryTimingPoint = {
  trade: Trade;
  analysisPrice: number;
  rawMove: number;
  absolutePips: number;
  directionalEntryMovePips: number;
};

export type EntryMoveBandStats = {
  band: EntryMoveBandKey;
  count: number;
  wins: number;
  losses: number;
  draws: number;
  winRate: number | null;
  totalPnl: number;
  averagePnl: number | null;
  referenceOnly: boolean;
};

export type EntryTimingInsight = {
  id: string;
  type: InsightKind;
  severity: InsightSeverity;
  label: InsightLabel;
  title: string;
  description: string;
  sampleSize: number;
  suggestion: string | null;
};

export type EntryTimingResult = {
  points: EntryTimingPoint[];
  eligibleClosedCount: number;
  bands: EntryMoveBandStats[];
  withDirection: ReturnType<typeof summarize> & { averagePnl: number | null };
  againstDirection: ReturnType<typeof summarize> & { averagePnl: number | null };
  averageAbsolutePips: number | null;
  insights: EntryTimingInsight[];
  empty: boolean;
};

/** Half-open bands: [0,5), [5,10), [10,20), [20, ∞). */
export const ENTRY_MOVE_BANDS: readonly { key: EntryMoveBandKey; min: number; max: number }[] = [
  { key: "0-5", min: 0, max: 5 },
  { key: "5-10", min: 5, max: 10 },
  { key: "10-20", min: 10, max: 20 },
  { key: "20+", min: 20, max: Number.POSITIVE_INFINITY },
] as const;

const FORBIDDEN = /次は.*入るべき|5pips以内なら勝て|10pips以上は悪い|このタイミングなら利益|Entryが遅い|Entryが早い|必ず勝てる/;

function assertSafe(text: string): string {
  if (FORBIDDEN.test(text)) throw new Error(`entry timing wording rejected: ${text}`);
  return text;
}

function fmtMoney(n: number): string {
  return `${n > 0 ? "+" : ""}${n.toLocaleString("ja-JP", { maximumFractionDigits: 2 })}円`;
}

function roundPips(value: number): number {
  return Math.round(value * 100) / 100;
}

function isValidPrice(value: number): boolean {
  return Number.isFinite(value) && value > 0 && value !== Number.POSITIVE_INFINITY;
}

/** Band membership with half-open intervals except the last which is closed on the left. */
export function absolutePipsBand(absolutePips: number): EntryMoveBandKey | null {
  if (!Number.isFinite(absolutePips) || absolutePips < 0) return null;
  for (const band of ENTRY_MOVE_BANDS) {
    if (band.max === Number.POSITIVE_INFINITY) {
      if (absolutePips >= band.min) return band.key;
    } else if (absolutePips >= band.min && absolutePips < band.max) {
      return band.key;
    }
  }
  return null;
}

/**
 * Direction-aware move in pips relative to the trade side (not AI direction).
 * BUY: (entry - analysis) / pip; SELL: (analysis - entry) / pip.
 */
export function directionalEntryMovePips(trade: Trade, analysisPrice: number): number | null {
  if (!isValidPrice(trade.entryPrice) || !isValidPrice(analysisPrice)) return null;
  const pip = priceDeltaToPips(trade.pair, JPY_PIP_SIZE);
  if (pip === null) return null;
  const raw = trade.side === "long"
    ? trade.entryPrice - analysisPrice
    : analysisPrice - trade.entryPrice;
  return roundPips(raw / JPY_PIP_SIZE);
}

export function computeEntryTimingPoint(trade: Trade): EntryTimingPoint | null {
  if (!isValidPrice(trade.entryPrice)) return null;
  const analysisPrice = analysisReferencePrice(trade);
  if (analysisPrice === null || !isValidPrice(analysisPrice)) return null;
  const absolutePips = priceDeltaToPips(trade.pair, Math.abs(trade.entryPrice - analysisPrice));
  if (absolutePips === null) return null;
  const directional = directionalEntryMovePips(trade, analysisPrice);
  if (directional === null) return null;
  return {
    trade,
    analysisPrice,
    rawMove: trade.entryPrice - analysisPrice,
    absolutePips,
    directionalEntryMovePips: directional,
  };
}

function withAverage(stats: ReturnType<typeof summarize>) {
  return { ...stats, averagePnl: stats.count ? stats.totalPnl / stats.count : null };
}

export function entryMoveBandPerformance(trades: Trade[]): EntryMoveBandStats[] {
  const points = trades
    .filter(t => t.status === "closed" && t.realizedPnl !== null)
    .map(computeEntryTimingPoint)
    .filter((p): p is EntryTimingPoint => !!p);

  return ENTRY_MOVE_BANDS.map(band => {
    const selected = points.filter(p => absolutePipsBand(p.absolutePips) === band.key).map(p => p.trade);
    const stats = summarize(selected);
    return {
      band: band.key,
      count: stats.count,
      wins: stats.wins,
      losses: stats.losses,
      draws: stats.draws,
      winRate: stats.winRate,
      totalPnl: stats.totalPnl,
      averagePnl: stats.count ? stats.totalPnl / stats.count : null,
      referenceOnly: stats.count < MIN_INSIGHT_SAMPLE_SIZE,
    };
  });
}

/**
 * Deterministic Entry Timing analysis for closed trades with valid analysis→entry prices.
 * Does not call external APIs. Not a judgment of entry quality.
 */
export function analyzeEntryTiming(trades: Trade[]): EntryTimingResult {
  const closed = trades.filter(t => t.status === "closed" && t.realizedPnl !== null);
  const points = closed.map(computeEntryTimingPoint).filter((p): p is EntryTimingPoint => !!p);

  if (!points.length) {
    return {
      points: [],
      eligibleClosedCount: 0,
      bands: entryMoveBandPerformance(trades),
      withDirection: withAverage(summarize([])),
      againstDirection: withAverage(summarize([])),
      averageAbsolutePips: null,
      insights: [],
      empty: true,
    };
  }

  const bands = entryMoveBandPerformance(trades);
  const withDir = withAverage(summarize(points.filter(p => p.directionalEntryMovePips > 0).map(p => p.trade)));
  const againstDir = withAverage(summarize(points.filter(p => p.directionalEntryMovePips <= 0).map(p => p.trade)));
  const averageAbsolutePips = roundPips(points.reduce((sum, p) => sum + p.absolutePips, 0) / points.length);

  const insights: EntryTimingInsight[] = [];

  if (points.length < MIN_INSIGHT_SAMPLE_SIZE) {
    insights.push({
      id: "timing-insufficient",
      type: "insufficient_data",
      severity: "info",
      label: "データ不足",
      title: "Entry Timingの傾向判定にはまだデータが不足しています",
      description: assertSafe(`分析時点価格がある決済は${points.length}件です。傾向判定の目安は${MIN_INSIGHT_SAMPLE_SIZE}件以上です。数字自体は帯別カードで確認できます。`),
      sampleSize: points.length,
      suggestion: null,
    });
  } else {
    const enoughBands = bands.filter(b => b.count >= MIN_INSIGHT_SAMPLE_SIZE);
    if (enoughBands.length) {
      const focus = [...enoughBands].sort((a, b) => b.count - a.count || Math.abs(b.totalPnl) - Math.abs(a.totalPnl))[0];
      insights.push({
        id: `timing-band-${focus.band}`,
        type: "neutral",
        severity: "info",
        label: "参考データ",
        title: `分析時点から${focus.band} pipsのEntry記録`,
        description: assertSafe(`過去の記録では、分析時点から${focus.band} pips離れてEntryした取引は${focus.count}件、勝率${focus.winRate === null ? "—" : `${focus.winRate.toFixed(1)}%`}、平均損益 ${focus.averagePnl === null ? "—" : fmtMoney(focus.averagePnl)}でした。エントリーの良し悪しを直接判定するものではありません。`),
        sampleSize: focus.count,
        suggestion: "Entry理由と合わせて記録すると比較しやすくなります。",
      });
    }

    if (withDir.count >= MIN_INSIGHT_SAMPLE_SIZE && againstDir.count >= MIN_INSIGHT_SAMPLE_SIZE) {
      insights.push({
        id: "timing-direction",
        type: "neutral",
        severity: "info",
        label: "参考データ",
        title: "Trade方向基準の値動き後Entry（過去データ）",
        description: assertSafe(`Trade side基準の比較です。「分析方向に進んだ後のEntry」${withDir.count}件・平均 ${withDir.averagePnl === null ? "—" : fmtMoney(withDir.averagePnl)}、「分析方向と逆に動いた後のEntry」${againstDir.count}件・平均 ${againstDir.averagePnl === null ? "—" : fmtMoney(againstDir.averagePnl)}。AI directionとの一致比較ではありません。`),
        sampleSize: withDir.count + againstDir.count,
        suggestion: null,
      });
    }

    insights.push({
      id: "timing-average",
      type: "neutral",
      severity: "info",
      label: "参考データ",
      title: "分析時点からEntryまでの平均距離",
      description: assertSafe(`過去の記録では、分析時点から平均${averageAbsolutePips.toFixed(1)} pips動いた後にEntryしています（対象${points.length}件）。遅すぎる・早すぎるといった断定はしません。`),
      sampleSize: points.length,
      suggestion: null,
    });
  }

  return {
    points,
    eligibleClosedCount: points.length,
    bands,
    withDirection: withDir,
    againstDirection: againstDir,
    averageAbsolutePips,
    insights: insights.slice(0, 3),
    empty: false,
  };
}
