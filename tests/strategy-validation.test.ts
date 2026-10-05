import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadLocalHistoricalDataset, sha256Hex as checksumSha256, importHistoricalCsvManifest, type ImportedHistoricalDataset } from "../lib/backtest/local-dataset";
import { applyCostScenario, baselineSelectionView, buildPartitionDataset, classifySession, createFrozenBaselineConfig, DEFAULT_VALIDATION_SPLIT, defaultCostScenario, frozenBaselineHash, markOosConsumed, runFrozenBaselineValidation, splitChronologically, type BaselineValidationResult, type CostScenario } from "../lib/backtest/strategy-validation";
import { historicalTimeframeDurationMs, type HistoricalDataset, type HistoricalTimeframe } from "../lib/backtest/signal-replay";
import type { SimulatedTrade, TradeSimulatorResult } from "../lib/backtest/trade-simulator";
import type { Candle, Symbol } from "../lib/market/types";

const origin = Date.parse("2025-01-01T00:00:00.000Z");
const HOUR = 3_600_000;
const durations = historicalTimeframeDurationMs;

function csv(rows: Array<[string, number, number, number, number]>): string {
  return ["time,open,high,low,close", ...rows.map((row) => row.join(","))].join("\n") + "\n";
}

function manifestFor(content: string, changes: Record<string, unknown> = {}) {
  return {
    datasetId: "csv-test",
    pair: "USD/JPY",
    source: "LOCAL_FIXTURE",
    timezone: "UTC",
    exportedAt: "2026-01-01T00:00:00.000Z",
    licenseProvenance: "test-only synthetic fixture",
    dataKind: "SYNTHETIC",
    files: { "15m": { fileName: "usdjpy_15m.csv", sha256: checksumSha256(content) } },
    ...changes,
  };
}

function candle(time: number, close: number, pad = 0.02): Candle {
  return { time: new Date(time).toISOString(), open: close, high: close + pad, low: close - pad, close };
}

function generatedDataset(pair: Symbol = "USD/JPY", count = 220): HistoricalDataset {
  const end = origin + count * durations["1h"];
  const rows = (timeframe: HistoricalTimeframe, bars: number) =>
    Array.from({ length: bars }, (_, index) => {
      const closeAt = end - (bars - index - 1) * durations[timeframe];
      return candle(closeAt - durations[timeframe], 150 + ((closeAt - end) / durations["1h"]) * 0.02, timeframe === "1h" ? 0.3 : 0.1);
    });
  return {
    id: `synthetic-${pair}`,
    pair,
    timeframes: { "15m": rows("15m", count * 4), "1h": rows("1h", count), "4h": rows("4h", count), "1day": rows("1day", count) },
  };
}

function imported(dataset: HistoricalDataset): ImportedHistoricalDataset {
  const checksums: ImportedHistoricalDataset["provenance"]["checksums"] = {};
  const rowCounts: ImportedHistoricalDataset["provenance"]["rowCounts"] = {};
  const firstTimestamps: ImportedHistoricalDataset["provenance"]["firstTimestamps"] = {};
  const lastTimestamps: ImportedHistoricalDataset["provenance"]["lastTimestamps"] = {};
  for (const timeframe of Object.keys(dataset.timeframes) as HistoricalTimeframe[]) {
    const rows = dataset.timeframes[timeframe]!;
    checksums[timeframe] = "0".repeat(64);
    rowCounts[timeframe] = rows.length;
    firstTimestamps[timeframe] = rows[0]!.time;
    lastTimestamps[timeframe] = rows.at(-1)!.time;
  }
  return {
    dataset,
    provenance: { datasetId: dataset.id, pair: dataset.pair as Symbol, source: "TEST", timezone: "UTC", exportedAt: new Date(origin).toISOString(), licenseProvenance: "synthetic test data", dataKind: "SYNTHETIC", checksums, rowCounts, firstTimestamps, lastTimestamps, missingIntervals: [] },
  };
}

