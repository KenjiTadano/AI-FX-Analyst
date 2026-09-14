import test from "node:test";
import assert from "node:assert/strict";
import {
  AI_ENTRY_NEUTRAL_PIPS,
  aiDirectionalMovePips,
  analyzeAiEntryContext,
  classifyAiDirectionalMove,
  classifyAiEntryMoveContext,
} from "../lib/trades/ai-entry-context";
import { generateTradingInsights, MAX_INSIGHTS } from "../lib/trades/insights";
import { filterTradesByPeriod } from "../lib/trades/performance-period";
import type { Trade, TradeAiAnalysisSnapshot, TradeAnalysisSnapshot } from "../lib/trades/types";

const NOW = "2026-09-12T00:00:00.000Z";
const NOW_MS = Date.parse(NOW);
const DAY = 24 * 60 * 60 * 1000;

function rich(partial: Partial<TradeAiAnalysisSnapshot> = {}): TradeAiAnalysisSnapshot {
  return {
    pair: "USD/JPY",
    signal: "buy",
    score: 10,
    confidence: 70,
    summary: "t016",
    dataQualityScore: 80,
    analyzedAt: NOW,
    capturedAt: NOW,
    expiresAt: NOW,
    aiStatus: "available",
    model: "x",
    bullishReasons: [],
    bearishReasons: [],
    version: 1,
    directionSignal: "buy",
    action: "BUY",
    marketPrice: 150,
    analysisPrice: 150,
    factors: [],
    scenario: null,
    dataQuality: {
      score: 80,
      missingData: [],
      categories: {
        technical: { status: "ok", detail: "", fraction: 1 },
        news: { status: "ok", detail: "", fraction: 1 },
        economic: { status: "ok", detail: "", fraction: 1 },
        central_bank: { status: "ok", detail: "", fraction: 1 },
        market_environment: { status: "ok", detail: "", fraction: 1 },
      },
      macroeconomicData: { status: "ok", detail: "", fraction: 1 },
    },
    economicRisk: null,
    chartEvidence: null,
    chartAnalysis: null,
    aiCode: null,
    isFallback: false,
    ...partial,
  };
}

function legacy(): TradeAnalysisSnapshot {
  return {
    pair: "USD/JPY", signal: "buy", score: 10, confidence: 70, summary: "legacy",
    dataQualityScore: 80, analyzedAt: NOW, capturedAt: NOW, expiresAt: NOW,
    aiStatus: "available", model: "x", bullishReasons: [], bearishReasons: [],
  };
}

function trade(partial: Partial<Trade> & Pick<Trade, "id">): Trade {
  return {
    pair: "USD/JPY",
    side: "long",
    status: "closed",
    quantity: 1000,
    entryPrice: 150.1,
    exitPrice: 150.2,
    openedAt: NOW,
    closedAt: NOW,
    stopLoss: null,
    takeProfit: null,
    notes: "T016",
    realizedPnl: 100,
    analysisSnapshot: rich(),
    createdAt: NOW,
    updatedAt: NOW,
    ...partial,
  };
}

function daysAgo(days: number): string {
  return new Date(NOW_MS - days * DAY).toISOString();
}

test("A: AI BUY + price up → with_ai_direction", () => {
  const t = trade({ id: "a", entryPrice: 150.1, analysisSnapshot: rich({ directionSignal: "buy", analysisPrice: 150 }) });
  assert.equal(classifyAiEntryMoveContext(t).context, "with_ai_direction");
});

test("B: AI BUY + price down → against_ai_direction", () => {
  const t = trade({ id: "b", entryPrice: 149.9, analysisSnapshot: rich({ directionSignal: "buy", analysisPrice: 150 }) });
  assert.equal(classifyAiEntryMoveContext(t).context, "against_ai_direction");
});

