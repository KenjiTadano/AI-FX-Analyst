import type { PreTradeContextSnapshot, TradeAiAnalysisSnapshot, Trade } from "../../lib/trades/types";
import { pnl } from "../../lib/trades/calculations";
import { createExitPlan } from "../../lib/trades/exit-plan";
import { E2E_USER_ID, TRADE_IDS, daysAgo, iso, localDayOffset } from "./ids";
import type { TradeSignal } from "../../lib/ai/types";
import type { HigherTimeframeBias, MultiTimeframeAnalysis, TimeframeAlignment, TimeframeAnalysis, TimeframeTrend } from "../../lib/market/multi-timeframe";
import { mtfTimeframes } from "../../lib/market/types";

function quality() {
  return {
    score: 80,
    missingData: [] as string[],
    categories: {
      technical: { status: "ok" as const, detail: "ok", fraction: 1 },
      news: { status: "ok" as const, detail: "ok", fraction: 1 },
      economic: { status: "ok" as const, detail: "ok", fraction: 1 },
      central_bank: { status: "ok" as const, detail: "ok", fraction: 1 },
      market_environment: { status: "ok" as const, detail: "ok", fraction: 1 },
    },
    macroeconomicData: { status: "ok" as const, detail: "ok", fraction: 1 },
  };
}

export function richSnapshot(partial: Partial<TradeAiAnalysisSnapshot> = {}): TradeAiAnalysisSnapshot {
  const now = partial.analyzedAt ?? new Date().toISOString();
  return {
    pair: "USD/JPY",
    signal: "sell",
    score: 20,
    confidence: 70,
    summary: "e2e snapshot",
    dataQualityScore: 80,
    analyzedAt: now,
    capturedAt: now,
    expiresAt: now,
    aiStatus: "available",
    model: "e2e",
    bullishReasons: [],
    bearishReasons: [],
    version: 1,
    directionSignal: "sell",
    action: "WAIT",
    marketPrice: 156.5,
    analysisPrice: 156.5,
    factors: [],
    scenario: null,
    dataQuality: quality(),
    economicRisk: null,
    chartEvidence: null,
    chartAnalysis: null,
    aiCode: null,
    isFallback: false,
    ...partial,
  };
}

function closedTrade(args: {
  id: string;
  openedAt: string;
  closedAt: string;
  side: "long" | "short";
  entryPrice: number;
  exitPrice: number;
  pair?: Trade["pair"];
  snapshot?: TradeAiAnalysisSnapshot | null;
  notes?: string;
}): Trade {
  const quantity = 1000;
  const realizedPnl = pnl(args.side, args.entryPrice, args.exitPrice, quantity);
  if (realizedPnl === null) throw new Error("e2e pnl");
  return {
    id: args.id,
    pair: args.pair ?? "USD/JPY",
    side: args.side,
    status: "closed",
    quantity,
    entryPrice: args.entryPrice,
    exitPrice: args.exitPrice,
    openedAt: args.openedAt,
    closedAt: args.closedAt,
    stopLoss: null,
    takeProfit: null,
    notes: args.notes ?? "e2e",
    realizedPnl,
    analysisSnapshot: args.snapshot ?? null,
    createdAt: args.openedAt,
    updatedAt: args.closedAt,
  };
}

function withExitPlan(trade: Trade, stopLoss: number, takeProfit: number | null): Trade {
  return {
    ...trade,
    stopLoss,
    takeProfit,
    exitPlan: createExitPlan({
      pair: trade.pair,
      side: trade.side,
      entryPrice: trade.entryPrice,
      stopLoss,
      takeProfit,
      capturedAt: trade.createdAt,
    }),
  };
}

