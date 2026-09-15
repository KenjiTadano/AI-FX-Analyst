import test from "node:test";
import assert from "node:assert/strict";
import { buildInput } from "../lib/ai/input";
import { finalizeAnalysis } from "../lib/ai/engine";
import type { AIAnalysis, TradeScenario, TradeSignal } from "../lib/ai/types";
import type { DataResource, EconomicEvent } from "../lib/fundamental/types";
import type { RiskSettings } from "../lib/risk/types";
import type { Trade } from "../lib/trades/types";
import {
  ANALYSIS_STALE_MESSAGE,
  CONFIDENCE_DISCLAIMER,
  CONDITION_SOURCE_LABEL,
  NO_AUTO_TRADING_COPY,
  REVIEW_BUY_MESSAGE,
  REVIEW_SELL_MESSAGE,
  RISK_LIMIT_MESSAGE,
  UNAVAILABLE_MESSAGE,
  WAIT_MESSAGE,
  buildDailyTradingPlan,
  directionToken,
  parseDailyLossLimitPercent,
  resolveAction,
} from "../lib/trading-plan/daily-plan";
import { isSameLocalDay, localDayKey } from "../lib/trading-plan/today";

const NOW = Date.parse("2026-09-15T01:00:00.000Z");
const settings: RiskSettings = { balance: 50_000, target: 100_000, riskPercent: 2, tradeUnit: 1000 };

function analysis(signal: TradeSignal = "wait", extra: Partial<AIAnalysis> = {}): AIAnalysis {
  const base = finalizeAnalysis(buildInput("USD/JPY", null, null, NOW), null, "TEST", "not_configured", NOW);
  const action = extra.action ?? (signal === "wait" ? "WAIT" : signal.includes("buy") ? "BUY" : "SELL");
  return {
    ...base,
    ...extra,
    pair: extra.pair ?? "USD/JPY",
    signal,
    directionSignal: extra.directionSignal ?? signal,
    action,
    ai: extra.ai ?? { status: "available", model: "TEST", code: null, message: null },
    scenario: extra.scenario ?? null,
    economicRisk: extra.economicRisk ?? { active: false, known: true, reasons: [], nextHigh: null },
    chartEvidence: extra.chartEvidence !== undefined ? extra.chartEvidence : null,
    confidence: extra.confidence ?? 68,
    dataQuality: extra.dataQuality ?? { ...base.dataQuality, score: 82 },
    currentRate: extra.currentRate ?? 156.42,
    analyzedAt: extra.analyzedAt ?? new Date(NOW).toISOString(),
    expiresAt: extra.expiresAt ?? new Date(NOW + 300_000).toISOString(),
  };
}

function scenario(partial: Partial<TradeScenario> = {}): TradeScenario {
  return {
    direction: "short",
    entryZone: { min: 156.1, max: 156.2 },
    stopLoss: 156.8,
    takeProfit1: 155.4,
    takeProfit2: 155.0,
    riskReward: 1.6,
    condition: "156.20を下抜けた場合",
    invalidation: "156.80を超えた場合は無効",
    sourceTimeframe: "1h",
    ...partial,
  };
}

function trade(partial: Partial<Trade> & Pick<Trade, "id">): Trade {
  return {
    pair: "USD/JPY",
    side: "short",
    status: "closed",
    quantity: 1000,
    entryPrice: 156.5,
    exitPrice: 156.8,
    openedAt: new Date(NOW).toISOString(),
    closedAt: new Date(NOW).toISOString(),
    stopLoss: null,
    takeProfit: null,
    notes: "T017",
    realizedPnl: -320,
    analysisSnapshot: null,
    createdAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
    ...partial,
  };
}

function calendar(events: EconomicEvent[], fetchedAt = new Date(NOW).toISOString()): DataResource<EconomicEvent[]> {
  return { data: events, status: events.length ? "ok" : "empty", error: null, warnings: [], fetchedAt, provider: "TEST" };
}

function event(change: Partial<EconomicEvent> = {}): EconomicEvent {
  return {
    id: "cpi",
    name: "米CPI",
    country: "US",
    currency: "USD",
    scheduledAt: new Date(NOW + 3_600_000).toISOString(),
    rawScheduledAt: null,
    timezone: "UTC",
    previous: 3.0,
    forecast: 3.1,
    actual: null,
    unit: "%",
    status: "upcoming",
    source: "TEST",
    url: null,
    isKeyIndicator: true,
    affectedCurrencies: ["USD"],
    importance: "high",
    importanceBasis: "provider",
    impactDirection: null,
    reason: "TEST",
    ...change,
  };
}

