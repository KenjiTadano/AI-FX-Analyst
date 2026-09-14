import { summarize } from "./analytics";
import {
  JPY_PIP_SIZE,
  MIN_INSIGHT_SAMPLE_SIZE,
  analysisReferencePrice,
  priceDeltaToPips,
} from "./analysis-price";
import type {
  InsightKind,
  InsightLabel,
  InsightSeverity,
  InsightMetrics,
  TradingInsight,
} from "./insights";
import { computeAiAlignment, isRichSnapshot } from "./snapshot";
import type { Trade } from "./types";
import type { TradeSignal } from "../ai/types";

/** Neutral band around analysis price for AI-direction classification (pips). */
export const AI_ENTRY_NEUTRAL_PIPS = 2;

export type AiEntryMoveContext =
  | "with_ai_direction"
  | "against_ai_direction"
  | "near_analysis_price"
  | "unavailable";

export type AiBuySellDirection = "buy" | "sell";

export type AiEntryMoveClassification = {
  context: AiEntryMoveContext;
  aiDirection: AiBuySellDirection | null;
  action: "BUY" | "SELL" | "WAIT" | null;
  analysisPrice: number | null;
  entryPrice: number | null;
  aiDirectionalMovePips: number | null;
  absolutePips: number | null;
};

export type AiEntryContextGroupStats = {
  context: Exclude<AiEntryMoveContext, "unavailable">;
  label: string;
  count: number;
  wins: number;
  losses: number;
  draws: number;
  winRate: number | null;
  totalPnl: number;
  averagePnl: number | null;
  referenceOnly: boolean;
};

export type AiEntryContextResult = {
  classifications: AiEntryMoveClassification[];
  eligibleClosedCount: number;
  unavailableClosedCount: number;
  groups: AiEntryContextGroupStats[];
  withAi: AiEntryContextGroupStats;
  againstAi: AiEntryContextGroupStats;
  near: AiEntryContextGroupStats;
  waitWithAi: ReturnType<typeof summarize> & { averagePnl: number | null };
  waitAgainstAi: ReturnType<typeof summarize> & { averagePnl: number | null };
  insights: TradingInsight[];
  emptyTrades: boolean;
  emptyComparable: boolean;
};

export const AI_ENTRY_CONTEXT_LABELS: Record<Exclude<AiEntryMoveContext, "unavailable">, string> = {
  with_ai_direction: "AI方向に進んだ後",
  against_ai_direction: "AI方向と逆に動いた後",
  near_analysis_price: "分析価格付近",
};

const FORBIDDEN = /AI方向へ進んだらEntryすべき|逆へ動いたら待つべき|2pips以内が最適|この形なら勝てる|AI directionが正しい|必ず勝てる|AI方向へ動いた後に入れば勝て/;

function assertSafe(text: string): string {
  if (FORBIDDEN.test(text)) throw new Error(`ai entry context wording rejected: ${text}`);
  return text;
}

function fmtMoney(n: number): string {
  return `${n > 0 ? "+" : ""}${n.toLocaleString("ja-JP", { maximumFractionDigits: 2 })}円`;
}

function fmtRate(n: number | null): string {
  return n === null ? "—" : `${n.toFixed(1)}%`;
}

function roundPips(value: number): number {
  return Math.round(value * 100) / 100;
}

function isValidPrice(value: number): boolean {
  return Number.isFinite(value) && value > 0 && value !== Number.POSITIVE_INFINITY;
}

function metricsFromStats(stats: ReturnType<typeof summarize>): InsightMetrics {
  return {
    count: stats.count,
    wins: stats.wins,
    losses: stats.losses,
    draws: stats.draws,
    winRate: stats.winRate,
    totalPnl: stats.totalPnl,
    averagePnl: stats.count ? stats.totalPnl / stats.count : null,
  };
}

function withAverage(stats: ReturnType<typeof summarize>) {
  return { ...stats, averagePnl: stats.count ? stats.totalPnl / stats.count : null };
}

function groupFrom(context: Exclude<AiEntryMoveContext, "unavailable">, trades: Trade[]): AiEntryContextGroupStats {
  const stats = summarize(trades);
  return {
    context,
    label: AI_ENTRY_CONTEXT_LABELS[context],
    count: stats.count,
    wins: stats.wins,
    losses: stats.losses,
    draws: stats.draws,
    winRate: stats.winRate,
    totalPnl: stats.totalPnl,
    averagePnl: stats.count ? stats.totalPnl / stats.count : null,
    referenceOnly: stats.count < MIN_INSIGHT_SAMPLE_SIZE,
  };
}

