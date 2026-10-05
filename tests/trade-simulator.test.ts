import test from "node:test";
import assert from "node:assert/strict";
import {
  defaultTradeSimulatorConfig,
  evaluateEntryLimit,
  jstDate,
  evaluateResearchSafety,
  resolveEntryFill,
  resolvePositionExit,
  simulateTrades,
  updateConsecutiveLosses,
} from "../lib/backtest/trade-simulator";
import { buildHistoricalAsOfMarket, historicalTimeframeDurationMs, replayHistoricalSignals, type HistoricalDataset, type HistoricalTimeframe } from "../lib/backtest/signal-replay";
import { evaluateTechnical } from "../lib/ai/technical";
import { generateScenario } from "../lib/ai/scenario";
import type { AnalysisInput } from "../lib/ai/types";
import type { Candle, Symbol } from "../lib/market/types";

const HOUR = 3_600_000;
const END = Date.parse("2026-03-15T00:00:00.000Z");
const durations = historicalTimeframeDurationMs;

function candle(time: number, open: number, high: number, low: number, close: number): Candle {
  return { time: new Date(time).toISOString(), open, high, low, close };
}

function generatedDataset(pair: Symbol = "USD/JPY", end = END, count = 220, trend: "up" | "down" = "up"): HistoricalDataset {
  const make = (timeframe: HistoricalTimeframe, bars: number): Candle[] => Array.from({ length: bars }, (_, index) => {
    const start = end - (bars - index) * durations[timeframe];
    const closeAt = start + durations[timeframe];
    const offset = (closeAt - end) / HOUR * 0.02;
    const close = 150 + (trend === "up" ? offset : -offset);
    const highPad = timeframe === "1h" || timeframe === "4h" ? (trend === "up" ? 1 : 0.05) : 0.2;
    const lowPad = timeframe === "1h" || timeframe === "4h" ? (trend === "up" ? 0.05 : 1) : 0.1;
    return candle(start, close, close + highPad, close - lowPad, close);
  });
  return {
    id: `fixture-${pair}`,
    pair,
    timeframes: {
      "15m": make("15m", count * 4),
      "1h": make("1h", count),
      "4h": make("4h", count),
      "1day": make("1day", count),
    },
  };
}

function scenarioForFirstEvaluated(dataset: HistoricalDataset) {
  const replay = replayHistoricalSignals(dataset, { signalTimeframe: "1h" });
  const signal = replay.signals.find(row => row.status === "EVALUATED" && row.direction && row.direction !== "wait" && row.scenarioStatus === "available")!;
  const asOf = buildHistoricalAsOfMarket(dataset, Date.parse(signal.at));
  const technical = evaluateTechnical(asOf.market, Date.parse(signal.at));
  const input = {
    pair: dataset.pair,
    currentRate: asOf.currentRate,
    technicalAnalysis: technical,
  } as AnalysisInput;
  const scenario = generateScenario(input, signal.direction!);
  assert.ok(scenario, JSON.stringify({ direction: signal.direction, rate: asOf.currentRate, technicalReady: technical.ready, frame1h: technical.frames.find(frame => frame.timeframe === "1h") }));
  const signalIndex = dataset.timeframes["1h"]!.findIndex(row => Date.parse(row.time) + HOUR === Date.parse(signal.at));
  return { signal, scenario: scenario!, signalIndex };
}

