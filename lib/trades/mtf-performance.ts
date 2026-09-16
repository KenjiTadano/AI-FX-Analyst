import { summarize } from "./analytics";
import { aiBuySellDirection } from "./ai-entry-context";
import { MIN_INSIGHT_SAMPLE_SIZE } from "./analysis-price";
import type { HigherTimeframeBias, MultiTimeframeAnalysis, TimeframeAlignment } from "../market/multi-timeframe";
import { storedMultiTimeframeAnalysis } from "./mtf-snapshot";
import {
  type ContextPerformanceComparison,
  type ContextPerformanceGroup,
} from "./pre-trade-performance";
import { isRichSnapshot } from "./snapshot";
import type { Trade } from "./types";

export {
  MIN_INSIGHT_SAMPLE_SIZE,
} from "./analysis-price";

export {
  formatContextProfitFactor,
  type ContextPerformanceComparison,
  type ContextPerformanceGroup,
} from "./pre-trade-performance";

export const MTF_PERFORMANCE_TITLE = "エントリー時MTF別の過去実績";
export const MTF_PERFORMANCE_EYEBROW = "MULTI-TIMEFRAME PERFORMANCE";
export const MTF_PERFORMANCE_DISCLAIMER =
  "この集計は取引登録時に保存されたMTF情報と、決済済み取引の過去結果を集計したものです。特定のMTF状態が将来の利益や勝率を保証するものではなく、結果との因果関係を示すものでもありません。";
export const MTF_PERFORMANCE_EMPTY =
  "この期間には、エントリー時MTFが保存された決済済み取引がありません。";
export const MTF_PERFORMANCE_COVERAGE_LABEL = "MTF保存あり";
export const MTF_PERFORMANCE_SAMPLE_NOTE = "サンプル数が少ないグループは参考値です。";
export const MTF_PERFORMANCE_WINRATE_NOTE =
  "勝率は過去の取引結果です。将来の勝率を示すものではありません。";

export const ALIGNMENT_GROUP_ORDER = ["aligned_bullish", "aligned_bearish", "mixed", "insufficient"] as const;
export const HTF_GROUP_ORDER = ["bullish", "bearish", "neutral", "unavailable"] as const;
export const AI_MTF_GROUP_ORDER = [
  "aligned_with_ai",
  "contrary_to_ai",
  "mixed",
  "insufficient",
  "ai_direction_unavailable",
] as const;

export type MtfAiDirectionContext = typeof AI_MTF_GROUP_ORDER[number];

export const ALIGNMENT_GROUP_LABELS: Record<typeof ALIGNMENT_GROUP_ORDER[number], string> = {
  aligned_bullish: "全時間軸で上向き",
  aligned_bearish: "全時間軸で下向き",
  mixed: "時間軸で方向が混在",
  insufficient: "データ不足",
};

export const HTF_GROUP_LABELS: Record<typeof HTF_GROUP_ORDER[number], string> = {
  bullish: "上向き",
  bearish: "下向き",
  neutral: "中立",
  unavailable: "未取得",
};

export const AI_MTF_GROUP_LABELS: Record<MtfAiDirectionContext, string> = {
  aligned_with_ai: "方向一致",
  contrary_to_ai: "逆方向",
  mixed: "時間軸混在",
  insufficient: "MTFデータ不足",
  ai_direction_unavailable: "AI方向未取得",
};

export type PerformanceGroup = ContextPerformanceGroup;

export type MtfPerformanceAnalysis = {
  periodLabel: string;
  coverage: {
    eligibleTrades: number;
    withMtfContext: number;
    coverageRate: number | null;
  };
  missingMtfTrades: number;
  byAlignment: PerformanceGroup[];
  byHigherTimeframeBias: PerformanceGroup[];
  byAiDirectionContext: PerformanceGroup[];
  comparisons: ContextPerformanceComparison[];
};

