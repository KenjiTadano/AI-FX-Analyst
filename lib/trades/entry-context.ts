import type { AIAnalysis } from "../ai/types";
import {
  ALIGNMENT_LABEL,
  TREND_LABEL,
  type HigherTimeframeBias,
  type MultiTimeframeAnalysis,
  type TimeframeAlignment,
} from "../market/multi-timeframe";
import {
  REGIME_LABEL,
  REGIME_TREND_LABEL,
  VOLATILITY_LABEL,
  type MarketRegimeAnalysis,
} from "../market/market-regime";
import type { MarketData } from "../market/types";
import type { DailyTradingPlan } from "../trading-plan/daily-plan";
import { STATE_LABEL, type EntryReadiness } from "../trading-plan/entry-readiness";
import { buildEntryTriggerWatch } from "../trading-plan/entry-trigger-watch";
import {
  capturePreTradeContext,
  eventRiskAtEntry,
  formatPreTradeEvent,
  formatPreTradeTriggerStatus,
  sanitizePreTradeContext,
  triggerStatusAtEntry,
} from "./pre-trade-context";
import { captureMultiTimeframeSnapshot, storedMultiTimeframeAnalysis } from "./mtf-snapshot";
import { captureMarketRegimeSnapshot, REGIME_SNAPSHOT_MISSING, regimeSnapshotState, storedMarketRegimeAnalysis } from "./regime-snapshot";
import { isRichSnapshot } from "./snapshot";
import { pairs, type PreTradeContextSnapshot, type Trade, type TradePair } from "./types";

export const ENTRY_CONTEXT_VERSION = 1 as const;
export const ENTRY_CONTEXT_TITLE = "エントリー判断コンテキスト";
export const ENTRY_CONTEXT_EYEBROW = "ENTRY CONTEXT";
export const ENTRY_CONTEXT_DISCLAIMER =
  "エントリー時点に存在していた判断材料の整理であり、売買を推奨・禁止するものではありません。品質評価ではありません。";
export const ENTRY_CONTEXT_NOTE = "エントリー時点の保存情報";

export const ENTRY_MTF_ALIGNMENT_LABEL: Record<TimeframeAlignment, string> = {
  aligned_bullish: "全時間軸で上向き",
  aligned_bearish: "全時間軸で下向き",
  mixed: "時間軸混在",
  insufficient: "データ不足",
};

export type EntryMtfVsDirection = "方向一致" | "逆方向" | "時間軸混在" | "データ不足";
export type EntryDllStatus = "到達" | "未到達" | "未設定/未取得";
export type EntryFreshness = "最新" | "更新から時間経過" | "未取得";

export interface EntryContext {
  version: typeof ENTRY_CONTEXT_VERSION;
  pair: TradePair;
  capturedAt: string;
  source: "live" | "stored";
  ai: {
    direction: PreTradeContextSnapshot["direction"];
    action: PreTradeContextSnapshot["action"];
  };
  mtf: {
    alignment: TimeframeAlignment;
    higherTimeframeBias: HigherTimeframeBias;
    vsDirection: EntryMtfVsDirection;
  } | null;
  marketRegime: {
    timeframe: "1h";
    analyzedAt: string;
    regime: MarketRegimeAnalysis["regime"];
    trendDirection: MarketRegimeAnalysis["trendDirection"];
    volatility: MarketRegimeAnalysis["volatility"];
    atrPercent: number | null;
    atrRatio: number | null;
    smaSpreadPercent: number | null;
  } | null;
  regimeState: "ok" | "absent" | "unreadable";
  readiness: {
    confirmed: number;
    total: 5;
    overall: string;
  } | null;
  trigger: {
    status: ReturnType<typeof triggerStatusAtEntry>;
    label: string;
    distancePips: number | null;
  };
  eventRisk: {
    level: ReturnType<typeof eventRiskAtEntry>;
    label: string;
  };
  risk: {
    riskPerTrade: number | null;
    riskPercent: number | null;
  };
  dailyLossLimit: {
    enabled: boolean;
    reached: boolean | null;
    label: EntryDllStatus;
  };
  freshness: {
    stale: boolean | null;
    label: EntryFreshness;
  };
}

