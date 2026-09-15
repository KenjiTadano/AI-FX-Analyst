import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildInput } from "../lib/ai/input";
import { finalizeAnalysis } from "../lib/ai/engine";
import type { StructuredEntryTrigger } from "../lib/ai/entry-trigger";
import { evaluateStructuredEntryTrigger } from "../lib/ai/entry-trigger";
import type { AIAnalysis, TradeSignal } from "../lib/ai/types";
import type { DataResource, EconomicEvent } from "../lib/fundamental/types";
import type { RiskSettings } from "../lib/risk/types";
import { capturePreTradeContext, eventRiskAtEntry, sanitizePreTradeContext, triggerStatusAtEntry } from "../lib/trades/pre-trade-context";
import { captureTradeAiSnapshot, isRichSnapshot, sanitizeTradeAiSnapshot } from "../lib/trades/snapshot";
import { closeTrade, createTrade, editTrade } from "../lib/trades/service";
import type { TradeDraft } from "../lib/trades/types";
import { buildDailyTradingPlan } from "../lib/trading-plan/daily-plan";
import { buildEntryReadiness } from "../lib/trading-plan/entry-readiness";
import { buildEntryTriggerWatch } from "../lib/trading-plan/entry-trigger-watch";
import { decodeJournal } from "../lib/trades/repository";

const NOW = Date.parse("2026-09-15T03:15:00.000Z");
const capturedAt = new Date(NOW).toISOString();
const settings: RiskSettings = { balance: 50_000, target: 100_000, riskPercent: 1, tradeUnit: 1000 };

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
    scenario: extra.scenario ?? {
      direction: signal.includes("buy") ? "long" : "short",
      entryZone: { min: 156.1, max: 156.2 },
      stopLoss: 156.8,
      takeProfit1: 155.4,
      takeProfit2: 155.0,
      riskReward: 1.6,
      condition: "156.20を下抜けた場合",
      invalidation: "156.80を超えた場合は無効",
      sourceTimeframe: "1h",
    },
    economicRisk: extra.economicRisk ?? { active: false, known: true, reasons: [], nextHigh: null },
    chartEvidence: extra.chartEvidence !== undefined ? extra.chartEvidence : null,
    confidence: extra.confidence ?? 76,
    dataQuality: extra.dataQuality ?? { ...base.dataQuality, score: 82 },
    currentRate: extra.currentRate ?? 156.42,
    analyzedAt: extra.analyzedAt ?? capturedAt,
    expiresAt: extra.expiresAt ?? new Date(NOW + 300_000).toISOString(),
    entryTrigger: extra.entryTrigger !== undefined ? extra.entryTrigger : trigger(),
  };
}

function emptyCalendar(): DataResource<EconomicEvent[]> {
  return { data: [], status: "empty", error: null, warnings: [], fetchedAt: capturedAt, provider: "TEST" };
}

function highCalendar(): DataResource<EconomicEvent[]> {
  return {
    data: [{
      id: "cpi", name: "米CPI", country: "US", currency: "USD", scheduledAt: new Date(NOW + 3_600_000).toISOString(),
      rawScheduledAt: null, timezone: "UTC", previous: 3, forecast: 3.1, actual: null, unit: "%", status: "upcoming",
      source: "TEST", url: null, isKeyIndicator: true, affectedCurrencies: ["USD"], importance: "high",
      importanceBasis: "provider", impactDirection: null, reason: "TEST",
    }],
    status: "ok", error: null, warnings: [], fetchedAt: capturedAt, provider: "TEST",
  };
}

function unavailableCalendar(): DataResource<EconomicEvent[]> {
  return { data: null, status: "unavailable", error: { code: "network", message: "down" }, warnings: [], fetchedAt: capturedAt, provider: "TEST" };
}

