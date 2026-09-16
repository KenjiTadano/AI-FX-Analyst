import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { HigherTimeframeBias, MultiTimeframeAnalysis, TimeframeAlignment, TimeframeAnalysis, TimeframeTrend } from "../lib/market/multi-timeframe";
import { mtfTimeframes } from "../lib/market/types";
import { MIN_INSIGHT_SAMPLE_SIZE } from "../lib/trades/analysis-price";
import { filterTradesByPeriod } from "../lib/trades/performance-period";
import {
  AI_MTF_GROUP_ORDER,
  ALIGNMENT_GROUP_ORDER,
  HTF_GROUP_ORDER,
  buildMtfPerformanceAnalysis,
  classifyMtfAiDirection,
  formatContextProfitFactor,
  mtfFromTrade,
} from "../lib/trades/mtf-performance";
import type { Trade, TradeAiAnalysisSnapshot, TradeAnalysisSnapshot } from "../lib/trades/types";
import type { TradeSignal } from "../lib/ai/types";

const NOW = "2026-09-16T03:15:00.000Z";
const SOURCE = [
  readFileSync(join(process.cwd(), "lib/trades/mtf-performance.ts"), "utf8"),
  readFileSync(join(process.cwd(), "components/trades/mtf-performance.tsx"), "utf8"),
].join("\n");

const FORBIDDEN =
  /alignedだから|mixedだから|4\/4を待つべき|逆らうと負ける|この条件なら勝てる|このパターンを狙うべき|一致した方が優秀|今後一致だけ狙う|悪いEntry|良いEntry|Good Setup|Bad Setup|Entry Quality|MTF Score|勝ちパターン|おすすめ|ルール違反|Entry OK/;

function frame(tf: TimeframeAnalysis["timeframe"], trend: TimeframeTrend): TimeframeAnalysis {
  const ok = trend !== "unavailable";
  return {
    timeframe: tf,
    trend,
    structure: trend === "bullish" ? "uptrend" : trend === "bearish" ? "downtrend" : trend === "neutral" ? "mixed" : "unavailable",
    lastClose: ok ? 156.5 : null,
    sma20: ok ? 156.3 : null,
    sma75: ok ? 156.1 : null,
    sma200: ok ? 155.8 : null,
    rsi14: ok ? 55 : null,
    recentHigh: ok ? 157 : null,
    recentLow: ok ? 156 : null,
    dataPoints: ok ? 240 : 0,
    sufficientData: ok,
  };
}

function mtf(args: {
  alignment: TimeframeAlignment;
  bias: HigherTimeframeBias;
  trends?: TimeframeTrend[];
  pair?: MultiTimeframeAnalysis["pair"];
  available?: number;
}): MultiTimeframeAnalysis {
  const trends = args.trends ?? mtfTimeframes.map(tf => {
    if (args.alignment === "aligned_bullish") return "bullish";
    if (args.alignment === "aligned_bearish") return "bearish";
    if (args.alignment === "insufficient") {
      if (args.bias === "unavailable") return "unavailable";
      return tf === "15m" ? "unavailable" : args.bias === "bearish" ? "bearish" : "bullish";
    }
    if (tf === "1day" || tf === "4h") return args.bias === "bearish" ? "bearish" : args.bias === "neutral" ? "bullish" : "bullish";
    return args.bias === "neutral" ? "bearish" : "bearish";
  });
  const timeframes = mtfTimeframes.map((tf, index) => frame(tf, trends[index] ?? "unavailable"));
  if (args.bias === "neutral" && args.alignment === "mixed") {
    timeframes[0] = frame("1day", "bullish");
    timeframes[1] = frame("4h", "bearish");
    timeframes[2] = frame("1h", "bullish");
    timeframes[3] = frame("15m", "bearish");
  }
  return {
    pair: args.pair ?? "USD/JPY",
    analyzedAt: NOW,
    timeframes,
    higherTimeframeBias: args.bias,
    alignment: args.alignment,
    availableTimeframes: args.available ?? timeframes.filter(item => item.trend !== "unavailable").length,
    totalTimeframes: 4,
    conflicts: [],
  };
}