function plan(extra: Parameters<typeof buildDailyTradingPlan>[0] extends infer T ? Partial<T> : never = {}) {
  return buildDailyTradingPlan({
    pair: "USD/JPY",
    analysis: analysis("wait"),
    trades: [],
    riskSettings: settings,
    currentRate: 156.42,
    now: NOW,
    ...extra,
  });
}

test("A: direction SELL + action WAIT → status wait, separated", () => {
  const result = plan({ analysis: analysis("wait", { directionSignal: "sell", action: "WAIT", signal: "wait" }) });
  assert.equal(result.status, "wait");
  assert.equal(result.action, "WAIT");
  assert.equal(result.direction, "SELL");
  assert.equal(result.mainMessage, WAIT_MESSAGE);
  assert.equal(result.directionNote, "AI方向は下方向ですが、現在のActionはWAITです。");
  assert.notEqual(result.direction, result.action);
});

test("B: direction BUY + action WAIT → status wait, separated", () => {
  const result = plan({ analysis: analysis("wait", { directionSignal: "buy", action: "WAIT", signal: "wait" }) });
  assert.equal(result.status, "wait");
  assert.equal(result.action, "WAIT");
  assert.equal(result.direction, "BUY");
  assert.equal(result.directionNote, "AI方向は上方向ですが、現在のActionはWAITです。");
});

test("C: action BUY → review_buy", () => {
  const result = plan({ analysis: analysis("buy", { action: "BUY", directionSignal: "buy", scenario: scenario({ direction: "long", condition: "押し目確認" }) }) });
  assert.equal(result.status, "review_buy");
  assert.equal(result.mainMessage, REVIEW_BUY_MESSAGE);
  assert.doesNotMatch(result.mainMessage, /今すぐ買う/);
});

test("D: action SELL → review_sell", () => {
  const result = plan({ analysis: analysis("sell", { action: "SELL", directionSignal: "sell", scenario: scenario() }) });
  assert.equal(result.status, "review_sell");
  assert.equal(result.mainMessage, REVIEW_SELL_MESSAGE);
  assert.doesNotMatch(result.mainMessage, /今すぐ売る/);
});

test("E: stale → stale優先", () => {
  const result = plan({
    analysis: analysis("sell", {
      action: "SELL",
      directionSignal: "sell",
      analyzedAt: new Date(NOW - 6 * 60_000).toISOString(),
      expiresAt: new Date(NOW + 60_000).toISOString(),
    }),
  });
  assert.equal(result.stale, true);
  assert.equal(result.status, "stale");
  assert.equal(result.mainMessage, ANALYSIS_STALE_MESSAGE);
});

test("F: risk limit reached → risk_limit最優先", () => {
  const result = plan({
    analysis: analysis("buy", { action: "BUY", directionSignal: "buy" }),
    dailyLossLimitPercent: 1,
    trades: [trade({ id: "loss", realizedPnl: -800 })],
  });
  assert.equal(result.status, "risk_limit");
  assert.equal(result.mainMessage, RISK_LIMIT_MESSAGE);
  assert.equal(result.dailyLossRemaining, 0);
});

test("G: analysisなし → unavailable", () => {
  const result = plan({ analysis: null });
  assert.equal(result.status, "unavailable");
  assert.equal(result.mainMessage, UNAVAILABLE_MESSAGE);
  assert.equal(result.entryCondition, null);
  assert.equal(result.action, null);
});

test("H: pair mismatch → unavailable", () => {
  const result = plan({ pair: "EUR/JPY", analysis: analysis("sell", { pair: "USD/JPY", action: "SELL", scenario: scenario() }) });
  assert.equal(result.status, "unavailable");
  assert.equal(result.entryCondition, null);
  assert.equal(result.stopLoss, null);
  assert.equal(result.chartEvidenceUsed, false);
});

test("I: entry conditionあり → そのまま表示", () => {
  const result = plan({ analysis: analysis("sell", { action: "SELL", scenario: scenario() }) });
  assert.equal(result.entryCondition, "156.20を下抜けた場合");
  assert.equal(result.conditionSource, CONDITION_SOURCE_LABEL);
});

test("J: entry conditionなし → 捏造しない", () => {
  const result = plan({ analysis: analysis("wait", { scenario: null }) });
  assert.equal(result.entryCondition, null);
});

