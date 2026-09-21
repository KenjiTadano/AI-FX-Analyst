import type { AIAnalysis } from "../ai/types";
import { actionGuidanceLabel, directionBiasLabel } from "../ai/decision-ui";
import { STATUS_TEXT, type EntryTriggerEvaluationStatus } from "../ai/entry-trigger";
import type { DataResource, EconomicEvent } from "../fundamental/types";
import {
  marketRegimeForPair,
  REGIME_LABEL,
  REGIME_TREND_LABEL,
  VOLATILITY_LABEL,
} from "../market/market-regime";
import {
  multiTimeframeForPair,
  TIMEFRAME_LABEL,
  TREND_LABEL,
  type TimeframeTrend,
} from "../market/multi-timeframe";
import type { MarketData, Symbol as MarketSymbol } from "../market/types";
import type { RiskSettings } from "../risk/types";
import { CHANGE_TIMEFRAME_ORDER } from "../trades/market-context-change";
import {
  buildCurrentMarketContext,
  findSimilarHistoricalContexts,
  similarHistoricalEmptyMessage,
  type SimilarHistoricalEmptyReason,
} from "../trades/context-similarity";
import type { Trade, TradePair } from "../trades/types";
import { buildDailyTradingPlan, type EventRiskLevel } from "../trading-plan/daily-plan";
import {
  buildEntryReadiness,
  READINESS_FIXED_TOTAL,
  STATE_LABEL,
} from "../trading-plan/entry-readiness";

export const WORKSPACE_TITLE = "Trading Decision Workspace";
export const WORKSPACE_EYEBROW = "DECISION WORKSPACE";
export const WORKSPACE_NOTE =
  "既存の判断材料を短時間で確認するための要約です。新しい売買判定やスコアは追加していません。";
export const WORKSPACE_TRIGGER_NOTE =
  "Trigger の条件成立はエントリー推奨ではありません。Action が WAIT なら WAIT のままです。";
export const WORKSPACE_AI_UNAVAILABLE_NOTE =
  "AI status が unavailable / error のときの Action WAIT は、AI が WAIT と判断した結果ではありません。";

export type RateFreshness = "fresh" | "stale" | "error" | "loading";

export type WorkspaceAiStatus = "available" | "unavailable" | "error" | "missing";

export type TradingDecisionWorkspaceModel = {
  pair: string;
  rate: {
    value: number | null;
    freshness: RateFreshness;
    freshnessLabel: string;
    fetchedAt: string | null;
  };
  ai: {
    directionCode: string;
    directionLabel: string;
    actionCode: string;
    actionLabel: string;
    confidence: number | null;
    status: WorkspaceAiStatus;
    statusLabel: string;
    /** True when AI is not available — WAIT must not be read as AI judgment. */
    unavailableSeparatesWait: boolean;
  };
  readiness: {
    available: boolean;
    confirmedCount: number;
    totalCount: number;
    countLabel: string;
    stateLabel: string;
  };
  trigger: {
    available: boolean;
    status: EntryTriggerEvaluationStatus | null;
    statusText: string;
  };
  eventRisk: {
    available: boolean;
    level: EventRiskLevel | null;
    levelLabel: string;
    message: string;
    name: string | null;
    highImpact: boolean;
  };
  mtf: {
    available: boolean;
    frames: Array<{ timeframe: string; label: string; trend: TimeframeTrend; trendLabel: string }>;
  };
  regime: {
    available: boolean;
    regime: string | null;
    regimeLabel: string;
    trendDirection: string | null;
    trendLabel: string;
    volatility: string | null;
    volatilityLabel: string;
  };
  similar: {
    available: boolean;
    count: number;
    topPercent: number | null;
    emptyReason: SimilarHistoricalEmptyReason;
    emptyMessage: string | null;
  };
};

export type BuildTradingDecisionWorkspaceInput = {
  pair: string;
  analysis: AIAnalysis | null | undefined;
  trades: Trade[];
  riskSettings: RiskSettings;
  currentRate: number | null;
  market: MarketData | null;
  marketError?: string | null;
  calendar?: DataResource<EconomicEvent[]> | null;
  dailyLossLimitPercent?: number | null;
  now?: number;
  capturedAt?: string;
};

