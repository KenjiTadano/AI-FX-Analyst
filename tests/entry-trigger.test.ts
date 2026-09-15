import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildInput } from "../lib/ai/input";
import { finalizeAnalysis } from "../lib/ai/engine";
import {
  ENTRY_TRIGGER_SOURCE_MAX,
  evaluateStructuredEntryTrigger,
  sanitizeStructuredEntryTrigger,
  triggerExpression,
  type StructuredEntryTrigger,
} from "../lib/ai/entry-trigger";
import type { AIAnalysis, TradeScenario, TradeSignal } from "../lib/ai/types";
import type { DataResource, EconomicEvent } from "../lib/fundamental/types";
import type { Candle, Timeframe } from "../lib/market/types";
import type { RiskSettings } from "../lib/risk/types";
import type { Trade } from "../lib/trades/types";
import { captureTradeAiSnapshot } from "../lib/trades/snapshot";
import { RISK_LIMIT_MESSAGE, buildDailyTradingPlan } from "../lib/trading-plan/daily-plan";
import { WAIT_ACTION_MESSAGE, buildEntryReadiness } from "../lib/trading-plan/entry-readiness";

const NOW = Date.parse("2026-09-15T01:00:00.000Z");
const settings: RiskSettings = { balance: 50_000, target: 100_000, riskPercent: 2, tradeUnit: 1000 };

function trigger(partial: Partial<StructuredEntryTrigger> = {}): StructuredEntryTrigger {
  return {
    version: 1,
    type: "price_below",
    pair: "USD/JPY",
    price: 156.2,
    timeframe: null,
    sourceCondition: "現在価格が156.20を下回った場合",
    ...partial,
  };
}

function candle(close: number, start = NOW - 15 * 60_000): Candle {
  return { time: new Date(start).toISOString(), open: close, high: close + 0.05, low: close - 0.05, close };
}

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
    entryTrigger: extra.entryTrigger !== undefined ? extra.entryTrigger : null,
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
    pair: "USD/JPY", side: "short", status: "closed", quantity: 1000, entryPrice: 156.5, exitPrice: 156.8,
    openedAt: new Date(NOW).toISOString(), closedAt: new Date(NOW).toISOString(), stopLoss: null, takeProfit: null,
    notes: "T020", realizedPnl: -800, analysisSnapshot: null, createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString(),
    ...partial,
  };
}

function calendar(events: EconomicEvent[]): DataResource<EconomicEvent[]> {
  return { data: events, status: events.length ? "ok" : "empty", error: null, warnings: [], fetchedAt: new Date(NOW).toISOString(), provider: "TEST" };
}

function event(importance: "high" | "medium" | "low" = "high"): EconomicEvent {
  return {
    id: "cpi", name: "米CPI", country: "US", currency: "USD", scheduledAt: new Date(NOW + 3_600_000).toISOString(),
    rawScheduledAt: null, timezone: "UTC", previous: 3, forecast: 3.1, actual: null, unit: "%", status: "upcoming",
    source: "TEST", url: null, isKeyIndicator: true, affectedCurrencies: ["USD"], importance, importanceBasis: "provider",
    impactDirection: null, reason: "TEST",
  };
}

function readiness(extra: Parameters<typeof buildDailyTradingPlan>[0] extends infer T ? Partial<T> : never = {}, currentRate: number | null = 156.42, candles?: Partial<Record<Timeframe, { candles: Candle[]; lastClosedAt: string | null }>>) {
  const input = {
    pair: "USD/JPY",
    analysis: analysis("wait", { directionSignal: "sell", action: "WAIT", scenario: scenario(), entryTrigger: trigger() }),
    trades: [] as Trade[],
    riskSettings: settings,
    currentRate,
    now: NOW,
    ...extra,
  };
  const dailyPlan = buildDailyTradingPlan(input);
  return buildEntryReadiness({
    pair: input.pair,
    analysis: input.analysis,
    dailyPlan,
    riskSettings: input.riskSettings,
    currentRate,
    candlesByTimeframe: candles,
    now: NOW,
  });
}

test("A: valid price_above", () => {
  const value = trigger({ type: "price_above", sourceCondition: "現在価格が156.20を上回った場合" });
  assert.deepEqual(sanitizeStructuredEntryTrigger(value, "USD/JPY"), value);
});

