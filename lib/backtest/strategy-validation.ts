import { createHash } from "node:crypto";
import { technicalScoreWeights, timeframeWeights } from "../ai/technical";
import { defaultTradeSimulatorConfig, simulateTrades, type SimulatedTrade, type TradeSimulatorConfig, type TradeSimulatorResult } from "./trade-simulator";
import { historicalTimeframes, historicalTimeframeDurationMs, replayHistoricalSignals, type HistoricalDataset, type HistoricalTimeframe } from "./signal-replay";
import type { Symbol } from "../market/types";
import type { ImportedHistoricalDataset } from "./local-dataset";

export type ValidationPartitionName = "TRAIN" | "VALIDATION" | "OOS";
export type OosStatus = "UNTOUCHED" | "EVALUATED" | "CONSUMED";
export type DatasetKind = ImportedHistoricalDataset["provenance"]["dataKind"];

export interface ChronologicalSplitConfig {
  trainRatio: number;
  validationRatio: number;
  oosRatio: number;
}

export interface SplitBoundary {
  partition: ValidationPartitionName;
  startIndex: number;
  endIndexExclusive: number;
  startInclusiveAt: string;
  endExclusiveAt: string | null;
  lastEvaluationAt: string;
}

export interface FrozenBaselineConfig {
  baselineVersion: "TASK113_V2_TASK115_V1";
  directionThresholds: { strongBuy: number; buy: number; sell: number; strongSell: number };
  technicalScoreWeights: typeof technicalScoreWeights;
  timeframeWeights: typeof timeframeWeights;
  indicators: { smaPeriods: [20, 75, 200]; rsiPeriod: 14; atrPeriod: 14; recentHighLowBars: 20; momentumBars: 5; slopeLookbackBars: 5 };
  scenario: { entryPullbackAtr: [0.25, 0.1]; entryReturnAtr: [0.1, 0.25]; stopPaddingAtr: [0.1, 0.5]; target2PaddingAtr: 0.75; minRewardRisk: 1.5 };
  simulator: TradeSimulatorConfig;
}

export interface CostScenario {
  name: string;
  spreadMode: "FIXED_ROUND_TRIP_PIPS";
  spreadPipsByPair: Partial<Record<Symbol, number>>;
  slippagePipsPerFill: number;
  commissionJpyPerTrade: number;
}

export const defaultCostScenario: CostScenario = {
  name: "zero-cost-reference",
  spreadMode: "FIXED_ROUND_TRIP_PIPS",
  spreadPipsByPair: { "USD/JPY": 0, "EUR/JPY": 0, "GBP/JPY": 0 },
  slippagePipsPerFill: 0,
  commissionJpyPerTrade: 0,
};

export interface TradeCostBreakdown {
  tradeId: string;
  pair: Symbol;
  grossPnlJpy: number;
  spreadCostJpy: number;
  slippageCostJpy: number;
  commissionCostJpy: number;
  totalCostJpy: number;
  netPnlJpy: number;
  grossR: number | null;
  netR: number | null;
}

export interface CostMetrics {
  closedTradeCount: number;
  spreadCostJpy: number;
  slippageCostJpy: number;
  commissionCostJpy: number;
  totalCostJpy: number;
  netPnlJpy: number;
  netReturnPercent: number;
  netProfitFactor: number | null;
  netExpectancyJpy: number | null;
  netExpectancyR: number | null;
  netMaxDrawdownJpy: number;
  netMaxDrawdownPercent: number;
}

export interface NetEquityPoint {
  at: string | null;
  equityJpy: number;
  peakEquityJpy: number;
  drawdownJpy: number;
  drawdownPercent: number;
}

export interface CostScenarioResult {
  scenario: CostScenario;
  costModel: "SENSITIVITY_NOT_BROKER_QUOTE";
  spreadConvention: "FIXED_ROUND_TRIP_TOTAL_PIPS";
  slippageConvention: "ADVERSE_PER_FILL_ENTRY_AND_EXIT";
  commissionConvention: "JPY_PER_COMPLETED_TRADE";
  trades: TradeCostBreakdown[];
  netEquityCurve: NetEquityPoint[];
  metrics: CostMetrics;
}