function context(
  extra: Parameters<typeof buildDailyTradingPlan>[0] extends infer T ? Partial<T> : never = {},
  currentRate: number | null = 156.18,
) {
  const ai = extra.analysis === undefined ? analysis("wait", { directionSignal: "sell", action: "WAIT" }) : extra.analysis;
  const plan = buildDailyTradingPlan({
    pair: "USD/JPY",
    analysis: ai,
    trades: [],
    riskSettings: settings,
    currentRate,
    calendar: extra.calendar ?? emptyCalendar(),
    now: NOW,
    ...extra,
  });
  const readiness = buildEntryReadiness({
    pair: extra.pair ?? "USD/JPY",
    analysis: ai,
    dailyPlan: plan,
    riskSettings: settings,
    currentRate,
    now: NOW,
  });
  const distance = buildEntryTriggerWatch({
    trigger: readiness.entryTrigger,
    evaluation: readiness.triggerEvaluation,
    action: readiness.action,
    direction: readiness.direction,
    stale: readiness.stale,
    dailyLossLimitReached: readiness.dailyLossLimitReached,
    pair: readiness.pair,
  })?.distanceToTriggerPips ?? null;
  return capturePreTradeContext({
    pair: extra.pair ?? "USD/JPY",
    capturedAt,
    analysis: ai,
    dailyPlan: plan,
    readiness,
    distanceToTriggerPips: distance,
  });
}

function draft(changes: Partial<TradeDraft> = {}): TradeDraft {
  return {
    pair: "USD/JPY", side: "short", status: "open", quantity: 1000, entryPrice: 156.18, exitPrice: null,
    openedAt: capturedAt, closedAt: null, stopLoss: 156.8, takeProfit: 155.4, notes: "T022", ...changes,
  };
}

test("A: valid full preTrade snapshot", () => {
  const captured = context();
  assert.ok(captured);
  assert.equal(captured.version, 1);
  assert.equal(captured.pair, "USD/JPY");
  assert.equal(captured.capturedAt, capturedAt);
  assert.equal(captured.direction, "SELL");
  assert.equal(captured.action, "WAIT");
});

test("B: SELL + WAIT + MET", () => {
  const captured = context({}, 156.18);
  assert.equal(captured?.direction, "SELL");
  assert.equal(captured?.action, "WAIT");
  assert.equal(captured?.trigger?.evaluation.status, "met");
  assert.equal(triggerStatusAtEntry(captured), "met");
});

test("C: BUY + WAIT + MET", () => {
  const captured = context({
    analysis: analysis("wait", { directionSignal: "buy", action: "WAIT", entryTrigger: trigger({ type: "price_above", price: 156.1 }) }),
  }, 156.18);
  assert.equal(captured?.direction, "BUY");
  assert.equal(captured?.action, "WAIT");
  assert.equal(captured?.trigger?.evaluation.status, "met");
});

test("D: 5/5 preserved", () => {
  const captured = context();
  assert.equal(captured?.readiness?.totalCount, 5);
  assert.equal(captured?.readiness?.confirmedCount, 5);
});

test("E: Trigger not_met", () => {
  const captured = context({}, 156.28);
  assert.equal(captured?.trigger?.evaluation.status, "not_met");
  assert.ok((captured?.trigger?.evaluation.distanceToTriggerPips ?? 0) > 0);
});

test("F: Trigger equality not_met + 0 pips", () => {
  const captured = context({}, 156.2);
  assert.equal(captured?.trigger?.evaluation.status, "not_met");
  assert.equal(captured?.trigger?.evaluation.distanceToTriggerPips, 0);
});

test("G: Trigger unavailable", () => {
  const captured = context({}, null);
  assert.equal(captured?.trigger?.evaluation.status, "unavailable");
  assert.equal(captured?.trigger?.evaluation.distanceToTriggerPips, null);
  assert.notEqual(captured?.trigger?.evaluation.status, "not_met");
});

test("H: Trigger null", () => {
  const captured = context({ analysis: analysis("wait", { directionSignal: "sell", action: "WAIT", entryTrigger: null }) });
  assert.equal(captured?.trigger, null);
  assert.equal(triggerStatusAtEntry(captured), "no_trigger");
});