function quality() {
  return {
    score: 80,
    missingData: [] as string[],
    categories: {
      technical: { status: "ok" as const, detail: "", fraction: 1 },
      news: { status: "ok" as const, detail: "", fraction: 1 },
      economic: { status: "ok" as const, detail: "", fraction: 1 },
      central_bank: { status: "ok" as const, detail: "", fraction: 1 },
      market_environment: { status: "ok" as const, detail: "", fraction: 1 },
    },
    macroeconomicData: { status: "ok" as const, detail: "", fraction: 1 },
  };
}

function snap(opts: {
  mtf?: MultiTimeframeAnalysis | null;
  direction?: TradeSignal;
  action?: "BUY" | "SELL" | "WAIT";
} = {}): TradeAiAnalysisSnapshot {
  return {
    pair: "USD/JPY",
    signal: "wait",
    score: 10,
    confidence: 70,
    summary: "t028",
    dataQualityScore: 80,
    analyzedAt: NOW,
    capturedAt: NOW,
    expiresAt: NOW,
    aiStatus: "available",
    model: "x",
    bullishReasons: [],
    bearishReasons: [],
    version: 1,
    directionSignal: opts.direction ?? "buy",
    action: opts.action ?? "WAIT",
    marketPrice: 156.5,
    analysisPrice: 156.5,
    factors: [],
    scenario: null,
    dataQuality: quality(),
    economicRisk: null,
    chartEvidence: null,
    chartAnalysis: null,
    aiCode: null,
    isFallback: false,
    ...(opts.mtf !== undefined ? { multiTimeframeAnalysis: opts.mtf } : {}),
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
    entryPrice: 156.5,
    exitPrice: 157.0,
    openedAt: NOW,
    closedAt: NOW,
    stopLoss: null,
    takeProfit: null,
    notes: "",
    realizedPnl: 500,
    analysisSnapshot: snap({ mtf: mtf({ alignment: "aligned_bullish", bias: "bullish" }) }),
    createdAt: NOW,
    updatedAt: NOW,
    ...partial,
  };
}

function many(count: number, prefix: string, analysis: TradeAiAnalysisSnapshot | TradeAnalysisSnapshot | null, pnl: number): Trade[] {
  return Array.from({ length: count }, (_, index) => trade({
    id: `${prefix}-${index}`,
    realizedPnl: pnl,
    analysisSnapshot: analysis,
  }));
}

function group(result: ReturnType<typeof buildMtfPerformanceAnalysis>, axis: "byAlignment" | "byHigherTimeframeBias" | "byAiDirectionContext", key: string) {
  return result[axis].find(item => item.key === key);
}

test("A no trades", () => {
  const result = buildMtfPerformanceAnalysis([]);
  assert.equal(result.coverage.eligibleTrades, 0);
  assert.equal(result.coverage.withMtfContext, 0);
  assert.equal(result.coverage.coverageRate, null);
  assert.deepEqual(result.byAlignment, []);
});

test("B OPEN only", () => {
  const result = buildMtfPerformanceAnalysis([trade({ id: "open", status: "open", realizedPnl: null, closedAt: null, exitPrice: null })]);
  assert.equal(result.coverage.eligibleTrades, 0);
  assert.equal(result.coverage.withMtfContext, 0);
});

test("C invalid PnL excluded", () => {
  const result = buildMtfPerformanceAnalysis([
    trade({ id: "ok" }),
    trade({ id: "nan", realizedPnl: Number.NaN }),
    trade({ id: "inf", realizedPnl: Number.POSITIVE_INFINITY }),
  ]);
  assert.equal(result.coverage.eligibleTrades, 1);
  assert.equal(result.coverage.withMtfContext, 1);
});

test("D coverage zero eligible", () => {
  const result = buildMtfPerformanceAnalysis([]);
  assert.equal(result.coverage.coverageRate, null);
});