const FORBIDDEN =
  /alignedだから|mixedだから|4\/4を待つべき|逆らうと負ける|この条件なら勝てる|このパターンを狙うべき|一致した方が優秀|今後一致だけ狙う|悪いEntry|良いEntry|Good Setup|Bad Setup|Entry Quality|MTF Score|勝ちパターン|おすすめ|Entry OK/;

function eligibleClosed(trades: Trade[]): Trade[] {
  return trades.filter(trade =>
    trade.status === "closed"
    && trade.realizedPnl !== null
    && Number.isFinite(trade.realizedPnl),
  );
}

function statsGroup(key: string, label: string, trades: Trade[]): PerformanceGroup {
  const stats = summarize(trades);
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
  };
}

function emptyBuckets<K extends string>(keys: readonly K[]): Record<K, Trade[]> {
  return Object.fromEntries(keys.map(key => [key, [] as Trade[]])) as Record<K, Trade[]>;
}

function present<K extends string>(
  order: readonly K[],
  labels: Record<K, string>,
  buckets: Record<K, Trade[]>,
): PerformanceGroup[] {
  return order
    .map(key => statsGroup(key, labels[key], buckets[key]))
    .filter(group => group.sampleSize > 0);
}

function fmtMoney(n: number): string {
  return `${n > 0 ? "+" : ""}${n.toLocaleString("ja-JP", { maximumFractionDigits: 2 })}円`;
}

function safeText(text: string): string {
  if (FORBIDDEN.test(text)) throw new Error(`mtf performance wording rejected: ${text}`);
  return text;
}

const MAX_COMPARISONS = 3;

export function mtfFromTrade(trade: Trade): MultiTimeframeAnalysis | null {
  return storedMultiTimeframeAnalysis(trade);
}

/** Saved Direction only. WAIT Action is ignored. Neutral / wait / missing → unavailable. */
export function classifyMtfAiDirection(trade: Trade, mtf: MultiTimeframeAnalysis): MtfAiDirectionContext {
  if (mtf.alignment === "mixed") return "mixed";
  if (mtf.alignment === "insufficient") return "insufficient";
  const snap = trade.analysisSnapshot;
  const direction = isRichSnapshot(snap) ? aiBuySellDirection(snap.directionSignal) : null;
  if (!direction) return "ai_direction_unavailable";
  if (direction === "buy" && mtf.alignment === "aligned_bullish") return "aligned_with_ai";
  if (direction === "sell" && mtf.alignment === "aligned_bearish") return "aligned_with_ai";
  if (direction === "buy" && mtf.alignment === "aligned_bearish") return "contrary_to_ai";
  if (direction === "sell" && mtf.alignment === "aligned_bullish") return "contrary_to_ai";
  return "ai_direction_unavailable";
}

function htfKey(bias: HigherTimeframeBias): typeof HTF_GROUP_ORDER[number] {
  return (HTF_GROUP_ORDER as readonly string[]).includes(bias) ? bias : "unavailable";
}

function alignmentKey(alignment: TimeframeAlignment): typeof ALIGNMENT_GROUP_ORDER[number] {
  return (ALIGNMENT_GROUP_ORDER as readonly string[]).includes(alignment) ? alignment : "insufficient";
}