test("K: SL/TPなし → 捏造しない", () => {
  const result = plan({ analysis: analysis("wait", { scenario: null }) });
  assert.equal(result.stopLoss, null);
  assert.equal(result.takeProfit, null);
});

test("L: FRED actualを未来eventにしない", () => {
  const released = event({
    name: "CPI",
    actual: 3.1,
    status: "released",
    scheduledAt: new Date(NOW - 86_400_000).toISOString(),
  });
  const result = plan({
    calendar: calendar([released]),
    analysis: analysis("wait", { economicRisk: { active: false, known: true, reasons: [], nextHigh: null } }),
  });
  assert.notEqual(result.eventRisk.message.includes("本日21:30"), true);
  assert.equal(result.eventRisk.scheduledAt, null);
  assert.equal(result.eventRisk.name, null);
  assert.equal(result.eventRisk.source, "economic_calendar");
});

test("M: today OPEN trade → countに含む / realized P/Lには含まない", () => {
  const result = plan({
    trades: [trade({ id: "open", status: "open", exitPrice: null, closedAt: null, realizedPnl: null })],
  });
  assert.equal(result.todayTradeCount, 1);
  assert.equal(result.todayClosedCount, 0);
  assert.equal(result.todayRealizedPnl, 0);
});

test("N: today closed → realized P/Lへ含む", () => {
  const result = plan({ trades: [trade({ id: "closed", realizedPnl: -320 })] });
  assert.equal(result.todayClosedCount, 1);
  assert.equal(result.todayRealizedPnl, -320);
});

test("O: 昨日trade → today count除外", () => {
  const yesterday = new Date(NOW);
  yesterday.setDate(yesterday.getDate() - 1);
  const result = plan({ trades: [trade({ id: "old", openedAt: yesterday.toISOString(), closedAt: yesterday.toISOString() })] });
  assert.equal(result.todayTradeCount, 0);
  assert.equal(result.todayRealizedPnl, 0);
});

test("P: 利益の日 → dailyLossUsed=0", () => {
  const result = plan({
    dailyLossLimitPercent: 3,
    trades: [trade({ id: "win", realizedPnl: 500, status: "closed" })],
  });
  assert.equal(result.dailyLossUsed, 0);
  assert.equal(result.dailyLossRemaining, result.dailyLossLimit);
});

test("Q: 損失の日 → absolute lossをusedへ", () => {
  const result = plan({
    dailyLossLimitPercent: 3,
    trades: [trade({ id: "loss", realizedPnl: -500 })],
  });
  assert.equal(result.dailyLossUsed, 500);
  assert.equal(result.dailyLossRemaining, (result.dailyLossLimit ?? 0) - 500);
});

test("R: loss limit超過 → remaining=0", () => {
  const result = plan({
    dailyLossLimitPercent: 1,
    trades: [trade({ id: "big", realizedPnl: -2000 })],
  });
  assert.equal(result.dailyLossRemaining, 0);
  assert.equal(result.status, "risk_limit");
});

test("S: 別pair analysis → 表示しない", () => {
  const result = plan({
    pair: "GBP/JPY",
    analysis: analysis("sell", { pair: "USD/JPY", action: "SELL", scenario: scenario(), chartEvidence: { used: true, timeframe: "1h", trend: "down", qualityScore: 80 } }),
  });
  assert.equal(result.status, "unavailable");
  assert.equal(result.entryCondition, null);
  assert.equal(result.invalidationCondition, null);
  assert.equal(result.chartEvidenceUsed, false);
  assert.equal(result.confidence, null);
});

test("T: chartEvidence used badge", () => {
  const result = plan({
    analysis: analysis("wait", { chartEvidence: { used: true, timeframe: "1h", trend: "down", qualityScore: 71 } }),
  });
  assert.equal(result.chartEvidenceUsed, true);
});

test("U: confidence disclaimer", () => {
  assert.match(CONFIDENCE_DISCLAIMER, /勝率を保証する値ではありません/);
});

test("V: no auto trading copy", () => {
  assert.match(NO_AUTO_TRADING_COPY, /注文は自動送信されません/);
});

test("W: NaN/invalid risk values safe", () => {
  const result = plan({
    riskSettings: { balance: Number.NaN, target: Number.POSITIVE_INFINITY, riskPercent: -1, tradeUnit: 0 },
    dailyLossLimitPercent: Number.NaN,
  });
  assert.equal(result.riskPerTrade, null);
  assert.equal(result.dailyLossLimit, null);
  assert.equal(result.capital, null);
  assert.ok(!Number.isNaN(result.todayRealizedPnl));
});