test("C: AI SELL + price down → with_ai_direction", () => {
  const t = trade({ id: "c", side: "short", entryPrice: 149.9, analysisSnapshot: rich({ directionSignal: "sell", signal: "sell", action: "SELL", analysisPrice: 150 }) });
  assert.equal(classifyAiEntryMoveContext(t).context, "with_ai_direction");
});

test("D: AI SELL + price up → against_ai_direction", () => {
  const t = trade({ id: "d", side: "short", entryPrice: 150.1, analysisSnapshot: rich({ directionSignal: "sell", signal: "sell", action: "SELL", analysisPrice: 150 }) });
  assert.equal(classifyAiEntryMoveContext(t).context, "against_ai_direction");
});

test("E: within ±2 pips → near_analysis_price", () => {
  assert.equal(classifyAiDirectionalMove(0), "near_analysis_price");
  assert.equal(classifyAiDirectionalMove(AI_ENTRY_NEUTRAL_PIPS), "near_analysis_price");
  assert.equal(classifyAiDirectionalMove(-AI_ENTRY_NEUTRAL_PIPS), "near_analysis_price");
  const t = trade({ id: "e", entryPrice: 150.02, analysisSnapshot: rich({ analysisPrice: 150 }) });
  assert.equal(classifyAiEntryMoveContext(t).context, "near_analysis_price");
});

test("F: +2 pips超 → with", () => {
  assert.equal(classifyAiDirectionalMove(AI_ENTRY_NEUTRAL_PIPS + 0.01), "with_ai_direction");
});

test("G: -2 pips未満 → against", () => {
  assert.equal(classifyAiDirectionalMove(-(AI_ENTRY_NEUTRAL_PIPS + 0.01)), "against_ai_direction");
});

test("H: direction wait → unavailable", () => {
  const t = trade({ id: "h", analysisSnapshot: rich({ directionSignal: "wait", signal: "wait", action: "WAIT" }) });
  assert.equal(classifyAiEntryMoveContext(t).context, "unavailable");
});

test("I: analysis price missing → unavailable", () => {
  const t = trade({ id: "i", analysisSnapshot: rich({ analysisPrice: null, marketPrice: null }) });
  assert.equal(classifyAiEntryMoveContext(t).context, "unavailable");
});

test("J: pair mismatch → unavailable", () => {
  const t = trade({ id: "j", pair: "USD/JPY", analysisSnapshot: rich({ pair: "EUR/JPY", analysisPrice: 160 }) });
  assert.equal(classifyAiEntryMoveContext(t).context, "unavailable");
});

test("K: OPEN trade classifiable but excluded from result metrics", () => {
  const open = trade({
    id: "k-open", status: "open", realizedPnl: null, exitPrice: null, closedAt: null,
    entryPrice: 150.1, analysisSnapshot: rich({ directionSignal: "buy", analysisPrice: 150 }),
  });
  assert.equal(classifyAiEntryMoveContext(open).context, "with_ai_direction");
  const closed = Array.from({ length: 5 }, (_, i) => trade({
    id: `k${i}`, entryPrice: 150.1, realizedPnl: 50,
    analysisSnapshot: rich({ directionSignal: "buy", analysisPrice: 150 }),
  }));
  const result = analyzeAiEntryContext([...closed, open]);
  assert.equal(result.withAi.count, 5);
});

test("L: WAIT + SELL direction classifies on SELL basis", () => {
  const t = trade({
    id: "l", side: "long", entryPrice: 149.9,
    analysisSnapshot: rich({ directionSignal: "sell", signal: "wait", action: "WAIT", analysisPrice: 150 }),
  });
  const c = classifyAiEntryMoveContext(t);
  assert.equal(c.aiDirection, "sell");
  assert.equal(c.action, "WAIT");
  assert.equal(c.context, "with_ai_direction");
});

test("M: contrary trade still classifies by AI direction", () => {
  // AI SELL, price down (with AI), but trade is BUY (contrary alignment)
  const t = trade({
    id: "m", side: "long", entryPrice: 149.9,
    analysisSnapshot: rich({ directionSignal: "sell", signal: "sell", action: "SELL", analysisPrice: 150 }),
  });
  assert.equal(classifyAiEntryMoveContext(t).context, "with_ai_direction");
});