export function performanceTrades(now = Date.now()): Trade[] {
  const today = localDayOffset(0, 10, new Date(now));
  const yesterday = localDayOffset(-1, 15, new Date(now));
  const recent = daysAgo(5, now);
  const month = daysAgo(45, now);
  const old = daysAgo(120, now);
  return [
    {
      id: TRADE_IDS.todayOpen,
      pair: "USD/JPY",
      side: "short",
      status: "open",
      quantity: 1000,
      entryPrice: 156.4,
      exitPrice: null,
      openedAt: today,
      closedAt: null,
      stopLoss: null,
      takeProfit: null,
      notes: "e2e open",
      realizedPnl: null,
      analysisSnapshot: null,
      createdAt: today,
      updatedAt: today,
    },
    closedTrade({
      id: TRADE_IDS.todayClosed,
      openedAt: today,
      closedAt: today,
      side: "short",
      entryPrice: 156.5,
      exitPrice: 157.3,
      snapshot: richSnapshot({ analyzedAt: today, capturedAt: today, expiresAt: today }),
    }),
    withExitPlan(closedTrade({
      id: TRADE_IDS.yesterdayClosed,
      openedAt: yesterday,
      closedAt: yesterday,
      side: "short",
      entryPrice: 156.5,
      exitPrice: 156.1,
    }), 156.8, 156.1),
    closedTrade({
      id: TRADE_IDS.recentClosed,
      openedAt: recent,
      closedAt: recent,
      side: "short",
      entryPrice: 156.5,
      exitPrice: 156.2,
      snapshot: richSnapshot({
        analyzedAt: recent,
        capturedAt: recent,
        expiresAt: recent,
        directionSignal: "sell",
        action: "SELL",
        analysisPrice: 156.5,
        marketPrice: 156.5,
      }),
    }),
    withExitPlan(closedTrade({
      id: TRADE_IDS.monthClosed,
      openedAt: month,
      closedAt: month,
      side: "long",
      entryPrice: 156.2,
      exitPrice: 156.5,
    }), 155.9, 156.8),
    closedTrade({
      id: TRADE_IDS.oldClosed,
      openedAt: old,
      closedAt: old,
      side: "long",
      entryPrice: 156.0,
      exitPrice: 156.4,
    }),
    closedTrade({
      id: TRADE_IDS.waitSellClosed,
      openedAt: recent,
      closedAt: recent,
      side: "short",
      entryPrice: 156.2,
      exitPrice: 156.0,
      snapshot: richSnapshot({
        analyzedAt: recent,
        capturedAt: recent,
        expiresAt: recent,
        directionSignal: "sell" as TradeSignal,
        action: "WAIT",
        analysisPrice: 156.5,
        marketPrice: 156.5,
      }),
    }),
    closedTrade({
      id: TRADE_IDS.contraryClosed,
      openedAt: recent,
      closedAt: recent,
      side: "long",
      entryPrice: 156.2,
      exitPrice: 156.0,
      snapshot: richSnapshot({
        analyzedAt: recent,
        capturedAt: recent,
        expiresAt: recent,
        directionSignal: "sell",
        action: "SELL",
        signal: "sell",
        analysisPrice: 156.5,
        marketPrice: 156.5,
      }),
    }),
  ];
}

function t023Id(n: number): string {
  return `11111111-1111-4111-8111-111111111${String(300 + n).padStart(3, "0")}`;
}

export function preTradeSnapshotContext(partial: Partial<PreTradeContextSnapshot> = {}, at = "2026-09-15T03:15:00.000Z"): PreTradeContextSnapshot {
  return {
    version: 1,
    capturedAt: at,
    pair: "USD/JPY",
    direction: "SELL",
    action: "WAIT",
    readiness: { confirmedCount: 5, totalCount: 5, state: "waiting" },
    trigger: {
      structuredTrigger: {
        version: 1,
        type: "price_below",
        pair: "USD/JPY",
        price: 156.2,
        timeframe: null,
        sourceCondition: "現在価格が156.20を下回った場合",
      },
      evaluation: { status: "met", observedValue: 156.18, checkedAt: at, distanceToTriggerPips: 0 },
    },
    dataQuality: { score: 82 },
    confidence: 76,
    eventRisk: { level: "low", available: true },
    risk: { capital: 50_000, riskPercent: 1, riskPerTrade: 500 },
    dailyLossLimitPercent: 3,
    dailyLossRemaining: 1_000,
    dailyLossLimitReached: false,
    analysisStale: false,
    eventRiskHigh: false,
    ...partial,
  };
}