function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function mtfVsDirection(
  alignment: TimeframeAlignment | null | undefined,
  direction: PreTradeContextSnapshot["direction"],
): EntryMtfVsDirection {
  if (!alignment || alignment === "insufficient") return "データ不足";
  if (alignment === "mixed") return "時間軸混在";
  if (direction !== "BUY" && direction !== "SELL") return "時間軸混在";
  if (alignment === "aligned_bullish") return direction === "BUY" ? "方向一致" : "逆方向";
  return direction === "SELL" ? "方向一致" : "逆方向";
}

export function formatDllStatus(context: PreTradeContextSnapshot | null | undefined): EntryDllStatus {
  if (!context) return "未設定/未取得";
  if (context.dailyLossLimitPercent == null && context.dailyLossRemaining == null) return "未設定/未取得";
  return context.dailyLossLimitReached ? "到達" : "未到達";
}

export function formatEntryFreshness(stale: boolean | null | undefined): EntryFreshness {
  if (stale == null) return "未取得";
  return stale ? "更新から時間経過" : "最新";
}

function compactRegime(analysis: MarketRegimeAnalysis | null): EntryContext["marketRegime"] {
  if (!analysis) return null;
  return {
    timeframe: "1h",
    analyzedAt: analysis.analyzedAt,
    regime: analysis.regime,
    trendDirection: analysis.trendDirection,
    volatility: analysis.volatility,
    atrPercent: analysis.evidence.atrPercent,
    atrRatio: analysis.evidence.atrRatio,
    smaSpreadPercent: analysis.evidence.smaSpreadPercent,
  };
}

function compactMtf(
  analysis: MultiTimeframeAnalysis | null,
  direction: PreTradeContextSnapshot["direction"],
): EntryContext["mtf"] {
  if (!analysis) return null;
  return {
    alignment: analysis.alignment,
    higherTimeframeBias: analysis.higherTimeframeBias,
    vsDirection: mtfVsDirection(analysis.alignment, direction),
  };
}

function fromPreTrade(
  pair: TradePair,
  capturedAt: string,
  source: "live" | "stored",
  preTrade: PreTradeContextSnapshot | null,
  mtf: MultiTimeframeAnalysis | null,
  regime: MarketRegimeAnalysis | null,
  regimeState: EntryContext["regimeState"],
): EntryContext {
  const direction = preTrade?.direction ?? null;
  const dllLabel = formatDllStatus(preTrade);
  return copy({
    version: ENTRY_CONTEXT_VERSION,
    pair,
    capturedAt,
    source,
    ai: {
      direction,
      action: preTrade?.action ?? null,
    },
    mtf: compactMtf(mtf, direction),
    marketRegime: compactRegime(regime),
    regimeState,
    readiness: preTrade?.readiness
      ? {
        confirmed: preTrade.readiness.confirmedCount,
        total: 5,
        overall: STATE_LABEL[preTrade.readiness.state],
      }
      : null,
    trigger: {
      status: triggerStatusAtEntry(preTrade),
      label: preTrade ? formatPreTradeTriggerStatus(preTrade) : "未取得",
      distancePips: preTrade?.trigger?.evaluation.distanceToTriggerPips ?? null,
    },
    eventRisk: {
      level: eventRiskAtEntry(preTrade),
      label: preTrade ? formatPreTradeEvent(preTrade) : "未取得",
    },
    risk: {
      riskPerTrade: preTrade?.risk?.riskPerTrade ?? null,
      riskPercent: preTrade?.risk?.riskPercent ?? null,
    },
    dailyLossLimit: {
      enabled: preTrade?.dailyLossLimitPercent != null,
      reached: preTrade?.dailyLossLimitPercent != null ? preTrade.dailyLossLimitReached : null,
      label: dllLabel,
    },
    freshness: {
      stale: preTrade ? preTrade.analysisStale : null,
      label: formatEntryFreshness(preTrade ? preTrade.analysisStale : null),
    },
  });
}

