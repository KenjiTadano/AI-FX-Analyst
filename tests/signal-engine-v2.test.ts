import test from "node:test";
import assert from "node:assert/strict";
import { calculateSignalDirection, evaluateSafetyGate, evaluateSignalEngineV2, resolveSignalAction } from "../lib/ai/signal-engine-v2";
import type { DataQuality, TechnicalAnalysis, TechnicalFrame, TradeSignal } from "../lib/ai/types";
import type { Timeframe } from "../lib/market/types";
import { signalFromScore } from "../lib/ai/engine";

const quality = (score = 100): DataQuality => ({
  score,
  missingData: [],
  categories: {
    technical: { status: "ok", detail: "", fraction: 1 },
    news: { status: "ok", detail: "", fraction: 1 },
    economic: { status: "ok", detail: "", fraction: 1 },
    central_bank: { status: "ok", detail: "", fraction: 1 },
    market_environment: { status: "ok", detail: "", fraction: 1 },
  },
  macroeconomicData: { status: "ok", detail: "", fraction: 1 },
});

function technical(score: number, ready = true, extended = false): TechnicalAnalysis {
  return { score, frames: [], factors: [], warnings: [], ready, extended };
}

function evaluate(overrides: Partial<Parameters<typeof evaluateSignalEngineV2>[0]> = {}) {
  return evaluateSignalEngineV2({
    technical: technical(0),
    dataQuality: quality(),
    eventRisk: { imminent: false, uncertainTime: false, nextRiskAt: null, reasons: [] },
    aiAvailable: true,
    confidence: 90,
    preferWait: false,
    contradictions: false,
    scenarioAvailable: true,
    now: Date.parse("2026-10-05T00:00:00Z"),
    ...overrides,
  });
}

for (const [score, expected] of [[60, "strong_buy"], [20, "buy"], [0, "wait"], [-20, "sell"], [-60, "strong_sell"]] as const) {
  test(`v2 direction threshold ${score} => ${expected}`, () => {
    assert.equal(calculateSignalDirection(technical(score)).direction, expected);
  });
}

test("stale data blocks action without altering direction", () => {
  const result = evaluate({ technical: technical(65), staleDataSources: ["market.1h"] });
  assert.equal(result.direction, "strong_buy");
  assert.equal(result.safety, "BLOCK");
  assert.ok(result.safetyReasons.some(reason => reason.code === "STALE_DATA"));
  assert.equal(result.action, "WAIT");
  assert.equal(result.waitClassification, "safety");
});

test("insufficient data blocks action independently of score", () => {
  const result = evaluate({ technical: technical(-35, false) });
  assert.equal(result.direction, "sell");
  assert.equal(result.safety, "BLOCK");
  assert.ok(result.safetyReasons.some(reason => reason.code === "INSUFFICIENT_DATA"));
});

test("economic risk blocks action but leaves direction unchanged", () => {
  const result = evaluate({
    technical: technical(70),
    eventRisk: { imminent: true, uncertainTime: false, nextRiskAt: null, reasons: ["HIGH event"] },
  });
  assert.equal(result.direction, "strong_buy");
  assert.equal(result.safety, "BLOCK");
  assert.equal(result.action, "WAIT");
});

test("extended market blocks action but leaves direction unchanged", () => {
  const result = evaluate({ technical: technical(25, true, true) });
  assert.equal(result.direction, "buy");
  assert.ok(result.safetyReasons.some(reason => reason.code === "EXTENDED_MARKET"));
  assert.equal(result.action, "WAIT");
});

test("valid market is allowed and resolves directional action", () => {
  const result = evaluate({ technical: technical(-25) });
  assert.equal(result.safety, "ALLOW");
  assert.equal(result.action, "SELL");
  assert.deepEqual(result.safetyReasons, []);
});

test("AI unavailable, low confidence, and preferWait do not rewrite direction", () => {
  const unavailable = evaluate({ technical: technical(70), aiAvailable: false, confidence: null });
  const lowConfidence = evaluate({ technical: technical(-30), confidence: 20 });
  const preferWait = evaluate({ technical: technical(30), preferWait: true });
  assert.equal(unavailable.direction, "strong_buy");
  assert.equal(lowConfidence.direction, "sell");
  assert.equal(preferWait.direction, "buy");
  assert.equal(unavailable.safety, "ALLOW");
  assert.equal(lowConfidence.safety, "ALLOW");
  assert.equal(preferWait.safety, "ALLOW");
  assert.equal(unavailable.action, "WAIT");
  assert.equal(lowConfidence.action, "WAIT");
  assert.equal(preferWait.action, "WAIT");
});

