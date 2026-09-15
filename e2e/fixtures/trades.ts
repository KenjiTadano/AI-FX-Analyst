import type { TradeAiAnalysisSnapshot, Trade } from "../../lib/trades/types";
import { pnl } from "../../lib/trades/calculations";
import { E2E_USER_ID, TRADE_IDS, daysAgo, localDayOffset } from "./ids";
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