test("B: valid price_below", () => {
  assert.equal(sanitizeStructuredEntryTrigger(trigger(), "USD/JPY")?.type, "price_below");
});

test("C: valid candle_close_above", () => {
  const value = trigger({ type: "candle_close_above", timeframe: "15min" });
  assert.deepEqual(sanitizeStructuredEntryTrigger(value, "USD/JPY"), value);
});

test("D: valid candle_close_below", () => {
  const value = trigger({ type: "candle_close_below", timeframe: "1h" });
  assert.equal(sanitizeStructuredEntryTrigger(value, "USD/JPY")?.type, "candle_close_below");
});

test("E: unsupported type reject", () => {
  assert.equal(sanitizeStructuredEntryTrigger({ ...trigger(), type: "rsi_cross" }, "USD/JPY"), null);
});

test("F: invalid pair reject", () => {
  assert.equal(sanitizeStructuredEntryTrigger({ ...trigger(), pair: "AUD/JPY" }, "USD/JPY"), null);
});

test("G: pair mismatch reject", () => {
  assert.equal(sanitizeStructuredEntryTrigger(trigger(), "EUR/JPY"), null);
});

test("H: price NaN reject", () => {
  assert.equal(sanitizeStructuredEntryTrigger({ ...trigger(), price: Number.NaN }, "USD/JPY"), null);
});

test("I: price <=0 reject", () => {
  assert.equal(sanitizeStructuredEntryTrigger({ ...trigger(), price: 0 }, "USD/JPY"), null);
  assert.equal(sanitizeStructuredEntryTrigger({ ...trigger(), price: -1 }, "USD/JPY"), null);
});

test("J: unrealistic > guard reject", () => {
  assert.equal(sanitizeStructuredEntryTrigger({ ...trigger(), price: 1000 }, "USD/JPY"), null);
  assert.equal(sanitizeStructuredEntryTrigger({ ...trigger(), price: 999.9 }, "USD/JPY")?.price, 999.9);
});

test("K: invalid timeframe", () => {
  assert.equal(sanitizeStructuredEntryTrigger({ ...trigger(), type: "candle_close_below", timeframe: "3h" }, "USD/JPY"), null);
  assert.equal(sanitizeStructuredEntryTrigger({ ...trigger(), type: "candle_close_below", timeframe: null }, "USD/JPY"), null);
});

test("L: sourceCondition cap", () => {
  const capped = sanitizeStructuredEntryTrigger({ ...trigger(), sourceCondition: "あ".repeat(ENTRY_TRIGGER_SOURCE_MAX + 20) }, "USD/JPY");
  assert.equal(capped?.sourceCondition?.length, ENTRY_TRIGGER_SOURCE_MAX);
});

test("M: price_above met", () => {
  const result = evaluateStructuredEntryTrigger({ trigger: trigger({ type: "price_above" }), pair: "USD/JPY", currentRate: 156.21, now: NOW });
  assert.equal(result.status, "met");
  assert.equal(result.observedValue, 156.21);
  assert.equal(result.observedLabel, "現在価格");
});

test("N: price_above equal not_met", () => {
  const result = evaluateStructuredEntryTrigger({ trigger: trigger({ type: "price_above" }), pair: "USD/JPY", currentRate: 156.2, now: NOW });
  assert.equal(result.status, "not_met");
});

test("O: price_above below not_met", () => {
  const result = evaluateStructuredEntryTrigger({ trigger: trigger({ type: "price_above" }), pair: "USD/JPY", currentRate: 156.1, now: NOW });
  assert.equal(result.status, "not_met");
});

test("P: price_below met", () => {
  const result = evaluateStructuredEntryTrigger({ trigger: trigger(), pair: "USD/JPY", currentRate: 156.1, now: NOW });
  assert.equal(result.status, "met");
});

test("Q: price_below equal not_met", () => {
  const result = evaluateStructuredEntryTrigger({ trigger: trigger(), pair: "USD/JPY", currentRate: 156.2, now: NOW });
  assert.equal(result.status, "not_met");
});

test("R: candle above met", () => {
  const closed = candle(156.3, NOW - 15 * 60_000);
  const result = evaluateStructuredEntryTrigger({
    trigger: trigger({ type: "candle_close_above", timeframe: "15min" }),
    pair: "USD/JPY",
    candlesByTimeframe: { "15m": { candles: [closed], lastClosedAt: closed.time } },
    now: NOW,
  });
  assert.equal(result.status, "met");
  assert.equal(result.observedValue, 156.3);
  assert.equal(result.observedLabel, "確定足終値");
});