function trade(overrides: Partial<SimulatedTrade> = {}): SimulatedTrade {
  return {
    id: "sim-1",
    pair: "USD/JPY",
    direction: "buy",
    side: "long",
    signalAt: "2025-01-01T00:00:00.000Z",
    signalPrice: 150,
    entryAt: "2025-01-01T01:00:00.000Z",
    entryBarTime: "2025-01-01T01:00:00.000Z",
    entryBarTimeIndex: 1,
    entryPrice: 150,
    entryReason: "FILLED",
    quantity: 1000,
    projectedLossJpy: 100,
    initialStopLoss: 149.9,
    takeProfit1: 150.2,
    initialRiskJpy: 100,
    exitAt: "2025-01-01T02:00:00.000Z",
    exitPrice: 150.1,
    exitReason: "TAKE_PROFIT",
    holdingCandles: 1,
    realizedGrossPnlJpy: 100,
    realizedR: 1,
    unrealizedGrossPnlJpy: 0,
    status: "CLOSED",
    sameCandleEntryExit: false,
    productionAction: "WAIT",
    productionSafety: "BLOCK",
    productionSafetyReasons: ["DATA_QUALITY"],
    aiContext: "UNAVAILABLE",
    fundamentalContext: "UNAVAILABLE",
    economicEventContext: "NOT_EVALUATED",
    ...overrides,
  };
}

function simulationWith(trades: SimulatedTrade[]): TradeSimulatorResult {
  return { config: { initialCapital: 10_000 } as TradeSimulatorResult["config"], trades } as TradeSimulatorResult;
}

test("CSV import accepts canonical data and retains provenance/checksum/count/range", () => {
  const content = csv([
    ["2025-01-01T00:00:00.000Z", 157.123, 157.2, 157.05, 157.18],
    ["2025-01-01T00:15:00.000Z", 157.18, 157.21, 157.1, 157.2],
  ]);
  const result = importHistoricalCsvManifest(manifestFor(content), { "15m": content });
  assert.equal(result.valid, true);
  if (!result.valid) return;
  assert.equal(result.imported.provenance.dataKind, "SYNTHETIC");
  assert.equal(result.imported.provenance.checksums["15m"], checksumSha256(content));
  assert.equal(result.imported.provenance.rowCounts["15m"], 2);
  assert.equal(result.imported.provenance.firstTimestamps["15m"], "2025-01-01T00:00:00.000Z");
  assert.equal(result.imported.provenance.lastTimestamps["15m"], "2025-01-01T00:15:00.000Z");
});

test("local manifest and CSV load from disk without provider access", () => {
  const content = csv([["2025-01-01T00:00:00.000Z", 157.1, 157.2, 157, 157.15]]);
  const directory = mkdtempSync(join(tmpdir(), "task116-local-data-"));
  const originalFetch = globalThis.fetch;
  let providerCalls = 0;
  try {
    writeFileSync(join(directory, "manifest.json"), JSON.stringify(manifestFor(content, { dataKind: "OBSERVED" })));
    writeFileSync(join(directory, "usdjpy_15m.csv"), content);
    globalThis.fetch = async () => {
      providerCalls++;
      throw new Error("provider access forbidden");
    };
    const result = loadLocalHistoricalDataset(directory);
    assert.equal(result.valid, true);
    if (result.valid) {
      assert.equal(result.imported.provenance.dataKind, "OBSERVED");
      assert.equal(result.imported.provenance.source, "LOCAL_FIXTURE");
    }
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(directory, { recursive: true, force: true });
  }
  assert.equal(providerCalls, 0);
});