function contextTrade(args: {
  id: string;
  openedAt: string;
  closedAt: string;
  exitPrice: number;
  context: PreTradeContextSnapshot;
  status?: Trade["status"];
  notes?: string;
}): Trade {
  if (args.status === "open") {
    return {
      id: args.id,
      pair: "USD/JPY",
      side: "short",
      status: "open",
      quantity: 1000,
      entryPrice: 156.5,
      exitPrice: null,
      openedAt: args.openedAt,
      closedAt: null,
      stopLoss: null,
      takeProfit: null,
      notes: args.notes ?? "t023 open",
      realizedPnl: null,
      analysisSnapshot: richSnapshot({
        analyzedAt: args.openedAt,
        capturedAt: args.openedAt,
        expiresAt: args.openedAt,
        action: args.context.action ?? "WAIT",
        directionSignal: "sell",
        preTradeContext: args.context,
      }),
      createdAt: args.openedAt,
      updatedAt: args.openedAt,
    };
  }
  return closedTrade({
    id: args.id,
    openedAt: args.openedAt,
    closedAt: args.closedAt,
    side: "short",
    entryPrice: 156.5,
    exitPrice: args.exitPrice,
    notes: args.notes,
    snapshot: richSnapshot({
      analyzedAt: args.openedAt,
      capturedAt: args.openedAt,
      expiresAt: args.openedAt,
      action: args.context.action ?? "WAIT",
      directionSignal: "sell",
      preTradeContext: { ...args.context, capturedAt: args.openedAt, pair: "USD/JPY" },
    }),
  });
}

/** Default journal trades plus Task023 context samples. Coverage is partial. */
export function preTradePerformanceTrades(now = Date.now()): Trade[] {
  return [...performanceTrades(now), ...preTradeContextClosedTrades(now), preTradeContextOpenTrade(now)];
}

/** Closed trades that all have valid preTradeContext (coverage 100%). */
export function preTradeFullContextTrades(now = Date.now()): Trade[] {
  return preTradeContextClosedTrades(now);
}

export function preTradeContextOpenTrade(now = Date.now()): Trade {
  const today = localDayOffset(0, 11, new Date(now));
  return contextTrade({
    id: t023Id(19),
    openedAt: today,
    closedAt: today,
    exitPrice: 156.0,
    status: "open",
    context: preTradeSnapshotContext({ action: "WAIT" }, today),
    notes: "t023-open-context",
  });
}

export function preTradeContextClosedTrades(now = Date.now()): Trade[] {
  const recent = daysAgo(5, now);
  const month = daysAgo(45, now);
  const at = iso(now);
  const met = preTradeSnapshotContext({ action: "WAIT", analysisStale: false }, at);
  const notMet = preTradeSnapshotContext({
    action: "WAIT",
    trigger: {
      structuredTrigger: met.trigger!.structuredTrigger,
      evaluation: { status: "not_met", observedValue: 156.2, checkedAt: at, distanceToTriggerPips: 0 },
    },
  }, at);
  const stale = preTradeSnapshotContext({ action: "WAIT", analysisStale: true }, at);
  const eventUnavailable = preTradeSnapshotContext({
    action: "WAIT",
    eventRisk: { level: "unknown", available: false },
    eventRiskHigh: false,
  }, at);
  const dll = preTradeSnapshotContext({ action: "WAIT", dailyLossLimitReached: true, dailyLossRemaining: 0 }, at);

  const recentWins = [1, 2, 3, 4, 5].map(n => contextTrade({
    id: t023Id(n), openedAt: recent, closedAt: recent, exitPrice: 156.0, context: met, notes: "t023-met",
  }));
  const recentLosses = [6, 7, 8, 9, 10].map(n => contextTrade({
    id: t023Id(n), openedAt: recent, closedAt: recent, exitPrice: 157.0, context: notMet, notes: "t023-not-met",
  }));
  const olderWins = [11, 12, 13].map(n => contextTrade({
    id: t023Id(n), openedAt: month, closedAt: month, exitPrice: 156.0, context: met, notes: "t023-met-90d",
  }));
  const olderLosses = [14, 15].map(n => contextTrade({
    id: t023Id(n), openedAt: month, closedAt: month, exitPrice: 157.0, context: notMet, notes: "t023-not-met-90d",
  }));
  return [
    ...recentWins,
    ...recentLosses,
    ...olderWins,
    ...olderLosses,
    contextTrade({ id: t023Id(16), openedAt: recent, closedAt: recent, exitPrice: 156.0, context: stale, notes: "t023-stale" }),
    contextTrade({ id: t023Id(17), openedAt: recent, closedAt: recent, exitPrice: 156.0, context: eventUnavailable, notes: "t023-event-unavailable" }),
    contextTrade({ id: t023Id(18), openedAt: recent, closedAt: recent, exitPrice: 157.0, context: dll, notes: "t023-dll" }),
  ];
}