test("E legacy no MTF", () => {
  const result = buildMtfPerformanceAnalysis([trade({ id: "legacy", analysisSnapshot: legacy(), realizedPnl: 10 })]);
  assert.equal(result.coverage.eligibleTrades, 1);
  assert.equal(result.coverage.withMtfContext, 0);
  assert.equal(result.missingMtfTrades, 1);
  assert.equal(group(result, "byAlignment", "insufficient"), undefined);
  assert.equal(group(result, "byHigherTimeframeBias", "unavailable"), undefined);
});

test("F valid MTF coverage", () => {
  const result = buildMtfPerformanceAnalysis([
    trade({ id: "with" }),
    trade({ id: "without", analysisSnapshot: null, realizedPnl: -10 }),
  ]);
  assert.equal(result.coverage.eligibleTrades, 2);
  assert.equal(result.coverage.withMtfContext, 1);
  assert.equal(result.coverage.coverageRate, 50);
});

test("G all unavailable counts as valid", () => {
  const stored = mtf({
    alignment: "insufficient",
    bias: "unavailable",
    trends: ["unavailable", "unavailable", "unavailable", "unavailable"],
    available: 0,
  });
  const result = buildMtfPerformanceAnalysis([trade({ id: "g", analysisSnapshot: snap({ mtf: stored }) })]);
  assert.equal(result.coverage.withMtfContext, 1);
  assert.equal(group(result, "byAlignment", "insufficient")?.sampleSize, 1);
  assert.equal(group(result, "byHigherTimeframeBias", "unavailable")?.sampleSize, 1);
});

test("H partial counts as valid", () => {
  const stored = mtf({ alignment: "insufficient", bias: "bullish" });
  const result = buildMtfPerformanceAnalysis([trade({ id: "h", analysisSnapshot: snap({ mtf: stored }) })]);
  assert.equal(result.coverage.withMtfContext, 1);
  assert.equal(group(result, "byAlignment", "insufficient")?.sampleSize, 1);
  assert.equal(group(result, "byAlignment", "aligned_bullish"), undefined);
});

test("I pair mismatch contextなし", () => {
  const stored = mtf({ alignment: "aligned_bullish", bias: "bullish", pair: "EUR/JPY" });
  const item = trade({ id: "i", analysisSnapshot: snap({ mtf: stored }) });
  assert.equal(mtfFromTrade(item), null);
  const result = buildMtfPerformanceAnalysis([item]);
  assert.equal(result.coverage.withMtfContext, 0);
  assert.deepEqual(result.byAlignment, []);
});

test("J malformed contextなし", () => {
  const item = trade({ id: "j", analysisSnapshot: snap({ mtf: { pair: "USD/JPY", candles: [] } as never }) });
  const result = buildMtfPerformanceAnalysis([item]);
  assert.equal(result.coverage.withMtfContext, 0);
});

test("K aligned_bullish", () => {
  assert.equal(group(buildMtfPerformanceAnalysis([trade({ id: "k" })]), "byAlignment", "aligned_bullish")?.sampleSize, 1);
});

test("L aligned_bearish", () => {
  const stored = mtf({ alignment: "aligned_bearish", bias: "bearish" });
  assert.equal(group(buildMtfPerformanceAnalysis([trade({ id: "l", analysisSnapshot: snap({ mtf: stored, direction: "sell" }) })]), "byAlignment", "aligned_bearish")?.sampleSize, 1);
});

test("M mixed", () => {
  const stored = mtf({ alignment: "mixed", bias: "bullish" });
  assert.equal(group(buildMtfPerformanceAnalysis([trade({ id: "m", analysisSnapshot: snap({ mtf: stored }) })]), "byAlignment", "mixed")?.sampleSize, 1);
});

test("N insufficient", () => {
  const stored = mtf({ alignment: "insufficient", bias: "bullish" });
  assert.equal(group(buildMtfPerformanceAnalysis([trade({ id: "n", analysisSnapshot: snap({ mtf: stored }) })]), "byAlignment", "insufficient")?.sampleSize, 1);
});

test("O HTF bullish", () => {
  assert.equal(group(buildMtfPerformanceAnalysis([trade({ id: "o" })]), "byHigherTimeframeBias", "bullish")?.sampleSize, 1);
});

