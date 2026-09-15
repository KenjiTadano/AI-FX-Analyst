import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildInput } from "../lib/ai/input";
import { finalizeAnalysis } from "../lib/ai/engine";
import type { AIAnalysis, TradeScenario, TradeSignal } from "../lib/ai/types";
import type { DataResource, EconomicEvent } from "../lib/fundamental/types";
import type { RiskSettings } from "../lib/risk/types";
import type { Trade } from "../lib/trades/types";
import { ANALYSIS_STALE_MESSAGE, RISK_LIMIT_MESSAGE, REVIEW_BUY_MESSAGE, REVIEW_SELL_MESSAGE, buildDailyTradingPlan } from "../lib/trading-plan/daily-plan";
import {
  CONDITION_NOT_EVALUATED_MESSAGE,
  CONDITION_PRESENT_LABEL,
  ENTRY_READINESS_DISCLAIMER,
  EVENT_UNAVAILABLE_MESSAGE,
  READINESS_FIXED_TOTAL,
  READINESS_UNAVAILABLE_MESSAGE,
  READY_TO_REVIEW_MESSAGE,
  RISK_INVALID_MESSAGE,
  STALE_REFRESH_MESSAGE,
  WAIT_ACTION_MESSAGE,
  WAIT_UNTIL_CONDITION_MESSAGE,
  buildEntryReadiness,
  type EntryReadiness,
} from "../lib/trading-plan/entry-readiness";

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
    notes: "T019",
    realizedPnl: -800,
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

function readiness(extra: Parameters<typeof buildDailyTradingPlan>[0] extends infer T ? Partial<T> : never = {}) {
  const input = {
    pair: "USD/JPY",
    analysis: analysis("wait", { directionSignal: "sell", action: "WAIT", scenario: scenario() }),
    trades: [] as Trade[],
    riskSettings: settings,
    currentRate: 156.42,
    now: NOW,
    ...extra,
  };
  const dailyPlan = buildDailyTradingPlan(input);
  return buildEntryReadiness({
    pair: input.pair,
    analysis: input.analysis,
    dailyPlan,
    riskSettings: input.riskSettings,
  });
}

function texts(value: unknown): string {
  return JSON.stringify(value);
}

function assertNoSignalCopy(result: EntryReadiness) {
  const blob = texts(result);
  assert.doesNotMatch(blob, /Entry OK|エントリー可能|売買OK|今すぐ買う|今すぐ売る|勝率予測|BUY\/SELL probability/);
  assert.equal("percentage" in result, false);
  assert.equal("probability" in result, false);
  assert.equal("winRate" in result, false);
  assert.equal("readinessPercent" in result, false);
}

test("A: analysis valid → confirmed", () => {
  const result = readiness();
  assert.equal(result.checks.analysis.status, "confirmed");
  assert.equal(result.checks.analysis.detail, "最新");
  assert.equal(result.checks.analysis.statusLabel, "確認済み");
});

test("B: analysis missing → unavailable", () => {
  const result = readiness({ analysis: null });
  assert.equal(result.state, "unavailable");
  assert.equal(result.checks.analysis.status, "unavailable");
  assert.equal(result.stateMessage, READINESS_UNAVAILABLE_MESSAGE);
  assert.equal(result.action, null);
});

test("C: pair mismatch → fail closed", () => {
  const result = readiness({
    pair: "EUR/JPY",
    analysis: analysis("sell", { pair: "USD/JPY", action: "WAIT", directionSignal: "sell", scenario: scenario() }),
  });
  assert.equal(result.pair, "EUR/JPY");
  assert.equal(result.state, "unavailable");
  assert.equal(result.checks.analysis.status, "unavailable");
  assert.equal(result.entryCondition.text, null);
  assert.equal(result.chartEvidenceUsed, false);
  assert.doesNotMatch(texts(result), /156\.20を下抜けた場合/);
});

test("D: stale analysis → warning + refresh copy", () => {
  const result = readiness({
    analysis: analysis("sell", {
      directionSignal: "sell",
      action: "WAIT",
      analyzedAt: new Date(NOW - 10 * 60_000).toISOString(),
    }),
  });
  assert.equal(result.stale, true);
  assert.equal(result.state, "warning");
  assert.equal(result.checks.analysis.status, "warning");
  assert.equal(result.checks.analysis.detail, STALE_REFRESH_MESSAGE);
  assert.ok(result.warnings.some(item => item.code === "stale" && item.message === ANALYSIS_STALE_MESSAGE));
});

test("E: BUY direction → confirmed", () => {
  const result = readiness({ analysis: analysis("wait", { directionSignal: "buy", action: "WAIT" }) });
  assert.equal(result.direction, "BUY");
  assert.equal(result.checks.direction.status, "confirmed");
  assert.equal(result.checks.direction.detail, "BUY");
  assert.equal(result.action, "WAIT");
});

test("F: SELL direction → confirmed, not Entry OK", () => {
  const result = readiness();
  assert.equal(result.direction, "SELL");
  assert.equal(result.checks.direction.status, "confirmed");
  assert.equal(result.action, "WAIT");
  assertNoSignalCopy(result);
});