test("missing risk scenario blocks action without rewriting direction", () => {
  const result = evaluate({ technical: technical(35), scenarioAvailable: false });
  assert.equal(result.direction, "buy");
  assert.equal(result.scenarioStatus, "unavailable");
  assert.ok(result.actionReasons.some(reason => reason.code === "NO_VALID_RISK_SCENARIO"));
  assert.equal(result.action, "WAIT");
  assert.equal(result.waitClassification, "scenario");
});

test("trigger MET is context only and cannot force a trade action", () => {
  const noTrigger = evaluate({ technical: technical(40), entryTriggerContext: "not_evaluated" });
  const met = evaluate({ technical: technical(40), entryTriggerContext: "met" });
  assert.equal(met.direction, noTrigger.direction);
  assert.equal(met.action, noTrigger.action);
  assert.equal(met.action, "BUY");
  assert.equal(met.entryTriggerContext, "met");
  const neutralMet = evaluate({ technical: technical(0), entryTriggerContext: "met" });
  assert.equal(neutralMet.action, "WAIT");
});

test("data quality threshold is a hard safety reason", () => {
  const result = evaluateSafetyGate({
    technical: technical(80),
    dataQuality: quality(59),
    eventRisk: { imminent: false, uncertainTime: false, reasons: [] },
    now: 0,
  });
  assert.equal(result.status, "BLOCK");
  assert.equal(result.reasons[0]?.code, "DATA_QUALITY");
});

test("directional threshold mapping has no score tuning", () => {
  const resolved = resolveSignalAction({
    direction: "buy",
    safety: { status: "ALLOW", reasons: [] },
    scenarioStatus: "available",
    aiAvailable: true,
    confidence: 90,
    preferWait: false,
    contradictions: false,
    entryTriggerContext: "met",
  });
  assert.equal(resolved.action, "BUY");
  assert.equal(resolved.entryTriggerContext, "met");
});

function bullishFrame(timeframe: Timeframe): TechnicalFrame {
  return {
    timeframe, available: true, completeness: 1, lastClosedAt: "2026-10-05T00:00:00Z", score: 100,
    close: 2, sma20: 1.9, sma75: 1.8, sma200: 1.7,
    priceVsSma: "bullish", shortVsMedium: "bullish", mediumVsLong: "bullish",
    smaSlopes: { short: 0.1, medium: 0.1, long: 0.1 },
    rsi: 75, rsiState: "overbought", momentum: 0.2, momentumAtr: 1, atr: 0.1,
    recentHigh: 2.1, recentLow: 1.7, extended: false,
  };
}

test("components expose existing technical contributions and non-scoring RSI context", () => {
  const technicalInput: TechnicalAnalysis = {
    score: 100,
    frames: [bullishFrame("15m"), bullishFrame("1h"), bullishFrame("4h")],
    factors: [], warnings: [], ready: true, extended: false,
  };
  const result = calculateSignalDirection(technicalInput);
  assert.equal(result.score, 100);
  assert.equal(result.direction, "strong_buy");
  assert.equal(Math.round(result.components.reduce((sum, item) => sum + item.points, 0)), 100);
  assert.ok(result.components.filter(item => item.id === "rsi_context").every(item => item.points === 0));
});

interface ComparisonFixture {
  id: string;
  technicalScore: number;
  fundamentalScore: number;
  ready?: boolean;
  stale?: boolean;
  eventRisk?: boolean;
  aiAvailable?: boolean;
  confidence?: number | null;
  preferWait?: boolean;
  contradictions?: boolean;
  extended?: boolean;
  scenarioAvailable?: boolean;
}