function setFillAndTargetBars(dataset: HistoricalDataset, scenario: ReturnType<typeof scenarioForFirstEvaluated>["scenario"], signalIndex: number, sameBarExit: "none" | "stop" | "both" | "target" = "none") {
  const candles = dataset.timeframes["1h"]!;
  const fillIndex = signalIndex + 1;
  const fill = (scenario.entryZone.min + scenario.entryZone.max) / 2;
  const stop = scenario.stopLoss;
  const target = scenario.takeProfit1;
  const isLong = scenario.direction === "long";
  let low = isLong ? Math.max(stop + 0.001, fill - 0.001) : Math.max(target + 0.001, fill - 0.001);
  let high = isLong ? Math.min(target - 0.001, fill + 0.001) : Math.min(stop - 0.001, fill + 0.001);
  if (sameBarExit === "stop" || sameBarExit === "both") {
    if (isLong) low = stop - 0.01;
    else high = stop + 0.01;
  }
  if (sameBarExit === "target" || sameBarExit === "both") {
    if (isLong) high = target + 0.01;
    else low = target - 0.01;
  }
  const fillClose = isLong ? fill + 0.0005 : fill - 0.0005;
  candles[fillIndex] = candle(Date.parse(candles[fillIndex]!.time), fill, Math.max(high, fill, fillClose), Math.min(low, fill, fillClose), fillClose);
  if (sameBarExit === "none" && fillIndex + 1 < candles.length) {
    const next = candles[fillIndex + 1]!;
    if (isLong) candles[fillIndex + 1] = candle(Date.parse(next.time), fill + 0.005, target + 0.01, fill + 0.001, target);
    else candles[fillIndex + 1] = candle(Date.parse(next.time), fill - 0.005, fill - 0.001, target - 0.01, target);
  }
  return { fillIndex, fill };
}

function simulatorPosition(side: "long" | "short", stop: number, target: number) {
  return { side, initialStopLoss: stop, takeProfit1: target } as const;
}

test("defaults match Task115 risk, limits, timeout, gross-only and SL_FIRST policy", () => {
  assert.equal(defaultTradeSimulatorConfig.riskPerTradePercent, 0.5);
  assert.equal(defaultTradeSimulatorConfig.maxConcurrentPositions, 1);
  assert.equal(defaultTradeSimulatorConfig.maxTradesPerJstDay, 3);
  assert.equal(defaultTradeSimulatorConfig.dailyLossLimitPercent, 1);
  assert.equal(defaultTradeSimulatorConfig.consecutiveLossLimit, 3);
  assert.equal(defaultTradeSimulatorConfig.maxHoldingCandles, 24);
  assert.equal(defaultTradeSimulatorConfig.spreadPips, 0);
  assert.equal(defaultTradeSimulatorConfig.slippagePips, 0);
  assert.equal(defaultTradeSimulatorConfig.commissionJpyPerTrade, 0);
});

test("entry fills only when next-or-later bar open is inside the Scenario zone", () => {
  const scenario = { entryZone: { min: 100, max: 101 } } as ReturnType<typeof scenarioForFirstEvaluated>["scenario"];
  assert.deepEqual(resolveEntryFill(scenario, candle(END, 100.5, 101, 100, 100.7)), { reason: "FILLED", price: 100.5 });
  assert.deepEqual(resolveEntryFill(scenario, candle(END, 102, 103, 101.5, 102.5)), { reason: "NO_ZONE_TOUCH", price: null });
  assert.deepEqual(resolveEntryFill(scenario, candle(END, 102, 102.5, 100.5, 101)), { reason: "ENTRY_GAP_AMBIGUOUS", price: null });
});

test("BUY and SELL use the same inclusive entry-zone bounds and open fill", () => {
  const scenario = { entryZone: { min: 100, max: 101 } } as ReturnType<typeof scenarioForFirstEvaluated>["scenario"];
  assert.deepEqual(resolveEntryFill(scenario, candle(END, 100, 100.2, 99.9, 100.1)), { reason: "FILLED", price: 100 });
  assert.deepEqual(resolveEntryFill(scenario, candle(END, 101, 101.1, 100.8, 100.9)), { reason: "FILLED", price: 101 });
});

test("open gapping across the entry zone is ambiguous and never receives a favorable fill", () => {
  const scenario = { entryZone: { min: 100, max: 101 } } as ReturnType<typeof scenarioForFirstEvaluated>["scenario"];
  assert.equal(resolveEntryFill(scenario, candle(END, 99, 102, 98, 101.5)).reason, "ENTRY_GAP_AMBIGUOUS");
  assert.equal(resolveEntryFill(scenario, candle(END, 102, 103, 99, 100)).price, null);
});

test("BUY and SELL stop/target touches use conservative SL_FIRST on same candle", () => {
  assert.deepEqual(resolvePositionExit(simulatorPosition("long", 99, 103), candle(END, 101, 104, 98, 102), 1, 24), { reason: "STOP_LOSS", price: 99, holdingCandles: 1 });
  assert.deepEqual(resolvePositionExit(simulatorPosition("short", 103, 99), candle(END, 101, 104, 98, 100), 1, 24), { reason: "STOP_LOSS", price: 103, holdingCandles: 1 });
});