function distanceFromReadiness(pair: string, readiness: EntryReadiness | null | undefined): number | null {
  if (!readiness?.triggerEvaluation) return null;
  const distance = buildEntryTriggerWatch({
    trigger: readiness.entryTrigger,
    evaluation: readiness.triggerEvaluation,
    action: readiness.action,
    direction: readiness.direction,
    stale: readiness.stale,
    dailyLossLimitReached: readiness.dailyLossLimitReached,
    pair,
  })?.distanceToTriggerPips ?? null;
  return distance != null && Number.isFinite(distance) && distance >= 0 ? distance : null;
}

export function buildLiveEntryContext(input: {
  pair: string;
  capturedAt: string;
  analysis?: AIAnalysis | null;
  dailyPlan?: DailyTradingPlan | null;
  readiness?: EntryReadiness | null;
  market?: MarketData | null;
}): EntryContext | null {
  if (!pairs.includes(input.pair as TradePair)) return null;
  const pair = input.pair as TradePair;
  const analysis = input.analysis && input.analysis.pair === pair ? input.analysis : null;
  const preTrade = analysis
    ? capturePreTradeContext({
      pair,
      capturedAt: analysis.analyzedAt,
      analysis,
      dailyPlan: input.dailyPlan ?? null,
      readiness: input.readiness ?? null,
      distanceToTriggerPips: distanceFromReadiness(pair, input.readiness),
    })
    : null;
  const market = input.market && input.market.symbol === pair ? input.market : null;
  const mtf = captureMultiTimeframeSnapshot(market, pair, input.capturedAt);
  const regime = captureMarketRegimeSnapshot(market, pair, input.capturedAt);
  return fromPreTrade(pair, input.capturedAt, "live", preTrade, mtf, regime, regime ? "ok" : "absent");
}

export function buildStoredEntryContext(trade: Trade): EntryContext | null {
  const snap = trade.analysisSnapshot;
  if (!isRichSnapshot(snap)) return null;
  const preTrade = sanitizePreTradeContext(snap.preTradeContext, trade.pair);
  const mtf = storedMultiTimeframeAnalysis(trade);
  const regime = storedMarketRegimeAnalysis(trade);
  const capturedAt = preTrade?.capturedAt ?? snap.capturedAt;
  return fromPreTrade(trade.pair, capturedAt, "stored", preTrade, mtf, regime, regimeSnapshotState(trade));
}

export function entryContextLabels(context: EntryContext) {
  return {
    direction: context.ai.direction ?? "未取得",
    action: context.ai.action ?? "未取得",
    mtf: context.mtf ? ENTRY_MTF_ALIGNMENT_LABEL[context.mtf.alignment] : "未取得",
    mtfAlignment: context.mtf ? ALIGNMENT_LABEL[context.mtf.alignment] : "未取得",
    htf: context.mtf ? TREND_LABEL[context.mtf.higherTimeframeBias] : "未取得",
    vsDirection: context.mtf?.vsDirection ?? "データ不足",
    regime: context.marketRegime ? REGIME_LABEL[context.marketRegime.regime] : REGIME_SNAPSHOT_MISSING,
    regimeTrend: context.marketRegime ? REGIME_TREND_LABEL[context.marketRegime.trendDirection] : "未取得",
    volatility: context.marketRegime ? VOLATILITY_LABEL[context.marketRegime.volatility] : "未取得",
    readiness: context.readiness ? `${context.readiness.confirmed} / ${context.readiness.total}` : "—",
    trigger: context.trigger.label,
    event: context.eventRisk.label,
    risk: context.risk.riskPerTrade != null && context.risk.riskPercent != null
      ? `${context.risk.riskPerTrade.toLocaleString("ja-JP", { maximumFractionDigits: 2 })}円 / ${context.risk.riskPercent.toFixed(1)}%`
      : "未取得",
    dll: context.dailyLossLimit.label,
    freshness: context.freshness.label,
  };
}

export { REGIME_SNAPSHOT_MISSING };