export interface SessionWindows {
  asia: { timeZone: "Asia/Tokyo"; startLocal: string; endLocal: string };
  london: { timeZone: "Europe/London"; startLocal: string; endLocal: string };
  newYork: { timeZone: "America/New_York"; startLocal: string; endLocal: string };
}

export type SessionLabel = "ASIA" | "LONDON" | "NEW_YORK" | "LONDON_NEW_YORK_OVERLAP" | "OFF_SESSION" | "SESSION_ANALYSIS_UNAVAILABLE";
export type SessionAnalysisStatus = "AVAILABLE" | "SESSION_ANALYSIS_UNAVAILABLE";

export interface PartitionRun {
  pair: Symbol;
  datasetId: string;
  dataKind: DatasetKind;
  provenance: ImportedHistoricalDataset["provenance"];
  boundary: SplitBoundary;
  warmupCandlesByTimeframe: Partial<Record<HistoricalTimeframe, number>>;
  evaluationSignalCount: number;
  simulation: TradeSimulatorResult;
  costSensitivity: CostScenarioResult;
  regimeSegments: SegmentMetric[];
  sessionSegments: { status: SessionAnalysisStatus; groups: SegmentMetric[]; reason: string | null };
}

export interface SegmentMetric {
  key: string;
  sampleSize: number;
  wins: number;
  losses: number;
  breakEven: number;
  winRatePercent: number | null;
  grossPnlJpy: number;
  netPnlJpy: number;
  expectancyGrossJpy: number | null;
  expectancyNetJpy: number | null;
  averageR: number | null;
}

export interface BaselineValidationResult {
  metadata: {
    validationMode: "FROZEN_BASELINE";
    baselineVersion: FrozenBaselineConfig["baselineVersion"];
    baselineHash: string;
    parameterOptimization: false;
    oosStatus: OosStatus;
    oosIsolation: "OOS_NOT_INCLUDED_IN_SELECTION_INPUT";
    dataKind: DatasetKind;
    datasetId: string;
    pair: Symbol;
  };
  baselineConfig: FrozenBaselineConfig;
  splitConfig: ChronologicalSplitConfig;
  boundaries: SplitBoundary[];
  partitions: Record<ValidationPartitionName, PartitionRun[]>;
  pairSegments: Record<ValidationPartitionName, SegmentMetric[]>;
  costScenario: CostScenario;
  limitations: string[];
}

export interface ValidationRunOptions {
  signalTimeframe: HistoricalTimeframe;
  split?: Partial<ChronologicalSplitConfig>;
  costScenario?: CostScenario;
  sessionWindows?: SessionWindows;
}

export const DEFAULT_VALIDATION_SPLIT: ChronologicalSplitConfig = { trainRatio: 0.6, validationRatio: 0.2, oosRatio: 0.2 };

const regimeKeys = ["trending", "range", "transition", "unavailable"] as const;
function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableSerialize(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
  }
  return value;
}

export function createFrozenBaselineConfig(simulator: Partial<TradeSimulatorConfig> = {}): FrozenBaselineConfig {
  return deepFreeze({
    baselineVersion: "TASK113_V2_TASK115_V1",
    directionThresholds: { strongBuy: 60, buy: 20, sell: -20, strongSell: -60 },
    technicalScoreWeights: { ...technicalScoreWeights },
    timeframeWeights: { ...timeframeWeights },
    indicators: { smaPeriods: [20, 75, 200] as [20, 75, 200], rsiPeriod: 14, atrPeriod: 14, recentHighLowBars: 20, momentumBars: 5, slopeLookbackBars: 5 },
    scenario: { entryPullbackAtr: [0.25, 0.1] as [0.25, 0.1], entryReturnAtr: [0.1, 0.25] as [0.1, 0.25], stopPaddingAtr: [0.1, 0.5] as [0.1, 0.5], target2PaddingAtr: 0.75, minRewardRisk: 1.5 },
    simulator: { ...defaultTradeSimulatorConfig, ...simulator },
  });
}