/** Map snapshot directionSignal to BUY/SELL bias. wait / unknown → null. */
export function aiBuySellDirection(direction: TradeSignal | null | undefined): AiBuySellDirection | null {
  if (direction === "buy" || direction === "strong_buy") return "buy";
  if (direction === "sell" || direction === "strong_sell") return "sell";
  return null;
}

/**
 * AI-direction-aware move in pips (not Trade side).
 * BUY bias: (entry - analysis) / 0.01; SELL bias: (analysis - entry) / 0.01.
 */
export function aiDirectionalMovePips(
  aiDirection: AiBuySellDirection,
  entryPrice: number,
  analysisPrice: number,
  pair: string,
): number | null {
  if (!isValidPrice(entryPrice) || !isValidPrice(analysisPrice)) return null;
  if (priceDeltaToPips(pair, JPY_PIP_SIZE) === null) return null;
  const raw = aiDirection === "buy"
    ? entryPrice - analysisPrice
    : analysisPrice - entryPrice;
  return roundPips(raw / JPY_PIP_SIZE);
}

export function classifyAiDirectionalMove(movePips: number, neutral = AI_ENTRY_NEUTRAL_PIPS): Exclude<AiEntryMoveContext, "unavailable"> {
  if (movePips > neutral) return "with_ai_direction";
  if (movePips < -neutral) return "against_ai_direction";
  return "near_analysis_price";
}

/** Classify a trade's Entry vs AI directionSignal. Pure; does not mutate. */
export function classifyAiEntryMoveContext(trade: Trade): AiEntryMoveClassification {
  const unavailable = (partial: Partial<AiEntryMoveClassification> = {}): AiEntryMoveClassification => ({
    context: "unavailable",
    aiDirection: null,
    action: null,
    analysisPrice: null,
    entryPrice: isValidPrice(trade.entryPrice) ? trade.entryPrice : null,
    aiDirectionalMovePips: null,
    absolutePips: null,
    ...partial,
  });

  if (!isValidPrice(trade.entryPrice)) return unavailable();
  const snap = trade.analysisSnapshot;
  if (!snap || snap.pair !== trade.pair) return unavailable({ entryPrice: trade.entryPrice });
  if (!isRichSnapshot(snap)) return unavailable({ entryPrice: trade.entryPrice });

  const aiDirection = aiBuySellDirection(snap.directionSignal);
  const action = snap.action === "BUY" || snap.action === "SELL" || snap.action === "WAIT" ? snap.action : null;
  if (!aiDirection) return unavailable({ entryPrice: trade.entryPrice, action });

  const analysisPrice = analysisReferencePrice(trade);
  if (analysisPrice === null || !isValidPrice(analysisPrice)) {
    return unavailable({ entryPrice: trade.entryPrice, aiDirection, action });
  }

  const move = aiDirectionalMovePips(aiDirection, trade.entryPrice, analysisPrice, trade.pair);
  if (move === null) return unavailable({ entryPrice: trade.entryPrice, aiDirection, action, analysisPrice });
  const absolutePips = priceDeltaToPips(trade.pair, Math.abs(trade.entryPrice - analysisPrice));
  if (absolutePips === null) return unavailable({ entryPrice: trade.entryPrice, aiDirection, action, analysisPrice });

  return {
    context: classifyAiDirectionalMove(move),
    aiDirection,
    action,
    analysisPrice,
    entryPrice: trade.entryPrice,
    aiDirectionalMovePips: move,
    absolutePips,
  };
}

function insight(
  partial: Omit<TradingInsight, "type" | "severity" | "label"> & {
    type?: InsightKind;
    severity?: InsightSeverity;
    label?: InsightLabel;
  },
): TradingInsight {
  return {
    type: partial.type ?? "neutral",
    severity: partial.severity ?? "info",
    label: partial.label ?? "参考データ",
    id: partial.id,
    title: assertSafe(partial.title),
    description: assertSafe(partial.description),
    sampleSize: partial.sampleSize,
    metrics: partial.metrics,
    suggestion: partial.suggestion ? assertSafe(partial.suggestion) : null,
  };
}