test("BUY/SELL stop gaps fill at adverse open and TP gaps fill at TP, not favorable open", () => {
  assert.deepEqual(resolvePositionExit(simulatorPosition("long", 99, 103), candle(END, 98, 100, 97, 99), 2, 24), { reason: "STOP_LOSS", price: 98, holdingCandles: 2 });
  assert.deepEqual(resolvePositionExit(simulatorPosition("short", 103, 99), candle(END, 104, 105, 100, 102), 2, 24), { reason: "STOP_LOSS", price: 104, holdingCandles: 2 });
  assert.deepEqual(resolvePositionExit(simulatorPosition("long", 99, 103), candle(END, 104, 105, 103.5, 104.5), 2, 24), { reason: "TAKE_PROFIT", price: 103, holdingCandles: 2 });
  assert.deepEqual(resolvePositionExit(simulatorPosition("short", 103, 99), candle(END, 98, 98.5, 97, 98), 2, 24), { reason: "TAKE_PROFIT", price: 99, holdingCandles: 2 });
});

test("timeout uses candle close after stop/target checks", () => {
  assert.deepEqual(resolvePositionExit(simulatorPosition("long", 99, 103), candle(END, 101, 102, 100, 101.5), 24, 24), { reason: "TIMEOUT", price: 101.5, holdingCandles: 24 });
  assert.equal(resolvePositionExit(simulatorPosition("long", 99, 103), candle(END, 101, 104, 98, 101), 24, 24)?.reason, "STOP_LOSS");
});

test("JST trading-day boundary is 15:00 UTC", () => {
  assert.equal(jstDate(Date.parse("2026-03-15T14:59:59.000Z")), "2026-03-15");
  assert.equal(jstDate(Date.parse("2026-03-15T15:00:00.000Z")), "2026-03-16");
});

test("entry limits enforce daily count, realized daily loss and consecutive losses", () => {
  const base = { entriesToday: 0, maxTradesPerJstDay: 3, realizedPnlTodayJpy: 0, startOfDayEquityJpy: 50_000, dailyLossLimitPercent: 1, consecutiveLosses: 0, consecutiveLossLimit: 3 };
  assert.equal(evaluateEntryLimit({ ...base, entriesToday: 3 }), "MAX_TRADES_PER_DAY");
  assert.equal(evaluateEntryLimit({ ...base, realizedPnlTodayJpy: -499 }), null);
  assert.equal(evaluateEntryLimit({ ...base, realizedPnlTodayJpy: -500, dailyLossLimitPercent: 1 }), "DAILY_LOSS_LIMIT");
  assert.equal(evaluateEntryLimit({ ...base, consecutiveLosses: 3 }), "CONSECUTIVE_LOSS_LIMIT");
  assert.equal(evaluateEntryLimit({ ...base, consecutiveLosses: 3, entriesToday: 3 }), "MAX_TRADES_PER_DAY");
  assert.equal(updateConsecutiveLosses(2, -1), 3);
  assert.equal(updateConsecutiveLosses(2, 0), 0);
  assert.equal(updateConsecutiveLosses(2, 1), 0);
});

test("same-candle entry/exit uses SL_FIRST and production Action remains separate", () => {
  const dataset = generatedDataset();
  const { scenario, signalIndex } = scenarioForFirstEvaluated(dataset);
  setFillAndTargetBars(dataset, scenario, signalIndex, "both");
  const result = simulateTrades(dataset, { initialCapital: 500_000 });
  const trade = result.trades.find(item => item.status === "CLOSED");
  assert.ok(trade);
  assert.equal(trade?.sameCandleEntryExit, true);
  assert.equal(trade?.exitReason, "STOP_LOSS");
  assert.equal(trade?.productionAction, "WAIT");
  assert.equal(result.metadata.productionActionReplayed, false);
});