export function frozenBaselineHash(config: FrozenBaselineConfig): string {
  return createHash("sha256").update(stableSerialize(config), "utf8").digest("hex");
}

export function splitChronologically(signalCloseTimestamps: readonly string[], override: Partial<ChronologicalSplitConfig> = {}): { config: ChronologicalSplitConfig; boundaries: SplitBoundary[] } {
  const config = { ...DEFAULT_VALIDATION_SPLIT, ...override };
  const ratios = [config.trainRatio, config.validationRatio, config.oosRatio];
  if (ratios.some((value) => !Number.isFinite(value) || value <= 0) || Math.abs(ratios.reduce((sum, value) => sum + value, 0) - 1) > 1e-9) {
    throw new Error("split ratios must be positive and sum to 1");
  }
  if (signalCloseTimestamps.length < 3) throw new Error("at least 3 chronological signal timestamps are required");
  const timestamps = signalCloseTimestamps.map((value) => Date.parse(value));
  if (timestamps.some((value) => !Number.isFinite(value)) || timestamps.some((value, index) => index > 0 && value <= timestamps[index - 1]!)) {
    throw new Error("signal timestamps must be strictly chronological");
  }
  const trainEndIndex = Math.floor(timestamps.length * config.trainRatio);
  const validationEndIndex = trainEndIndex + Math.floor(timestamps.length * config.validationRatio);
  if (trainEndIndex < 1 || validationEndIndex <= trainEndIndex || validationEndIndex >= timestamps.length) {
    throw new Error("each chronological partition must contain at least one timestamp");
  }
  const ranges: Array<{ partition: ValidationPartitionName; start: number; end: number }> = [
    { partition: "TRAIN", start: 0, end: trainEndIndex },
    { partition: "VALIDATION", start: trainEndIndex, end: validationEndIndex },
    { partition: "OOS", start: validationEndIndex, end: timestamps.length },
  ];
  const boundaries = ranges.map((range) => ({
    partition: range.partition,
    startIndex: range.start,
    endIndexExclusive: range.end,
    startInclusiveAt: signalCloseTimestamps[range.start]!,
    endExclusiveAt: signalCloseTimestamps[range.end] ?? null,
    lastEvaluationAt: signalCloseTimestamps[range.end - 1]!,
  }));
  return { config, boundaries };
}

export function buildPartitionDataset(dataset: HistoricalDataset, boundary: SplitBoundary, warmupCandles = 204, requireCompleteWarmup = false): { dataset: HistoricalDataset; warmupCandlesByTimeframe: Partial<Record<HistoricalTimeframe, number>> } {
  if (!Number.isSafeInteger(warmupCandles) || warmupCandles < 0) throw new Error("warmupCandles must be a non-negative integer");
  const startAt = Date.parse(boundary.startInclusiveAt);
  const lastAt = Date.parse(boundary.lastEvaluationAt);
  const timeframes: HistoricalDataset["timeframes"] = {};
  const warmupCandlesByTimeframe: Partial<Record<HistoricalTimeframe, number>> = {};
  for (const timeframe of historicalTimeframes) {
    const candles = dataset.timeframes[timeframe];
    if (!candles) continue;
    const duration = historicalTimeframeDurationMs[timeframe];
    const context = candles.filter((candle) => Date.parse(candle.time) + duration < startAt).slice(-warmupCandles);
    if (requireCompleteWarmup && context.length !== warmupCandles) throw new Error(`${dataset.pair} ${timeframe} has only ${context.length} of ${warmupCandles} required warmup candles before ${boundary.partition}`);
    const evaluation = candles.filter((candle) => {
      const closeAt = Date.parse(candle.time) + duration;
      return closeAt >= startAt && closeAt <= lastAt;
    });
    const selected = [...context, ...evaluation].map((candle) => ({ ...candle }));
    timeframes[timeframe] = selected;
    warmupCandlesByTimeframe[timeframe] = context.length;
  }
  return { dataset: { id: `${dataset.id}:${boundary.partition.toLowerCase()}`, pair: dataset.pair, timeframes }, warmupCandlesByTimeframe };
}

