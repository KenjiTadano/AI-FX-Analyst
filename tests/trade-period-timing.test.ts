import test from "node:test";
import assert from "node:assert/strict";
import {
  absolutePipsBand,
  analyzeEntryTiming,
  computeEntryTimingPoint,
  directionalEntryMovePips,
} from "../lib/trades/entry-timing";
import { analysisReferencePrice, generateTradingInsights, priceDeltaToPips } from "../lib/trades/insights";
import { filterTradesByPeriod, periodTradeCounts } from "../lib/trades/performance-period";
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
    summary: "t015",
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

function legacy(partial: Partial<TradeAnalysisSnapshot> = {}): TradeAnalysisSnapshot {
  return {
    pair: "USD/JPY",
    signal: "buy",
    score: 10,
    confidence: 70,
    summary: "legacy",
    dataQualityScore: 80,
    analyzedAt: NOW,
    capturedAt: NOW,
    expiresAt: NOW,
    aiStatus: "available",
    model: "x",
    bullishReasons: [],
    bearishReasons: [],
    ...partial,
  };
}

function trade(partial: Partial<Trade> & Pick<Trade, "id" | "openedAt">): Trade {
  return {
    pair: "USD/JPY",
    side: "long",
    status: "closed",
    quantity: 1000,
    entryPrice: 150.1,
    exitPrice: 150.2,
    closedAt: NOW,
    stopLoss: null,
    takeProfit: null,
    notes: "T015",
    realizedPnl: 100,
    analysisSnapshot: rich(),
    createdAt: NOW,
    updatedAt: NOW,
    ...partial,
  };
}

function atDaysAgo(days: number): string {
  return new Date(NOW_MS - days * DAY).toISOString();
}

test("A: period=all returns all trades", () => {
  const trades = [trade({ id: "a1", openedAt: atDaysAgo(100) }), trade({ id: "a2", openedAt: atDaysAgo(1) })];
  assert.equal(filterTradesByPeriod(trades, "all", NOW).length, 2);
});

test("B: 30D keeps trades within 30 days", () => {
  const trades = [
    trade({ id: "b1", openedAt: atDaysAgo(10) }),
    trade({ id: "b2", openedAt: atDaysAgo(40) }),
  ];
  const filtered = filterTradesByPeriod(trades, "30d", NOW);
  assert.deepEqual(filtered.map(t => t.id), ["b1"]);
});

test("C: 90D keeps trades within 90 days", () => {
  const trades = [
    trade({ id: "c1", openedAt: atDaysAgo(60) }),
    trade({ id: "c2", openedAt: atDaysAgo(100) }),
  ];
  const filtered = filterTradesByPeriod(trades, "90d", NOW);
  assert.deepEqual(filtered.map(t => t.id), ["c1"]);
});

test("D: 30-day boundary is inclusive", () => {
  const exact = trade({ id: "d1", openedAt: new Date(NOW_MS - 30 * DAY).toISOString() });
  assert.equal(filterTradesByPeriod([exact], "30d", NOW).length, 1);
});

test("E: 31 days ago excluded from 30D", () => {
  const old = trade({ id: "e1", openedAt: atDaysAgo(31) });
  assert.equal(filterTradesByPeriod([old], "30d", NOW).length, 0);
});

test("F: OPEN trades stay in filtered set but not in result metrics", () => {
  const open = trade({
    id: "f-open",
    openedAt: atDaysAgo(2),
    status: "open",
    realizedPnl: null,
    exitPrice: null,
    closedAt: null,
  });
  const closed = trade({ id: "f-closed", openedAt: atDaysAgo(2), realizedPnl: 50 });
  const filtered = filterTradesByPeriod([open, closed], "30d", NOW);
  assert.equal(filtered.length, 2);
  const counts = periodTradeCounts(filtered);
  assert.equal(counts.closed, 1);
  assert.equal(counts.open, 1);
  const insights = generateTradingInsights(filtered);
  assert.equal(insights.closedCount, 1);
});

test("G: period change alters Insights input set", () => {
  const recent = Array.from({ length: 5 }, (_, i) => trade({
    id: `g-r${i}`,
    openedAt: atDaysAgo(5),
    realizedPnl: 100,
    analysisSnapshot: rich({ action: "WAIT", signal: "wait", directionSignal: "sell" }),
  }));
  const old = Array.from({ length: 5 }, (_, i) => trade({
    id: `g-o${i}`,
    openedAt: atDaysAgo(60),
    realizedPnl: -100,
    analysisSnapshot: rich({ action: "WAIT", signal: "wait", directionSignal: "sell" }),
  }));
  const all = generateTradingInsights(filterTradesByPeriod([...recent, ...old], "all", NOW));
  const d30 = generateTradingInsights(filterTradesByPeriod([...recent, ...old], "30d", NOW));
  assert.equal(all.closedCount, 10);
  assert.equal(d30.closedCount, 5);
  const waitAll = all.insights.find(i => i.id === "wait-override");
  const wait30 = d30.insights.find(i => i.id === "wait-override");
  assert.ok(waitAll && wait30);
  assert.notEqual(waitAll!.metrics.totalPnl, wait30!.metrics.totalPnl);
});

test("H: analysisPrice is preferred", () => {
  const t = trade({
    id: "h1",
    openedAt: NOW,
    entryPrice: 150.1,
    analysisSnapshot: rich({ analysisPrice: 150, marketPrice: 149 }),
  });
  assert.equal(analysisReferencePrice(t), 150);
});

test("I: marketPrice used when analysisPrice missing", () => {
  const t = trade({
    id: "i1",
    openedAt: NOW,
    analysisSnapshot: rich({ analysisPrice: null, marketPrice: 149.5 }),
  });
  assert.equal(analysisReferencePrice(t), 149.5);
});

