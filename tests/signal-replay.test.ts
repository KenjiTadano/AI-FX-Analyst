import test from "node:test";
import assert from "node:assert/strict";
import {
  BACKTEST_MIN_TECHNICAL_CANDLES,
  buildHistoricalAsOfMarket,
  confirmedAtOrBefore,
  historicalTimeframeDurationMs,
  replayHistoricalSignals,
  measureForwardPerformance,
  validateHistoricalDataset,
  type HistoricalDataset,
} from "../lib/backtest/signal-replay";
import { calculateIndicators } from "../lib/market/indicators";
import { evaluateTechnical } from "../lib/ai/technical";
import type { Candle, MarketTimeframe } from "../lib/market/types";
import { signalFromScore } from "../lib/ai/signal-engine-v2";

const origin = Date.parse("2026-01-01T00:00:00.000Z");
const duration: Record<MarketTimeframe, number> = historicalTimeframeDurationMs;

function candle(time: number, close: number, high = close + 0.1, low = close - 0.1): Candle {
  return { time: new Date(time).toISOString(), open: close, high, low, close };
}

function series(timeframe: MarketTimeframe, count: number, start = origin, slope = 0.001): Candle[] {
  const step = duration[timeframe];
  return Array.from({ length: count }, (_, index) => {
    const close = 150 + index * slope;
    return candle(start + index * step, close);
  });
}

function seriesEnding(timeframe: MarketTimeframe, count: number, end: number, slope = 0.001): Candle[] {
  return Array.from({ length: count }, (_, index) => {
    const close = 150 + index * slope;
    return candle(end - (count - index) * duration[timeframe], close);
  });
}

function dataset(timeframes: Partial<Record<MarketTimeframe, Candle[]>>): HistoricalDataset {
  return { id: "local-test", pair: "USD/JPY", timeframes };
}

function readyDataset(extraFuture = false): HistoricalDataset {
  const timeframes = {
    "15m": series("15m", 960),
    "1h": series("1h", 240),
    "4h": series("4h", 240),
    "1day": series("1day", 220),
  };
  if (extraFuture) {
    for (const timeframe of Object.keys(timeframes) as MarketTimeframe[]) {
      const candles = timeframes[timeframe];
      candles.push(candle(Date.parse(candles.at(-1)!.time) + duration[timeframe], 900, 1000, 1));
    }
  }
  return dataset(timeframes);
}

test("dataset accepts supported pair/timeframes and immutable canonical UTC OHLC", () => {
  const input = dataset({ "15m": series("15m", 3), "1day": series("1day", 2) });
  const before = structuredClone(input);
  const result = validateHistoricalDataset(input);
  assert.equal(result.valid, true);
  assert.deepEqual(input, before);
  if (result.valid) assert.deepEqual(result.dataset.timeframes, input.timeframes);
});

test("dataset rejects unsupported pair/timeframe, malformed OHLC, offset timestamps, duplicates and disorder", () => {
  assert.equal(validateHistoricalDataset({ pair: "AUD/JPY", timeframes: { "15m": series("15m", 1) } }).valid, false);
  assert.equal(validateHistoricalDataset({ pair: "USD/JPY", timeframes: { "5m": [] } }).valid, false);
  const bad = candle(origin, 10, 9, 8);
  assert.equal(validateHistoricalDataset(dataset({ "15m": [bad] })).valid, false);
  const offset = { ...candle(origin, 10), time: "2026-01-01T00:00:00+00:00" };
  assert.equal(validateHistoricalDataset(dataset({ "15m": [offset] })).valid, false);
  const ordered = series("15m", 2);
  assert.equal(validateHistoricalDataset(dataset({ "15m": [ordered[1]!, ordered[0]!] })).valid, false);
  assert.equal(validateHistoricalDataset(dataset({ "15m": [ordered[0]!, ordered[0]!] })).valid, false);
});

test("per-timeframe as-of cutoff excludes forming candles independently", () => {
  const at = origin + 4 * 3_600_000;
  for (const timeframe of ["15m", "1h", "4h", "1day"] as const) {
    const rows = [candle(at - duration[timeframe] * 2, 10), candle(at - duration[timeframe], 11), candle(at, 12)];
    const confirmed = confirmedAtOrBefore(rows, timeframe, at);
    assert.equal(confirmed.length, 2, timeframe);
    assert.equal(Date.parse(confirmed.at(-1)!.time) + duration[timeframe], at, timeframe);
  }
});