test("G: NEUTRAL direction → pending", () => {
  const result = readiness({ analysis: analysis("wait", { directionSignal: "wait", action: "WAIT" }) });
  assert.equal(result.direction, "NEUTRAL");
  assert.equal(result.checks.direction.status, "pending");
  assert.equal(result.checks.direction.statusLabel, "確認待ち");
});

test("H: Data Quality high → confirmed (qualityLabel 80+)", () => {
  const result = readiness();
  assert.equal(result.checks.dataQuality.status, "confirmed");
  assert.match(result.checks.dataQuality.detail, /82（高）/);
});

test("I: Data Quality low → warning", () => {
  const result = readiness({
    analysis: analysis("wait", {
      directionSignal: "sell",
      action: "WAIT",
      dataQuality: { ...analysis().dataQuality, score: 20 },
    }),
  });
  assert.equal(result.checks.dataQuality.status, "warning");
  assert.match(result.checks.dataQuality.detail, /20（低）/);
});

test("J: Data Quality missing → unavailable", () => {
  const result = readiness({
    analysis: analysis("wait", {
      directionSignal: "sell",
      action: "WAIT",
      dataQuality: { ...analysis().dataQuality, score: Number.NaN },
    }),
  });
  assert.equal(result.checks.dataQuality.status, "unavailable");
  assert.equal(result.checks.dataQuality.statusLabel, "未取得");
});

test("K: Risk valid → confirmed", () => {
  const result = readiness();
  assert.equal(result.checks.risk.status, "confirmed");
  assert.match(result.checks.risk.detail, /1回あたり/);
});

test("L: Risk invalid → warning", () => {
  const result = readiness({ riskSettings: { ...settings, riskPercent: 0 } });
  assert.equal(result.checks.risk.status, "warning");
  assert.equal(result.checks.risk.detail, RISK_INVALID_MESSAGE);
});

test("M: Event high → warning", () => {
  const result = readiness({ calendar: calendar([event({ importance: "high" })]) });
  assert.equal(result.checks.eventRisk.status, "warning");
  assert.equal(result.checks.eventRisk.statusLabel, "注意");
  assert.notEqual(result.checks.eventRisk.status, "confirmed");
});

test("N: Event low → confirmed", () => {
  const result = readiness({ calendar: calendar([]) });
  assert.equal(result.checks.eventRisk.status, "confirmed");
  assert.doesNotMatch(result.checks.eventRisk.detail, /重要イベントなし/);
});

test("O: Event unavailable → 未取得 copy", () => {
  const result = readiness({
    analysis: analysis("wait", {
      directionSignal: "sell",
      action: "WAIT",
      economicRisk: { active: false, known: false, reasons: [], nextHigh: null },
    }),
    calendar: { data: null, status: "unavailable", error: { code: "network", message: "none" }, warnings: [], fetchedAt: null, provider: "TEST" },
  });
  assert.equal(result.checks.eventRisk.status, "unavailable");
  assert.equal(result.checks.eventRisk.detail, EVENT_UNAVAILABLE_MESSAGE);
  assert.doesNotMatch(result.checks.eventRisk.detail, /重要イベントなし/);
});

test("P: unavailable Event is not counted as confirmed", () => {
  const result = readiness({
    analysis: analysis("wait", {
      directionSignal: "sell",
      action: "WAIT",
      economicRisk: { active: false, known: false, reasons: [], nextHigh: null },
    }),
  });
  assert.equal(result.checks.eventRisk.status, "unavailable");
  assert.equal(result.confirmedCount, 4);
  assert.equal(result.totalCount, READINESS_FIXED_TOTAL);
});

test("Q: Entry condition exists → pending, not confirmed", () => {
  const result = readiness();
  assert.equal(result.entryCondition.status, "pending");
  assert.equal(result.entryCondition.label, CONDITION_PRESENT_LABEL);
  assert.equal(result.entryCondition.text, "156.20を下抜けた場合");
  assert.equal(result.entryCondition.evaluated, false);
  assert.notEqual(result.entryCondition.status, "confirmed");
});

test("R: Entry condition absent → unavailable", () => {
  const result = readiness({ analysis: analysis("wait", { directionSignal: "sell", action: "WAIT", scenario: null }) });
  assert.equal(result.entryCondition.status, "unavailable");
  assert.equal(result.entryCondition.text, null);
});

test("S: condition text is not parsed against currentRate", () => {
  const result = readiness({
    currentRate: 156.10,
    analysis: analysis("wait", { directionSignal: "sell", action: "WAIT", currentRate: 156.10, scenario: scenario() }),
  });
  assert.equal(result.entryCondition.status, "pending");
  assert.equal(result.entryCondition.evaluated, false);
  assert.equal(result.entryCondition.note, CONDITION_NOT_EVALUATED_MESSAGE);
  assert.doesNotMatch(texts(result), /成立[!！]|条件成立済み/);
});