test("I: DQ preserved", () => {
  assert.equal(context()?.dataQuality?.score, 82);
});

test("J: confidence preserved", () => {
  assert.equal(context()?.confidence, 76);
});

test("K: Event low", () => {
  const captured = context({ calendar: emptyCalendar() });
  assert.equal(captured?.eventRisk?.available, true);
  assert.equal(captured?.eventRisk?.level, "low");
  assert.equal(eventRiskAtEntry(captured), "low");
});

test("L: Event high", () => {
  const captured = context({ calendar: highCalendar() });
  assert.equal(captured?.eventRisk?.level, "high");
  assert.equal(captured?.eventRiskHigh, true);
});

test("M: Event unavailable not low", () => {
  const captured = context({
    calendar: unavailableCalendar(),
    analysis: analysis("wait", { directionSignal: "sell", action: "WAIT", economicRisk: { active: false, known: false, reasons: [], nextHigh: null } }),
  });
  assert.equal(captured?.eventRisk?.available, false);
  assert.notEqual(captured?.eventRisk?.level, "low");
  assert.equal(eventRiskAtEntry(captured), "unavailable");
});

test("N: Risk preserved", () => {
  assert.equal(context()?.risk?.capital, 50_000);
  assert.equal(context()?.risk?.riskPercent, 1);
  assert.equal(context()?.risk?.riskPerTrade, 500);
});

test("O: DLL reached preserved", () => {
  const captured = context({
    dailyLossLimitPercent: 1,
    trades: [{
      id: "loss", pair: "USD/JPY", side: "short", status: "closed", quantity: 1000, entryPrice: 156.5, exitPrice: 157.3,
      openedAt: capturedAt, closedAt: capturedAt, stopLoss: null, takeProfit: null, notes: "", realizedPnl: -800,
      analysisSnapshot: null, createdAt: capturedAt, updatedAt: capturedAt,
    }],
  });
  assert.equal(captured?.dailyLossLimitReached, true);
  assert.equal(captured?.dailyLossLimitPercent, 1);
});

test("P: stale preserved", () => {
  const captured = context({
    analysis: analysis("wait", {
      directionSignal: "sell", action: "WAIT",
      analyzedAt: new Date(NOW - 10 * 60_000).toISOString(),
      expiresAt: new Date(NOW - 60_000).toISOString(),
    }),
  });
  assert.equal(captured?.analysisStale, true);
});

test("Q: pair mismatch fail closed", () => {
  const ai = analysis("wait", { directionSignal: "sell", action: "WAIT" });
  assert.equal(capturePreTradeContext({ pair: "EUR/JPY", capturedAt, analysis: ai }), null);
});

test("R: invalid trigger sanitized", () => {
  const captured = context({
    analysis: analysis("wait", { directionSignal: "sell", action: "WAIT", entryTrigger: { version: 1, type: "macd_cross" } as never }),
  });
  assert.equal(captured?.trigger, null);
});

test("S: invalid preTrade does not kill trade snapshot", () => {
  const snap = captureTradeAiSnapshot({ analysis: analysis("wait", { directionSignal: "sell", action: "WAIT" }), pair: "USD/JPY", now: capturedAt })!;
  const poisoned = sanitizeTradeAiSnapshot({ ...snap, preTradeContext: { version: 1, pair: "USD/JPY", direction: "SIDEWAYS" } });
  assert.ok(poisoned);
  assert.equal(poisoned!.preTradeContext, null);
  assert.equal(poisoned!.action, "WAIT");
});

test("T: capturedAt fixed", () => {
  assert.equal(context()?.capturedAt, capturedAt);
});

test("U: checkedAt preserved", () => {
  const evaluation = evaluateStructuredEntryTrigger({ trigger: trigger(), pair: "USD/JPY", currentRate: 156.18, now: NOW });
  assert.equal(context()?.trigger?.evaluation.checkedAt, evaluation.checkedAt);
});