export function baselineSelectionView(result: BaselineValidationResult): {
  baselineHash: string;
  train: PartitionRun[];
  validation: PartitionRun[];
} {
  return { baselineHash: result.metadata.baselineHash, train: result.partitions.TRAIN, validation: result.partitions.VALIDATION };
}

export function markOosConsumed(result: BaselineValidationResult, reason: string): BaselineValidationResult {
  if (!reason.trim()) throw new Error("an OOS consumption reason is required");
  return { ...result, metadata: { ...result.metadata, oosStatus: "CONSUMED" }, limitations: [...result.limitations, `OOS consumed: ${reason.trim()}. A fresh untouched OOS period is now required.`] };
}

function roundTripCosts(trade: SimulatedTrade, scenario: CostScenario): TradeCostBreakdown {
  const pipSize = 0.01;
  const spreadPips = scenario.spreadPipsByPair[trade.pair] ?? 0;
  const spreadCostJpy = spreadPips * pipSize * trade.quantity;
  const slippageCostJpy = scenario.slippagePipsPerFill * 2 * pipSize * trade.quantity;
  const commissionCostJpy = scenario.commissionJpyPerTrade;
  const totalCostJpy = spreadCostJpy + slippageCostJpy + commissionCostJpy;
  const grossPnlJpy = trade.realizedGrossPnlJpy!;
  const netPnlJpy = grossPnlJpy - totalCostJpy;
  return {
    tradeId: trade.id,
    pair: trade.pair,
    grossPnlJpy,
    spreadCostJpy,
    slippageCostJpy,
    commissionCostJpy,
    totalCostJpy,
    netPnlJpy,
    grossR: trade.realizedR,
    netR: trade.initialRiskJpy > 0 ? netPnlJpy / trade.initialRiskJpy : null,
  };
}

function netEquity(values: Array<{ at: string; pnl: number }>, initialCapital: number): { curve: NetEquityPoint[]; maxJpy: number; maxPercent: number } {
  let equity = initialCapital;
  let peak = initialCapital;
  let maxJpy = 0;
  let maxPercent = 0;
  const curve: NetEquityPoint[] = [{ at: null, equityJpy: equity, peakEquityJpy: peak, drawdownJpy: 0, drawdownPercent: 0 }];
  for (const value of values) {
    equity += value.pnl;
    peak = Math.max(peak, equity);
    const drawdown = peak - equity;
    const drawdownPercent = peak > 0 ? (drawdown / peak) * 100 : 0;
    maxJpy = Math.max(maxJpy, drawdown);
    maxPercent = Math.max(maxPercent, drawdownPercent);
    curve.push({ at: value.at, equityJpy: equity, peakEquityJpy: peak, drawdownJpy: drawdown, drawdownPercent });
  }
  return { curve, maxJpy, maxPercent };
}