test("N: 30D filter changes context aggregation", () => {
  const recent = Array.from({ length: 5 }, (_, i) => trade({
    id: `n-r${i}`, openedAt: daysAgo(5), entryPrice: 150.1, realizedPnl: 40,
    analysisSnapshot: rich({ directionSignal: "buy", analysisPrice: 150 }),
  }));
  const old = Array.from({ length: 5 }, (_, i) => trade({
    id: `n-o${i}`, openedAt: daysAgo(60), entryPrice: 149.9, realizedPnl: -40,
    analysisSnapshot: rich({ directionSignal: "buy", analysisPrice: 150 }),
  }));
  const all = analyzeAiEntryContext(filterTradesByPeriod([...recent, ...old], "all", NOW));
  const d30 = analyzeAiEntryContext(filterTradesByPeriod([...recent, ...old], "30d", NOW));
  assert.equal(all.withAi.count, 5);
  assert.equal(all.againstAi.count, 5);
  assert.equal(d30.withAi.count, 5);
  assert.equal(d30.againstAi.count, 0);
});

test("O: 90D includes mid-window trades", () => {
  const mid = Array.from({ length: 5 }, (_, i) => trade({
    id: `o${i}`, openedAt: daysAgo(60), entryPrice: 150.1, realizedPnl: 10,
    analysisSnapshot: rich({ directionSignal: "buy", analysisPrice: 150 }),
  }));
  const d30 = analyzeAiEntryContext(filterTradesByPeriod(mid, "30d", NOW));
  const d90 = analyzeAiEntryContext(filterTradesByPeriod(mid, "90d", NOW));
  assert.equal(d30.eligibleClosedCount, 0);
  assert.equal(d90.withAi.count, 5);
});

test("P: sample < 5 → no strong comparison insight", () => {
  const trades = Array.from({ length: 3 }, (_, i) => trade({
    id: `p${i}`, entryPrice: 150.1, realizedPnl: 10,
    analysisSnapshot: rich({ directionSignal: "buy", analysisPrice: 150 }),
  }));
  const result = analyzeAiEntryContext(trades);
  assert.ok(result.insights.some(i => i.id === "ai-entry-insufficient"));
  assert.equal(result.insights.some(i => i.id === "ai-entry-comparison"), false);
});

test("Q: sample >= 5 → deterministic with insight", () => {
  const trades = Array.from({ length: 5 }, (_, i) => trade({
    id: `q${i}`, entryPrice: 150.1, realizedPnl: 20,
    analysisSnapshot: rich({ directionSignal: "buy", analysisPrice: 150 }),
  }));
  const result = analyzeAiEntryContext(trades);
  assert.ok(result.insights.some(i => i.id === "ai-entry-with" || i.id === "ai-entry-comparison"));
});

test("R: with vs against both MIN → comparison insight", () => {
  const withAi = Array.from({ length: 5 }, (_, i) => trade({
    id: `rw${i}`, entryPrice: 150.1, realizedPnl: 50,
    analysisSnapshot: rich({ directionSignal: "buy", analysisPrice: 150 }),
  }));
  const against = Array.from({ length: 5 }, (_, i) => trade({
    id: `ra${i}`, entryPrice: 149.9, realizedPnl: -40,
    analysisSnapshot: rich({ directionSignal: "buy", analysisPrice: 150 }),
  }));
  const result = analyzeAiEntryContext([...withAi, ...against]);
  assert.ok(result.insights.some(i => i.id === "ai-entry-comparison"));
});

