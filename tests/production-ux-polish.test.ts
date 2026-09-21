import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildInput } from "../lib/ai/input";
import { finalizeAnalysis } from "../lib/ai/engine";
import type { AIAnalysis, TradeSignal } from "../lib/ai/types";
import type { RiskSettings } from "../lib/risk/types";
import { buildTradingDecisionWorkspace } from "../lib/dashboard/trading-decision-workspace";
import { buildPerformanceIntelligence } from "../lib/trades/performance-intelligence";
import { buildTradeEvolutionPerformance } from "../lib/trades/trade-evolution-performance";

const NOW = Date.parse("2026-09-21T12:00:00.000Z");
const ROOT = process.cwd();
const DASH = readFileSync(join(ROOT, "components/dashboard/dashboard.tsx"), "utf8");
const WORKSPACE_UI = readFileSync(join(ROOT, "components/dashboard/trading-decision-workspace.tsx"), "utf8");
const CSS = readFileSync(join(ROOT, "app/globals.css"), "utf8");
const LIB = readFileSync(join(ROOT, "lib/dashboard/trading-decision-workspace.ts"), "utf8");

const settings: RiskSettings = { balance: 50_000, target: 100_000, riskPercent: 1, tradeUnit: 1000 };

function analysis(signal: TradeSignal = "sell", extra: Partial<AIAnalysis> = {}): AIAnalysis {
  const base = finalizeAnalysis(buildInput("USD/JPY", null, null, NOW), null, "TEST", "not_configured", NOW);
  return {
    ...base,
    ...extra,
    pair: "USD/JPY",
    signal,
    directionSignal: extra.directionSignal ?? signal,
    action: extra.action ?? "WAIT",
    confidence: extra.confidence ?? 70,
    ai: extra.ai ?? { status: "available", model: "TEST", code: null, message: null },
  };
}

test("Task110 header production cleanup", () => {
  assert.match(DASH, /AI-FX-Analyst/);
  assert.match(DASH, /product-badge/);
  assert.doesNotMatch(DASH, /MVP\s*\/\s*TASK\s*033|FX ANALYSIS\s*\/\s*01|PROTOTYPE\s*\/\s*TASK/);
  assert.match(DASH, /data-testid="dashboard-tabs"/);
  assert.match(DASH, /market-freshness-label/);
});

test("Task110 workspace hierarchy and Japanese labels", () => {
  assert.match(WORKSPACE_UI, /tdw-layer-primary/);
  assert.match(WORKSPACE_UI, /tdw-primary/);
  assert.match(WORKSPACE_UI, /Direction（方向）/);
  assert.match(WORKSPACE_UI, /Action（行動）/);
  assert.match(WORKSPACE_UI, /エントリー準備状況/);
  assert.match(WORKSPACE_UI, /エントリー条件/);
  assert.match(WORKSPACE_UI, /イベントリスク/);
  assert.match(WORKSPACE_UI, /tdw-rate-loading/);
  assert.match(CSS, /\.tdw-primary/);
  assert.match(CSS, /\.journal-nav\s*\{[^}]*grid-template-columns:\s*repeat\(4/);
});

test("Task110 Technical compact strip not adopted (no new technical calc)", () => {
  assert.doesNotMatch(WORKSPACE_UI, /RSI14|Price vs SMA|technical-compact|tdw-technical/);
  assert.doesNotMatch(LIB, /RSI14|SMA20|SMA75|SMA200/);
});

test("Task110 Direction / Action semantics unchanged", () => {
  assert.doesNotMatch(LIB, /decisionScore|compositeScore|tradeScore|expectedValue|probability/i);
  const model = buildTradingDecisionWorkspace({
    pair: "USD/JPY",
    analysis: analysis("sell", { directionSignal: "sell", action: "WAIT", confidence: 71 }),
    trades: [],
    riskSettings: settings,
    currentRate: 156.2,
    market: null,
  });
  assert.equal(model.ai.directionCode, "SELL");
  assert.equal(model.ai.actionCode, "WAIT");
  assert.notEqual(model.ai.directionCode, model.ai.actionCode);
  assert.equal(model.ai.confidence, 71);
});

test("Task110 PI / evolution builders still pure with empty trades", () => {
  const trades: never[] = [];
  const pi = buildPerformanceIntelligence(trades);
  const evo = buildTradeEvolutionPerformance(trades);
  buildTradingDecisionWorkspace({
    pair: "USD/JPY",
    analysis: analysis("sell", { directionSignal: "sell", action: "WAIT" }),
    trades,
    riskSettings: settings,
    currentRate: 156.2,
    market: null,
  });
  assert.equal(buildPerformanceIntelligence(trades).overview.closedTrades, pi.overview.closedTrades);
  assert.equal(buildTradeEvolutionPerformance(trades).coverage.periodClosed, evo.coverage.periodClosed);
});

test("Task110 detail sections remain / duplication reduced via hierarchy CSS", () => {
  assert.match(DASH, /TradingDecisionWorkspacePanel/);
  assert.match(DASH, /AIOverview/);
  assert.match(DASH, /DailyTradingPlanPanel/);
  assert.match(DASH, /ia-section-detail/);
  assert.match(CSS, /\.ia-section-detail/);
  assert.match(WORKSPACE_UI, /tdw-jump-ai/);
  assert.match(CSS, /\.product-badge/);
});
