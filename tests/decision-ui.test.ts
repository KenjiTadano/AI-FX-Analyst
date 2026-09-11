import test from "node:test";
import assert from "node:assert/strict";
import { buildInput } from "../lib/ai/input";
import { finalizeAnalysis } from "../lib/ai/engine";
import type { AIAnalysis, AnalysisFactor, TradeSignal } from "../lib/ai/types";
import {
  ANALYSIS_STALE_MS,
  actionGuidanceLabel,
  classifyWaitReasons,
  directionBiasLabel,
  evidenceConflictNote,
  formatScenarioPrices,
  isAnalysisStale,
  recommendedPositionHint,
  scenarioStance,
  signalLabels,
  splitEvidenceMaterials,
  whatToDoNow,
} from "../lib/ai/decision-ui";
import defaults from "../lib/settings/defaults.json";

const now = Date.parse("2026-09-11T12:00:00Z");
const settings = { balance: defaults.balance, target: defaults.target, riskPercent: defaults.riskPercent, tradeUnit: defaults.tradeUnit };

function base(signal: TradeSignal = "wait"): AIAnalysis {
  const a = finalizeAnalysis(buildInput("USD/JPY", null, null, now), null, "TEST", "not_configured", now);
  return {
    ...a,
    signal,
    directionSignal: signal,
    action: signal === "wait" ? "WAIT" : signal.includes("buy") ? "BUY" : "SELL",
    ai: { status: "available", model: "TEST", code: null, message: null },
    scenario: null,
    economicRisk: { active: false, known: true, reasons: [], nextHigh: null },
    chartEvidence: null,
  };
}

test("A: direction SELL + action WAIT stay visually separated", () => {
  const analysis = { ...base("sell"), directionSignal: "sell" as const, action: "WAIT" as const, signal: "wait" as const };
  assert.equal(directionBiasLabel(analysis.directionSignal), "売り寄り");
  assert.equal(actionGuidanceLabel(analysis.action, analysis.signal), "今はエントリーしない");
  assert.notEqual(directionBiasLabel(analysis.directionSignal), signalLabels[analysis.signal]);
  assert.equal(scenarioStance(analysis).wait, "現在推奨");
});

test("B: high impact event prioritizes WAIT messaging", () => {
  const analysis: AIAnalysis = {
    ...base("strong_sell"),
    directionSignal: "strong_sell",
    action: "WAIT",
    signal: "wait",
    economicRisk: {
      active: true,
      known: true,
      reasons: ["重要指標発表が近いためWAITを優先"],
      nextHigh: {
        id: "cpi",
        name: "米CPI",
        country: "US",
        currency: "USD",
        scheduledAt: new Date(now + 3_600_000).toISOString(),
        rawScheduledAt: null,
        timezone: "UTC",
        previous: null,
        forecast: null,
        actual: null,
        unit: null,
        status: "upcoming",
        source: "TEST",
        url: null,
        isKeyIndicator: true,
        affectedCurrencies: ["USD"],
        importance: "high",
        importanceBasis: "provider",
        impactDirection: null,
        reason: "TEST",
      },
    },
  };
  assert.match(whatToDoNow(analysis), /米CPI|重要指標/);
  assert.ok(classifyWaitReasons(analysis).some(item => item.kind === "event"));
  assert.equal(recommendedPositionHint(analysis, "USD/JPY", settings, now).maxUnits, 0);
});

test("C: chartEvidence.used surfaces chart material", () => {
  const analysis: AIAnalysis = {
    ...base("sell"),
    chartEvidence: { used: true, timeframe: "15m", trend: "down", qualityScore: 85 },
    factors: [
      { category: "technical", title: "チャート画像", direction: "bearish", impact: "medium", reason: "15分足は下降", source: "chart_image", evidenceIds: ["technical:chart_image"] },
    ],
  };
  const materials = splitEvidenceMaterials(analysis);
  assert.ok(materials.sell.some(item => /チャート|下降/.test(`${item.title}${item.reason}`)));
  assert.equal(analysis.chartEvidence?.used, true);
});

test("D: without chartEvidence Chart Image is unused", () => {
  const analysis = base("buy");
  assert.equal(analysis.chartEvidence, null);
  assert.equal(splitEvidenceMaterials(analysis).buy.every(item => item.title !== "チャート画像"), true);
});

test("E: conflicting BUY/SELL factors both appear", () => {
  const factors: AnalysisFactor[] = [
    { category: "technical", title: "短期", direction: "bullish", impact: "medium", reason: "短期上昇", source: "market", evidenceIds: ["t1"] },
    { category: "technical", title: "チャート画像", direction: "bearish", impact: "medium", reason: "下降", source: "chart_image", evidenceIds: ["c1"] },
  ];
  const analysis: AIAnalysis = {
    ...base("wait"),
    directionSignal: "buy",
    chartEvidence: { used: true, timeframe: "15m", trend: "down", qualityScore: 80 },
    factors,
    bullishReasons: ["短期上昇"],
    bearishReasons: ["下降"],
  };
  const materials = splitEvidenceMaterials(analysis);
  assert.ok(materials.buy.length >= 1);
  assert.ok(materials.sell.length >= 1);
  assert.match(evidenceConflictNote(analysis) ?? "", /一致していません|割れています/);
});

test("F: missing scenario prices are not invented", () => {
  assert.equal(formatScenarioPrices(null), null);
  assert.equal(formatScenarioPrices(undefined), null);
  const todo = whatToDoNow({ ...base("wait"), scenario: null });
  assert.ok(todo.length > 0);
  assert.doesNotMatch(todo, /\d{3}\.\d+/);
  assert.equal(recommendedPositionHint({ ...base("wait"), scenario: null }, "USD/JPY", settings, now).maxUnits, 0);
});

test("G: fallback analysis keeps WAIT-safe position guidance", () => {
  const analysis: AIAnalysis = {
    ...base("wait"),
    ai: { status: "unavailable", model: null, code: "not_configured", message: "OpenAI unavailable" },
    action: "WAIT",
  };
  assert.equal(recommendedPositionHint(analysis, "USD/JPY", settings, now).label, "新規エントリーなし");
  assert.equal(analysis.ai.status, "unavailable");
});

test("H: analyzedAt remains available for UI timestamp", () => {
  const analysis = base("buy");
  assert.ok(analysis.analyzedAt);
  assert.ok(Number.isFinite(Date.parse(analysis.analyzedAt)));
});

test("I: stale threshold marks analysis for refresh", () => {
  const analyzedAt = new Date(now - ANALYSIS_STALE_MS - 1).toISOString();
  assert.equal(isAnalysisStale(analyzedAt, now), true);
  assert.equal(isAnalysisStale(new Date(now - 60_000).toISOString(), now), false);
});

test("J: action WAIT forces position recommendation 0 / 新規なし", () => {
  const analysis: AIAnalysis = {
    ...base("strong_buy"),
    directionSignal: "strong_buy",
    action: "WAIT",
    signal: "wait",
    scenario: {
      direction: "long",
      entryZone: { min: 153.4, max: 153.5 },
      stopLoss: 153,
      takeProfit1: 154.5,
      takeProfit2: 155,
      riskReward: 2,
      condition: "上抜け",
      invalidation: "下抜け",
      sourceTimeframe: "1h",
    },
  };
  const hint = recommendedPositionHint(analysis, "USD/JPY", settings, now);
  assert.equal(hint.wait, true);
  assert.equal(hint.maxUnits, 0);
  assert.match(hint.label, /新規エントリーなし/);
});