test("S: candle below met", () => {
  const closed = candle(156.1, NOW - 15 * 60_000);
  const result = evaluateStructuredEntryTrigger({
    trigger: trigger({ type: "candle_close_below", timeframe: "15min" }),
    pair: "USD/JPY",
    candlesByTimeframe: { "15m": { candles: [closed], lastClosedAt: closed.time } },
    now: NOW,
  });
  assert.equal(result.status, "met");
});

test("T: forming candle ignored", () => {
  const forming = candle(156.1, NOW - 60_000);
  const result = evaluateStructuredEntryTrigger({
    trigger: trigger({ type: "candle_close_below", timeframe: "15min" }),
    pair: "USD/JPY",
    candlesByTimeframe: { "15m": { candles: [forming], lastClosedAt: forming.time } },
    now: NOW,
  });
  assert.equal(result.status, "unavailable");
});

test("U: timeframe mismatch unavailable", () => {
  const closed = candle(156.1, NOW - 15 * 60_000);
  const result = evaluateStructuredEntryTrigger({
    trigger: trigger({ type: "candle_close_below", timeframe: "5min" }),
    pair: "USD/JPY",
    candlesByTimeframe: { "15m": { candles: [closed], lastClosedAt: closed.time } },
    now: NOW,
  });
  assert.equal(result.status, "unavailable");
  assert.notEqual(result.status, "not_met");
});

test("V: no rate unavailable", () => {
  const result = evaluateStructuredEntryTrigger({ trigger: trigger(), pair: "USD/JPY", currentRate: null, now: NOW });
  assert.equal(result.status, "unavailable");
});

test("stale live rate does not fall back to analysis price", () => {
  const result = readiness({}, null);
  assert.equal(result.triggerEvaluation?.status, "unavailable");
});

test("W: no candle unavailable", () => {
  const result = evaluateStructuredEntryTrigger({
    trigger: trigger({ type: "candle_close_below", timeframe: "15min" }),
    pair: "USD/JPY",
    candlesByTimeframe: { "15m": { candles: [], lastClosedAt: null } },
    now: NOW,
  });
  assert.equal(result.status, "unavailable");
});

test("X: trigger null compatibility", () => {
  const result = readiness({ analysis: analysis("wait", { directionSignal: "sell", action: "WAIT", scenario: scenario(), entryTrigger: null }) });
  assert.equal(result.entryTrigger, null);
  assert.equal(result.triggerEvaluation, null);
  assert.equal(result.entryCondition.evaluated, false);
  assert.match(result.entryCondition.note, /自動判定はしていません/);
});

test("Y: Action WAIT unchanged when trigger met", () => {
  const result = readiness({ analysis: analysis("wait", { directionSignal: "sell", action: "WAIT", scenario: scenario(), entryTrigger: trigger() }) }, 156.1);
  assert.equal(result.triggerEvaluation?.status, "met");
  assert.equal(result.action, "WAIT");
  assert.equal(result.actionMessage, WAIT_ACTION_MESSAGE);
  assert.equal(result.confirmedCount, 5);
});

test("Z: deterministic", () => {
  const input = { trigger: trigger(), pair: "USD/JPY", currentRate: 156.1, now: NOW };
  assert.deepEqual(evaluateStructuredEntryTrigger(input), evaluateStructuredEntryTrigger(input));
});

test("AA: stale overrides trigger met", () => {
  const result = readiness({
    analysis: analysis("wait", {
      directionSignal: "sell", action: "WAIT", scenario: scenario(), entryTrigger: trigger(),
      analyzedAt: new Date(NOW - 10 * 60_000).toISOString(),
    }),
  }, 156.1);
  assert.equal(result.triggerEvaluation?.status, "met");
  assert.equal(result.state, "warning");
  assert.equal(result.stale, true);
  assert.match(result.triggerStaleNote ?? "", /再分析/);
});

test("AB: DLL overrides trigger met", () => {
  const result = readiness({
    dailyLossLimitPercent: 1,
    trades: [trade({ id: "loss", realizedPnl: -800 })],
  }, 156.1);
  assert.equal(result.triggerEvaluation?.status, "met");
  assert.equal(result.warnings[0]?.code, "daily_loss_limit");
  assert.equal(result.stateMessage, RISK_LIMIT_MESSAGE);
  assert.equal(result.action, "WAIT");
});