test("P HTF bearish", () => {
  const stored = mtf({ alignment: "aligned_bearish", bias: "bearish" });
  assert.equal(group(buildMtfPerformanceAnalysis([trade({ id: "p", analysisSnapshot: snap({ mtf: stored, direction: "sell" }) })]), "byHigherTimeframeBias", "bearish")?.sampleSize, 1);
});

test("Q HTF neutral", () => {
  const stored = mtf({ alignment: "mixed", bias: "neutral" });
  assert.equal(group(buildMtfPerformanceAnalysis([trade({ id: "q", analysisSnapshot: snap({ mtf: stored }) })]), "byHigherTimeframeBias", "neutral")?.sampleSize, 1);
});

test("R HTF unavailable", () => {
  const stored = mtf({ alignment: "insufficient", bias: "unavailable", trends: ["unavailable", "unavailable", "unavailable", "unavailable"], available: 0 });
  assert.equal(group(buildMtfPerformanceAnalysis([trade({ id: "r", analysisSnapshot: snap({ mtf: stored }) })]), "byHigherTimeframeBias", "unavailable")?.sampleSize, 1);
});

test("S AI BUY + bullish => aligned", () => {
  const stored = mtf({ alignment: "aligned_bullish", bias: "bullish" });
  const item = trade({ id: "s", analysisSnapshot: snap({ mtf: stored, direction: "buy", action: "WAIT" }) });
  assert.equal(classifyMtfAiDirection(item, stored), "aligned_with_ai");
  assert.equal(group(buildMtfPerformanceAnalysis([item]), "byAiDirectionContext", "aligned_with_ai")?.sampleSize, 1);
});

test("T AI SELL + bearish => aligned", () => {
  const stored = mtf({ alignment: "aligned_bearish", bias: "bearish" });
  const item = trade({ id: "t", analysisSnapshot: snap({ mtf: stored, direction: "sell" }) });
  assert.equal(group(buildMtfPerformanceAnalysis([item]), "byAiDirectionContext", "aligned_with_ai")?.sampleSize, 1);
});

test("U AI BUY + bearish => contrary", () => {
  const stored = mtf({ alignment: "aligned_bearish", bias: "bearish" });
  const item = trade({ id: "u", analysisSnapshot: snap({ mtf: stored, direction: "buy" }) });
  assert.equal(group(buildMtfPerformanceAnalysis([item]), "byAiDirectionContext", "contrary_to_ai")?.sampleSize, 1);
});

test("V AI SELL + bullish => contrary", () => {
  const stored = mtf({ alignment: "aligned_bullish", bias: "bullish" });
  const item = trade({ id: "v", analysisSnapshot: snap({ mtf: stored, direction: "sell" }) });
  assert.equal(group(buildMtfPerformanceAnalysis([item]), "byAiDirectionContext", "contrary_to_ai")?.sampleSize, 1);
});

test("W mixed AI context", () => {
  const stored = mtf({ alignment: "mixed", bias: "bullish" });
  const item = trade({ id: "w", analysisSnapshot: snap({ mtf: stored, direction: "buy" }) });
  assert.equal(group(buildMtfPerformanceAnalysis([item]), "byAiDirectionContext", "mixed")?.sampleSize, 1);
  assert.equal(group(buildMtfPerformanceAnalysis([item]), "byAiDirectionContext", "aligned_with_ai"), undefined);
});

test("X insufficient AI context", () => {
  const stored = mtf({ alignment: "insufficient", bias: "bullish" });
  const item = trade({ id: "x", analysisSnapshot: snap({ mtf: stored, direction: "buy" }) });
  assert.equal(group(buildMtfPerformanceAnalysis([item]), "byAiDirectionContext", "insufficient")?.sampleSize, 1);
});

test("Y AI direction unavailable", () => {
  const stored = mtf({ alignment: "aligned_bullish", bias: "bullish" });
  const item = trade({ id: "y", analysisSnapshot: snap({ mtf: stored, direction: "wait" }) });
  assert.equal(group(buildMtfPerformanceAnalysis([item]), "byAiDirectionContext", "ai_direction_unavailable")?.sampleSize, 1);
});