const EVENT_LEVEL_LABEL: Record<EventRiskLevel, string> = {
  high: "HIGH",
  medium: "MEDIUM",
  low: "LOW",
  unknown: "UNKNOWN",
};

function resolveFreshness(input: {
  market: MarketData | null;
  marketError?: string | null;
  currentRate: number | null;
}): { freshness: RateFreshness; freshnessLabel: string; fetchedAt: string | null; value: number | null } {
  const price = input.market?.price ?? null;
  if (!input.market && input.marketError) {
    return { freshness: "error", freshnessLabel: "ERROR", fetchedAt: null, value: null };
  }
  if (!input.market || !price) {
    return { freshness: "loading", freshnessLabel: "LOADING", fetchedAt: null, value: null };
  }
  if (price.error && price.data == null) {
    return { freshness: "error", freshnessLabel: "ERROR", fetchedAt: price.fetchedAt, value: null };
  }
  if (price.stale) {
    return {
      freshness: "stale",
      freshnessLabel: "STALE",
      fetchedAt: price.fetchedAt,
      value: typeof price.data === "number" && Number.isFinite(price.data) ? price.data : input.currentRate,
    };
  }
  if (price.data != null && Number.isFinite(price.data)) {
    return {
      freshness: "fresh",
      freshnessLabel: "FRESH",
      fetchedAt: price.fetchedAt,
      value: price.data,
    };
  }
  return {
    freshness: "loading",
    freshnessLabel: "LOADING",
    fetchedAt: price.fetchedAt,
    value: input.currentRate,
  };
}

function aiStatusOf(analysis: AIAnalysis | null | undefined): {
  status: WorkspaceAiStatus;
  statusLabel: string;
  unavailableSeparatesWait: boolean;
} {
  if (!analysis) {
    return { status: "missing", statusLabel: "AI status: missing", unavailableSeparatesWait: true };
  }
  const status = analysis.ai.status;
  if (status === "available") {
    return { status: "available", statusLabel: "AI status: available", unavailableSeparatesWait: false };
  }
  if (status === "unavailable") {
    return { status: "unavailable", statusLabel: "AI status: unavailable", unavailableSeparatesWait: true };
  }
  return { status: "error", statusLabel: "AI status: error", unavailableSeparatesWait: true };
}

function directionCode(analysis: AIAnalysis | null | undefined, planDirection: string): string {
  const signal = analysis?.directionSignal;
  if (signal === "strong_buy" || signal === "buy") return "BUY";
  if (signal === "strong_sell" || signal === "sell") return "SELL";
  if (signal === "wait") return "NEUTRAL";
  return planDirection;
}

/**
 * Pure view-model for Trading Decision Workspace.
 * Reuses existing builders only — does not invent scores, signals, or recommendations.
 */