export function postTradeReviewTrades(now = Date.now()): Trade[] {
  const recent = daysAgo(5, now);
  const holdLongOpen = iso(now - (27 * 60 + 0) * 60_000);
  const hold235Open = iso(now - (2 * 60 + 35) * 60_000);
  const hold35Open = iso(now - 35 * 60_000);
  const closedAt = iso(now);
  const met = preTradeSnapshotContext({ action: "WAIT", analysisStale: false }, closedAt);
  const notMetZero = preTradeSnapshotContext({
    action: "WAIT",
    trigger: {
      structuredTrigger: met.trigger!.structuredTrigger,
      evaluation: { status: "not_met", observedValue: 156.2, checkedAt: closedAt, distanceToTriggerPips: 0 },
    },
  }, closedAt);
  const eventUnavailable = preTradeSnapshotContext({
    action: "WAIT",
    eventRisk: { level: "unknown", available: false },
    eventRiskHigh: false,
  }, closedAt);
  const stale = preTradeSnapshotContext({ action: "WAIT", analysisStale: true }, closedAt);
  const dll = preTradeSnapshotContext({ action: "WAIT", dailyLossLimitReached: true, dailyLossRemaining: 0 }, closedAt);
  const mismatch = preTradeSnapshotContext({ pair: "EUR/JPY", action: "WAIT" }, closedAt);

  return [
    contextTrade({
      id: t025Id(1),
      openedAt: recent,
      closedAt: recent,
      exitPrice: 156.0,
      status: "open",
      context: met,
      notes: "t025-open",
    }),
    contextTrade({ id: t025Id(2), openedAt: hold235Open, closedAt, exitPrice: 156.0, context: met, notes: "t025-profit" }),
    contextTrade({ id: t025Id(3), openedAt: hold35Open, closedAt, exitPrice: 157.0, context: met, notes: "t025-loss" }),
    contextTrade({ id: t025Id(4), openedAt: hold35Open, closedAt, exitPrice: 156.5, context: met, notes: "t025-flat" }),
    closedTrade({
      id: t025Id(5),
      openedAt: holdLongOpen,
      closedAt,
      side: "long",
      entryPrice: 156.5,
      exitPrice: 156.0,
      notes: "t025-buy-sell",
      snapshot: richSnapshot({
        analyzedAt: holdLongOpen,
        capturedAt: holdLongOpen,
        expiresAt: holdLongOpen,
        directionSignal: "sell",
        action: "WAIT",
        preTradeContext: { ...met, capturedAt: holdLongOpen },
      }),
    }),
    contextTrade({ id: t025Id(6), openedAt: hold35Open, closedAt, exitPrice: 156.0, context: notMetZero, notes: "t025-equality" }),
    contextTrade({ id: t025Id(7), openedAt: hold35Open, closedAt, exitPrice: 157.0, context: eventUnavailable, notes: "t025-event" }),
    contextTrade({ id: t025Id(8), openedAt: hold35Open, closedAt, exitPrice: 156.0, context: stale, notes: "t025-stale" }),
    contextTrade({ id: t025Id(9), openedAt: hold35Open, closedAt, exitPrice: 157.0, context: dll, notes: "t025-dll" }),
    closedTrade({
      id: t025Id(10),
      openedAt: hold35Open,
      closedAt,
      side: "short",
      entryPrice: 156.5,
      exitPrice: 156.0,
      notes: "t025-legacy",
    }),
    closedTrade({
      id: t025Id(11),
      openedAt: hold35Open,
      closedAt,
      side: "short",
      entryPrice: 156.5,
      exitPrice: 156.0,
      notes: "t025-ai-only",
      snapshot: richSnapshot({
        analyzedAt: hold35Open,
        capturedAt: hold35Open,
        expiresAt: hold35Open,
        directionSignal: "sell",
        action: "WAIT",
      }),
    }),
    closedTrade({
      id: t025Id(12),
      openedAt: hold35Open,
      closedAt,
      side: "short",
      entryPrice: 156.5,
      exitPrice: 156.0,
      notes: "t025-mismatch",
      snapshot: richSnapshot({
        analyzedAt: hold35Open,
        capturedAt: hold35Open,
        expiresAt: hold35Open,
        directionSignal: "sell",
        action: "WAIT",
        preTradeContext: mismatch,
      }),
    }),
    {
      ...closedTrade({
        id: t025Id(13),
        openedAt: hold35Open,
        closedAt,
        side: "short",
        entryPrice: 156.5,
        exitPrice: 156.0,
        notes: "t031-malformed",
      }),
      exitPlan: { version: 1, pair: "USD/JPY" } as Trade["exitPlan"],
    },
  ];
}