test("one completed research trade updates realized equity, R, drawdown and TP1 exit metrics", () => {
  const dataset = generatedDataset();
  const { scenario, signalIndex } = scenarioForFirstEvaluated(dataset);
  const { fill } = setFillAndTargetBars(dataset, scenario, signalIndex);
  const result = simulateTrades(dataset, { initialCapital: 500_000 });
  const trade = result.trades.find(item => item.status === "CLOSED");
  assert.ok(trade);
  assert.equal(trade?.exitReason, "TAKE_PROFIT");
  assert.equal(trade?.exitPrice, scenario.takeProfit1);
  assert.equal(trade?.entryAt, trade?.signalAt);
  assert.equal(trade?.entryBarTime, trade?.signalAt);
  assert.ok(trade?.quantity && trade.quantity % 1000 === 0);
  assert.ok(trade?.projectedLossJpy && trade.projectedLossJpy <= 2500);
  assert.ok(trade?.realizedR && trade.realizedGrossPnlJpy);
  assert.equal(result.metrics.endingRealizedEquityJpy, 500_000 + result.metrics.realizedGrossPnlJpy);
  assert.equal(result.metadata.costModel, "GROSS");
  assert.equal(result.metadata.spreadModeled, false);
  assert.ok(fill >= scenario.entryZone.min && fill <= scenario.entryZone.max);
  assert.ok(result.equityCurve.length > 1);
  assert.equal(trade?.realizedR, trade!.realizedGrossPnlJpy! / trade!.initialRiskJpy);
  assert.equal(result.metrics.expectancyJpyPerTrade, trade?.realizedGrossPnlJpy);
  assert.equal(result.metrics.expectancyRPerTrade, trade?.realizedR);
});

test("SHORT gross PnL and realized R use the fixed initial risk denominator", () => {
  const dataset = generatedDataset("USD/JPY", END, 220, "down");
  const { scenario, signalIndex } = scenarioForFirstEvaluated(dataset);
  assert.equal(scenario.direction, "short");
  setFillAndTargetBars(dataset, scenario, signalIndex);
  const result = simulateTrades(dataset, { initialCapital: 500_000 });
  const trade = result.trades.find(item => item.status === "CLOSED");
  assert.ok(trade);
  assert.equal(trade?.side, "short");
  assert.ok(trade!.realizedGrossPnlJpy! > 0);
  assert.equal(trade?.realizedR, trade!.realizedGrossPnlJpy! / trade!.initialRiskJpy);
});

test("realized stop loss updates equity and computes peak-to-trough drawdown", () => {
  const dataset = generatedDataset();
  const { scenario, signalIndex } = scenarioForFirstEvaluated(dataset);
  setFillAndTargetBars(dataset, scenario, signalIndex, "stop");
  const result = simulateTrades(dataset, { initialCapital: 500_000 });
  const trade = result.trades.find(item => item.status === "CLOSED");
  assert.ok(trade);
  assert.equal(trade?.exitReason, "STOP_LOSS");
  assert.ok(trade!.realizedGrossPnlJpy! < 0);
  assert.ok(result.metrics.maxDrawdownJpy > 0);
  assert.ok(result.equityCurve.at(-1)!.equityJpy < 500_000);
});

test("signal candle cannot fill; next candle is the earliest entry", () => {
  const source = generatedDataset();
  const replay = replayHistoricalSignals(source, { signalTimeframe: "1h" });
  const record = replay.signals.find(item => item.status === "EVALUATED" && item.direction && item.direction !== "wait")!;
  const { scenario, signalIndex } = scenarioForFirstEvaluated(source);
  const signalCandle = source.timeframes["1h"]![signalIndex]!;
  const sameBarOpen = (scenario.entryZone.min + scenario.entryZone.max) / 2;
  source.timeframes["1h"]![signalIndex] = {
    ...signalCandle,
    open: sameBarOpen,
    high: Math.max(signalCandle.high, sameBarOpen),
    low: Math.min(signalCandle.low, sameBarOpen),
  };
  const shortened: HistoricalDataset = { ...source, timeframes: { ...source.timeframes, "1h": source.timeframes["1h"]!.slice(0, signalIndex + 1) } };
  const result = simulateTrades(shortened, { initialCapital: 500_000 });
  assert.ok(result.signals.some(row => row.signalAt === record.at));
  assert.equal(result.trades.length, 0);
  assert.equal(result.signals.find(row => row.signalAt === record.at)?.entryFillAt, null);
});