test("CSV import rejects header, non-UTC, duplicate/unordered, malformed, NaN and Infinity data", () => {
  const validRows: Array<[string, number, number, number, number]> = [["2025-01-01T00:00:00.000Z", 10, 11, 9, 10.5]];
  const good = csv(validRows);
  const invalids = ["timestamp,open,high,low,close\n2025-01-01T00:00:00.000Z,10,11,9,10\n", csv([["2025-01-01T00:00:00+00:00", 10, 11, 9, 10]]), csv([["2025-01-01T00:00:00.000Z", 10, 9, 8, 10]]), csv([["2025-01-01T00:00:00.000Z", NaN, 11, 9, 10]]), csv([["2025-01-01T00:00:00.000Z", Infinity, 11, 9, 10]]), csv([["2025-01-01T00:00:00.000Z", 10, 11, 9, 0]])];
  for (const text of invalids) assert.equal(importHistoricalCsvManifest(manifestFor(text), { "15m": text }).valid, false);
  const dup = csv([validRows[0]!, validRows[0]!]);
  assert.equal(importHistoricalCsvManifest(manifestFor(dup), { "15m": dup }).valid, false);
  const unordered = csv([
    ["2025-01-01T00:15:00.000Z", 10, 11, 9, 10],
    ["2025-01-01T00:00:00.000Z", 10, 11, 9, 10],
  ]);
  assert.equal(importHistoricalCsvManifest(manifestFor(unordered), { "15m": unordered }).valid, false);
  assert.equal(importHistoricalCsvManifest(manifestFor(good, { pair: "AUD/JPY" }), { "15m": good }).valid, false);
});

test("manifest rejects unsupported timeframe, bad checksum and missing provenance", () => {
  const content = csv([["2025-01-01T00:00:00.000Z", 10, 11, 9, 10]]);
  assert.equal(importHistoricalCsvManifest(manifestFor(content, { files: { "5m": { fileName: "bad.csv", sha256: checksumSha256(content) } } }), { "15m": content }).valid, false);
  assert.equal(importHistoricalCsvManifest(manifestFor(content, { files: { "15m": { fileName: "x.csv", sha256: "0".repeat(64) } } }), { "15m": content }).valid, false);
  assert.equal(importHistoricalCsvManifest(manifestFor(content, { licenseProvenance: "" }), { "15m": content }).valid, false);
});

test("gap detection records unclassified intervals and never repairs weekends/holidays", () => {
  const content = csv([
    ["2025-01-03T21:45:00.000Z", 150, 150.1, 149.9, 150],
    ["2025-01-06T00:00:00.000Z", 150, 150.1, 149.9, 150],
  ]);
  const result = importHistoricalCsvManifest(manifestFor(content), { "15m": content });
  assert.equal(result.valid, true);
  if (!result.valid) return;
  assert.equal(result.imported.dataset.timeframes["15m"]?.length, 2);
  assert.equal(result.imported.provenance.missingIntervals[0]?.classification, "UNCLASSIFIED_GAP");
  assert.ok((result.imported.provenance.missingIntervals[0]?.estimatedMissingSlots ?? 0) > 1);
});

test("SHA-256 checksum is deterministic", () => {
  const text = "time,open,high,low,close\n";
  assert.equal(checksumSha256(text), checksumSha256(text));
  assert.equal(checksumSha256(text).length, 64);
});

test("chronological split uses configurable 60/20/20 defaults with exact non-overlapping boundaries", () => {
  const timestamps = Array.from({ length: 10 }, (_, index) => new Date(origin + index * 1000).toISOString());
  const split = splitChronologically(timestamps);
  assert.deepEqual(split.config, DEFAULT_VALIDATION_SPLIT);
  assert.deepEqual(
    split.boundaries.map((boundary) => [boundary.startIndex, boundary.endIndexExclusive]),
    [
      [0, 6],
      [6, 8],
      [8, 10],
    ],
  );
  assert.equal(split.boundaries[0]!.endExclusiveAt, split.boundaries[1]!.startInclusiveAt);
  assert.equal(split.boundaries[1]!.endExclusiveAt, split.boundaries[2]!.startInclusiveAt);
  assert.equal(split.boundaries[2]!.lastEvaluationAt, timestamps[9]);
  assert.throws(() => splitChronologically(timestamps, { trainRatio: 0.7, validationRatio: 0.2, oosRatio: 0.2 }), /sum to 1/);
  assert.throws(() => splitChronologically([...timestamps].reverse()), /strictly chronological/);
});