test("AC: Event high overrides trigger met", () => {
  const result = readiness({ calendar: calendar([event("high")]) }, 156.1);
  assert.equal(result.triggerEvaluation?.status, "met");
  assert.equal(result.checks.eventRisk.status, "warning");
  assert.equal(result.state, "warning");
  assert.equal(result.action, "WAIT");
});

test("AD: pair switch no residual", () => {
  const result = readiness({
    pair: "EUR/JPY",
    analysis: analysis("wait", { pair: "USD/JPY", directionSignal: "sell", action: "WAIT", scenario: scenario(), entryTrigger: trigger() }),
  }, 156.1);
  assert.equal(result.pair, "EUR/JPY");
  assert.equal(result.entryTrigger, null);
  assert.equal(result.triggerEvaluation, null);
  assert.doesNotMatch(JSON.stringify(result), /156\.2/);
});

test("AE: invalid trigger does not kill analysis", () => {
  const result = finalizeAnalysis(
    buildInput("USD/JPY", null, null, NOW),
    null,
    "TEST",
    "not_configured",
    NOW,
  );
  const withBad = { ...result, entryTrigger: { version: 1 as const, type: "macd_cross" as never, pair: "USD/JPY" as const, price: 156.2, timeframe: null, sourceCondition: null } } as AIAnalysis;
  const ready = buildEntryReadiness({
    pair: "USD/JPY",
    analysis: withBad,
    dailyPlan: buildDailyTradingPlan({ pair: "USD/JPY", analysis: withBad, trades: [], riskSettings: settings, now: NOW }),
    riskSettings: settings,
    now: NOW,
  });
  assert.equal(ready.triggerEvaluation?.status, "invalid");
  assert.equal(ready.entryTrigger, null);
  assert.ok(ready.action === "WAIT" || ready.action === null);
});

test("AF: no natural-language parsing", () => {
  const source = readFileSync(join(process.cwd(), "lib/ai/entry-trigger.ts"), "utf8");
  assert.doesNotMatch(source, /下抜け|condition\.match|parseFloat\(condition/);
  const result = evaluateStructuredEntryTrigger({
    trigger: trigger({ sourceCondition: "156.20を下抜けた場合" }),
    pair: "USD/JPY",
    currentRate: 156.1,
    now: NOW,
  });
  assert.equal(result.status, "met");
  assert.equal(result.expression, "PRICE < 156.2");
});

test("AG: no external fetch", () => {
  const source = readFileSync(join(process.cwd(), "lib/ai/entry-trigger.ts"), "utf8");
  assert.doesNotMatch(source, /openai|twelvedata|finnhub|stlouisfed|eodhd|fetch\(/i);
  const original = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error("unexpected fetch"); }) as typeof fetch;
  try {
    assert.equal(evaluateStructuredEntryTrigger({ trigger: trigger(), pair: "USD/JPY", currentRate: 156.1, now: NOW }).status, "met");
  } finally {
    globalThis.fetch = original;
  }
});

test("AH: no probability/win-rate fields", () => {
  const result = evaluateStructuredEntryTrigger({ trigger: trigger(), pair: "USD/JPY", currentRate: 156.1, now: NOW });
  assert.equal("percentage" in result, false);
  assert.equal("probability" in result, false);
  assert.equal("winRate" in result, false);
  assert.doesNotMatch(JSON.stringify(result), /Entry OK|今すぐ売る|勝率/);
});

test("price trigger strips unused timeframe", () => {
  const value = sanitizeStructuredEntryTrigger({ ...trigger(), timeframe: "15min" }, "USD/JPY");
  assert.equal(value?.timeframe, null);
});

test("human label is not symbols only", () => {
  assert.match(triggerExpression(trigger({ type: "candle_close_below", timeframe: "15min" })), /15min CLOSE </);
});

test("snapshot stores sanitized trigger without evaluation", () => {
  const snap = captureTradeAiSnapshot({
    analysis: analysis("wait", { directionSignal: "sell", action: "WAIT", entryTrigger: trigger(), ai: { status: "available", model: "TEST", code: null, message: null } }),
    pair: "USD/JPY",
    now: new Date(NOW).toISOString(),
  });
  assert.deepEqual(snap?.entryTrigger, trigger());
});
