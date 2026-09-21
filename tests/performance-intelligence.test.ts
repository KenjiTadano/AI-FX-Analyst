import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TradeSignal } from "../lib/ai/types";
import {
  sanitizeMarketRegimeAnalysis,
  type MarketRegimeAnalysis,
  type MarketRegimeKind,
  type VolatilityRegime,
} from "../lib/market/market-regime";
import type { HigherTimeframeBias, MultiTimeframeAnalysis, TimeframeAlignment, TimeframeAnalysis, TimeframeTrend } from "../lib/market/multi-timeframe";
import { mtfTimeframes } from "../lib/market/types";
import { MIN_INSIGHT_SAMPLE_SIZE } from "../lib/trades/analysis-price";
import { createExitPlan } from "../lib/trades/exit-plan";
import { filterTradesByPeriod } from "../lib/trades/performance-period";
import {
  MAX_PERFORMANCE_OBSERVATIONS,
  buildPerformanceIntelligence,
  calculateContextSummary,
  classifyRDistributionBucket,
  classifyRsiBucket,
  classifySavedAiDirection,
  classifySavedRegimeGroup,
  classifySavedVolatility,
  classifySmaContexts,
  realizedROrNull,
  savedTechnicalPoint,
  savedTimeframeTrend,
} from "../lib/trades/performance-intelligence";
import type { Trade, TradeAiAnalysisSnapshot, TradeAnalysisSnapshot, PreTradeContextSnapshot } from "../lib/trades/types";
import type { StructuredEntryTrigger } from "../lib/ai/entry-trigger";

const NOW = "2026-09-20T03:15:00.000Z";
const ROOT = process.cwd();
const SOURCE = [
  readFileSync(join(ROOT, "lib/trades/performance-intelligence.ts"), "utf8"),
  readFileSync(join(ROOT, "components/trades/performance-intelligence.tsx"), "utf8"),
].join("\n");

const FORBIDDEN =
  /この条件で取引すると有利|トレンド相場を狙うべき|レンジを避けるべき|勝ちパターン|今後も期待できる|優位性がある|\bbest\b|\bworst\b|good context|bad context|high quality|\bscore\b|有意に高い|統計的に優位|統計的有意|Date\.now\(|買うべき|最も勝てる|今後この戦略/;

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

function frame(
  tf: TimeframeAnalysis["timeframe"],
  trend: TimeframeTrend,
  overrides: Partial<Omit<TimeframeAnalysis, "timeframe" | "trend" | "structure" | "sufficientData">> = {},
): TimeframeAnalysis {
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
    ...overrides,
  };
}

function mtf(args: { alignment: TimeframeAlignment; bias: HigherTimeframeBias }): MultiTimeframeAnalysis {
  const trends: TimeframeTrend[] = mtfTimeframes.map(tf => {
    if (args.alignment === "aligned_bullish") return "bullish";
    if (args.alignment === "aligned_bearish") return "bearish";
    if (args.alignment === "insufficient") return tf === "15m" ? "unavailable" : "bullish";
    return tf === "1day" || tf === "4h" ? "bullish" : "bearish";
  });
  return {
    pair: "USD/JPY",
    analyzedAt: NOW,
    timeframes: mtfTimeframes.map((tf, index) => frame(tf, trends[index] ?? "unavailable")),
    higherTimeframeBias: args.bias,
    alignment: args.alignment,
    availableTimeframes: trends.filter(t => t !== "unavailable").length,
    totalTimeframes: 4,
    conflicts: [],
  };
}

function regimeOf(kind: MarketRegimeKind, volatility: VolatilityRegime = "normal"): MarketRegimeAnalysis {
  return sanitizeMarketRegimeAnalysis({
    version: 1,
    pair: "USD/JPY",
    timeframe: "1h",
    analyzedAt: NOW,
    regime: kind,
    trendDirection: kind === "trending" ? "bullish" : "neutral",
    volatility,
    evidence: {
      close: 156.5, sma20: 156.3, sma75: 156.0, sma200: 155.5, rsi14: 55,
      atr14: 0.2, atrPercent: 0.13, atrRatio: volatility === "high" ? 1.5 : volatility === "low" ? 0.5 : 1,
      atrBaseline: 0.2, smaSpreadPercent: 0.2, rangePosition: 0.5, recentHigh: 157, recentLow: 155, dataPoints: 240,
    },
    reasons: ["test"],
  }, "USD/JPY")!;
}