function legacyResult(fixture: ComparisonFixture): { direction: TradeSignal; action: "BUY" | "SELL" | "WAIT"; waitClassification: Exclude<import("../lib/ai/signal-engine-v2").WaitClassification, null> | null } {
  const score = Math.round(Math.max(-100, Math.min(100, fixture.technicalScore * 0.7 + fixture.fundamentalScore)));
  const direction = signalFromScore(score);
  const aiAvailable = fixture.aiAvailable ?? true;
  const confidence = aiAvailable ? fixture.confidence ?? 90 : 35;
  const blocked = !aiAvailable || fixture.ready === false || fixture.eventRisk === true
    || (fixture.confidence !== undefined && fixture.confidence !== null && confidence < 55)
    || fixture.contradictions === true || fixture.extended === true || fixture.preferWait === true;
  let signal = blocked ? "wait" : direction;
  if (confidence < 75 && (signal === "strong_buy" || signal === "strong_sell")) signal = signal === "strong_buy" ? "buy" : "sell";
  if (signal !== "wait" && fixture.scenarioAvailable === false) signal = "wait";
  const action = signal === "wait" ? "WAIT" : signal.includes("buy") ? "BUY" : "SELL";
  const waitClassification = action !== "WAIT" ? null
    : fixture.ready === false || fixture.eventRisk === true || fixture.extended === true ? "safety"
      : direction === "wait" ? "neutral"
        : fixture.scenarioAvailable === false && !blocked ? "scenario" : "directional";
  return { direction, action, waitClassification };
}

const comparisonFixtures: ComparisonFixture[] = [
  { id: "bullish clean", technicalScore: 50, fundamentalScore: 30 },
  { id: "bearish clean", technicalScore: -50, fundamentalScore: -30 },
  { id: "neutral", technicalScore: 0, fundamentalScore: 0 },
  { id: "AI unavailable", technicalScore: 70, fundamentalScore: 0, aiAvailable: false, confidence: null },
  { id: "low confidence", technicalScore: 40, fundamentalScore: 0, confidence: 40 },
  { id: "stale", technicalScore: 40, fundamentalScore: 0, ready: false, stale: true },
  { id: "insufficient data", technicalScore: 40, fundamentalScore: 0, ready: false },
  { id: "economic high risk", technicalScore: 65, fundamentalScore: 0, eventRisk: true },
  { id: "contradiction", technicalScore: 45, fundamentalScore: -10, contradictions: true },
  { id: "extended", technicalScore: 60, fundamentalScore: 0, extended: true },
  { id: "scenario RR failure", technicalScore: 40, fundamentalScore: 0, scenarioAvailable: false },
  { id: "strong bullish", technicalScore: 90, fundamentalScore: 0 },
  { id: "strong bearish", technicalScore: -90, fundamentalScore: 0 },
];

test("Legacy/v2 comparison on the fixed 13-case cohort", () => {
  const legacyWaits = { safety: 0, scenario: 0, directional: 0, neutral: 0 };
  const v2Waits = { safety: 0, scenario: 0, directional: 0, neutral: 0 };
  for (const fixture of comparisonFixtures) {
    const legacy = legacyResult(fixture);
    const v2 = evaluate({
      technical: technical(fixture.technicalScore, fixture.ready ?? true, fixture.extended ?? false),
      staleDataSources: fixture.stale ? ["market.1h"] : [],
      eventRisk: { imminent: fixture.eventRisk ?? false, uncertainTime: false, reasons: fixture.eventRisk ? ["HIGH event"] : [] },
      aiAvailable: fixture.aiAvailable ?? true,
      confidence: fixture.aiAvailable === false ? null : fixture.confidence ?? 90,
      preferWait: fixture.preferWait ?? false,
      contradictions: fixture.contradictions ?? false,
      scenarioAvailable: fixture.scenarioAvailable ?? true,
    });
    assert.ok(["strong_buy", "buy", "wait", "sell", "strong_sell"].includes(legacy.direction), fixture.id);
    assert.equal(v2.direction, signalFromScore(fixture.technicalScore), fixture.id);
    assert.equal(v2.action, legacy.action, fixture.id);
    if (legacy.action === "WAIT" && legacy.waitClassification) legacyWaits[legacy.waitClassification]++;
    if (v2.action === "WAIT") v2Waits[v2.waitClassification === "safety" ? "safety" : v2.waitClassification === "scenario" ? "scenario" : v2.waitClassification === "neutral" ? "neutral" : "directional"]++;
  }
  assert.deepEqual(legacyWaits, { safety: 4, scenario: 1, directional: 3, neutral: 1 });
  assert.deepEqual(v2Waits, { safety: 4, scenario: 1, directional: 3, neutral: 1 });
});