test("X: 同じinputで同じplan", () => {
  const input = {
    pair: "USD/JPY",
    analysis: analysis("sell", { action: "WAIT", directionSignal: "sell", scenario: scenario() }),
    trades: [trade({ id: "a" })],
    riskSettings: settings,
    currentRate: 156.42,
    dailyLossLimitPercent: 3,
    now: NOW,
  };
  assert.deepEqual(buildDailyTradingPlan(input), buildDailyTradingPlan(input));
});

test("Y: 追加OpenAI/API call不要", () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error("unexpected fetch"); }) as typeof fetch;
  try {
    const result = plan({ analysis: analysis("wait") });
    assert.equal(result.status, "wait");
  } finally {
    globalThis.fetch = original;
  }
});

test("local day helper uses injectable now / local calendar", () => {
  const now = new Date(2026, 8, 15, 10, 0, 0);
  const today = new Date(2026, 8, 15, 0, 1, 0);
  const yesterday = new Date(2026, 8, 14, 23, 59, 0);
  assert.equal(localDayKey(today), localDayKey(now));
  assert.equal(isSameLocalDay(today, now), true);
  assert.equal(isSameLocalDay(yesterday, now), false);
});

test("today boundary: local day start included, previous local day excluded", () => {
  const now = new Date(2026, 8, 15, 8, 0, 0);
  const result = plan({
    now,
    trades: [
      trade({ id: "today", openedAt: new Date(2026, 8, 15, 0, 0, 1).toISOString(), realizedPnl: -10 }),
      trade({ id: "yesterday", openedAt: new Date(2026, 8, 14, 23, 59, 0).toISOString(), realizedPnl: -999 }),
    ],
  });
  assert.equal(result.todayTradeCount, 1);
  assert.equal(result.todayRealizedPnl, -10);
});

test("Today's results are all-pair scoped", () => {
  const result = plan({
    pair: "USD/JPY",
    trades: [
      trade({ id: "usd", pair: "USD/JPY", realizedPnl: -100 }),
      trade({ id: "eur", pair: "EUR/JPY", realizedPnl: -50 }),
    ],
  });
  assert.equal(result.todayScopeLabel, "全通貨ペア");
  assert.equal(result.todayTradeCount, 2);
  assert.equal(result.todayPairTradeCount, 1);
  assert.equal(result.todayRealizedPnl, -150);
});

test("invalidation missing stays unlabeled as dataなし at UI layer (null)", () => {
  const result = plan({ analysis: analysis("sell", { action: "SELL", scenario: scenario({ invalidation: "  " }) }) });
  assert.equal(result.invalidationCondition, null);
});

test("stale loses to risk_limit", () => {
  const result = plan({
    analysis: analysis("buy", {
      action: "BUY",
      analyzedAt: new Date(NOW - 10 * 60_000).toISOString(),
    }),
    dailyLossLimitPercent: 1,
    trades: [trade({ id: "hit", realizedPnl: -800 })],
  });
  assert.equal(result.status, "risk_limit");
});

test("1-trade risk is not treated as daily loss limit", () => {
  const result = plan({ dailyLossLimitPercent: null });
  assert.equal(result.riskPerTrade, 1000);
  assert.equal(result.dailyLossLimit, null);
  assert.equal(result.status, "wait");
});

test("upcoming calendar event uses existing importance only", () => {
  const result = plan({ calendar: calendar([event({ importance: "medium" })]) });
  assert.equal(result.eventRisk.level, "medium");
  assert.equal(result.eventRisk.source, "economic_calendar");
  assert.equal(result.eventRisk.name, "米CPI");
});

test("parseDailyLossLimitPercent rejects unsafe values", () => {
  assert.equal(parseDailyLossLimitPercent(""), null);
  assert.equal(parseDailyLossLimitPercent(0), null);
  assert.equal(parseDailyLossLimitPercent(11), null);
  assert.equal(parseDailyLossLimitPercent(3), 3);
});

test("resolveAction / directionToken keep WAIT vs SELL split", () => {
  const value = analysis("wait", { directionSignal: "strong_sell", action: "WAIT" });
  assert.equal(resolveAction(value), "WAIT");
  assert.equal(directionToken(value.directionSignal), "SELL");
});