test("Z Action WAIT + Direction BUY still classifiable", () => {
  const stored = mtf({ alignment: "aligned_bullish", bias: "bullish" });
  const item = trade({ id: "z", analysisSnapshot: snap({ mtf: stored, direction: "buy", action: "WAIT" }) });
  assert.equal(classifyMtfAiDirection(item, stored), "aligned_with_ai");
  assert.doesNotMatch(JSON.stringify(buildMtfPerformanceAnalysis([item])), /ルール違反|WAITを無視/);
});

test("AA win", () => {
  assert.equal(group(buildMtfPerformanceAnalysis([trade({ id: "aa", realizedPnl: 100 })]), "byAlignment", "aligned_bullish")?.wins, 1);
});

test("AB loss", () => {
  assert.equal(group(buildMtfPerformanceAnalysis([trade({ id: "ab", realizedPnl: -100 })]), "byAlignment", "aligned_bullish")?.losses, 1);
});

test("AC break-even", () => {
  assert.equal(group(buildMtfPerformanceAnalysis([trade({ id: "ac", realizedPnl: 0 })]), "byAlignment", "aligned_bullish")?.breakEven, 1);
});

test("AD totalPnl", () => {
  const result = buildMtfPerformanceAnalysis([
    trade({ id: "ad1", realizedPnl: 100 }),
    trade({ id: "ad2", realizedPnl: -40 }),
  ]);
  assert.equal(group(result, "byAlignment", "aligned_bullish")?.totalPnl, 60);
});

test("AE averagePnl", () => {
  const result = buildMtfPerformanceAnalysis([
    trade({ id: "ae1", realizedPnl: 100 }),
    trade({ id: "ae2", realizedPnl: 200 }),
  ]);
  assert.equal(group(result, "byAlignment", "aligned_bullish")?.averagePnl, 150);
});

test("AF winRate", () => {
  const result = buildMtfPerformanceAnalysis([
    trade({ id: "af1", realizedPnl: 10 }),
    trade({ id: "af2", realizedPnl: -10 }),
  ]);
  assert.equal(group(result, "byAlignment", "aligned_bullish")?.winRate, 50);
});

test("AG PF", () => {
  const result = buildMtfPerformanceAnalysis([
    trade({ id: "ag1", realizedPnl: 200 }),
    trade({ id: "ag2", realizedPnl: -100 }),
  ]);
  assert.equal(group(result, "byAlignment", "aligned_bullish")?.profitFactor, 2);
});

test("AH PF no loss => null", () => {
  const result = buildMtfPerformanceAnalysis([trade({ id: "ah", realizedPnl: 200 })]);
  assert.equal(group(result, "byAlignment", "aligned_bullish")?.profitFactor, null);
  assert.equal(formatContextProfitFactor(null), "—");
});

test("AI sufficient sample", () => {
  const result = buildMtfPerformanceAnalysis(many(MIN_INSIGHT_SAMPLE_SIZE, "ai", snap({ mtf: mtf({ alignment: "aligned_bullish", bias: "bullish" }) }), 10));
  assert.equal(group(result, "byAlignment", "aligned_bullish")?.sufficientSample, true);
});

test("AJ insufficient sample", () => {
  const result = buildMtfPerformanceAnalysis(many(MIN_INSIGHT_SAMPLE_SIZE - 1, "aj", snap({ mtf: mtf({ alignment: "aligned_bullish", bias: "bullish" }) }), 10));
  assert.equal(group(result, "byAlignment", "aligned_bullish")?.sufficientSample, false);
});

test("AK zero-sample hidden", () => {
  const result = buildMtfPerformanceAnalysis([trade({ id: "ak" })]);
  assert.equal(result.byAlignment.some(item => item.sampleSize === 0), false);
  assert.equal(group(result, "byAlignment", "aligned_bearish"), undefined);
});