test("T: Daily Loss Limit reached → warning first", () => {
  const result = readiness({
    dailyLossLimitPercent: 1,
    trades: [trade({ id: "loss", realizedPnl: -800 })],
  });
  assert.equal(result.dailyLossLimitReached, true);
  assert.equal(result.state, "warning");
  assert.equal(result.warnings[0]?.code, "daily_loss_limit");
  assert.equal(result.warnings[0]?.message, RISK_LIMIT_MESSAGE);
  assert.equal(result.stateMessage, RISK_LIMIT_MESSAGE);
  assert.doesNotMatch(texts(result), /取引禁止/);
  assert.equal(result.action, "WAIT");
});

test("U: WAIT remains WAIT", () => {
  const result = readiness();
  assert.equal(result.action, "WAIT");
  assert.equal(result.actionMessage, WAIT_ACTION_MESSAGE);
  assert.equal(result.guidance, WAIT_UNTIL_CONDITION_MESSAGE);
});

test("V: 5/5 + WAIT remains WAIT, not Entry OK", () => {
  const result = readiness({ calendar: calendar([]) });
  assert.equal(result.confirmedCount, 5);
  assert.equal(result.totalCount, 5);
  assert.equal(result.state, "ready_to_review");
  assert.equal(result.stateMessage, READY_TO_REVIEW_MESSAGE);
  assert.equal(result.action, "WAIT");
  assert.equal(result.actionMessage, WAIT_ACTION_MESSAGE);
  assertNoSignalCopy(result);
  assert.equal(result.entryCondition.status, "pending");
});

test("W: chart evidence is optional and does not change count", () => {
  const without = readiness({ calendar: calendar([]) });
  const withChart = readiness({
    calendar: calendar([]),
    analysis: analysis("wait", {
      directionSignal: "sell",
      action: "WAIT",
      scenario: scenario(),
      chartEvidence: { used: true, timeframe: "1h", trend: "down", qualityScore: 74 },
    }),
  });
  assert.equal(without.chartEvidenceUsed, false);
  assert.equal(withChart.chartEvidenceUsed, true);
  assert.equal(without.confirmedCount, withChart.confirmedCount);
  assert.equal(withChart.confirmedCount, 5);
});

test("X: deterministic", () => {
  const input = {
    pair: "USD/JPY",
    analysis: analysis("wait", { directionSignal: "sell", action: "WAIT", scenario: scenario() }),
    trades: [] as Trade[],
    riskSettings: settings,
    currentRate: 156.10,
    calendar: calendar([]),
    now: NOW,
  };
  const a = buildEntryReadiness({ pair: input.pair, analysis: input.analysis, dailyPlan: buildDailyTradingPlan(input), riskSettings: input.riskSettings });
  const b = buildEntryReadiness({ pair: input.pair, analysis: input.analysis, dailyPlan: buildDailyTradingPlan(input), riskSettings: input.riskSettings });
  assert.deepEqual(a, b);
});

test("Y: no external call", () => {
  const source = readFileSync(join(process.cwd(), "lib/trading-plan/entry-readiness.ts"), "utf8");
  assert.doesNotMatch(source, /openai|twelvedata|finnhub|stlouisfed|eodhd|fetch\(/i);
  const original = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error("unexpected fetch"); }) as typeof fetch;
  try {
    const result = readiness();
    assert.equal(result.totalCount, 5);
  } finally {
    globalThis.fetch = original;
  }
});

test("Z: no percentage / probability field", () => {
  const result = readiness();
  assertNoSignalCopy(result);
  assert.match(ENTRY_READINESS_DISCLAIMER, /勝率やエントリー推奨度を表すものではありません/);
  assert.equal(result.action === "BUY" ? result.actionMessage : REVIEW_BUY_MESSAGE, REVIEW_BUY_MESSAGE);
  assert.equal(result.action === "SELL" ? result.actionMessage : REVIEW_SELL_MESSAGE, REVIEW_SELL_MESSAGE);
});

test("BUY action copy is review, not execute", () => {
  const result = readiness({ analysis: analysis("buy", { directionSignal: "buy", action: "BUY", scenario: scenario({ direction: "long", condition: "押し目確認" }) }) });
  assert.equal(result.action, "BUY");
  assert.equal(result.actionMessage, REVIEW_BUY_MESSAGE);
  assert.doesNotMatch(texts(result), /今すぐ買う|Entry OK/);
});

test("medium Data Quality uses existing 50–79 pending band", () => {
  const result = readiness({
    analysis: analysis("wait", {
      directionSignal: "sell",
      action: "WAIT",
      dataQuality: { ...analysis().dataQuality, score: 60 },
    }),
  });
  assert.equal(result.checks.dataQuality.status, "pending");
  assert.match(result.checks.dataQuality.detail, /60（中）/);
});

test("missing risk settings → unavailable, not confirmed", () => {
  const result = readiness({ riskSettings: null });
  assert.equal(result.checks.risk.status, "unavailable");
  assert.ok(result.confirmedCount < 5);
});
