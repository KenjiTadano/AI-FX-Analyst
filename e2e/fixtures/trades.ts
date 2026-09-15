import type { PreTradeContextSnapshot, TradeAiAnalysisSnapshot, Trade } from "../../lib/trades/types";
import { pnl } from "../../lib/trades/calculations";
import { E2E_USER_ID, TRADE_IDS, daysAgo, iso, localDayOffset } from "./ids";
import type { TradeSignal } from "../../lib/ai/types";

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
    notes: "e2e",
    realizedPnl,
    analysisSnapshot: args.snapshot ?? null,
    createdAt: args.openedAt,
    updatedAt: args.closedAt,
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
    closedTrade({
      id: TRADE_IDS.yesterdayClosed,
      openedAt: yesterday,
      closedAt: yesterday,
      side: "short",
      entryPrice: 156.5,
      exitPrice: 156.1,
    }),
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
    closedTrade({
      id: TRADE_IDS.monthClosed,
      openedAt: month,
      closedAt: month,
      side: "long",
      entryPrice: 156.2,
      exitPrice: 156.5,
    }),
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
    local_trade_id: null,
    created_at: trade.createdAt,
    updated_at: trade.updatedAt,
    version: 1,
  }));
}