test("V: checkedAt not candle close label", () => {
  const source = readFileSync(join(process.cwd(), "lib/trades/pre-trade-context.ts"), "utf8");
  assert.match(source, /判定確認時刻/);
  assert.doesNotMatch(source, /ローソク足確定/);
});

test("W: edit preserves preTrade", () => {
  const ai = analysis("wait", { directionSignal: "sell", action: "WAIT" });
  const plan = buildDailyTradingPlan({ pair: "USD/JPY", analysis: ai, trades: [], riskSettings: settings, currentRate: 156.18, calendar: emptyCalendar(), now: NOW });
  const readiness = buildEntryReadiness({ pair: "USD/JPY", analysis: ai, dailyPlan: plan, riskSettings: settings, currentRate: 156.18, now: NOW });
  const trade = createTrade(draft(), ai, "w", capturedAt, { dailyPlan: plan, readiness }).data!;
  const edited = editTrade(trade, { ...trade, notes: "changed", entryPrice: 156.2 }, capturedAt).data!;
  assert.deepEqual(edited.analysisSnapshot, trade.analysisSnapshot);
});

test("X: close preserves preTrade", () => {
  const ai = analysis("wait", { directionSignal: "sell", action: "WAIT" });
  const plan = buildDailyTradingPlan({ pair: "USD/JPY", analysis: ai, trades: [], riskSettings: settings, currentRate: 156.18, calendar: emptyCalendar(), now: NOW });
  const readiness = buildEntryReadiness({ pair: "USD/JPY", analysis: ai, dailyPlan: plan, riskSettings: settings, currentRate: 156.18, now: NOW });
  const trade = createTrade(draft(), ai, "x", capturedAt, { dailyPlan: plan, readiness }).data!;
  const closed = closeTrade(trade, 155.9, capturedAt, capturedAt).data!;
  assert.deepEqual(closed.analysisSnapshot, trade.analysisSnapshot);
});

test("Y: toggle OFF no snapshot/context", () => {
  const trade = createTrade(draft(), analysis("wait", { directionSignal: "sell", action: "WAIT" }), "y", capturedAt, { saveSnapshot: false }).data!;
  assert.equal(trade.analysisSnapshot, null);
});

test("Z: legacy no context", () => {
  const legacy = {
    pair: "USD/JPY", signal: "wait", score: 0, confidence: 40, summary: "legacy", dataQualityScore: 50,
    analyzedAt: capturedAt, capturedAt, expiresAt: capturedAt, aiStatus: "unavailable", model: null, bullishReasons: [], bearishReasons: [],
  };
  const trade = createTrade(draft(), null, "z", capturedAt).data!;
  assert.equal(trade.analysisSnapshot, null);
  assert.equal("preTradeContext" in legacy, false);
});

test("AA: local restore compatibility", () => {
  const ai = analysis("wait", { directionSignal: "sell", action: "WAIT" });
  const plan = buildDailyTradingPlan({ pair: "USD/JPY", analysis: ai, trades: [], riskSettings: settings, currentRate: 156.18, calendar: emptyCalendar(), now: NOW });
  const readiness = buildEntryReadiness({ pair: "USD/JPY", analysis: ai, dailyPlan: plan, riskSettings: settings, currentRate: 156.18, now: NOW });
  const trade = createTrade(draft(), ai, "aa", capturedAt, { dailyPlan: plan, readiness }).data!;
  const restored = decodeJournal(JSON.stringify({ schemaVersion: 1, revision: 1, trades: [trade] }));
  assert.ok(restored.data);
  assert.ok(isRichSnapshot(restored.data.trades[0]?.analysisSnapshot));
  assert.equal(restored.data.trades[0]?.analysisSnapshot && "preTradeContext" in restored.data.trades[0].analysisSnapshot
    ? (restored.data.trades[0].analysisSnapshot as { preTradeContext?: { action: string } }).preTradeContext?.action
    : null, "WAIT");
});