test("S: P/L=0 counted as break-even draw", () => {
  const trades = [
    ...Array.from({ length: 4 }, (_, i) => trade({ id: `s${i}`, entryPrice: 150.1, realizedPnl: 10, analysisSnapshot: rich({ analysisPrice: 150 }) })),
    trade({ id: "s-be", entryPrice: 150.1, realizedPnl: 0, analysisSnapshot: rich({ analysisPrice: 150 }) }),
  ];
  const result = analyzeAiEntryContext(trades);
  assert.equal(result.withAi.count, 5);
  assert.equal(result.withAi.draws, 1);
});

test("T: legacy snapshot does not crash", () => {
  const trades = Array.from({ length: 5 }, (_, i) => trade({ id: `t${i}`, analysisSnapshot: legacy() }));
  assert.doesNotThrow(() => analyzeAiEntryContext(trades));
  assert.equal(analyzeAiEntryContext(trades).emptyComparable, true);
});

test("U: null snapshot → unavailable", () => {
  const t = trade({ id: "u", analysisSnapshot: null });
  assert.equal(classifyAiEntryMoveContext(t).context, "unavailable");
});

test("V: NaN/Infinity → unavailable", () => {
  assert.equal(classifyAiEntryMoveContext(trade({ id: "v1", entryPrice: Number.NaN })).context, "unavailable");
  assert.equal(classifyAiEntryMoveContext(trade({ id: "v2", entryPrice: Number.POSITIVE_INFINITY })).context, "unavailable");
  assert.equal(aiDirectionalMovePips("buy", Number.NaN, 150, "USD/JPY"), null);
});

test("W: pure classification needs no API", () => {
  const t = trade({ id: "w", entryPrice: 150.05, analysisSnapshot: rich({ analysisPrice: 150 }) });
  assert.equal(typeof classifyAiEntryMoveContext(t).context, "string");
  assert.equal(typeof analyzeAiEntryContext([t]).eligibleClosedCount, "number");
});

test("X: no forbidden future-claim wording", () => {
  const withAi = Array.from({ length: 5 }, (_, i) => trade({
    id: `xw${i}`, entryPrice: 150.1, realizedPnl: 40,
    analysisSnapshot: rich({ directionSignal: "buy", analysisPrice: 150 }),
  }));
  const against = Array.from({ length: 5 }, (_, i) => trade({
    id: `xa${i}`, entryPrice: 149.9, realizedPnl: -30,
    analysisSnapshot: rich({ directionSignal: "buy", analysisPrice: 150 }),
  }));
  const text = analyzeAiEntryContext([...withAi, ...against]).insights.flatMap(i => [i.title, i.description]).join("\n");
  assert.equal(/AI方向へ進んだらEntryすべき|逆へ動いたら待つべき|2pips以内が最適|この形なら勝てる|AI方向へ動いた後に入れば勝て/.test(text), false);
  assert.match(text, /過去/);
});

test("Insights merge keeps MAX_INSIGHTS", () => {
  const withAi = Array.from({ length: 5 }, (_, i) => trade({
    id: `mw${i}`, entryPrice: 150.1, realizedPnl: 40, side: "long",
    analysisSnapshot: rich({ directionSignal: "buy", action: "BUY", analysisPrice: 150, confidence: 75, dataQualityScore: 80 }),
  }));
  const against = Array.from({ length: 5 }, (_, i) => trade({
    id: `ma${i}`, entryPrice: 149.9, realizedPnl: -30, side: "long",
    analysisSnapshot: rich({ directionSignal: "sell", signal: "sell", action: "SELL", analysisPrice: 150, confidence: 55 }),
  }));
  const wait = Array.from({ length: 5 }, (_, i) => trade({
    id: `mw2${i}`, entryPrice: 150.1, realizedPnl: -20, side: "short",
    analysisSnapshot: rich({ directionSignal: "buy", signal: "wait", action: "WAIT", analysisPrice: 150 }),
  }));
  const result = generateTradingInsights([...withAi, ...against, ...wait]);
  assert.ok(result.insights.length <= MAX_INSIGHTS);
  assert.ok(result.insights.some(i => i.id.startsWith("ai-entry-")));
});