test("as-of market uses latest confirmed 15m close and prefix-only indicators", () => {
  const source = readyDataset(true);
  const at = origin + 220 * duration["1h"];
  const built = buildHistoricalAsOfMarket(source, at);
  const expected = source.timeframes["15m"]!.filter(row => Date.parse(row.time) + duration["15m"] <= at).at(-1)!;
  assert.equal(built.currentRateTimeframe, "15m");
  assert.equal(built.currentRate, expected.close);
  const prefix = built.prefixes["15m"]!;
  assert.equal(built.market.timeframes["15m"].data?.indicators.sma200, calculateIndicators(prefix).sma200);
  assert.ok(!prefix.some(row => Date.parse(row.time) + duration["15m"] > at));
});

test("old 15m quote retains its true close time and fails live freshness", () => {
  const source = readyDataset();
  const last15m = source.timeframes["15m"]!.at(-1)!;
  const closeAt = Date.parse(last15m.time) + duration["15m"];
  const built = buildHistoricalAsOfMarket(source, closeAt + 5 * 60_000);
  assert.equal(Date.parse(built.market.price.fetchedAt!), closeAt);
  assert.equal(evaluateTechnical(built.market, closeAt + 5 * 60_000).ready, false);
});

test("205 candle warmup is required for SMA200 and five-candle slope; 204 is insufficient", () => {
  assert.equal(BACKTEST_MIN_TECHNICAL_CANDLES, 205);
  const makeMarket = (count: number) => {
    const at = origin + 205 * duration["1h"];
    const rows = (timeframe: MarketTimeframe) => Array.from({ length: count }, (_, index) => {
      const close = 150 + index * 0.01;
      return candle(at - (count - index) * duration[timeframe], close);
    });
    const timeframe = (frame: MarketTimeframe) => {
      const candles = rows(frame);
      return { data: { candles, indicators: calculateIndicators(candles), lastClosedAt: candles.at(-1)!.time }, fetchedAt: new Date(at).toISOString(), error: null, stale: false };
    };
    const fifteen = rows("15m");
    return {
      symbol: "USD/JPY" as const,
      price: { data: fifteen.at(-1)!.close, fetchedAt: new Date(at).toISOString(), error: null, stale: false },
      timeframes: { "15m": timeframe("15m"), "1h": timeframe("1h"), "4h": timeframe("4h") },
    };
  };
  assert.equal(evaluateTechnical(makeMarket(204), origin + 205 * duration["1h"]).ready, false);
  assert.equal(evaluateTechnical(makeMarket(205), origin + 205 * duration["1h"]).ready, true);
});

test("replay is deterministic, excludes future additions, and marks event/AI context unavailable", () => {
  const base = readyDataset();
  const future = readyDataset(true);
  const first = replayHistoricalSignals(base, { signalTimeframe: "1h" });
  const second = replayHistoricalSignals(future, { signalTimeframe: "1h" });
  const a = first.signals.find(signal => signal.status === "EVALUATED")!;
  const b = second.signals.find(signal => signal.at === a.at)!;
  assert.equal(a.direction, b.direction);
  assert.equal(a.score, b.score);
  assert.equal(a.signalPrice, b.signalPrice);
  assert.equal(a.mtfAlignment, b.mtfAlignment);
  assert.equal(a.regime, b.regime);
  assert.equal(a.regimeTrendDirection, b.regimeTrendDirection);
  assert.equal(a.scenarioStatus, b.scenarioStatus);
  assert.equal(a.economicEventStatus, "NOT_EVALUATED");
  assert.equal(a.aiContextStatus, "UNAVAILABLE_NOT_FABRICATED");
  assert.ok(first.summary.evaluated > 0);
  assert.ok(first.summary.warmupSkipped > 0);
  assert.ok(first.signals.filter(signal => signal.status === "EVALUATED").every(signal => signal.actionObservation === "WAIT"));
  assert.ok(first.safetyObservations.counts.DATA_QUALITY > 0);
});

test("prefix invariance covers direction, MTF, Regime, and Scenario inputs", () => {
  const before = readyDataset();
  const after = readyDataset(true);
  const at = origin + 220 * duration["1h"];
  const left = buildHistoricalAsOfMarket(before, at);
  const right = buildHistoricalAsOfMarket(after, at);
  const leftTechnical = evaluateTechnical(left.market, at);
  const rightTechnical = evaluateTechnical(right.market, at);
  assert.deepEqual(leftTechnical, rightTechnical);
  const leftMtf = replayHistoricalSignals(before, { signalTimeframe: "1h" }).signals.find(signal => signal.at === new Date(at).toISOString());
  const rightMtf = replayHistoricalSignals(after, { signalTimeframe: "1h" }).signals.find(signal => signal.at === new Date(at).toISOString());
  assert.equal(leftMtf?.direction, rightMtf?.direction);
  const regimeA = buildHistoricalAsOfMarket(before, at).prefixes["1h"]!;
  const regimeB = buildHistoricalAsOfMarket(after, at).prefixes["1h"]!;
  assert.deepEqual(regimeA, regimeB);
});