test("ambiguous entry gap is cancelled and never retries at a later favorable price", () => {
  const source = generatedDataset();
  const { scenario, signalIndex } = scenarioForFirstEvaluated(source);
  const gapIndex = signalIndex + 1;
  const gapBar = source.timeframes["1h"]![gapIndex]!;
  source.timeframes["1h"]![gapIndex] = candle(Date.parse(gapBar.time), scenario.entryZone.max + 0.05, scenario.entryZone.max + 0.1, scenario.entryZone.min + 0.01, scenario.entryZone.max + 0.06);
  source.timeframes["1h"] = source.timeframes["1h"]!.slice(0, gapIndex + 1);
  const result = simulateTrades(source, { initialCapital: 500_000 });
  const candidate = result.signals.find(signal => signal.signalAt === new Date(Date.parse(source.timeframes["1h"]![signalIndex]!.time) + HOUR).toISOString());
  assert.equal(candidate?.reason, "ENTRY_GAP_AMBIGUOUS");
  assert.equal(candidate?.researchEligibility, "BLOCKED");
  assert.equal(result.entryOpportunityReasons.ENTRY_GAP_AMBIGUOUS, 1);
  assert.equal(result.trades.length, 0);
});

test("research eligibility ignores AI/Fundamental/Event context but preserves production WAIT/BLOCK", () => {
  const dataset = generatedDataset();
  const { scenario, signalIndex } = scenarioForFirstEvaluated(dataset);
  setFillAndTargetBars(dataset, scenario, signalIndex);
  const result = simulateTrades(dataset, { initialCapital: 500_000 });
  const eligible = result.signals.find(row => row.researchEligibility === "ELIGIBLE");
  assert.ok(eligible);
  assert.equal(eligible?.productionAction, "WAIT");
  assert.equal(eligible?.productionSafety, "BLOCK");
  assert.deepEqual(eligible?.contextReasons, ["UNKNOWN_AI_CONTEXT", "UNKNOWN_FUNDAMENTAL_CONTEXT", "UNKNOWN_EVENT_CONTEXT"]);
  assert.equal(eligible?.scenario !== null, true);
  assert.equal(result.metadata.historicalEconomicEventContext, "NOT_EVALUATED");
});

test("market Safety BLOCK prevents Research entry while missing context alone does not", () => {
  assert.deepEqual(evaluateResearchSafety({ technicalReady: true, productionReasonCodes: ["DATA_QUALITY"] }), { status: "ALLOW", reasons: [] });
  assert.deepEqual(evaluateResearchSafety({ technicalReady: true, productionReasonCodes: ["EXTENDED_MARKET"] }), { status: "BLOCK", reasons: ["EXTENDED_MARKET"] });
  assert.deepEqual(evaluateResearchSafety({ technicalReady: true, productionReasonCodes: ["INSUFFICIENT_DATA"] }), { status: "BLOCK", reasons: ["INSUFFICIENT_DATA"] });
  assert.deepEqual(evaluateResearchSafety({ technicalReady: true, productionReasonCodes: ["ECONOMIC_EVENT"] }), { status: "BLOCK", reasons: ["ECONOMIC_EVENT"] });
  assert.deepEqual(evaluateResearchSafety({ technicalReady: false, productionReasonCodes: [] }), { status: "BLOCK", reasons: ["INSUFFICIENT_DATA"] });
});

test("multiple pair datasets share one global position slot", () => {
  const usd = generatedDataset("USD/JPY");
  const eur = generatedDataset("EUR/JPY");
  for (const dataset of [usd, eur]) {
    const { scenario, signalIndex } = scenarioForFirstEvaluated(dataset);
    setFillAndTargetBars(dataset, scenario, signalIndex);
  }
  const result = simulateTrades([usd, eur], { initialCapital: 500_000 });
  assert.equal(result.trades.length, 0);
  assert.ok(result.blockedCandidateReasons.POSITION_LIMIT > 0);
});

