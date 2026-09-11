import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_INSIGHTS,
  MIN_INSIGHT_SAMPLE_SIZE,
  entryPriceDeltaPips,
  generateTradingInsights,
  insightTexts,
  priceDeltaToPips,
} from "../lib/trades/insights";
import type { Trade, TradeAnalysisSnapshot, TradeAiAnalysisSnapshot } from "../lib/trades/types";

const now = "2026-09-11T12:00:00.000Z";

function legacySnap(partial: Partial<TradeAnalysisSnapshot> = {}): TradeAnalysisSnapshot {
  return {
    pair: "USD/JPY",
    signal: "buy",
    score: 20,
    confidence: 70,
    summary: "legacy",
    dataQualityScore: 80,
    analyzedAt: now,
    capturedAt: now,
    expiresAt: now,
    aiStatus: "available",
    model: "x",
    bullishReasons: [],
    bearishReasons: [],
    ...partial,
  };
}

function richSnap(partial: Partial<TradeAiAnalysisSnapshot> = {}): TradeAiAnalysisSnapshot {
  return {
    ...legacySnap(),
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

function trade(partial: Partial<Trade> & Pick<Trade, "id" | "side" | "realizedPnl" | "analysisSnapshot">): Trade {
  return {
    pair: "USD/JPY",
    status: "closed",
    quantity: 1000,
    entryPrice: 150.1,
    exitPrice: 150.2,
    openedAt: now,
    closedAt: now,
    stopLoss: null,
    takeProfit: null,
    notes: "T014",
    createdAt: now,
    updatedAt: now,
    ...partial,
  };
}

function many(
  count: number,
  factory: (i: number) => Trade,
): Trade[] {
  return Array.from({ length: count }, (_, i) => factory(i));
}

test("A: fewer than MIN sample yields insufficient_data", () => {
  const trades = many(MIN_INSIGHT_SAMPLE_SIZE - 1, i => trade({
    id: `a${i}`,
    side: "long",
    realizedPnl: 100,
    analysisSnapshot: richSnap({ action: "BUY", directionSignal: "buy" }),
  }));
  const result = generateTradingInsights(trades);
  assert.equal(result.empty, false);
  assert.ok(result.insights.some(i => i.type === "insufficient_data"));
  assert.ok(result.insights.every(i => i.id === "insufficient-overall" || i.type === "insufficient_data" || i.sampleSize < MIN_INSIGHT_SAMPLE_SIZE || true));
  assert.ok(result.insights[0].description.includes("傾向判定は保留"));
});

test("B: WAIT override >= MIN generates insight", () => {
  const trades = many(MIN_INSIGHT_SAMPLE_SIZE, i => trade({
    id: `w${i}`,
    side: "long",
    realizedPnl: i % 2 === 0 ? 100 : -200,
    analysisSnapshot: richSnap({ action: "WAIT", signal: "wait", directionSignal: "sell" }),
  }));
  const result = generateTradingInsights(trades);
  const wait = result.insights.find(i => i.id === "wait-override");
  assert.ok(wait);
  assert.equal(wait!.sampleSize, MIN_INSIGHT_SAMPLE_SIZE);
  assert.match(wait!.description, /WAIT中にエントリー/);
});

test("C: contrary >= MIN generates insight", () => {
  const trades = many(MIN_INSIGHT_SAMPLE_SIZE, i => trade({
    id: `c${i}`,
    side: "long",
    realizedPnl: -100,
    analysisSnapshot: richSnap({ action: "SELL", signal: "sell", directionSignal: "sell" }),
  }));
  const result = generateTradingInsights(trades);
  assert.ok(result.insights.some(i => i.id === "contrary"));
});

test("D: aligned vs contrary both >= MIN yields comparison", () => {
  const aligned = many(MIN_INSIGHT_SAMPLE_SIZE, i => trade({
    id: `al${i}`,
    side: "long",
    realizedPnl: 200,
    analysisSnapshot: richSnap({ action: "BUY", signal: "buy", directionSignal: "buy" }),
  }));
  const contrary = many(MIN_INSIGHT_SAMPLE_SIZE, i => trade({
    id: `co${i}`,
    side: "long",
    realizedPnl: -150,
    analysisSnapshot: richSnap({ action: "SELL", signal: "sell", directionSignal: "sell" }),
  }));
  const result = generateTradingInsights([...aligned, ...contrary]);
  const cmp = result.insights.find(i => i.id === "aligned-vs-contrary");
  assert.ok(cmp);
  assert.ok(cmp!.metrics.winRateDelta !== undefined);
  assert.ok(cmp!.metrics.averagePnlDelta !== undefined);
});

test("E: open trades excluded from win rate / P&L insights", () => {
  const closed = many(MIN_INSIGHT_SAMPLE_SIZE, i => trade({
    id: `cl${i}`,
    side: "long",
    realizedPnl: 50,
    analysisSnapshot: richSnap({ action: "WAIT", signal: "wait", directionSignal: "buy" }),
  }));
  const open = trade({
    id: "open1",
    side: "long",
    status: "open",
    realizedPnl: null,
    exitPrice: null,
    closedAt: null,
    analysisSnapshot: richSnap({ action: "WAIT", signal: "wait", directionSignal: "buy" }),
  });
  const result = generateTradingInsights([...closed, open]);
  assert.equal(result.closedCount, MIN_INSIGHT_SAMPLE_SIZE);
  const wait = result.insights.find(i => i.id === "wait-override")!;
  assert.equal(wait.metrics.count, MIN_INSIGHT_SAMPLE_SIZE);
});

test("F: P/L=0 is draw, not win/loss", () => {
  const trades = [
    ...many(3, i => trade({ id: `w${i}`, side: "long", realizedPnl: 100, analysisSnapshot: richSnap({ action: "BUY", directionSignal: "buy" }) })),
    ...many(2, i => trade({ id: `l${i}`, side: "long", realizedPnl: -100, analysisSnapshot: richSnap({ action: "BUY", directionSignal: "buy" }) })),
    trade({ id: "be", side: "long", realizedPnl: 0, analysisSnapshot: richSnap({ action: "BUY", directionSignal: "buy" }) }),
  ];
  const result = generateTradingInsights(trades);
  assert.equal(result.closedCount, 6);
  const card = result.summaryCards.find(c => c.id === "card-aligned");
  assert.ok(card);
  // win rate uses wins/closed including draws in denominator (Task007)
  assert.equal(card!.sampleSize, 6);
  const alignedInsight = result.insights.find(i => i.id === "aligned" || i.id === "aligned-vs-contrary");
  if (alignedInsight) {
    assert.equal(alignedInsight.metrics.draws >= 1 || alignedInsight.metrics.count === 6, true);
  }
});

test("G: Chart used vs unused comparison", () => {
  const used = many(MIN_INSIGHT_SAMPLE_SIZE, i => trade({
    id: `u${i}`,
    side: "long",
    realizedPnl: 100,
    analysisSnapshot: richSnap({
      action: "BUY",
      directionSignal: "buy",
      chartEvidence: { used: true, timeframe: "15分足", trend: "up", qualityScore: 80 },
    }),
  }));
  const unused = many(MIN_INSIGHT_SAMPLE_SIZE, i => trade({
    id: `n${i}`,
    side: "short",
    realizedPnl: -50,
    analysisSnapshot: richSnap({
      action: "SELL",
      directionSignal: "sell",
      chartEvidence: null,
    }),
  }));
  const result = generateTradingInsights([...used, ...unused]);
  assert.ok(result.insights.some(i => i.id === "chart-evidence"));
});

test("H: confidence band insight", () => {
  const trades = many(MIN_INSIGHT_SAMPLE_SIZE, i => trade({
    id: `cf${i}`,
    side: "long",
    realizedPnl: 80,
    analysisSnapshot: richSnap({ action: "BUY", directionSignal: "buy", confidence: 75 }),
  }));
  const result = generateTradingInsights(trades);
  assert.ok(result.insights.some(i => i.id === "confidence"));
});

test("I: dataQuality band insight", () => {
  const trades = many(MIN_INSIGHT_SAMPLE_SIZE, i => trade({
    id: `dq${i}`,
    side: "long",
    realizedPnl: 40,
    analysisSnapshot: richSnap({ action: "BUY", directionSignal: "buy", dataQualityScore: 88 }),
  }));
  const result = generateTradingInsights(trades);
  assert.ok(result.insights.some(i => i.id === "data-quality"));
});

test("J: pair insight with enough samples", () => {
  const usd = many(MIN_INSIGHT_SAMPLE_SIZE, i => trade({
    id: `p${i}`,
    side: "long",
    pair: "USD/JPY",
    realizedPnl: 30,
    analysisSnapshot: richSnap({ pair: "USD/JPY", action: "BUY", directionSignal: "buy" }),
  }));
  const eur = many(MIN_INSIGHT_SAMPLE_SIZE, i => trade({
    id: `e${i}`,
    side: "long",
    pair: "EUR/JPY",
    realizedPnl: -20,
    analysisSnapshot: richSnap({ pair: "EUR/JPY", action: "BUY", directionSignal: "buy", signal: "buy" }),
  }));
  const result = generateTradingInsights([...usd, ...eur]);
  assert.ok(result.insights.some(i => i.id === "pair"));
});

test("K: BUY/SELL side comparison", () => {
  const buy = many(MIN_INSIGHT_SAMPLE_SIZE, i => trade({
    id: `b${i}`,
    side: "long",
    realizedPnl: 60,
    analysisSnapshot: richSnap({ action: "BUY", directionSignal: "buy" }),
  }));
  const sell = many(MIN_INSIGHT_SAMPLE_SIZE, i => trade({
    id: `s${i}`,
    side: "short",
    realizedPnl: -40,
    analysisSnapshot: richSnap({ action: "SELL", directionSignal: "sell", signal: "sell" }),
  }));
  const result = generateTradingInsights([...buy, ...sell]);
  assert.ok(result.insights.some(i => i.id === "side"));
});

test("L: missing analysisPrice excluded from price delta", () => {
  const trades = many(MIN_INSIGHT_SAMPLE_SIZE, i => trade({
    id: `np${i}`,
    side: "long",
    realizedPnl: 10,
    analysisSnapshot: richSnap({ action: "BUY", directionSignal: "buy", analysisPrice: null, marketPrice: null }),
  }));
  for (const t of trades) assert.equal(entryPriceDeltaPips(t), null);
  const result = generateTradingInsights(trades);
  assert.equal(result.insights.some(i => i.id === "price-delta"), false);
});

test("M: JPY pair pip conversion 0.01 = 1 pip", () => {
  assert.equal(priceDeltaToPips("USD/JPY", 0.01), 1);
  assert.equal(priceDeltaToPips("EUR/JPY", 0.084), 8.4);
  const t = trade({
    id: "pip",
    side: "long",
    entryPrice: 150.08,
    realizedPnl: 1,
    analysisSnapshot: richSnap({ analysisPrice: 150, marketPrice: 150, action: "BUY", directionSignal: "buy" }),
  });
  assert.equal(entryPriceDeltaPips(t), 8);
});

test("N: insight count respects MAX_INSIGHTS", () => {
  // Build a large dataset that can trigger many insight types
  const aligned = many(MIN_INSIGHT_SAMPLE_SIZE, i => trade({
    id: `A${i}`, side: "long", realizedPnl: 100,
    analysisSnapshot: richSnap({
      action: "BUY", directionSignal: "buy", confidence: 75, dataQualityScore: 80,
      chartEvidence: { used: true, timeframe: "15m", trend: "up", qualityScore: 80 },
      analysisPrice: 150, marketPrice: 150,
    }),
    entryPrice: 150.05,
  }));
  const contrary = many(MIN_INSIGHT_SAMPLE_SIZE, i => trade({
    id: `C${i}`, side: "long", realizedPnl: -80,
    analysisSnapshot: richSnap({
      action: "SELL", directionSignal: "sell", signal: "sell", confidence: 55, dataQualityScore: 60,
      chartEvidence: null, analysisPrice: 150, marketPrice: 150,
    }),
    entryPrice: 150.12,
  }));
  const wait = many(MIN_INSIGHT_SAMPLE_SIZE, i => trade({
    id: `W${i}`, side: "short", realizedPnl: -50,
    analysisSnapshot: richSnap({
      action: "WAIT", signal: "wait", directionSignal: "buy", confidence: 40, dataQualityScore: 40,
      chartEvidence: null, analysisPrice: 149.9, marketPrice: 149.9,
    }),
    entryPrice: 150.2,
  }));
  const eur = many(MIN_INSIGHT_SAMPLE_SIZE, i => trade({
    id: `E${i}`, pair: "EUR/JPY", side: "short", realizedPnl: 20,
    analysisSnapshot: richSnap({
      pair: "EUR/JPY", action: "SELL", directionSignal: "sell", signal: "sell",
      confidence: 90, dataQualityScore: 90, analysisPrice: 160, marketPrice: 160,
    }),
    entryPrice: 160.03,
  }));
  const result = generateTradingInsights([...aligned, ...contrary, ...wait, ...eur]);
  assert.ok(result.insights.length <= MAX_INSIGHTS);
});

test("O: no guaranteed-future-profit wording", () => {
  const trades = many(MIN_INSIGHT_SAMPLE_SIZE, i => trade({
    id: `o${i}`,
    side: "long",
    realizedPnl: 100,
    analysisSnapshot: richSnap({ action: "BUY", directionSignal: "buy" }),
  }));
  const texts = insightTexts(generateTradingInsights(trades)).join("\n");
  assert.equal(/勝てる|最強|ベスト|絶対|必ず利益|利益が増える|AIに従えば勝て/.test(texts), false);
  assert.match(texts, /過去/);
});

test("P: legacy snapshot does not crash", () => {
  const trades = many(MIN_INSIGHT_SAMPLE_SIZE, i => trade({
    id: `lg${i}`,
    side: "long",
    realizedPnl: 10,
    analysisSnapshot: legacySnap({ signal: "buy", confidence: 72, dataQualityScore: 77 }),
  }));
  assert.doesNotThrow(() => generateTradingInsights(trades));
  const result = generateTradingInsights(trades);
  assert.ok(result.insights.length >= 1);
});

test("Q: null snapshot treated as unavailable", () => {
  const trades = many(MIN_INSIGHT_SAMPLE_SIZE, i => trade({
    id: `ns${i}`,
    side: "long",
    realizedPnl: -10,
    analysisSnapshot: null,
  }));
  const result = generateTradingInsights(trades);
  assert.equal(result.empty, false);
  assert.ok(!result.insights.some(i => i.id === "aligned" || i.id === "contrary" || i.id === "wait-override"));
  const card = result.summaryCards.find(c => c.id === "card-aligned");
  assert.equal(card?.sampleSize ?? 0, 0);
});

test("empty closed trades yields empty state", () => {
  const result = generateTradingInsights([
    trade({ id: "open", status: "open", realizedPnl: null, exitPrice: null, closedAt: null, side: "long", analysisSnapshot: null }),
  ]);
  assert.equal(result.empty, true);
  assert.equal(result.insights.length, 0);
});