function t025Id(n: number): string {
  return `11111111-1111-4111-8111-111111111${String(400 + n).padStart(3, "0")}`;
}

function t028Id(n: number): string {
  return `11111111-1111-4111-8111-111111111${String(500 + n).padStart(3, "0")}`;
}

function mtfFrame(tf: TimeframeAnalysis["timeframe"], trend: TimeframeTrend): TimeframeAnalysis {
  const ok = trend !== "unavailable";
  return {
    timeframe: tf,
    trend,
    structure: trend === "bullish" ? "uptrend" : trend === "bearish" ? "downtrend" : trend === "neutral" ? "mixed" : "unavailable",
    lastClose: ok ? 156.5 : null,
    sma20: ok ? 156.3 : null,
    sma75: ok ? 156.1 : null,
    sma200: ok ? 155.8 : null,
    rsi14: ok ? 55 : null,
    recentHigh: ok ? 157 : null,
    recentLow: ok ? 156 : null,
    dataPoints: ok ? 240 : 0,
    sufficientData: ok,
  };
}

function e2eMtf(args: { alignment: TimeframeAlignment; bias: HigherTimeframeBias; trends?: TimeframeTrend[] }): MultiTimeframeAnalysis {
  const trends = args.trends ?? mtfTimeframes.map(tf => {
    if (args.alignment === "aligned_bullish") return "bullish" as const;
    if (args.alignment === "aligned_bearish") return "bearish" as const;
    if (args.alignment === "insufficient") {
      if (args.bias === "unavailable") return "unavailable" as const;
      return tf === "15m" ? "unavailable" as const : "bullish" as const;
    }
    if (args.bias === "neutral") return (tf === "1day" || tf === "1h" ? "bullish" : "bearish") as TimeframeTrend;
    return (tf === "1day" || tf === "4h" ? "bullish" : "bearish") as TimeframeTrend;
  });
  const timeframes = mtfTimeframes.map((tf, index) => mtfFrame(tf, trends[index] ?? "unavailable"));
  return {
    pair: "USD/JPY",
    analyzedAt: new Date().toISOString(),
    timeframes,
    higherTimeframeBias: args.bias,
    alignment: args.alignment,
    availableTimeframes: timeframes.filter(item => item.trend !== "unavailable").length,
    totalTimeframes: 4,
    conflicts: [],
  };
}

function mtfTrade(args: {
  id: string;
  openedAt: string;
  closedAt: string;
  side: "long" | "short";
  exitPrice: number;
  notes: string;
  mtf: MultiTimeframeAnalysis;
  direction?: TradeSignal;
  action?: "BUY" | "SELL" | "WAIT";
  snapshot?: boolean;
}): Trade {
  return closedTrade({
    id: args.id,
    openedAt: args.openedAt,
    closedAt: args.closedAt,
    side: args.side,
    entryPrice: 156.5,
    exitPrice: args.exitPrice,
    notes: args.notes,
    snapshot: args.snapshot === false ? null : richSnapshot({
      analyzedAt: args.openedAt,
      capturedAt: args.openedAt,
      expiresAt: args.openedAt,
      directionSignal: args.direction ?? "buy",
      action: args.action ?? "WAIT",
      signal: args.direction === "sell" ? "sell" : args.direction === "buy" ? "buy" : "wait",
      multiTimeframeAnalysis: args.mtf,
    }),
  });
}