test("partition dataset contains 204 past-only warmup bars plus only its evaluation range", () => {
  const dataset = generatedDataset("USD/JPY", 600);
  const signalTimeframe = dataset.timeframes["1h"]!;
  const closes = signalTimeframe.map((row) => new Date(Date.parse(row.time) + HOUR).toISOString());
  const split = splitChronologically(closes);
  const validationPartition = split.boundaries[1]!;
  const result = buildPartitionDataset(dataset, validationPartition);
  assert.equal(result.warmupCandlesByTimeframe["1h"], 204);
  assert.equal(result.dataset.timeframes["1h"]!.length, 204 + validationPartition.endIndexExclusive - validationPartition.startIndex);
  const evaluationRows = result.dataset.timeframes["1h"]!.filter((row) => Date.parse(row.time) + HOUR >= Date.parse(validationPartition.startInclusiveAt));
  assert.ok(evaluationRows.every((row) => Date.parse(row.time) + HOUR <= Date.parse(validationPartition.lastEvaluationAt)));
  assert.equal(dataset.timeframes["1h"]!.length, 600);
});

test("candles appended after a partition cannot alter its prepared dataset", () => {
  const original = generatedDataset("USD/JPY", 600);
  const closes = original.timeframes["1h"]!.map((row) => new Date(Date.parse(row.time) + HOUR).toISOString());
  const boundary = splitChronologically(closes).boundaries[1]!;
  const extended = structuredClone(original);
  for (const timeframe of Object.keys(extended.timeframes) as HistoricalTimeframe[]) {
    const rows = extended.timeframes[timeframe]!;
    const nextTime = Date.parse(rows.at(-1)!.time) + durations[timeframe];
    rows.push(candle(nextTime, 999, 0.1));
  }
  assert.deepEqual(buildPartitionDataset(extended, boundary), buildPartitionDataset(original, boundary));
});

test("partition can reject data without the required pre-evaluation warmup", () => {
  const dataset = generatedDataset("USD/JPY", 120);
  const closes = dataset.timeframes["1h"]!.map((row) => new Date(Date.parse(row.time) + HOUR).toISOString());
  const boundary = splitChronologically(closes).boundaries[1]!;
  assert.throws(() => buildPartitionDataset(dataset, boundary, 204, true), /only 72 of 204 required warmup candles/);
});

test("baseline config/hash are frozen and deterministic without strategy search", () => {
  const a = createFrozenBaselineConfig();
  const b = createFrozenBaselineConfig();
  assert.equal(frozenBaselineHash(a), frozenBaselineHash(b));
  assert.equal(a.scenario.minRewardRisk, 1.5);
  assert.equal(a.simulator.riskPerTradePercent, 0.5);
  assert.equal(a.simulator.maxHoldingCandles, 24);
  assert.equal(Object.isFrozen(a), true);
  assert.equal(Object.isFrozen(a.scenario), true);
});

test("cost sensitivity separates gross/cost/net and costs cannot improve result or fills", () => {
  const simulation = simulationWith([trade({ realizedGrossPnlJpy: 20, realizedR: 0.2, initialRiskJpy: 100 })]);
  const frozenSimulation = structuredClone(simulation);
  const scenario: CostScenario = { name: "stress", spreadMode: "FIXED_ROUND_TRIP_PIPS", spreadPipsByPair: { "USD/JPY": 1 }, slippagePipsPerFill: 0.5, commissionJpyPerTrade: 25 };
  const cost = applyCostScenario(simulation, scenario);
  assert.deepEqual(simulation, frozenSimulation);
  assert.equal(cost.trades[0]?.spreadCostJpy, 10);
  assert.equal(cost.trades[0]?.slippageCostJpy, 10);
  assert.equal(cost.trades[0]?.commissionCostJpy, 25);
  assert.equal(cost.trades[0]?.totalCostJpy, 45);
  assert.equal(cost.trades[0]?.grossPnlJpy, 20);
  assert.equal(cost.trades[0]?.netPnlJpy, -25);
  assert.equal(cost.trades[0]?.netR, -0.25);
  assert.ok(cost.trades[0]!.netPnlJpy <= cost.trades[0]!.grossPnlJpy);
  assert.equal(cost.metrics.netExpectancyJpy, -25);
  assert.ok(cost.metrics.netMaxDrawdownJpy > 0);
  assert.equal(cost.netEquityCurve[0]?.equityJpy, 10_000);
  assert.equal(cost.netEquityCurve.at(-1)?.equityJpy, 9_975);
});