function preTradeContext(action: "BUY" | "SELL" | "WAIT" = "WAIT"): PreTradeContextSnapshot {
  return {
    version: 1,
    capturedAt: NOW,
    pair: "USD/JPY",
    direction: "BUY",
    action,
    readiness: { confirmedCount: 5, totalCount: 5, state: "waiting" },
    trigger: {
      structuredTrigger: {
        version: 1,
        type: "price_below",
        pair: "USD/JPY",
        price: 156.2,
        timeframe: null,
        sourceCondition: "現在価格が156.20を下回った場合",
      } as StructuredEntryTrigger,
      evaluation: { status: "met", observedValue: 156.18, checkedAt: NOW, distanceToTriggerPips: 0 },
    },
    dataQuality: { score: 82 },
    confidence: 76,
    eventRisk: { level: "low", available: true },
    risk: { capital: 50_000, riskPercent: 1, riskPerTrade: 500 },
    dailyLossLimitPercent: 3,
    dailyLossRemaining: 1_000,
    dailyLossLimitReached: false,
    analysisStale: false,
    eventRiskHigh: false,
  };
}

function snap(opts: {
  action?: "BUY" | "SELL" | "WAIT";
  direction?: TradeSignal;
  mtf?: MultiTimeframeAnalysis | null;
  regime?: MarketRegimeAnalysis | null;
  preTrade?: boolean;
} = {}): TradeAiAnalysisSnapshot {
  return {
    pair: "USD/JPY",
    signal: "wait",
    score: 10,
    confidence: 70,
    summary: "t032",
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
    marketPrice: 155.2,
    analysisPrice: 155.2,
    factors: [],
    scenario: null,
    dataQuality: quality(),
    economicRisk: null,
    chartEvidence: null,
    chartAnalysis: null,
    aiCode: null,
    isFallback: false,
    ...(opts.mtf ? { multiTimeframeAnalysis: opts.mtf } : {}),
    ...(opts.regime ? { marketRegimeAnalysis: opts.regime } : {}),
    ...(opts.preTrade ? { preTradeContext: preTradeContext(opts.action ?? "WAIT") } : {}),
  };
}

function legacy(): TradeAnalysisSnapshot {
  return {
    pair: "USD/JPY", signal: "buy", score: 10, confidence: 70, summary: "legacy",
    dataQualityScore: 80, analyzedAt: NOW, capturedAt: NOW, expiresAt: NOW,
    aiStatus: "available", model: "x", bullishReasons: [], bearishReasons: [],
  };
}

function withPlan(trade: Trade, stopLoss = 154.9, takeProfit: number | null = 155.8): Trade {
  return {
    ...trade,
    exitPlan: createExitPlan({
      pair: trade.pair,
      side: trade.side,
      entryPrice: trade.entryPrice,
      stopLoss,
      takeProfit,
      capturedAt: trade.createdAt,
    }),
  };
}

function trade(partial: Partial<Trade> & Pick<Trade, "id">): Trade {
  return {
    pair: "USD/JPY",
    side: "long",
    status: "closed",
    quantity: 1000,
    entryPrice: 155.2,
    exitPrice: 155.5,
    openedAt: NOW,
    closedAt: NOW,
    stopLoss: 154.9,
    takeProfit: 155.8,
    notes: "",
    realizedPnl: 300,
    analysisSnapshot: snap({ regime: regimeOf("trending"), mtf: mtf({ alignment: "aligned_bullish", bias: "bullish" }) }),
    createdAt: NOW,
    updatedAt: NOW,
    ...partial,
  };
}

function closedWithR(id: string, exitPrice: number, pnl: number, extra: Partial<Trade> = {}): Trade {
  return withPlan(trade({
    id,
    exitPrice,
    realizedPnl: pnl,
    ...extra,
  }));
}