export function applyCostScenario(simulation: TradeSimulatorResult, scenario: CostScenario): CostScenarioResult {
  if (!scenario.name.trim()) throw new Error("CostScenario name is required");
  if (scenario.spreadMode !== "FIXED_ROUND_TRIP_PIPS") throw new Error("unsupported spread mode");
  if (Object.values(scenario.spreadPipsByPair).some((value) => value === undefined || !Number.isFinite(value) || value < 0)) throw new Error("spread pips must be finite and non-negative");
  if (!Number.isFinite(scenario.slippagePipsPerFill) || scenario.slippagePipsPerFill < 0) throw new Error("slippage pips must be finite and non-negative");
  if (!Number.isFinite(scenario.commissionJpyPerTrade) || scenario.commissionJpyPerTrade < 0) throw new Error("commission must be finite and non-negative");
  const closed = simulation.trades.filter((trade) => trade.status === "CLOSED").toSorted((a, b) => a.exitAt!.localeCompare(b.exitAt!) || a.id.localeCompare(b.id));
  const costTrades = closed.map((trade) => roundTripCosts(trade, scenario));
  const total = (key: "spreadCostJpy" | "slippageCostJpy" | "commissionCostJpy" | "totalCostJpy" | "grossPnlJpy" | "netPnlJpy") => costTrades.reduce((sum, trade) => sum + trade[key], 0);
  const netWins = costTrades.filter((trade) => trade.netPnlJpy > 0);
  const netLosses = costTrades.filter((trade) => trade.netPnlJpy < 0);
  const netProfit = netWins.reduce((sum, trade) => sum + trade.netPnlJpy, 0);
  const netLoss = Math.abs(netLosses.reduce((sum, trade) => sum + trade.netPnlJpy, 0));
  const equity = netEquity(
    closed.map((trade, index) => ({ at: trade.exitAt!, pnl: costTrades[index]!.netPnlJpy })),
    simulation.config.initialCapital,
  );
  const netRValues = costTrades.map((trade) => trade.netR).filter((value): value is number => value !== null);
  const netPnlJpy = total("netPnlJpy");
  const netExpectancyJpy = closed.length ? netPnlJpy / closed.length : null;
  const netExpectancyR = netRValues.length ? netRValues.reduce((sum, value) => sum + value, 0) / netRValues.length : null;
  return {
    scenario: structuredClone(scenario),
    costModel: "SENSITIVITY_NOT_BROKER_QUOTE",
    spreadConvention: "FIXED_ROUND_TRIP_TOTAL_PIPS",
    slippageConvention: "ADVERSE_PER_FILL_ENTRY_AND_EXIT",
    commissionConvention: "JPY_PER_COMPLETED_TRADE",
    trades: costTrades,
    netEquityCurve: equity.curve,
    metrics: {
      closedTradeCount: closed.length,
      spreadCostJpy: total("spreadCostJpy"),
      slippageCostJpy: total("slippageCostJpy"),
      commissionCostJpy: total("commissionCostJpy"),
      totalCostJpy: total("totalCostJpy"),
      netPnlJpy,
      netReturnPercent: simulation.config.initialCapital > 0 ? (netPnlJpy / simulation.config.initialCapital) * 100 : 0,
      netProfitFactor: netLoss ? netProfit / netLoss : null,
      netExpectancyJpy,
      netExpectancyR,
      netMaxDrawdownJpy: equity.maxJpy,
      netMaxDrawdownPercent: equity.maxPercent,
    },
  };
}

function summary(trades: readonly TradeCostBreakdown[]): SegmentMetric {
  const wins = trades.filter((trade) => trade.grossPnlJpy > 0);
  const losses = trades.filter((trade) => trade.grossPnlJpy < 0);
  const breakEven = trades.length - wins.length - losses.length;
  const grossPnlJpy = trades.reduce((sum, trade) => sum + trade.grossPnlJpy, 0);
  const netPnlJpy = trades.reduce((sum, trade) => sum + trade.netPnlJpy, 0);
  const r = trades.map((trade) => trade.grossR).filter((value): value is number => value !== null);
  return {
    key: "",
    sampleSize: trades.length,
    wins: wins.length,
    losses: losses.length,
    breakEven,
    winRatePercent: trades.length ? (wins.length / trades.length) * 100 : null,
    grossPnlJpy,
    netPnlJpy,
    expectancyGrossJpy: trades.length ? grossPnlJpy / trades.length : null,
    expectancyNetJpy: trades.length ? netPnlJpy / trades.length : null,
    averageR: r.length ? r.reduce((sum, value) => sum + value, 0) / r.length : null,
  };
}

function segmentMetrics(key: string, trades: readonly TradeCostBreakdown[]): SegmentMetric {
  return { ...summary(trades), key };
}

function localMinute(timestamp: string, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(timestamp));
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  const minute = Number(parts.find((part) => part.type === "minute")?.value);
  return hour * 60 + minute;
}

function localWindowContains(timestamp: string, window: { timeZone: string; startLocal: string; endLocal: string }): boolean {
  const parse = (value: string) => {
    const match = /^(\d\d):(\d\d)$/.exec(value);
    return match ? Number(match[1]) * 60 + Number(match[2]) : NaN;
  };
  const start = parse(window.startLocal);
  const end = parse(window.endLocal);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) throw new Error("session local window must be HH:mm and not cross midnight");
  const current = localMinute(timestamp, window.timeZone);
  return current >= start && current < end;
}