/** Task028: saved MTF groups + legacy. Dates span 5d / 45d / 120d. */
export function mtfPerformanceTrades(now = Date.now()): Trade[] {
  const recent = daysAgo(5, now);
  const month = daysAgo(45, now);
  const old = daysAgo(120, now);
  const bullish = e2eMtf({ alignment: "aligned_bullish", bias: "bullish" });
  const bearish = e2eMtf({ alignment: "aligned_bearish", bias: "bearish" });
  const mixed = e2eMtf({ alignment: "mixed", bias: "bullish" });
  const partial = e2eMtf({ alignment: "insufficient", bias: "bullish" });
  const allUnavailable = e2eMtf({
    alignment: "insufficient",
    bias: "unavailable",
    trends: ["unavailable", "unavailable", "unavailable", "unavailable"],
  });
  const neutral = e2eMtf({ alignment: "mixed", bias: "neutral" });

  const recentAligned = [1, 2, 3, 4, 5].map(n => mtfTrade({
    id: t028Id(n), openedAt: recent, closedAt: recent, side: "long", exitPrice: 157.0,
    notes: "t028-aligned-bullish", mtf: bullish, direction: "buy", action: "WAIT",
  }));
  const recentContrary = [6, 7, 8, 9, 10].map(n => mtfTrade({
    id: t028Id(n), openedAt: recent, closedAt: recent, side: "long", exitPrice: 156.0,
    notes: "t028-contrary", mtf: bearish, direction: "buy", action: "BUY",
  }));
  const recentMixed = [11, 12, 13, 14, 15].map(n => mtfTrade({
    id: t028Id(n), openedAt: recent, closedAt: recent, side: "long", exitPrice: 157.0,
    notes: "t028-mixed", mtf: mixed, direction: "buy",
  }));
  const recentPartial = [16, 17, 18, 19, 20].map(n => mtfTrade({
    id: t028Id(n), openedAt: recent, closedAt: recent, side: "long", exitPrice: 156.0,
    notes: "t028-insufficient", mtf: partial, direction: "buy",
  }));
  const recentUnavailable = [21, 22, 23, 24, 25].map(n => mtfTrade({
    id: t028Id(n), openedAt: recent, closedAt: recent, side: "long", exitPrice: 157.0,
    notes: "t028-unavailable", mtf: allUnavailable, direction: "buy",
  }));
  const recentLegacy = [26, 27, 28, 29, 30].map(n => mtfTrade({
    id: t028Id(n), openedAt: recent, closedAt: recent, side: "short", exitPrice: 156.0,
    notes: "t028-legacy", mtf: bullish, snapshot: false,
  }));
  const recentNeutral = [31, 32].map(n => mtfTrade({
    id: t028Id(n), openedAt: recent, closedAt: recent, side: "long", exitPrice: 157.0,
    notes: "t028-htf-neutral", mtf: neutral, direction: "buy",
  }));
  const monthAligned = [33, 34, 35, 36, 37].map(n => mtfTrade({
    id: t028Id(n), openedAt: month, closedAt: month, side: "long", exitPrice: 157.0,
    notes: "t028-aligned-90d", mtf: bullish, direction: "buy", action: "WAIT",
  }));
  const oldBearish = [38, 39, 40].map(n => mtfTrade({
    id: t028Id(n), openedAt: old, closedAt: old, side: "long", exitPrice: 156.0,
    notes: "t028-bearish-old", mtf: bearish, direction: "sell",
  }));
  const openTrade = {
    ...mtfTrade({
      id: t028Id(41), openedAt: recent, closedAt: recent, side: "long", exitPrice: 157.0,
      notes: "t028-open", mtf: bullish, direction: "buy",
    }),
    status: "open" as const,
    exitPrice: null,
    closedAt: null,
    realizedPnl: null,
  };

  return [
    ...recentAligned,
    ...recentContrary,
    ...recentMixed,
    ...recentPartial,
    ...recentUnavailable,
    ...recentLegacy,
    ...recentNeutral,
    ...monthAligned,
    ...oldBearish,
    openTrade,
  ];
}