test("TEST1 coverage regime/R and missing != unavailable", () => {
  const trades: Trade[] = [];
  for (let i = 0; i < 4; i++) {
    trades.push(closedWithR(`a${i}`, 155.5, 100, {
      analysisSnapshot: snap({ regime: regimeOf("trending"), mtf: mtf({ alignment: "aligned_bullish", bias: "bullish" }) }),
    }));
  }
  for (let i = 0; i < 2; i++) {
    trades.push(trade({
      id: `nr${i}`,
      exitPrice: 155.5,
      realizedPnl: 80,
      exitPlan: null,
      analysisSnapshot: snap({ regime: regimeOf("range") }),
    }));
  }
  for (let i = 0; i < 4; i++) {
    trades.push(trade({
      id: `b${i}`,
      exitPrice: 155.5,
      realizedPnl: 50,
      exitPlan: null,
      analysisSnapshot: snap(),
    }));
  }
  assert.equal(trades.length, 10);
  const result = buildPerformanceIntelligence(trades);
  assert.equal(result.overview.closedTrades, 10);
  assert.equal(result.coverage.regime.present, 6);
  assert.equal(result.coverage.regime.eligible, 10);
  assert.equal(result.coverage.regime.rate, 60);
  assert.equal(result.coverage.r.present, 4);
  assert.equal(result.coverage.r.rate, 40);
  assert.equal(result.coverage.regime.contextMissing, 4);
  assert.equal(result.coverage.regime.unavailableSaved, 0);
  const missing = result.regime.byRegime.find(g => g.key === "context_missing");
  const unavailable = result.regime.byRegime.find(g => g.key === "unavailable");
  assert.equal(missing?.sampleSize, 4);
  assert.equal(unavailable?.sampleSize ?? 0, 0);
});