test("AL fixed order", () => {
  const result = buildMtfPerformanceAnalysis([
    trade({ id: "al-ins", analysisSnapshot: snap({ mtf: mtf({ alignment: "insufficient", bias: "bullish" }) }) }),
    trade({ id: "al-mix", analysisSnapshot: snap({ mtf: mtf({ alignment: "mixed", bias: "bullish" }) }) }),
    trade({ id: "al-down", analysisSnapshot: snap({ mtf: mtf({ alignment: "aligned_bearish", bias: "bearish" }), direction: "sell" }) }),
    trade({ id: "al-up" }),
  ]);
  assert.deepEqual(result.byAlignment.map(item => item.key), [...ALIGNMENT_GROUP_ORDER]);
  assert.deepEqual(AI_MTF_GROUP_ORDER.slice(0, 3), ["aligned_with_ai", "contrary_to_ai", "mixed"]);
  assert.deepEqual([...HTF_GROUP_ORDER], ["bullish", "bearish", "neutral", "unavailable"]);
});

test("AM comparisons max 3", () => {
  const bullish = many(5, "am-up", snap({ mtf: mtf({ alignment: "aligned_bullish", bias: "bullish" }), direction: "buy" }), 100);
  const contrary = many(5, "am-ctr", snap({ mtf: mtf({ alignment: "aligned_bearish", bias: "bearish" }), direction: "buy" }), -50);
  const mixed = many(5, "am-mix", snap({ mtf: mtf({ alignment: "mixed", bias: "bullish" }), direction: "buy" }), 10);
  const result = buildMtfPerformanceAnalysis([...bullish, ...contrary, ...mixed]);
  assert.ok(result.comparisons.length <= 3);
});

test("AN comparison insufficient excluded", () => {
  const aligned = many(5, "an-a", snap({ mtf: mtf({ alignment: "aligned_bullish", bias: "bullish" }), direction: "buy" }), 100);
  const contrary = many(2, "an-c", snap({ mtf: mtf({ alignment: "aligned_bearish", bias: "bearish" }), direction: "buy" }), -50);
  const result = buildMtfPerformanceAnalysis([...aligned, ...contrary]);
  assert.equal(result.comparisons.some(item => item.id === "ai-aligned-contrary"), false);
});

test("AO no causal wording", () => {
  const result = buildMtfPerformanceAnalysis(many(5, "ao", snap({ mtf: mtf({ alignment: "aligned_bullish", bias: "bullish" }) }), 10));
  assert.doesNotMatch(JSON.stringify(result), FORBIDDEN);
  assert.doesNotMatch(JSON.stringify(result), /待つべき|逆らうと負ける|だから勝率/);
});

test("AP no recommendation wording", () => {
  const ui = SOURCE.replace(/const FORBIDDEN[\s\S]*?;/, "");
  assert.doesNotMatch(ui, /おすすめ|Entry OK|GO\b|狙うべき|4\/4を待つべき/);
});

test("AQ period input only", () => {
  assert.doesNotMatch(SOURCE, /filterTradesByPeriod|PERFORMANCE_PERIODS|PERIOD_WINDOW_MS/);
});

test("AR no internal date filter", () => {
  const recent = trade({ id: "ar-recent", openedAt: "2026-09-10T00:00:00.000Z" });
  const old = trade({ id: "ar-old", openedAt: "2026-01-01T00:00:00.000Z" });
  const all = buildMtfPerformanceAnalysis([recent, old]);
  assert.equal(all.coverage.eligibleTrades, 2);
  const filtered = filterTradesByPeriod([recent, old], "30d", Date.parse(NOW));
  assert.equal(buildMtfPerformanceAnalysis(filtered).coverage.eligibleTrades, 1);
});

test("AS no snapshot mutation", () => {
  const item = trade({ id: "as" });
  const before = JSON.stringify(item.analysisSnapshot);
  buildMtfPerformanceAnalysis([item]);
  assert.equal(JSON.stringify(item.analysisSnapshot), before);
});

test("AT current Live ignored", () => {
  assert.doesNotMatch(SOURCE, /multiTimeframeForPair|buildMultiTimeframeAnalysis|useMarket/);
  const first = buildMtfPerformanceAnalysis([trade({ id: "at" })]);
  const second = buildMtfPerformanceAnalysis([trade({ id: "at" })]);
  assert.deepEqual(first, second);
});