test("Task115 v1 rejects non-zero costs instead of reporting them as net PnL", () => {
  assert.throws(() => simulateTrades(generatedDataset(), { spreadPips: 0.5 }), /not modeled/);
  assert.throws(() => simulateTrades(generatedDataset(), { slippagePips: 1 }), /not modeled/);
  assert.throws(() => simulateTrades(generatedDataset(), { commissionJpyPerTrade: 10 }), /not modeled/);
});

test("same dataset/config produces identical signals, trades, equity and metrics", () => {
  const dataset = generatedDataset();
  const { scenario, signalIndex } = scenarioForFirstEvaluated(dataset);
  setFillAndTargetBars(dataset, scenario, signalIndex);
  assert.deepEqual(simulateTrades(dataset, { initialCapital: 500_000 }), simulateTrades(dataset, { initialCapital: 500_000 }));
});

test("simulation performs zero provider fetches", () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new Error("provider fetch forbidden");
  };
  try {
    simulateTrades(generatedDataset(), { initialCapital: 500_000 });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(calls, 0);
});

test("opposite signals do not add an automatic position exit rule", () => {
  const exit = resolvePositionExit(simulatorPosition("long", 99, 103), candle(END, 101, 102, 100, 100), 5, 24);
  assert.equal(exit, null);
  assert.deepEqual(Object.keys(exit ?? {}), []);
});

test("end-of-dataset leaves an open position marked unrealized, not realized", () => {
  const source = generatedDataset();
  const { scenario, signalIndex } = scenarioForFirstEvaluated(source);
  const fillIndex = signalIndex + 1;
  const fill = (scenario.entryZone.min + scenario.entryZone.max) / 2;
  const fillBar = source.timeframes["1h"]![fillIndex]!;
  source.timeframes["1h"]![fillIndex] = candle(Date.parse(fillBar.time), fill, Math.max(fill, scenario.takeProfit1 - 0.01), Math.min(fill, scenario.stopLoss + 0.01), fill);
  const shortened = { ...source, timeframes: { ...source.timeframes, "1h": source.timeframes["1h"]!.slice(0, signalIndex + 2) } };
  const result = simulateTrades(shortened, { initialCapital: 500_000 });
  assert.equal(result.openPositions.length, 1);
  assert.equal(result.openPositions[0]?.exitReason, "OPEN_UNREALIZED");
  assert.equal(result.openPositions[0]?.realizedGrossPnlJpy, null);
  assert.equal(result.metrics.closedTradeCount, 0);
  assert.notEqual(result.openPositions[0]?.unrealizedGrossPnlJpy, null);
});

test("daily loss, max trades/day, consecutive-loss reset and JST date are deterministic", () => {
  const dayBoundary = Date.parse("2026-03-15T15:00:00.000Z");
  assert.equal(jstDate(dayBoundary - 1), "2026-03-15");
  assert.equal(jstDate(dayBoundary), "2026-03-16");
  assert.equal(evaluateEntryLimit({ entriesToday: 3, maxTradesPerJstDay: 3, realizedPnlTodayJpy: 0, startOfDayEquityJpy: 500_000, dailyLossLimitPercent: 1, consecutiveLosses: 0, consecutiveLossLimit: 3 }), "MAX_TRADES_PER_DAY");
  assert.equal(evaluateEntryLimit({ entriesToday: 0, maxTradesPerJstDay: 3, realizedPnlTodayJpy: -5_000, startOfDayEquityJpy: 500_000, dailyLossLimitPercent: 1, consecutiveLosses: 0, consecutiveLossLimit: 3 }), "DAILY_LOSS_LIMIT");
  assert.equal(evaluateEntryLimit({ entriesToday: 0, maxTradesPerJstDay: 3, realizedPnlTodayJpy: 0, startOfDayEquityJpy: 500_000, dailyLossLimitPercent: 1, consecutiveLosses: 3, consecutiveLossLimit: 3 }), "CONSECUTIVE_LOSS_LIMIT");
  assert.equal(evaluateEntryLimit({ entriesToday: 0, maxTradesPerJstDay: 3, realizedPnlTodayJpy: 0, startOfDayEquityJpy: 500_000, dailyLossLimitPercent: 1, consecutiveLosses: 0, consecutiveLossLimit: 3 }), null);
});