test("zero-cost scenario preserves gross; zero sample metrics remain null not Infinity", () => {
  const result = applyCostScenario(simulationWith([trade()]), { ...defaultCostScenario });
  assert.equal(result.trades[0]?.totalCostJpy, 0);
  assert.equal(result.trades[0]?.netPnlJpy, result.trades[0]?.grossPnlJpy);
  const empty = applyCostScenario(simulationWith([]), defaultCostScenario);
  assert.equal(empty.metrics.netProfitFactor, null);
  assert.equal(empty.metrics.netExpectancyJpy, null);
});

test("frozen baseline selection view contains Train/Validation but structurally excludes OOS", () => {
  const config = createFrozenBaselineConfig();
  const emptyRuns = { TRAIN: [], VALIDATION: [], OOS: [] } as unknown as BaselineValidationResult["partitions"];
  const result = {
    metadata: { validationMode: "FROZEN_BASELINE", baselineVersion: config.baselineVersion, baselineHash: frozenBaselineHash(config), parameterOptimization: false, oosStatus: "EVALUATED", oosIsolation: "OOS_NOT_INCLUDED_IN_SELECTION_INPUT", dataKind: "SYNTHETIC", datasetId: "synthetic", pair: "USD/JPY" },
    baselineConfig: config,
    splitConfig: DEFAULT_VALIDATION_SPLIT,
    boundaries: [],
    partitions: emptyRuns,
    costScenario: defaultCostScenario,
    limitations: [],
  } as unknown as BaselineValidationResult;
  const selection = baselineSelectionView(result);
  assert.equal("oos" in selection, false);
  assert.equal(result.metadata.oosStatus, "EVALUATED");
  const consumed = markOosConsumed(result, "baseline-informed change");
  assert.equal(consumed.metadata.oosStatus, "CONSUMED");
  assert.equal(result.metadata.oosStatus, "EVALUATED");
});

test("session annotation is unavailable unless explicit IANA/DST-aware windows are provided", () => {
  assert.equal(classifySession("2025-01-01T12:00:00.000Z"), "SESSION_ANALYSIS_UNAVAILABLE");
  const windows = {
    asia: { timeZone: "Asia/Tokyo" as const, startLocal: "09:00", endLocal: "18:00" },
    london: { timeZone: "Europe/London" as const, startLocal: "08:00", endLocal: "17:00" },
    newYork: { timeZone: "America/New_York" as const, startLocal: "08:00", endLocal: "17:00" },
  };
  assert.equal(classifySession("2025-01-15T13:00:00.000Z", windows), "LONDON_NEW_YORK_OVERLAP");
  assert.equal(classifySession("2025-07-15T12:00:00.000Z", windows), "LONDON_NEW_YORK_OVERLAP");
});

test("frozen baseline runner keeps OOS separate and labels synthetic data", () => {
  const source = generatedDataset("USD/JPY", 800);
  const provenance = imported(source);
  const result = runFrozenBaselineValidation([provenance], { signalTimeframe: "1h" });
  assert.equal(result.metadata.validationMode, "FROZEN_BASELINE");
  assert.equal(result.metadata.dataKind, "SYNTHETIC");
  assert.equal(result.metadata.oosStatus, "EVALUATED");
  assert.equal(result.metadata.parameterOptimization, false);
  assert.equal(result.partitions.TRAIN.length, 1);
  assert.equal(result.partitions.VALIDATION.length, 1);
  assert.equal(result.partitions.OOS.length, 1);
  assert.ok(result.partitions.OOS[0]!.simulation.signals.every((signal) => signal.signalAt >= result.partitions.OOS[0]!.boundary.startInclusiveAt));
  assert.match(result.limitations[0]!, /Synthetic dataset/);
});