export function classifySession(timestamp: string, windows?: SessionWindows): SessionLabel {
  if (!windows) return "SESSION_ANALYSIS_UNAVAILABLE";
  const asia = localWindowContains(timestamp, windows.asia);
  const london = localWindowContains(timestamp, windows.london);
  const newYork = localWindowContains(timestamp, windows.newYork);
  if (london && newYork) return "LONDON_NEW_YORK_OVERLAP";
  if (london) return "LONDON";
  if (newYork) return "NEW_YORK";
  if (asia) return "ASIA";
  return "OFF_SESSION";
}

function segmentTradesByKey(costTrades: TradeCostBreakdown[], keys: Map<string, string>): SegmentMetric[] {
  const groups = new Map<string, TradeCostBreakdown[]>();
  for (const trade of costTrades) {
    const key = keys.get(trade.tradeId) ?? "UNAVAILABLE";
    groups.set(key, [...(groups.get(key) ?? []), trade]);
  }
  return [...groups.entries()].toSorted(([a], [b]) => a.localeCompare(b)).map(([key, trades]) => segmentMetrics(key, trades));
}

function preparePartitionRun(imported: ImportedHistoricalDataset, boundary: SplitBoundary, signalTimeframe: HistoricalTimeframe, simulatorConfig: TradeSimulatorConfig, costScenario: CostScenario, sessionWindows?: SessionWindows): PartitionRun {
  const prepared = buildPartitionDataset(imported.dataset, boundary, 204, boundary.partition !== "TRAIN");
  const simulation = simulateTrades(prepared.dataset, { ...simulatorConfig, signalTimeframe }, { evaluationStartAt: boundary.startInclusiveAt });
  const sensitivity = applyCostScenario(simulation, costScenario);
  const replay = replayHistoricalSignals(prepared.dataset, { signalTimeframe, forwardHorizons: [1] });
  const regimeKeyByTrade = new Map<string, string>();
  const signalByTrade = new Map(simulation.signals.filter((signal) => signal.tradeId).map((signal) => [signal.tradeId!, signal]));
  const replayByAt = new Map(replay.signals.map((signal) => [signal.at, signal]));
  for (const trade of simulation.trades.filter((trade) => trade.status === "CLOSED")) {
    const signal = signalByTrade.get(trade.id);
    const context = signal ? replayByAt.get(signal.signalAt) : undefined;
    regimeKeyByTrade.set(trade.id, context?.regime ?? "UNAVAILABLE");
  }
  const costById = new Map(sensitivity.trades.map((trade) => [trade.tradeId, trade]));
  const closedCostTrades = simulation.trades
    .filter((trade) => trade.status === "CLOSED")
    .map((trade) => costById.get(trade.id)!)
    .filter(Boolean);
  const regimeSegments = regimeKeys.map((key) =>
    segmentMetrics(
      key,
      closedCostTrades.filter((trade) => regimeKeyByTrade.get(trade.tradeId) === key),
    ),
  );
  const sessionKeyByTrade = new Map<string, string>();
  for (const trade of simulation.trades.filter((trade) => trade.status === "CLOSED")) {
    const signal = signalByTrade.get(trade.id);
    sessionKeyByTrade.set(trade.id, signal ? classifySession(signal.signalAt, sessionWindows) : "SESSION_ANALYSIS_UNAVAILABLE");
  }
  const sessionSegments = sessionWindows ? { status: "AVAILABLE" as const, groups: segmentTradesByKey(closedCostTrades, sessionKeyByTrade), reason: null } : { status: "SESSION_ANALYSIS_UNAVAILABLE" as SessionAnalysisStatus, groups: [], reason: "Session windows were not supplied; no session boundaries are guessed." };
  const evaluationSignalCount = simulation.signals.filter((signal) => {
    const at = Date.parse(signal.signalAt);
    return at >= Date.parse(boundary.startInclusiveAt) && at <= Date.parse(boundary.lastEvaluationAt);
  }).length;
  return {
    pair: imported.dataset.pair as Symbol,
    datasetId: imported.dataset.id,
    dataKind: imported.provenance.dataKind,
    provenance: imported.provenance,
    boundary,
    warmupCandlesByTimeframe: prepared.warmupCandlesByTimeframe,
    evaluationSignalCount,
    simulation,
    costSensitivity: sensitivity,
    regimeSegments,
    sessionSegments,
  };
}