test("J: both missing excludes timing", () => {
  const t = trade({
    id: "j1",
    openedAt: NOW,
    analysisSnapshot: rich({ analysisPrice: null, marketPrice: null }),
  });
  assert.equal(computeEntryTimingPoint(t), null);
});

test("K: USDJPY 0.01 difference is 1 pip", () => {
  assert.equal(priceDeltaToPips("USD/JPY", 0.01), 1);
});

test("L: BUY + price up → directional positive", () => {
  const t = trade({ id: "l1", openedAt: NOW, side: "long", entryPrice: 150.08, analysisSnapshot: rich({ analysisPrice: 150 }) });
  assert.equal(directionalEntryMovePips(t, 150), 8);
});

test("M: BUY + price down → directional negative", () => {
  const t = trade({ id: "m1", openedAt: NOW, side: "long", entryPrice: 149.95, analysisSnapshot: rich({ analysisPrice: 150 }) });
  assert.equal(directionalEntryMovePips(t, 150), -5);
});

test("N: SELL + price down → directional positive", () => {
  const t = trade({ id: "n1", openedAt: NOW, side: "short", entryPrice: 149.9, analysisSnapshot: rich({ analysisPrice: 150 }) });
  assert.equal(directionalEntryMovePips(t, 150), 10);
});

test("O: SELL + price up → directional negative", () => {
  const t = trade({ id: "o1", openedAt: NOW, side: "short", entryPrice: 150.04, analysisSnapshot: rich({ analysisPrice: 150 }) });
  assert.equal(directionalEntryMovePips(t, 150), -4);
});

test("P: absolute pip band boundaries are half-open", () => {
  assert.equal(absolutePipsBand(0), "0-5");
  assert.equal(absolutePipsBand(4.99), "0-5");
  assert.equal(absolutePipsBand(5), "5-10");
  assert.equal(absolutePipsBand(9.99), "5-10");
  assert.equal(absolutePipsBand(10), "10-20");
  assert.equal(absolutePipsBand(19.99), "10-20");
  assert.equal(absolutePipsBand(20), "20+");
  assert.equal(absolutePipsBand(100), "20+");
});

test("Q: pair mismatch excludes timing", () => {
  const t = trade({
    id: "q1",
    openedAt: NOW,
    pair: "USD/JPY",
    analysisSnapshot: rich({ pair: "EUR/JPY", analysisPrice: 160 }),
  });
  assert.equal(computeEntryTimingPoint(t), null);
});

test("R: NaN/invalid entry price excludes timing", () => {
  const t = trade({ id: "r1", openedAt: NOW, entryPrice: Number.NaN });
  assert.equal(computeEntryTimingPoint(t), null);
  const t2 = trade({ id: "r2", openedAt: NOW, entryPrice: 0 });
  assert.equal(computeEntryTimingPoint(t2), null);
  const t3 = trade({ id: "r3", openedAt: NOW, entryPrice: Number.POSITIVE_INFINITY });
  assert.equal(computeEntryTimingPoint(t3), null);
});

test("S: sample < 5 → no strong timing band insight", () => {
  const trades = Array.from({ length: 3 }, (_, i) => trade({
    id: `s${i}`,
    openedAt: NOW,
    entryPrice: 150.03,
    realizedPnl: 10,
    analysisSnapshot: rich({ analysisPrice: 150 }),
  }));
  const result = analyzeEntryTiming(trades);
  assert.ok(result.insights.some(i => i.id === "timing-insufficient"));
  assert.equal(result.insights.some(i => i.id.startsWith("timing-band-")), false);
});

test("T: sample >= 5 yields deterministic timing insight", () => {
  const trades = Array.from({ length: 5 }, (_, i) => trade({
    id: `t${i}`,
    openedAt: NOW,
    entryPrice: 150.03,
    realizedPnl: 20,
    analysisSnapshot: rich({ analysisPrice: 150 }),
  }));
  const result = analyzeEntryTiming(trades);
  assert.ok(result.insights.some(i => i.id === "timing-band-0-5" || i.id === "timing-average"));
  assert.equal(result.averageAbsolutePips, 3);
});

test("U: legacy snapshot does not crash", () => {
  const trades = Array.from({ length: 5 }, (_, i) => trade({
    id: `u${i}`,
    openedAt: NOW,
    analysisSnapshot: legacy(),
  }));
  assert.doesNotThrow(() => analyzeEntryTiming(trades));
  assert.equal(analyzeEntryTiming(trades).empty, true);
});

test("V: empty period yields empty filter and empty insights", () => {
  const trades = [trade({ id: "v1", openedAt: atDaysAgo(120) })];
  const filtered = filterTradesByPeriod(trades, "30d", NOW);
  assert.equal(filtered.length, 0);
  const insights = generateTradingInsights(filtered);
  assert.equal(insights.empty, true);
});

test("W: no guaranteed future-profit wording in timing insights", () => {
  const trades = Array.from({ length: 5 }, (_, i) => trade({
    id: `w${i}`,
    openedAt: NOW,
    entryPrice: 150.06,
    realizedPnl: i % 2 === 0 ? 30 : -20,
    analysisSnapshot: rich({ analysisPrice: 150 }),
  }));
  const text = analyzeEntryTiming(trades).insights.flatMap(i => [i.title, i.description, i.suggestion ?? ""]).join("\n");
  assert.equal(/次は.*入るべき|5pips以内なら勝て|このタイミングなら利益|Entryが遅い|必ず勝てる/.test(text), false);
  assert.match(text, /過去/);
});