test("AU current AI ignored", () => {
  assert.doesNotMatch(SOURCE, /finalizeAnalysis|createAnalysisService|\/api\/analysis/);
});

test("AV current market ignored", () => {
  assert.doesNotMatch(SOURCE, /\/api\/market|getMarketData|MarketData/);
});

test("AW no API", () => {
  assert.doesNotMatch(SOURCE, /fetch\(|openai|twelvedata|finnhub|stlouisfed|eodhd/);
});

test("AX no Supabase query", () => {
  assert.doesNotMatch(SOURCE, /supabase|from\("trades"\)/);
});

test("AY no polling", () => {
  assert.doesNotMatch(SOURCE, /setInterval|setTimeout/);
});

test("AZ deterministic", () => {
  const input = [
    trade({ id: "az1", realizedPnl: 20 }),
    trade({ id: "az2", realizedPnl: -5, analysisSnapshot: snap({ mtf: mtf({ alignment: "mixed", bias: "bullish" }) }) }),
  ];
  assert.deepEqual(buildMtfPerformanceAnalysis(input), buildMtfPerformanceAnalysis(input));
});

test("critical 1 WAIT + BUY + bullish is aligned_with_ai", () => {
  const stored = mtf({ alignment: "aligned_bullish", bias: "bullish" });
  const trades = many(5, "c1", snap({ mtf: stored, direction: "buy", action: "WAIT" }), 100);
  const result = buildMtfPerformanceAnalysis(trades);
  assert.equal(group(result, "byAiDirectionContext", "aligned_with_ai")?.sampleSize, 5);
  assert.doesNotMatch(JSON.stringify(result), /違反|無視/);
});

test("critical 2 BUY + bearish is contrary without 悪い", () => {
  const stored = mtf({ alignment: "aligned_bearish", bias: "bearish" });
  const trades = many(5, "c2", snap({ mtf: stored, direction: "buy" }), -20);
  const result = buildMtfPerformanceAnalysis(trades);
  assert.equal(group(result, "byAiDirectionContext", "contrary_to_ai")?.label, "逆方向");
  assert.doesNotMatch(JSON.stringify(result), /悪い|避けるべき/);
});

test("critical 3 legacy not mixed into insufficient", () => {
  const insufficient = many(5, "c3-ins", snap({ mtf: mtf({ alignment: "insufficient", bias: "bullish" }) }), 10);
  const legacyTrades = many(5, "c3-leg", legacy(), 10);
  const result = buildMtfPerformanceAnalysis([...insufficient, ...legacyTrades]);
  assert.equal(result.coverage.withMtfContext, 5);
  assert.equal(result.coverage.eligibleTrades, 10);
  assert.equal(group(result, "byAlignment", "insufficient")?.sampleSize, 5);
});

test("critical 4 all-unavailable is valid insufficient/unavailable", () => {
  const stored = mtf({
    alignment: "insufficient",
    bias: "unavailable",
    trends: ["unavailable", "unavailable", "unavailable", "unavailable"],
    available: 0,
  });
  const result = buildMtfPerformanceAnalysis(many(3, "c4", snap({ mtf: stored }), 0));
  assert.equal(result.coverage.withMtfContext, 3);
  assert.equal(group(result, "byAlignment", "insufficient")?.sampleSize, 3);
  assert.equal(group(result, "byHigherTimeframeBias", "unavailable")?.sampleSize, 3);
});

test("critical 5 same trades stay equal without live rewrite", () => {
  const trades = [trade({ id: "c5" })];
  const a = buildMtfPerformanceAnalysis(trades);
  const b = buildMtfPerformanceAnalysis(trades);
  assert.deepEqual(a, b);
  assert.equal(group(a, "byAlignment", "aligned_bullish")?.sampleSize, 1);
});

test("reuses MIN_INSIGHT_SAMPLE_SIZE", () => {
  assert.match(SOURCE, /MIN_INSIGHT_SAMPLE_SIZE/);
  assert.doesNotMatch(SOURCE, /MIN_INSIGHT_SAMPLE_SIZE\s*=/);
  assert.equal(MIN_INSIGHT_SAMPLE_SIZE, 5);
});