function t030Id(n: number): string {
  return `11111111-1111-4111-8111-111111111${String(800 + n).padStart(3, "0")}`;
}

function t032Id(n: number): string {
  return `11111111-1111-4111-8111-111111111${String(900 + n).padStart(3, "0")}`;
}

function e2eRegime(kind: "trending" | "range" | "transition" | "unavailable", volatility: "high" | "normal" | "low" | "unavailable" = "normal") {
  return {
    version: 1 as const,
    pair: "USD/JPY" as const,
    timeframe: "1h" as const,
    analyzedAt: "2026-09-15T03:15:00.000Z",
    regime: kind,
    trendDirection: kind === "trending" ? "bullish" as const : "neutral" as const,
    volatility,
    evidence: {
      close: 156.5, sma20: 156.3, sma75: 156.0, sma200: 155.5, rsi14: 55,
      atr14: 0.2, atrPercent: 0.13, atrRatio: 1, atrBaseline: 0.2,
      smaSpreadPercent: 0.2, rangePosition: 0.5, recentHigh: 157, recentLow: 155, dataPoints: 240,
    },
    reasons: ["e2e"],
  };
}

/** Task032: Performance Intelligence coverage of R / Regime / MTF / PreTrade / legacy. */
export function performanceIntelligenceTrades(now = Date.now()): Trade[] {
  const recent = daysAgo(5, now);
  const month = daysAgo(45, now);
  const old = daysAgo(120, now);
  const bullish = e2eMtf({ alignment: "aligned_bullish", bias: "bullish" });
  const mixed = e2eMtf({ alignment: "mixed", bias: "bullish" });
  const context = preTradeSnapshotContext({ action: "WAIT", direction: "BUY" }, recent);

  const withRegimeR = [1, 2, 3, 4, 5, 6].map(n => withExitPlan(closedTrade({
    id: t032Id(n),
    openedAt: recent,
    closedAt: recent,
    side: "long",
    entryPrice: 155.2,
    exitPrice: n <= 3 ? 155.8 : 154.9,
    notes: "t032-regime-r",
    snapshot: richSnapshot({
      analyzedAt: recent,
      capturedAt: recent,
      expiresAt: recent,
      action: n % 2 === 0 ? "BUY" : "WAIT",
      directionSignal: "buy",
      multiTimeframeAnalysis: n <= 3 ? bullish : mixed,
      marketRegimeAnalysis: e2eRegime(n <= 3 ? "trending" : "range", n <= 2 ? "high" : "normal"),
      preTradeContext: context,
    }),
  }), 154.9, 155.8));

  const legacyMissing = [7, 8].map(n => closedTrade({
    id: t032Id(n),
    openedAt: recent,
    closedAt: recent,
    side: "long",
    entryPrice: 155.2,
    exitPrice: 155.5,
    notes: "t032-legacy-missing",
    snapshot: null,
  }));

  const regimeUnavailable = withExitPlan(closedTrade({
    id: t032Id(9),
    openedAt: recent,
    closedAt: recent,
    side: "long",
    entryPrice: 155.2,
    exitPrice: 155.5,
    notes: "t032-regime-unavailable",
    snapshot: richSnapshot({
      analyzedAt: recent,
      capturedAt: recent,
      expiresAt: recent,
      marketRegimeAnalysis: e2eRegime("unavailable", "unavailable"),
      multiTimeframeAnalysis: bullish,
      preTradeContext: context,
    }),
  }), 154.9, 155.8);

  const monthTrade = withExitPlan(closedTrade({
    id: t032Id(10),
    openedAt: month,
    closedAt: month,
    side: "long",
    entryPrice: 155.2,
    exitPrice: 155.8,
    notes: "t032-month",
    snapshot: richSnapshot({
      analyzedAt: month,
      capturedAt: month,
      expiresAt: month,
      marketRegimeAnalysis: e2eRegime("transition", "low"),
      multiTimeframeAnalysis: mixed,
      preTradeContext: preTradeSnapshotContext({ action: "SELL" }, month),
    }),
  }), 154.9, 155.8);

  const oldTrade = withExitPlan(closedTrade({
    id: t032Id(11),
    openedAt: old,
    closedAt: old,
    side: "long",
    entryPrice: 155.2,
    exitPrice: 155.5,
    notes: "t032-old",
    snapshot: richSnapshot({
      analyzedAt: old,
      capturedAt: old,
      expiresAt: old,
      marketRegimeAnalysis: e2eRegime("trending", "normal"),
      multiTimeframeAnalysis: bullish,
    }),
  }), 154.9, 155.8);

  const openTrade = {
    ...closedTrade({
      id: t032Id(12),
      openedAt: recent,
      closedAt: recent,
      side: "long",
      entryPrice: 155.2,
      exitPrice: 155.5,
      notes: "t032-open",
      snapshot: richSnapshot({
        analyzedAt: recent,
        capturedAt: recent,
        expiresAt: recent,
        marketRegimeAnalysis: e2eRegime("trending"),
        multiTimeframeAnalysis: bullish,
      }),
    }),
    status: "open" as const,
    exitPrice: null,
    closedAt: null,
    realizedPnl: null,
  };

  return [...withRegimeR, ...legacyMissing, regimeUnavailable, monthTrade, oldTrade, openTrade];
}