test("MTF below 200 candles is unavailable and never consumes the stored-indicator fallback", () => {
  const end = origin + 205 * duration["1h"];
  const input = dataset({
    "15m": seriesEnding("15m", 821, end),
    "1h": seriesEnding("1h", 205, end),
    "4h": seriesEnding("4h", 199, end),
    "1day": seriesEnding("1day", 199, end),
  });
  const result = replayHistoricalSignals(input, { signalTimeframe: "1h" });
  assert.equal(result.signals.at(-1)?.mtfAlignment, "insufficient");
});

test("with all four timeframes warmed, appending a future extreme cannot change as-of MTF/Regime/Scenario", () => {
  const end = origin + 220 * duration["1day"];
  const original = dataset({
    "15m": seriesEnding("15m", 205, end),
    "1h": seriesEnding("1h", 205, end),
    "4h": seriesEnding("4h", 205, end),
    "1day": seriesEnding("1day", 220, end),
  });
  const future = structuredClone(original);
  for (const timeframe of ["15m", "1h", "4h", "1day"] as const) {
    future.timeframes[timeframe]!.push(candle(end, 900, 1000, 1));
  }
  const a = replayHistoricalSignals(original, { signalTimeframe: "1day" }).signals.at(-1)!;
  const b = replayHistoricalSignals(future, { signalTimeframe: "1day" }).signals.find(signal => signal.at === a.at)!;
  assert.equal(a.status, "EVALUATED");
  assert.equal(a.direction, b.direction);
  assert.equal(a.score, b.score);
  assert.equal(a.signalPrice, b.signalPrice);
  assert.equal(a.mtfAlignment, b.mtfAlignment);
  assert.equal(a.regime, b.regime);
  assert.equal(a.regimeTrendDirection, b.regimeTrendDirection);
  assert.equal(a.scenarioStatus, b.scenarioStatus);
});

test("replay executes without calling any provider fetch", () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new Error("provider fetch is forbidden in replay");
  };
  try {
    replayHistoricalSignals(readyDataset(), { signalTimeframe: "1h" });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(calls, 0);
});

test("forward BUY/SELL returns, MFE/MAE exclude the signal candle", () => {
  const buyRows = [candle(origin, 150, 151, 149), candle(origin + 3_600_000, 150.1, 150.3, 149.8), candle(origin + 7_200_000, 150.2, 150.4, 149.9)];
  const sellRows = [candle(origin, 150, 151, 149), candle(origin + 3_600_000, 149.9, 150.2, 149.7), candle(origin + 7_200_000, 149.8, 150.1, 149.6)];
  const buy = measureForwardPerformance("buy", 150, buyRows, 0, [1, 2]);
  const sell = measureForwardPerformance("sell", 150, sellRows, 0, [1, 2]);
  assert.ok(Math.abs(buy.forward[0]!.rawReturnPips! - 10) < 1e-8);
  assert.ok(Math.abs(buy.forward[0]!.directionAdjustedPips! - 10) < 1e-8);
  assert.ok(Math.abs(sell.forward[0]!.rawReturnPips! + 10) < 1e-8);
  assert.ok(Math.abs(sell.forward[0]!.directionAdjustedPips! - 10) < 1e-8);
  assert.ok(Math.abs(buy.excursions[0]!.mfePips! - 30) < 1e-8);
  assert.ok(Math.abs(buy.excursions[0]!.maePips! - 20) < 1e-8);
  assert.ok(Math.abs(sell.excursions[0]!.mfePips! - 30) < 1e-8);
  assert.ok(Math.abs(sell.excursions[0]!.maePips! - 20) < 1e-8);
});

test("five current Direction thresholds remain unchanged", () => {
  assert.deepEqual([60, 20, 0, -20, -60].map(signalFromScore), ["strong_buy", "buy", "wait", "sell", "strong_sell"]);
});

test("forward horizon with insufficient future candles is omitted rather than fabricated", () => {
  const result = replayHistoricalSignals(dataset({ "15m": series("15m", 880), "1h": series("1h", 220) }), { signalTimeframe: "1h" });
  const last = result.signals.at(-1)!;
  assert.equal(last.forward.length, 0);
  assert.equal(last.excursions.length, 0);
  assert.deepEqual(last.unavailableForwardHorizons, [1, 4, 12]);
});