export function buildTradingDecisionWorkspace(
  input: BuildTradingDecisionWorkspaceInput,
): TradingDecisionWorkspaceModel {
  const now = input.now ?? Date.now();
  const analysis = input.analysis ?? null;
  const market = input.market && input.market.symbol === input.pair ? input.market : null;

  const plan = buildDailyTradingPlan({
    pair: input.pair,
    analysis,
    trades: input.trades,
    riskSettings: input.riskSettings,
    currentRate: input.currentRate,
    calendar: input.calendar,
    dailyLossLimitPercent: input.dailyLossLimitPercent ?? null,
    now,
  });

  const candlesByTimeframe = market
    ? {
      "15m": market.timeframes["15m"]?.data ?? null,
      "1h": market.timeframes["1h"]?.data ?? null,
      "4h": market.timeframes["4h"]?.data ?? null,
    }
    : undefined;

  const readiness = buildEntryReadiness({
    pair: input.pair,
    analysis,
    dailyPlan: plan,
    riskSettings: input.riskSettings,
    currentRate: input.currentRate,
    candlesByTimeframe,
    now,
  });

  const rate = resolveFreshness({
    market,
    marketError: input.marketError,
    currentRate: input.currentRate,
  });

  const aiMeta = aiStatusOf(analysis);
  const directionSignal = analysis?.directionSignal ?? "wait";
  const actionCode = analysis?.action ?? plan.action ?? "WAIT";
  const dirCode = directionCode(analysis, plan.direction);

  const triggerEval = readiness.triggerEvaluation;
  const triggerStatus = triggerEval?.status ?? null;

  const analyzedAt = analysis?.analyzedAt
    ?? market?.price.fetchedAt
    ?? input.capturedAt
    ?? new Date(now).toISOString();

  const mtf = market
    ? multiTimeframeForPair(market, input.pair as MarketSymbol, analyzedAt)
    : null;
  const regime = market
    ? marketRegimeForPair(market, input.pair as MarketSymbol, analyzedAt)
    : null;

  const mtfFrames = CHANGE_TIMEFRAME_ORDER.map(tf => {
    const frame = mtf?.timeframes.find(item => item.timeframe === tf);
    const trend: TimeframeTrend = frame?.trend ?? "unavailable";
    return {
      timeframe: tf,
      label: tf === "1day" ? "1D" : TIMEFRAME_LABEL[tf] ?? tf,
      trend,
      trendLabel: TREND_LABEL[trend],
    };
  });

  const capturedAt = input.capturedAt
    ?? (market?.price.fetchedAt
      && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(market.price.fetchedAt)
      && new Date(market.price.fetchedAt).toISOString() === market.price.fetchedAt
      ? market.price.fetchedAt
      : new Date(now).toISOString());

  const currentContext = buildCurrentMarketContext({
    pair: input.pair,
    capturedAt,
    market,
    marketRate: rate.value,
  });
  const similar = findSimilarHistoricalContexts({
    pair: input.pair as TradePair,
    current: currentContext,
    trades: input.trades,
  });

  return {
    pair: input.pair,
    rate: {
      value: rate.value,
      freshness: rate.freshness,
      freshnessLabel: rate.freshnessLabel,
      fetchedAt: rate.fetchedAt,
    },
    ai: {
      directionCode: dirCode,
      directionLabel: directionBiasLabel(directionSignal),
      actionCode,
      actionLabel: actionGuidanceLabel(actionCode, directionSignal),
      confidence: analysis?.confidence ?? plan.confidence,
      status: aiMeta.status,
      statusLabel: aiMeta.statusLabel,
      unavailableSeparatesWait: aiMeta.unavailableSeparatesWait,
    },
    readiness: {
      available: readiness.state !== "unavailable" || readiness.confirmedCount > 0,
      confirmedCount: readiness.confirmedCount,
      totalCount: readiness.totalCount || READINESS_FIXED_TOTAL,
      countLabel: `${readiness.confirmedCount} / ${readiness.totalCount || READINESS_FIXED_TOTAL}`,
      stateLabel: STATE_LABEL[readiness.state],
    },
    trigger: {
      available: triggerStatus != null,
      status: triggerStatus,
      statusText: triggerStatus ? STATUS_TEXT[triggerStatus] : "Trigger unavailable",
    },
    eventRisk: {
      available: plan.eventRisk.available,
      level: plan.eventRisk.available ? plan.eventRisk.level : null,
      levelLabel: plan.eventRisk.available ? EVENT_LEVEL_LABEL[plan.eventRisk.level] : "UNAVAILABLE",
      message: plan.eventRisk.message,
      name: plan.eventRisk.name,
      highImpact: plan.eventRisk.available && plan.eventRisk.level === "high",
    },
    mtf: {
      available: mtf != null && mtf.availableTimeframes > 0,
      frames: mtfFrames,
    },
    regime: {
      available: regime != null && regime.regime !== "unavailable",
      regime: regime?.regime ?? null,
      regimeLabel: regime ? REGIME_LABEL[regime.regime] : "未取得",
      trendDirection: regime?.trendDirection ?? null,
      trendLabel: regime ? REGIME_TREND_LABEL[regime.trendDirection] : "未取得",
      volatility: regime?.volatility ?? null,
      volatilityLabel: regime ? VOLATILITY_LABEL[regime.volatility] : "未取得",
    },
    similar: {
      available: similar.matches.length > 0,
      count: similar.matches.length,
      topPercent: similar.matches[0]?.similarity.percent ?? null,
      emptyReason: similar.emptyReason,
      emptyMessage: similar.emptyReason ? similarHistoricalEmptyMessage(similar.emptyReason) : null,
    },
  };
}