test("TEST2 historical regime grouping ignores current regime", () => {
  const saved = closedWithR("hist", 155.5, 100, {
    analysisSnapshot: snap({ regime: regimeOf("trending") }),
  });
  assert.equal(classifySavedRegimeGroup(saved), "trending");
  const result = buildPerformanceIntelligence([saved]);
  assert.equal(result.regime.byRegime.find(g => g.key === "trending")?.sampleSize, 1);
  assert.equal(result.regime.byRegime.find(g => g.key === "range")?.sampleSize ?? 0, 0);
  assert.doesNotMatch(SOURCE, /currentRegime|liveRegime|marketRegimeForPair\(/);
});

test("TEST3 PnL n and R n denominators separate", () => {
  const trades: Trade[] = [];
  for (let i = 0; i < 6; i++) {
    trades.push(closedWithR(`r${i}`, 155.5, 100, {
      analysisSnapshot: snap({ regime: regimeOf("trending") }),
    }));
  }
  for (let i = 0; i < 4; i++) {
    trades.push(trade({
      id: `p${i}`,
      realizedPnl: 50,
      exitPlan: null,
      analysisSnapshot: snap({ regime: regimeOf("trending") }),
    }));
  }
  const group = calculateContextSummary("trending", "trending", trades);
  assert.equal(group.sampleSize, 10);
  assert.equal(group.rSampleSize, 6);
  assert.equal(group.averagePnl, (6 * 100 + 4 * 50) / 10);
  assert.ok(group.averageR != null);
  assert.equal(Math.round((group.averageR ?? 0) * 100) / 100, Math.round(((0.3 / 0.3) * 6) / 6 * 100) / 100);
});

test("TEST4 R distribution buckets", () => {
  const values = [-1.5, -1, -0.5, 0, 0.5, 1, 1.5, 2, 3];
  const counts = Object.fromEntries(
    ["r_le_minus_1", "r_minus_1_to_0", "r_0_to_1", "r_1_to_2", "r_ge_2"].map(k => [k, 0]),
  ) as Record<string, number>;
  for (const value of values) counts[classifyRDistributionBucket(value)] += 1;
  assert.deepEqual(counts, {
    r_le_minus_1: 2,
    r_minus_1_to_0: 1,
    r_0_to_1: 2,
    r_1_to_2: 2,
    r_ge_2: 2,
  });

  const trades = [
    closedWithR("r1", 154.75, -450), // -1.5
    closedWithR("r2", 154.9, -300), // -1
    closedWithR("r3", 155.05, -150), // -0.5
    closedWithR("r4", 155.2, 0), // 0
    closedWithR("r5", 155.35, 150), // 0.5
    closedWithR("r6", 155.5, 300), // 1
    closedWithR("r7", 155.65, 450), // 1.5
    closedWithR("r8", 155.8, 600), // 2
    closedWithR("r9", 156.1, 900), // 3
  ];
  const dist = buildPerformanceIntelligence(trades).rPerformance.distribution;
  assert.deepEqual(dist, {
    r_le_minus_1: 2,
    r_minus_1_to_0: 1,
    r_0_to_1: 2,
    r_1_to_2: 2,
    r_ge_2: 2,
  });
});

test("TEST5 comparison observation requires both groups n>=5", () => {
  const groupA = Array.from({ length: 5 }, (_, i) => closedWithR(`a${i}`, 155.5, 200, {
    analysisSnapshot: snap({ regime: regimeOf("trending"), mtf: mtf({ alignment: "aligned_bullish", bias: "bullish" }) }),
  }));
  const groupB = Array.from({ length: 4 }, (_, i) => closedWithR(`b${i}`, 155.0, -100, {
    analysisSnapshot: snap({ regime: regimeOf("trending"), mtf: mtf({ alignment: "mixed", bias: "bullish" }) }),
  }));
  const result = buildPerformanceIntelligence([...groupA, ...groupB]);
  assert.ok(result.cross.regimeMtf.some(g => g.key === "trending_aligned" && g.sampleSize === 5));
  assert.ok(result.cross.regimeMtf.some(g => g.key === "trending_mixed" && g.sampleSize === 4));
  assert.equal(result.observations.some(text => text.includes("trendingかつMTF")), false);
});

test("TEST6 same context different outcomes leave context unchanged", () => {
  const win = closedWithR("win", 155.8, 600, {
    analysisSnapshot: snap({ regime: regimeOf("range", "normal") }),
  });
  const loss = closedWithR("loss", 154.9, -300, {
    analysisSnapshot: snap({ regime: regimeOf("range", "normal") }),
  });
  assert.equal(classifySavedRegimeGroup(win), "range");
  assert.equal(classifySavedRegimeGroup(loss), "range");
  assert.ok((realizedROrNull(win) ?? 0) > 0);
  assert.ok((realizedROrNull(loss) ?? 0) < 0);
  const result = buildPerformanceIntelligence([win, loss]);
  assert.equal(result.regime.byRegime.find(g => g.key === "range")?.sampleSize, 2);
});

test("OPEN excluded from metrics", () => {
  const open = trade({ id: "open", status: "open", exitPrice: null, closedAt: null, realizedPnl: null });
  const closed = closedWithR("c1", 155.5, 100);
  const result = buildPerformanceIntelligence([open, closed]);
  assert.equal(result.overview.closedTrades, 1);
});

test("finite P/L only", () => {
  const bad = trade({ id: "nan", realizedPnl: Number.NaN });
  const good = closedWithR("ok", 155.5, 100);
  assert.equal(buildPerformanceIntelligence([bad, good]).overview.closedTrades, 1);
});

test("invalid / malformed exit plan and pair/side mismatch", () => {
  const missing = trade({ id: "m", exitPlan: null });
  const malformed = trade({ id: "bad", exitPlan: { version: 1, pair: "USD/JPY" } as Trade["exitPlan"] });
  const pairMismatch = withPlan(trade({ id: "pm" }));
  pairMismatch.exitPlan = createExitPlan({
    pair: "EUR/JPY",
    side: "long",
    entryPrice: 155.2,
    stopLoss: 154.9,
    takeProfit: 155.8,
    capturedAt: NOW,
  });
  const sideMismatch = withPlan(trade({ id: "sm", side: "long" }));
  sideMismatch.exitPlan = createExitPlan({
    pair: "USD/JPY",
    side: "short",
    entryPrice: 155.2,
    stopLoss: 155.5,
    takeProfit: 154.6,
    capturedAt: NOW,
  });
  assert.equal(realizedROrNull(missing), null);
  assert.equal(realizedROrNull(malformed), null);
  assert.equal(realizedROrNull(pairMismatch), null);
  assert.equal(realizedROrNull(sideMismatch), null);
  const result = buildPerformanceIntelligence([missing, malformed, pairMismatch, sideMismatch]);
  assert.equal(result.coverage.r.present, 0);
  assert.equal(result.coverage.r.eligible, 4);
});

test("legacy R missing is missing not 0R", () => {
  const legacyTrade = trade({ id: "legacy-r", exitPlan: null, analysisSnapshot: legacy() });
  const result = buildPerformanceIntelligence([legacyTrade]);
  assert.equal(result.rPerformance.distribution.r_0_to_1, 0);
  assert.equal(result.coverage.r.present, 0);
  assert.equal(result.coverage.r.missing, 1);
});

test("regime missing vs unavailable", () => {
  const missing = trade({ id: "rm", analysisSnapshot: snap() });
  const unavailable = trade({
    id: "ru",
    analysisSnapshot: snap({ regime: regimeOf("unavailable", "unavailable") }),
  });
  assert.equal(classifySavedRegimeGroup(missing), "context_missing");
  assert.equal(classifySavedRegimeGroup(unavailable), "unavailable");
  const result = buildPerformanceIntelligence([missing, unavailable]);
  assert.equal(result.coverage.regime.present, 1);
  assert.equal(result.coverage.regime.contextMissing, 1);
  assert.equal(result.coverage.regime.unavailableSaved, 1);
});

test("regime trending/range/transition and volatility bands", () => {
  const rows = [
    trade({ id: "t", analysisSnapshot: snap({ regime: regimeOf("trending", "high") }) }),
    trade({ id: "r", analysisSnapshot: snap({ regime: regimeOf("range", "normal") }) }),
    trade({ id: "x", analysisSnapshot: snap({ regime: regimeOf("transition", "low") }) }),
  ];
  const result = buildPerformanceIntelligence(rows);
  assert.equal(result.regime.byRegime.find(g => g.key === "trending")?.sampleSize, 1);
  assert.equal(result.regime.byRegime.find(g => g.key === "range")?.sampleSize, 1);
  assert.equal(result.regime.byRegime.find(g => g.key === "transition")?.sampleSize, 1);
  assert.equal(classifySavedVolatility(rows[0]!), "high");
  assert.equal(classifySavedVolatility(rows[1]!), "normal");
  assert.equal(classifySavedVolatility(rows[2]!), "low");
});

test("MTF / PreTrade / AI Direction existing semantics", () => {
  const wait = trade({
    id: "wait",
    analysisSnapshot: snap({
      action: "WAIT",
      preTrade: true,
      mtf: mtf({ alignment: "aligned_bullish", bias: "bullish" }),
      regime: regimeOf("trending"),
    }),
  });
  const buy = trade({
    id: "buy",
    analysisSnapshot: snap({
      action: "BUY",
      preTrade: true,
      mtf: mtf({ alignment: "mixed", bias: "bullish" }),
      regime: regimeOf("range"),
    }),
  });
  assert.equal(classifySavedAiDirection(wait), "WAIT");
  assert.equal(classifySavedAiDirection(buy), "BUY");
  const result = buildPerformanceIntelligence([wait, buy]);
  assert.ok(result.aiDirection.groups.some(g => g.key === "WAIT"));
  assert.ok(result.mtf.byAlignment.some(g => g.key === "aligned_bullish"));
  assert.ok(result.preTrade.byAction.some(g => g.key === "WAIT" || g.key === "BUY"));
});

test("period filter reuse — 30d changes same intelligence source", () => {
  const recent = closedWithR("recent", 155.5, 100, { openedAt: "2026-09-18T00:00:00.000Z" });
  const old = closedWithR("old", 155.5, 100, { openedAt: "2026-06-01T00:00:00.000Z" });
  const now = Date.parse("2026-09-20T00:00:00.000Z");
  const all = buildPerformanceIntelligence(filterTradesByPeriod([recent, old], "all", now));
  const d30 = buildPerformanceIntelligence(filterTradesByPeriod([recent, old], "30d", now));
  assert.equal(all.overview.closedTrades, 2);
  assert.equal(d30.overview.closedTrades, 1);
});

test("observations max 5, deterministic, no mutation, no forbidden wording", () => {
  const trades = Array.from({ length: 12 }, (_, i) => closedWithR(`o${i}`, i % 2 === 0 ? 155.8 : 154.9, i % 2 === 0 ? 200 : -100, {
    analysisSnapshot: snap({
      action: i % 2 === 0 ? "BUY" : "WAIT",
      regime: regimeOf(i % 2 === 0 ? "trending" : "range", "normal"),
      mtf: mtf({ alignment: i % 2 === 0 ? "aligned_bullish" : "mixed", bias: "bullish" }),
      preTrade: true,
    }),
  }));
  const clone = structuredClone(trades);
  const a = buildPerformanceIntelligence(trades);
  const b = buildPerformanceIntelligence(trades);
  assert.deepEqual(a.observations, b.observations);
  assert.ok(a.observations.length <= MAX_PERFORMANCE_OBSERVATIONS);
  assert.deepEqual(trades, clone);
  assert.doesNotMatch(a.observations.join("\n"), FORBIDDEN);
  const ui = readFileSync(join(ROOT, "components/trades/performance-intelligence.tsx"), "utf8");
  assert.doesNotMatch(ui, FORBIDDEN);
  assert.doesNotMatch(SOURCE.replace(/const FORBIDDEN[\s\S]*?;/, ""), FORBIDDEN);
  assert.equal(MIN_INSIGHT_SAMPLE_SIZE, 5);
});

test("profit factor null when no losses", () => {
  const wins = [closedWithR("w1", 155.5, 100), closedWithR("w2", 155.5, 200)];
  const result = buildPerformanceIntelligence(wins);
  assert.equal(result.overview.profitFactor, null);
});

test("0.00R goes to r_0_to_1", () => {
  assert.equal(classifyRDistributionBucket(0), "r_0_to_1");
});

test("v2 CLOSED only and period filter still apply", () => {
  const open = trade({ id: "open", status: "open", exitPrice: null, realizedPnl: null, closedAt: null });
  const closed = closedWithR("c1", 155.5, 100, {
    analysisSnapshot: snap({ mtf: mtf({ alignment: "aligned_bullish", bias: "bullish" }), regime: regimeOf("trending") }),
  });
  const result = buildPerformanceIntelligence([open, closed]);
  assert.equal(result.overview.closedTrades, 1);
  assert.equal(result.timeframe.byTimeframe.some(block => block.eligibleWithFrame > 0), true);
});

test("v2 missing MTF snapshot excluded from timeframe analysis", () => {
  const missing = closedWithR("m1", 155.5, 100, { analysisSnapshot: snap({ regime: regimeOf("trending") }) });
  const withMtf = closedWithR("m2", 155.5, 100, {
    analysisSnapshot: snap({ mtf: mtf({ alignment: "aligned_bullish", bias: "bullish" }), regime: regimeOf("trending") }),
  });
  assert.equal(savedTimeframeTrend(missing, "4h"), null);
  assert.equal(savedTimeframeTrend(withMtf, "4h"), "bullish");
  const result = buildPerformanceIntelligence([missing, withMtf]);
  assert.equal(result.timeframe.missingMtf, 1);
  const fourHour = result.timeframe.byTimeframe.find(block => block.timeframe === "4h");
  assert.equal(fourHour?.eligibleWithFrame, 1);
  assert.equal(fourHour?.missingFrame, 1);
});

test("v2 individual timeframe grouping and metrics", () => {
  const custom = (trend15: TimeframeTrend, trend4h: TimeframeTrend): MultiTimeframeAnalysis => ({
    pair: "USD/JPY",
    analyzedAt: NOW,
    timeframes: [
      frame("1day", "bullish"),
      frame("4h", trend4h),
      frame("1h", "bullish"),
      frame("15m", trend15),
    ],
    higherTimeframeBias: "bullish",
    alignment: "mixed",
    availableTimeframes: 4,
    totalTimeframes: 4,
    conflicts: [],
  });
  const rows = [
    closedWithR("t1", 155.8, 100, { analysisSnapshot: snap({ mtf: custom("bullish", "bullish"), regime: regimeOf("trending") }) }),
    closedWithR("t2", 155.8, 100, { analysisSnapshot: snap({ mtf: custom("bullish", "bearish"), regime: regimeOf("trending") }) }),
    closedWithR("t3", 154.9, -80, { analysisSnapshot: snap({ mtf: custom("bearish", "bullish"), regime: regimeOf("range") }) }),
  ];
  const result = buildPerformanceIntelligence(rows);
  const tf15 = result.timeframe.byTimeframe.find(block => block.timeframe === "15m")!;
  assert.equal(tf15.byTrend.find(g => g.key === "15m:bullish")?.sampleSize, 2);
  assert.equal(tf15.byTrend.find(g => g.key === "15m:bearish")?.sampleSize, 1);
  const bull = tf15.byTrend.find(g => g.key === "15m:bullish")!;
  assert.equal(bull.wins, 2);
  assert.equal(bull.totalPnl, 200);
  assert.ok(bull.averagePnl != null);
  assert.ok(bull.rSampleSize >= 1);
});

test("v2 sample n < 5 marks insufficient", () => {
  const rows = Array.from({ length: 3 }, (_, i) => closedWithR(`s${i}`, 155.8, 50, {
    analysisSnapshot: snap({ mtf: mtf({ alignment: "aligned_bullish", bias: "bullish" }), regime: regimeOf("trending") }),
  }));
  const result = buildPerformanceIntelligence(rows);
  const group = result.timeframe.byTimeframe.find(b => b.timeframe === "1h")?.byTrend.find(g => g.key === "1h:bullish");
  assert.equal(group?.sampleSize, 3);
  assert.equal(group?.sufficientSample, false);
});

test("v2 realizedR missing is not 0 and positive/negative R counts", () => {
  const withR = closedWithR("r1", 155.8, 100, { analysisSnapshot: snap({ mtf: mtf({ alignment: "aligned_bullish", bias: "bullish" }) }) });
  const lossR = closedWithR("r2", 154.9, -100, { analysisSnapshot: snap({ mtf: mtf({ alignment: "aligned_bullish", bias: "bullish" }) }) });
  const noR = trade({
    id: "r3",
    realizedPnl: 50,
    exitPlan: null,
    analysisSnapshot: snap({ mtf: mtf({ alignment: "aligned_bullish", bias: "bullish" }) }),
  });
  assert.equal(realizedROrNull(noR), null);
  const result = buildPerformanceIntelligence([withR, lossR, noR]);
  assert.equal(result.rPerformance.coverage.present, 2);
  assert.equal(result.rPerformance.coverage.missing, 1);
  assert.equal(result.rPerformance.positiveRCount, 1);
  assert.equal(result.rPerformance.negativeRCount, 1);
  assert.equal(typeof result.rPerformance.totalR, "number");
});

test("v2 SMA context when data exists and missing when not", () => {
  const above = closedWithR("sma1", 155.8, 100, {
    analysisSnapshot: snap({
      mtf: {
        ...mtf({ alignment: "aligned_bullish", bias: "bullish" }),
        timeframes: mtfTimeframes.map(tf => frame(tf, "bullish", { lastClose: 157, sma20: 156, sma75: 155, sma200: 154 })),
      },
    }),
  });
  const below = closedWithR("sma2", 154.9, -50, {
    analysisSnapshot: snap({
      mtf: {
        ...mtf({ alignment: "mixed", bias: "bearish" }),
        timeframes: mtfTimeframes.map(tf => frame(tf, "bearish", { lastClose: 154, sma20: 156, sma75: 157, sma200: 158 })),
      },
    }),
  });
  const noTech = closedWithR("sma3", 155.5, 10, { analysisSnapshot: snap() });
  assert.ok(classifySmaContexts(savedTechnicalPoint(above)!).includes("price_gt_sma20"));
  assert.ok(classifySmaContexts(savedTechnicalPoint(below)!).includes("price_lt_sma20"));
  assert.equal(savedTechnicalPoint(noTech), null);
  const result = buildPerformanceIntelligence([above, below, noTech]);
  assert.ok(result.technical.sma.groups.some(g => g.key === "price_gt_sma20"));
  assert.ok(result.technical.sma.groups.some(g => g.key === "price_lt_sma20"));
  assert.equal(result.technical.sma.coverage.present, 2);
  const empty = buildPerformanceIntelligence([noTech]);
  assert.equal(empty.technical.sma.groups.length, 0);
  assert.match(empty.technical.sma.noDataReason ?? "", /価格|SMA/);
});

test("v2 RSI buckets boundaries and missing", () => {
  assert.equal(classifyRsiBucket(29.9), "rsi_lt_30");
  assert.equal(classifyRsiBucket(30), "rsi_30_45");
  assert.equal(classifyRsiBucket(44.9), "rsi_30_45");
  assert.equal(classifyRsiBucket(45), "rsi_45_55");
  assert.equal(classifyRsiBucket(55), "rsi_55_70");
  assert.equal(classifyRsiBucket(70), "rsi_55_70");
  assert.equal(classifyRsiBucket(70.1), "rsi_gt_70");
  const mid = closedWithR("rsi1", 155.5, 80, {
    analysisSnapshot: snap({
      mtf: {
        ...mtf({ alignment: "aligned_bullish", bias: "bullish" }),
        timeframes: mtfTimeframes.map(tf => frame(tf, "bullish", { rsi14: 50 })),
      },
    }),
  });
  const hot = closedWithR("rsi2", 155.5, 40, {
    analysisSnapshot: snap({
      mtf: {
        ...mtf({ alignment: "aligned_bullish", bias: "bullish" }),
        timeframes: mtfTimeframes.map(tf => frame(tf, "bullish", { rsi14: 75 })),
      },
    }),
  });
  const noRsi = closedWithR("rsi3", 155.5, 10, {
    analysisSnapshot: snap({
      mtf: {
        ...mtf({ alignment: "aligned_bullish", bias: "bullish" }),
        timeframes: mtfTimeframes.map(tf => frame(tf, "bullish", { rsi14: null, lastClose: 156, sma20: null, sma75: null, sma200: null })),
      },
    }),
  });
  const result = buildPerformanceIntelligence([mid, hot, noRsi]);
  assert.equal(result.technical.rsi.groups.find(g => g.key === "rsi_45_55")?.sampleSize, 1);
  assert.equal(result.technical.rsi.groups.find(g => g.key === "rsi_gt_70")?.sampleSize, 1);
  assert.equal(result.technical.rsi.coverage.present, 2);
  const missingOnly = buildPerformanceIntelligence([
    closedWithR("rsi4", 155.5, 10, { analysisSnapshot: snap() }),
  ]);
  assert.equal(missingOnly.technical.rsi.groups.length, 0);
  assert.match(missingOnly.technical.rsi.noDataReason ?? "", /RSI|価格/);
});

test("v2 Regime MTF cross regression and no 3-axis", () => {
  const rows = [
    closedWithR("x1", 155.8, 100, {
      analysisSnapshot: snap({
        regime: regimeOf("trending"),
        mtf: mtf({ alignment: "aligned_bullish", bias: "bullish" }),
      }),
    }),
    closedWithR("x2", 154.9, -50, {
      analysisSnapshot: snap({
        regime: regimeOf("trending"),
        mtf: mtf({ alignment: "mixed", bias: "bullish" }),
      }),
    }),
  ];
  const result = buildPerformanceIntelligence(rows);
  assert.ok(result.cross.regimeMtf.some(g => g.key === "trending_aligned"));
  assert.ok(result.cross.regimeMtf.some(g => g.key === "trending_mixed"));
  assert.equal(Object.keys(result.cross).length, 1);
  assert.doesNotMatch(SOURCE, /regimeMtfRsi|three.?axis|× MTF ×/);
});

test("v2 no live market recomputation helpers", () => {
  assert.doesNotMatch(SOURCE, /multiTimeframeForPair\(|marketRegimeForPair\(|getMarketData\(|calculateIndicators\(/);
});