test("AB: unknown enum reject", () => {
  const valid = context()!;
  assert.equal(sanitizePreTradeContext({ ...valid, direction: "LONG" }, "USD/JPY"), null);
  assert.equal(sanitizePreTradeContext({ ...valid, trigger: { ...valid.trigger, evaluation: { ...valid.trigger!.evaluation, status: "almost" } } }, "USD/JPY"), null);
});

test("AC: numeric validation", () => {
  const valid = context()!;
  assert.equal(sanitizePreTradeContext({ ...valid, readiness: { confirmedCount: 6, totalCount: 5, state: "waiting" } }, "USD/JPY"), null);
  assert.equal(sanitizePreTradeContext({ ...valid, confidence: 140 }, "USD/JPY"), null);
  assert.equal(sanitizePreTradeContext({ ...valid, risk: { capital: -1, riskPercent: 1, riskPerTrade: 10 } }, "USD/JPY"), null);
});

test("AD: distance negative reject", () => {
  const valid = context()!;
  assert.equal(sanitizePreTradeContext({
    ...valid,
    trigger: { ...valid.trigger!, evaluation: { ...valid.trigger!.evaluation, distanceToTriggerPips: -3 } },
  }, "USD/JPY"), null);
});

test("AE: no raw candles", () => {
  const source = readFileSync(join(process.cwd(), "lib/trades/pre-trade-context.ts"), "utf8");
  assert.doesNotMatch(source, /candlesByTimeframe|lastClosedCandle|forming/);
});

test("AF: no API secrets", () => {
  const captured = context();
  assert.doesNotMatch(JSON.stringify(captured), /sk-|api[_-]?key|data:image\/|systemPrompt/i);
});

test("AG: no OpenAI call", () => {
  const source = readFileSync(join(process.cwd(), "lib/trades/pre-trade-context.ts"), "utf8");
  assert.doesNotMatch(source, /openai|responses\.create/i);
});

test("AH: no external fetch", () => {
  const source = readFileSync(join(process.cwd(), "lib/trades/pre-trade-context.ts"), "utf8");
  assert.doesNotMatch(source, /fetch\(|twelvedata|finnhub|stlouisfed|eodhd/i);
});

test("AI: no backfill", () => {
  const source = readFileSync(join(process.cwd(), "lib/trades/pre-trade-context.ts"), "utf8");
  assert.doesNotMatch(source, /backfill|inferTrigger|parseCondition/);
});

test("AJ: deterministic sanitizer/copy", () => {
  const first = context();
  const second = context();
  assert.deepEqual(first, second);
  first!.confidence = 1;
  assert.notEqual(context()?.confidence, 1);
});

test("copy semantics: mutating live readiness does not change snapshot", () => {
  const ai = analysis("wait", { directionSignal: "sell", action: "WAIT" });
  const plan = buildDailyTradingPlan({ pair: "USD/JPY", analysis: ai, trades: [], riskSettings: settings, currentRate: 156.18, calendar: emptyCalendar(), now: NOW });
  const readiness = buildEntryReadiness({ pair: "USD/JPY", analysis: ai, dailyPlan: plan, riskSettings: settings, currentRate: 156.18, now: NOW });
  const trade = createTrade(draft(), ai, "copy", capturedAt, { dailyPlan: plan, readiness }).data!;
  readiness.confirmedCount = 0;
  if (readiness.triggerEvaluation) readiness.triggerEvaluation.observedValue = 999;
  assert.equal(isRichSnapshot(trade.analysisSnapshot) ? trade.analysisSnapshot.preTradeContext?.readiness?.confirmedCount : null, 5);
  assert.equal(isRichSnapshot(trade.analysisSnapshot) ? trade.analysisSnapshot.preTradeContext?.trigger?.evaluation.observedValue : null, 156.18);
});

test("no newlyMet field", () => {
  const captured = context();
  assert.equal(captured && "newlyMet" in captured, false);
});

test("no quality labels", () => {
  assert.doesNotMatch(JSON.stringify(context()), /goodEntry|badEntry|correctEntry|wrongEntry|ruleFollowed|disciplineScore|Entry OK/);
});