/** Task030: AI + PreTrade + MTF without Regime, plus malformed Regime isolation. */
export function entryContextFixtureTrades(now = Date.now()): Trade[] {
  const at = daysAgo(5, now);
  const context = preTradeSnapshotContext({ action: "WAIT", direction: "BUY" }, at);
  const mtf = e2eMtf({ alignment: "aligned_bullish", bias: "bullish" });
  const baseSnap = {
    analyzedAt: at,
    capturedAt: at,
    expiresAt: at,
    directionSignal: "buy" as const,
    action: "WAIT" as const,
    signal: "wait" as const,
    preTradeContext: context,
    multiTimeframeAnalysis: mtf,
  };
  return [
    closedTrade({
      id: t030Id(1),
      openedAt: at,
      closedAt: at,
      side: "long",
      entryPrice: 156.5,
      exitPrice: 157.5,
      notes: "t030-legacy",
      snapshot: richSnapshot(baseSnap),
    }),
    closedTrade({
      id: t030Id(2),
      openedAt: at,
      closedAt: at,
      side: "long",
      entryPrice: 156.5,
      exitPrice: 155.5,
      notes: "t030-malformed",
      snapshot: richSnapshot({
        ...baseSnap,
        marketRegimeAnalysis: { version: 1, pair: "USD/JPY", candles: [{ time: at, open: 1, high: 1, low: 1, close: 1 }] } as never,
      }),
    }),
  ];
}

export function settingsRow(now = Date.now()) {
  const at = new Date(now).toISOString();
  return {
    user_id: E2E_USER_ID,
    current_capital: 50_000,
    target_capital: 100_000,
    risk_percent: 2,
    trade_unit: 1000,
    created_at: at,
    updated_at: at,
    version: 1,
  };
}

export function tradeRows(trades: Trade[]) {
  return trades.map(trade => ({
    id: trade.id,
    user_id: E2E_USER_ID,
    pair: trade.pair,
    side: trade.side,
    status: trade.status,
    quantity: trade.quantity,
    entry_price: trade.entryPrice,
    exit_price: trade.exitPrice,
    opened_at: trade.openedAt,
    closed_at: trade.closedAt,
    stop_loss: trade.stopLoss,
    take_profit: trade.takeProfit,
    realized_pnl: trade.realizedPnl,
    notes: trade.notes,
    analysis_snapshot: trade.analysisSnapshot,
    exit_plan: trade.exitPlan ?? null,
    market_context_snapshot: trade.marketContextSnapshot ?? null,
    market_context_revisions: trade.marketContextRevisions ?? null,
    local_trade_id: null,
    created_at: trade.createdAt,
    updated_at: trade.updatedAt,
    version: 1,
  }));
}