function validationLimitations(dataKinds: DatasetKind[]): string[] {
  return [
    ...(dataKinds.includes("SYNTHETIC") ? ["Synthetic dataset results are pipeline checks, not observed-market strategy evidence."] : []),
    "No parameter optimization is implemented; the current baseline is evaluated without tuning.",
    "OOS is reported separately and excluded from the Train/Validation selection view. If OOS informs a strategy change, mark it CONSUMED and use a fresh untouched OOS period.",
    "Session results are unavailable unless explicit DST-aware IANA session windows are provided.",
    "Cost sensitivity is a post-simulation overlay on identical fills/exits and does not change Task115 risk limits or position sizing.",
  ];
}

export function runFrozenBaselineValidation(importedDatasets: ImportedHistoricalDataset[], options: ValidationRunOptions): BaselineValidationResult {
  if (!importedDatasets.length) throw new Error("at least one imported dataset is required");
  if (new Set(importedDatasets.map((dataset) => dataset.provenance.pair)).size !== importedDatasets.length) throw new Error("duplicate pair dataset is not allowed");
  const simulatorConfig = { ...defaultTradeSimulatorConfig, signalTimeframe: options.signalTimeframe };
  const baselineConfig = createFrozenBaselineConfig(simulatorConfig);
  const baselineHash = frozenBaselineHash(baselineConfig);
  const splitPlanByPair = new Map<Symbol, ReturnType<typeof splitChronologically>>();
  for (const imported of importedDatasets) {
    const timestamps = imported.dataset.timeframes[options.signalTimeframe]?.map((candle) => new Date(Date.parse(candle.time) + historicalTimeframeDurationMs[options.signalTimeframe]).toISOString()) ?? [];
    splitPlanByPair.set(imported.dataset.pair as Symbol, splitChronologically(timestamps, options.split));
  }
  const firstPlan = splitPlanByPair.get(importedDatasets[0]!.dataset.pair as Symbol)!;
  const partitions: Record<ValidationPartitionName, PartitionRun[]> = { TRAIN: [], VALIDATION: [], OOS: [] };
  for (const imported of importedDatasets) {
    const plan = splitPlanByPair.get(imported.dataset.pair as Symbol)!;
    for (const boundary of plan.boundaries) {
      partitions[boundary.partition].push(preparePartitionRun(imported, boundary, options.signalTimeframe, simulatorConfig, options.costScenario ?? defaultCostScenario, options.sessionWindows));
    }
  }
  const pairSegments = Object.fromEntries((Object.keys(partitions) as ValidationPartitionName[]).map((partition) => [partition, partitions[partition].map((run) => segmentMetrics(run.pair, run.costSensitivity.trades))])) as Record<ValidationPartitionName, SegmentMetric[]>;
  const first = importedDatasets[0]!;
  return {
    metadata: {
      validationMode: "FROZEN_BASELINE",
      baselineVersion: baselineConfig.baselineVersion,
      baselineHash,
      parameterOptimization: false,
      oosStatus: "EVALUATED",
      oosIsolation: "OOS_NOT_INCLUDED_IN_SELECTION_INPUT",
      dataKind: first.provenance.dataKind,
      datasetId: first.provenance.datasetId,
      pair: first.provenance.pair,
    },
    baselineConfig,
    splitConfig: firstPlan.config,
    boundaries: firstPlan.boundaries,
    partitions,
    pairSegments,
    costScenario: structuredClone(options.costScenario ?? defaultCostScenario),
    limitations: validationLimitations(importedDatasets.map((dataset) => dataset.provenance.dataKind)),
  };
}