/**
 * Aggregate AI-direction × Entry-move contexts for closed trades.
 * Uses Task015 analysis price helpers. Not a forecast.
 */
export function analyzeAiEntryContext(trades: Trade[]): AiEntryContextResult {
  const closed = trades.filter(t => t.status === "closed" && t.realizedPnl !== null);
  if (!closed.length) {
    const emptyGroup = (context: Exclude<AiEntryMoveContext, "unavailable">) => groupFrom(context, []);
    return {
      classifications: [],
      eligibleClosedCount: 0,
      unavailableClosedCount: 0,
      groups: [emptyGroup("with_ai_direction"), emptyGroup("against_ai_direction"), emptyGroup("near_analysis_price")],
      withAi: emptyGroup("with_ai_direction"),
      againstAi: emptyGroup("against_ai_direction"),
      near: emptyGroup("near_analysis_price"),
      waitWithAi: withAverage(summarize([])),
      waitAgainstAi: withAverage(summarize([])),
      insights: [],
      emptyTrades: trades.length === 0,
      emptyComparable: true,
    };
  }

  const classified = closed.map(trade => ({ trade, result: classifyAiEntryMoveContext(trade) }));
  const eligible = classified.filter(c => c.result.context !== "unavailable");
  const unavailableClosedCount = classified.length - eligible.length;

  const withTrades = eligible.filter(c => c.result.context === "with_ai_direction").map(c => c.trade);
  const againstTrades = eligible.filter(c => c.result.context === "against_ai_direction").map(c => c.trade);
  const nearTrades = eligible.filter(c => c.result.context === "near_analysis_price").map(c => c.trade);

  const withAi = groupFrom("with_ai_direction", withTrades);
  const againstAi = groupFrom("against_ai_direction", againstTrades);
  const near = groupFrom("near_analysis_price", nearTrades);

  const waitEligible = eligible.filter(c => c.result.action === "WAIT");
  const waitWithAi = withAverage(summarize(waitEligible.filter(c => c.result.context === "with_ai_direction").map(c => c.trade)));
  const waitAgainstAi = withAverage(summarize(waitEligible.filter(c => c.result.context === "against_ai_direction").map(c => c.trade)));

  const insights: TradingInsight[] = [];

  if (eligible.length < MIN_INSIGHT_SAMPLE_SIZE) {
    insights.push(insight({
      id: "ai-entry-insufficient",
      type: "insufficient_data",
      severity: "info",
      label: "データ不足",
      title: "AI方向×Entry位置の傾向判定にはまだデータが不足しています",
      description: `比較可能な決済は${eligible.length}件です。傾向判定の目安は${MIN_INSIGHT_SAMPLE_SIZE}件以上です。`,
      sampleSize: eligible.length,
      metrics: metricsFromStats(summarize(eligible.map(c => c.trade))),
      suggestion: null,
    }));
  } else {
    if (withAi.count >= MIN_INSIGHT_SAMPLE_SIZE && againstAi.count >= MIN_INSIGHT_SAMPLE_SIZE) {
      const delta = (withAi.averagePnl ?? 0) - (againstAi.averagePnl ?? 0);
      insights.push(insight({
        id: "ai-entry-comparison",
        type: "neutral",
        severity: "info",
        label: "参考データ",
        title: "AI方向とEntry位置の比較（過去データ）",
        description: `過去データの比較です。AI方向に進んだ後：${withAi.count}件・勝率${fmtRate(withAi.winRate)}・平均 ${withAi.averagePnl === null ? "—" : fmtMoney(withAi.averagePnl)}。AI方向と逆に動いた後：${againstAi.count}件・勝率${fmtRate(againstAi.winRate)}・平均 ${againstAi.averagePnl === null ? "—" : fmtMoney(againstAi.averagePnl)}。平均損益差 ${fmtMoney(delta)} / 取引。将来の勝率や利益を予測するものではありません。`,
        sampleSize: withAi.count + againstAi.count,
        metrics: {
          ...metricsFromStats(summarize(withTrades)),
          compareCount: againstAi.count,
          compareWinRate: againstAi.winRate,
          compareTotalPnl: againstAi.totalPnl,
          compareAveragePnl: againstAi.averagePnl,
          averagePnlDelta: delta,
        },
        suggestion: null,
      }));
    } else if (withAi.count >= MIN_INSIGHT_SAMPLE_SIZE) {
      insights.push(insight({
        id: "ai-entry-with",
        type: "neutral",
        severity: "info",
        label: "参考データ",
        title: "AI方向に進んだ後のEntry記録",
        description: `過去の記録では、AI方向へ進んだ後にEntryした取引は${withAi.count}件、勝率${fmtRate(withAi.winRate)}、平均損益 ${withAi.averagePnl === null ? "—" : fmtMoney(withAi.averagePnl)}でした。AI方向へ動いた後に入れば利益が出る、という意味ではありません。`,
        sampleSize: withAi.count,
        metrics: metricsFromStats(summarize(withTrades)),
        suggestion: null,
      }));
    } else if (againstAi.count >= MIN_INSIGHT_SAMPLE_SIZE) {
      insights.push(insight({
        id: "ai-entry-against",
        type: "neutral",
        severity: "info",
        label: "参考データ",
        title: "AI方向と逆に動いた後のEntry記録",
        description: `過去の記録では、AI方向と逆へ動いた後にEntryした取引は${againstAi.count}件、勝率${fmtRate(againstAi.winRate)}、平均損益 ${againstAi.averagePnl === null ? "—" : fmtMoney(againstAi.averagePnl)}でした。`,
        sampleSize: againstAi.count,
        metrics: metricsFromStats(summarize(againstTrades)),
        suggestion: null,
      }));
    }

    if (waitWithAi.count >= MIN_INSIGHT_SAMPLE_SIZE && waitAgainstAi.count >= MIN_INSIGHT_SAMPLE_SIZE) {
      insights.push(insight({
        id: "ai-entry-wait-split",
        type: "neutral",
        severity: "info",
        label: "参考データ",
        title: "WAIT中EntryにおけるAI方向×値動き（過去データ）",
        description: `Action=WAIT の記録に限定した過去比較です。AI方向に進んだ後 ${waitWithAi.count}件・平均 ${waitWithAi.averagePnl === null ? "—" : fmtMoney(waitWithAi.averagePnl)}、逆に動いた後 ${waitAgainstAi.count}件・平均 ${waitAgainstAi.averagePnl === null ? "—" : fmtMoney(waitAgainstAi.averagePnl)}。WAITだから売買すべきだった、という意味ではありません。`,
        sampleSize: waitWithAi.count + waitAgainstAi.count,
        metrics: {
          ...metricsFromStats(waitWithAi),
          compareCount: waitAgainstAi.count,
          compareWinRate: waitAgainstAi.winRate,
          compareTotalPnl: waitAgainstAi.totalPnl,
          compareAveragePnl: waitAgainstAi.averagePnl,
        },
        suggestion: null,
      }));
    }

    // Optional cross material: wait_override + against (if enough)
    const waitAgainstAligned = againstTrades.filter(t => computeAiAlignment(t.side, t.analysisSnapshot, t.pair) === "wait_override");
    const waitAgainstStats = summarize(waitAgainstAligned);
    if (waitAgainstStats.count >= MIN_INSIGHT_SAMPLE_SIZE && insights.length < 2) {
      insights.push(insight({
        id: "ai-entry-wait-against",
        type: "neutral",
        severity: "info",
        label: "参考データ",
        title: "WAIT中かつAI方向と逆に動いた後のEntry",
        description: `過去の記録では、WAIT中でAI方向と逆に動いた後のEntryは${waitAgainstStats.count}件、勝率${fmtRate(waitAgainstStats.winRate)}、損益 ${fmtMoney(waitAgainstStats.totalPnl)}でした。`,
        sampleSize: waitAgainstStats.count,
        metrics: metricsFromStats(waitAgainstStats),
        suggestion: null,
      }));
    }
  }

  return {
    classifications: classified.map(c => c.result),
    eligibleClosedCount: eligible.length,
    unavailableClosedCount,
    groups: [withAi, againstAi, near],
    withAi,
    againstAi,
    near,
    waitWithAi,
    waitAgainstAi,
    insights,
    emptyTrades: false,
    emptyComparable: eligible.length === 0,
  };
}

/** Insights to merge into Task014 generateTradingInsights (priority after alignment). */
export function aiEntryContextInsights(trades: Trade[]): TradingInsight[] {
  return analyzeAiEntryContext(trades).insights.slice(0, 2);
}