function comparisonsFrom(groups: {
  alignment: PerformanceGroup[];
  htf: PerformanceGroup[];
  ai: PerformanceGroup[];
}): ContextPerformanceComparison[] {
  const byKey = (list: PerformanceGroup[], key: string) => list.find(group => group.key === key);
  const items: ContextPerformanceComparison[] = [];
  const aligned = byKey(groups.ai, "aligned_with_ai");
  const contrary = byKey(groups.ai, "contrary_to_ai");
  if (aligned && contrary && aligned.sufficientSample && contrary.sufficientSample) {
    items.push({
      id: "ai-aligned-contrary",
      text: safeText(
        `サンプル条件を満たしたグループでは、AI方向とMTF方向が一致していた取引の平均損益は ${aligned.averagePnl === null ? "—" : fmtMoney(aligned.averagePnl)}、逆方向だった取引は ${contrary.averagePnl === null ? "—" : fmtMoney(contrary.averagePnl)} でした。`,
      ),
    });
  }
  const bullish = byKey(groups.alignment, "aligned_bullish");
  const mixed = byKey(groups.alignment, "mixed");
  if (bullish && mixed && bullish.sufficientSample && mixed.sufficientSample) {
    items.push({
      id: "alignment-bullish-mixed",
      text: safeText(
        `この期間の保存済みMTFが全時間軸で上向きだった取引は${bullish.sampleSize}件・平均 ${bullish.averagePnl === null ? "—" : fmtMoney(bullish.averagePnl)}、時間軸で方向が混在していた取引は${mixed.sampleSize}件・平均 ${mixed.averagePnl === null ? "—" : fmtMoney(mixed.averagePnl)} でした。`,
      ),
    });
  }
  const htfUp = byKey(groups.htf, "bullish");
  const htfDown = byKey(groups.htf, "bearish");
  if (htfUp && htfDown && htfUp.sufficientSample && htfDown.sufficientSample) {
    items.push({
      id: "htf-bullish-bearish",
      text: safeText(
        `この期間の保存済み上位足バイアスが上向きだった取引は${htfUp.sampleSize}件・平均 ${htfUp.averagePnl === null ? "—" : fmtMoney(htfUp.averagePnl)}、下向きだった取引は${htfDown.sampleSize}件・平均 ${htfDown.averagePnl === null ? "—" : fmtMoney(htfDown.averagePnl)} でした。`,
      ),
    });
  }
  return items.slice(0, MAX_COMPARISONS);
}

/**
 * Aggregate realized results by saved MTF snapshot.
 * Uses already-filtered trades; does not apply a period window.
 */
export function buildMtfPerformanceAnalysis(
  trades: Trade[],
  periodLabel = "全期間",
): MtfPerformanceAnalysis {
  const closed = eligibleClosed(trades);
  const withMtf: { trade: Trade; mtf: MultiTimeframeAnalysis }[] = [];
  for (const trade of closed) {
    const mtf = mtfFromTrade(trade);
    if (mtf) withMtf.push({ trade, mtf });
  }

  const alignmentBuckets = emptyBuckets(ALIGNMENT_GROUP_ORDER);
  const htfBuckets = emptyBuckets(HTF_GROUP_ORDER);
  const aiBuckets = emptyBuckets(AI_MTF_GROUP_ORDER);

  for (const { trade, mtf } of withMtf) {
    alignmentBuckets[alignmentKey(mtf.alignment)].push(trade);
    htfBuckets[htfKey(mtf.higherTimeframeBias)].push(trade);
    aiBuckets[classifyMtfAiDirection(trade, mtf)].push(trade);
  }

  const byAlignment = present(ALIGNMENT_GROUP_ORDER, ALIGNMENT_GROUP_LABELS, alignmentBuckets);
  const byHigherTimeframeBias = present(HTF_GROUP_ORDER, HTF_GROUP_LABELS, htfBuckets);
  const byAiDirectionContext = present(AI_MTF_GROUP_ORDER, AI_MTF_GROUP_LABELS, aiBuckets);
  const eligibleTrades = closed.length;
  const withMtfContext = withMtf.length;

  return {
    periodLabel,
    coverage: {
      eligibleTrades,
      withMtfContext,
      coverageRate: eligibleTrades ? (withMtfContext / eligibleTrades) * 100 : null,
    },
    missingMtfTrades: eligibleTrades - withMtfContext,
    byAlignment,
    byHigherTimeframeBias,
    byAiDirectionContext,
    comparisons: comparisonsFrom({ alignment: byAlignment, htf: byHigherTimeframeBias, ai: byAiDirectionContext }),
  };
}
