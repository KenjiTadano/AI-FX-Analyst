import { calculateIndicators } from "../market/indicators";
import { buildMultiTimeframeAnalysis, MTF_MIN_CANDLES } from "../market/multi-timeframe";
import { analyzeMarketRegime } from "../market/market-regime";
import type { MarketRegimeKind, RegimeTrendDirection } from "../market/market-regime";
import type { TimeframeAlignment } from "../market/multi-timeframe";
import { symbols, timeframes, type Candle, type MarketData, type MarketTimeframe, type Resource, type Technical, type Timeframe } from "../market/types";
import { generateScenario } from "../ai/scenario";
import { evaluateTechnical } from "../ai/technical";
import { calculateSignalDirection, evaluateSignalEngineV2, type SignalEngineV2Result } from "../ai/signal-engine-v2";
import type { AnalysisInput, DataQuality, FactorCategory, TradeSignal } from "../ai/types";

export const historicalTimeframes = ["15m", "1h", "4h", "1day"] as const satisfies readonly MarketTimeframe[];
export type HistoricalTimeframe = (typeof historicalTimeframes)[number];
export const historicalTimeframeDurationMs: Record<HistoricalTimeframe, number> = {
  "15m": 900_000,
  "1h": 3_600_000,
  "4h": 14_400_000,
  "1day": 86_400_000,
};
export const BACKTEST_MIN_TECHNICAL_CANDLES = 205;
export const BACKTEST_DEFAULT_HORIZONS = [1, 4, 12] as const;
export const BACKTEST_CURRENT_RATE_TIMEFRAME: Timeframe = "15m";

export interface HistoricalDataset {
  id: string;
  pair: string;
  timeframes: Partial<Record<HistoricalTimeframe, Candle[]>>;
}

export type DatasetValidation =
  | { valid: true; dataset: HistoricalDataset; errors: [] }
  | { valid: false; dataset: null; errors: string[] };

export type BacktestWaitClassification = "NEUTRAL" | "SAFETY" | "SCENARIO" | "AI_CONTEXT" | "INSUFFICIENT";
export type SignalReplayStatus = "EVALUATED" | "WARMUP_SKIPPED";

export interface SignalReplayRecord {
  at: string;
  status: SignalReplayStatus;
  signalTimeframe: HistoricalTimeframe;
  signalPrice: number | null;
  currentRateTimeframe: Timeframe;
  direction: TradeSignal | null;
  score: number | null;
  actionObservation: "BUY" | "SELL" | "WAIT";
  scenarioStatus: SignalEngineV2Result["scenarioStatus"];
  waitClassification: BacktestWaitClassification[];
  safetyStatus: SignalEngineV2Result["safety"];
  safetyReasons: SignalEngineV2Result["safetyReasons"];
  mtfAlignment: TimeframeAlignment;
  regime: MarketRegimeKind;
  regimeTrendDirection: RegimeTrendDirection;
  economicEventStatus: "NOT_EVALUATED";
  aiContextStatus: "UNAVAILABLE_NOT_FABRICATED";
  unavailableForwardHorizons: number[];
  forward: ForwardObservation[];
  excursions: ExcursionObservation[];
}

export interface ForwardObservation {
  horizonCandles: number;
  direction: TradeSignal;
  rawReturnPips: number | null;
  rawReturnPercent: number | null;
  directionAdjustedPips: number | null;
  directionAdjustedPercent: number | null;
}

export interface ExcursionObservation {
  windowCandles: number;
  direction: TradeSignal;
  mfePips: number | null;
  maePips: number | null;
  mfePercent: number | null;
  maePercent: number | null;
}

export interface MetricSummary {
  samples: number;
  mean: number | null;
  median: number | null;
  positiveRate: number | null;
  negativeRate: number | null;
}

export interface BacktestConfig {
  signalTimeframe: HistoricalTimeframe;
  forwardHorizons: number[];
}

export interface BacktestResult {
  config: BacktestConfig & { currentRateTimeframe: Timeframe; minimumTechnicalCandles: number };
  datasetMetadata: {
    id: string;
    pair: string;
    timeframeCounts: Partial<Record<HistoricalTimeframe, number>>;
    timeframeRanges: Partial<Record<HistoricalTimeframe, { start: string; end: string }>>;
  };
  evaluatedRange: { start: string | null; end: string | null };
  summary: {
    totalTimestamps: number;
    evaluated: number;
    warmupSkipped: number;
    economicEventNotEvaluated: number;
    aiContextUnavailable: number;
  };
  signals: SignalReplayRecord[];
  directionDistribution: Record<TradeSignal, { count: number; percentage: number | null }>;
  forwardReturns: Record<TradeSignal, Record<number, { rawPips: MetricSummary; rawPercent: MetricSummary; directionAdjustedPips: MetricSummary; directionAdjustedPercent: MetricSummary }>>;
  mfeMae: Record<TradeSignal, Record<number, { mfePips: MetricSummary; maePips: MetricSummary; mfePercent: MetricSummary; maePercent: MetricSummary }>>;
  safetyObservations: {
    counts: Record<"DATA_QUALITY" | "STALE_DATA" | "ECONOMIC_EVENT" | "EXTENDED_MARKET" | "INSUFFICIENT_DATA", number>;
    staleDataStatus: "NOT_EVALUATED_NO_SOURCE_FRESHNESS_METADATA";
    economicEventStatus: "NOT_EVALUATED";
    eventNotEvaluatedCount: number;
  };
  waitClassification: Record<BacktestWaitClassification, number>;
  limitations: string[];
}

const categoryWeight: Record<FactorCategory, number> = { technical: 40, news: 20, economic: 20, central_bank: 10, market_environment: 10 };
const emptyAvailability = () => ({ status: "missing" as const, detail: "履歴データなし・未評価", fraction: 0 });
const emptySummary = (): MetricSummary => ({ samples: 0, mean: null, median: null, positiveRate: null, negativeRate: null });
const waitCategories: BacktestWaitClassification[] = ["NEUTRAL", "SAFETY", "SCENARIO", "AI_CONTEXT", "INSUFFICIENT"];
const signalValues: TradeSignal[] = ["strong_buy", "buy", "wait", "sell", "strong_sell"];
const safetyCodes = ["DATA_QUALITY", "STALE_DATA", "ECONOMIC_EVENT", "EXTENDED_MARKET", "INSUFFICIENT_DATA"] as const;
const LIMITATIONS = [
  "Historical AI, fundamental/news and economic-event snapshots are unavailable; they are not fabricated.",
  "Economic event safety is NOT_EVALUATED, not assumed safe.",
  "Action WAIT caused by missing AI/Fundamental context is an observation, not a historical strategy decision.",
  "No bid/ask spread, slippage, commission, fills, win rate, profit factor, expectancy, net profit or drawdown simulation.",
  "Forward return and MFE/MAE are descriptive post-signal measurements, not trade profitability.",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function canonicalUtc(value: unknown): value is string {
  if (typeof value !== "string" || !value.endsWith("Z")) return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value;
}

function validCandle(value: unknown): value is Candle {
  if (!isRecord(value) || !canonicalUtc(value.time)) return false;
  const { open, high, low, close } = value;
  if (![open, high, low, close].every(number => typeof number === "number" && Number.isFinite(number) && number > 0)) return false;
  return (high as number) >= Math.max(open as number, close as number, low as number)
    && (low as number) <= Math.min(open as number, close as number);
}

export function validateHistoricalDataset(value: unknown): DatasetValidation {
  const errors: string[] = [];
  if (!isRecord(value)) return { valid: false, dataset: null, errors: ["dataset must be an object"] };
  const id = typeof value.id === "string" && value.id.trim() ? value.id.trim() : "local-dataset";
  const pair = typeof value.pair === "string" ? value.pair : "";
  if (!symbols.includes(pair as (typeof symbols)[number])) errors.push("pair is unsupported");
  if (!isRecord(value.timeframes)) return { valid: false, dataset: null, errors: [...errors, "timeframes must be an object"] };
  const inputTimeframes = value.timeframes;
  for (const key of Object.keys(inputTimeframes)) if (!(historicalTimeframes as readonly string[]).includes(key)) errors.push(`timeframe is unsupported: ${key}`);
  const timeframes: HistoricalDataset["timeframes"] = {};
  for (const timeframe of historicalTimeframes) {
    const rows = inputTimeframes[timeframe];
    if (rows === undefined) continue;
    if (!Array.isArray(rows)) {
      errors.push(`${timeframe} candles must be an array`);
      continue;
    }
    const copy: Candle[] = [];
    let previous = Number.NEGATIVE_INFINITY;
    rows.forEach((row, index) => {
      if (!validCandle(row)) {
        errors.push(`${timeframe}[${index}] is not a valid canonical UTC OHLC candle`);
        return;
      }
      const at = Date.parse(row.time);
      if (at <= previous) errors.push(`${timeframe} candles must be strictly chronological without duplicates`);
      previous = at;
      copy.push({ time: row.time, open: row.open, high: row.high, low: row.low, close: row.close });
    });
    timeframes[timeframe] = copy;
  }
  if (!Object.keys(timeframes).length) errors.push("at least one supported timeframe is required");
  if (!Object.values(timeframes).some(candles => candles?.length)) errors.push("at least one candle is required");
  if (errors.length) return { valid: false, dataset: null, errors };
  return { valid: true, dataset: { id, pair, timeframes }, errors: [] };
}

export function confirmedAtOrBefore(candles: readonly Candle[], timeframe: HistoricalTimeframe, at: number): Candle[] {
  const duration = historicalTimeframeDurationMs[timeframe];
  return candles.filter(candle => Date.parse(candle.time) + duration <= at);
}

function resourceAt(candles: Candle[] | undefined, atIso: string): Resource<Technical> {
  if (!candles?.length) return { data: null, fetchedAt: atIso, error: null, stale: false };
  const prefix = candles.map(candle => ({ ...candle }));
  return {
    data: { candles: prefix, indicators: calculateIndicators(prefix), lastClosedAt: prefix.at(-1)!.time },
    fetchedAt: atIso,
    error: null,
    stale: false,
  };
}

function resourceForMtf(candles: Candle[] | undefined, atIso: string): Resource<Technical> | null {
  if (!candles || candles.length < MTF_MIN_CANDLES) return null;
  return resourceAt(candles, atIso);
}

export interface HistoricalAsOfMarket {
  at: string;
  market: MarketData;
  prefixes: Partial<Record<HistoricalTimeframe, Candle[]>>;
  currentRateTimeframe: Timeframe;
  currentRate: number | null;
}

export function buildHistoricalAsOfMarket(dataset: HistoricalDataset, at: number): HistoricalAsOfMarket {
  if (!Number.isFinite(at)) throw new Error("as-of timestamp must be finite");
  const atIso = new Date(at).toISOString();
  const prefixes: Partial<Record<HistoricalTimeframe, Candle[]>> = {};
  for (const timeframe of historicalTimeframes) {
    const candles = dataset.timeframes[timeframe];
    if (candles) prefixes[timeframe] = confirmedAtOrBefore(candles, timeframe, at);
  }
  const priceCandle = prefixes[BACKTEST_CURRENT_RATE_TIMEFRAME]?.at(-1) ?? null;
  const priceAsOf = priceCandle
    ? new Date(Date.parse(priceCandle.time) + historicalTimeframeDurationMs[BACKTEST_CURRENT_RATE_TIMEFRAME]).toISOString()
    : atIso;
  const price: Resource<number> = {
    data: priceCandle?.close ?? null,
    fetchedAt: priceAsOf,
    error: null,
    stale: false,
  };
  const market: MarketData = {
    symbol: dataset.pair as MarketData["symbol"],
    price,
    timeframes: Object.fromEntries(timeframes.map(timeframe => [timeframe, resourceAt(prefixes[timeframe], atIso)])) as MarketData["timeframes"],
    daily: resourceAt(prefixes["1day"], atIso),
  };
  return { at: atIso, market, prefixes, currentRateTimeframe: BACKTEST_CURRENT_RATE_TIMEFRAME, currentRate: price.data };
}

function dataQualityFor(technicalFraction: number): DataQuality {
  const fractions: Record<FactorCategory, number> = {
    technical: Math.max(0, Math.min(1, technicalFraction)),
    news: 0,
    economic: 0,
    central_bank: 0,
    market_environment: 0,
  };
  const categories = Object.fromEntries(Object.entries(fractions).map(([category, fraction]) => [category, {
    status: fraction >= 0.999 ? "ok" as const : fraction > 0 ? "partial" as const : "missing" as const,
    detail: `${category}: historical context unavailable`,
    fraction,
  }])) as DataQuality["categories"];
  const missingData = Object.values(categories).filter(category => category.status !== "ok").map(category => category.detail);
  return {
    score: Math.round(Object.entries(fractions).reduce((sum, [category, fraction]) => sum + categoryWeight[category as FactorCategory] * fraction, 0)),
    missingData,
    categories,
    macroeconomicData: emptyAvailability(),
  };
}

function summarize(values: number[]): MetricSummary {
  if (!values.length) return emptySummary();
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return {
    samples: values.length,
    mean: values.reduce((sum, value) => sum + value, 0) / values.length,
    median: sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2,
    positiveRate: values.filter(value => value > 0).length / values.length * 100,
    negativeRate: values.filter(value => value < 0).length / values.length * 100,
  };
}

function pricePercent(delta: number, reference: number): number {
  return delta / reference * 100;
}

function directionSign(direction: TradeSignal): 1 | -1 | null {
  if (direction === "buy" || direction === "strong_buy") return 1;
  if (direction === "sell" || direction === "strong_sell") return -1;
  return null;
}

function toTechnicalInput(market: MarketData, at: number) {
  const technical = evaluateTechnical(market, at);
  const rateFraction = market.price.data !== null ? 0.2 : 0;
  const technicalFraction = rateFraction + technical.frames.reduce((sum, frame) => sum + frame.completeness * 0.8 / 3, 0);
  return { technical, dataQuality: dataQualityFor(technicalFraction) };
}

function waitClassification(engine: SignalEngineV2Result): BacktestWaitClassification[] {
  if (engine.action !== "WAIT") return [];
  const reasons = new Set(engine.actionReasons.map(reason => reason.code));
  const categories: BacktestWaitClassification[] = [];
  if (reasons.has("INSUFFICIENT_DATA")) categories.push("INSUFFICIENT");
  if (engine.safetyReasons.some(reason => reason.code !== "INSUFFICIENT_DATA")) categories.push("SAFETY");
  if (reasons.has("NO_VALID_RISK_SCENARIO")) categories.push("SCENARIO");
  if (reasons.has("NEUTRAL_DIRECTION")) categories.push("NEUTRAL");
  if (reasons.has("AI_CONTEXT_UNAVAILABLE")) categories.push("AI_CONTEXT");
  return categories;
}

function emptyRecord(at: string, timeframe: HistoricalTimeframe, currentRate: number | null, engine: SignalEngineV2Result, mtfAlignment: TimeframeAlignment, regime: MarketRegimeKind, regimeTrendDirection: RegimeTrendDirection): SignalReplayRecord {
  return {
    at,
    status: "WARMUP_SKIPPED",
    signalTimeframe: timeframe,
    signalPrice: currentRate,
    currentRateTimeframe: BACKTEST_CURRENT_RATE_TIMEFRAME,
    direction: null,
    score: null,
    actionObservation: engine.action,
    scenarioStatus: engine.scenarioStatus,
    waitClassification: ["INSUFFICIENT", ...waitClassification(engine).filter(item => item !== "INSUFFICIENT")],
    safetyStatus: engine.safety,
    safetyReasons: engine.safetyReasons,
    mtfAlignment,
    regime,
    regimeTrendDirection,
    economicEventStatus: "NOT_EVALUATED",
    aiContextStatus: "UNAVAILABLE_NOT_FABRICATED",
    unavailableForwardHorizons: [],
    forward: [],
    excursions: [],
  };
}

function buildEconomicEventUnknownInput(pair: string, at: string, currentRate: number | null, technical: ReturnType<typeof evaluateTechnical>, dataQuality: DataQuality): AnalysisInput {
  return {
    pair: pair as AnalysisInput["pair"],
    currentRate,
    technicalAnalysis: technical,
    fundamentalData: [],
    dataAvailability: dataQuality,
    timestamp: at,
    // false here means no historical event data was supplied to this call; it is not reported as event-safe.
    eventRisk: { imminent: false, uncertainTime: false, nextRiskAt: null, reasons: [], known: false },
  };
}

function recordEngineInput(input: AnalysisInput, scenarioAvailable: boolean, at: number): SignalEngineV2Result {
  return evaluateSignalEngineV2({
    technical: input.technicalAnalysis,
    dataQuality: input.dataAvailability,
    staleDataSources: [],
    eventRisk: input.eventRisk,
    aiAvailable: false,
    confidence: null,
    preferWait: false,
    contradictions: false,
    scenarioAvailable,
    now: at,
  });
}

export function measureForwardPerformance(
  direction: TradeSignal,
  signalPrice: number | null,
  timeframeCandles: readonly Candle[],
  signalIndex: number,
  horizons: readonly number[],
  pipSize = 0.01,
): Pick<SignalReplayRecord, "forward" | "excursions" | "unavailableForwardHorizons"> {
  if (!Number.isFinite(pipSize) || pipSize <= 0) throw new Error("pipSize must be positive and finite");
  const sign = directionSign(direction);
  const forward: ForwardObservation[] = [];
  const excursions: ExcursionObservation[] = [];
  const unavailableForwardHorizons: number[] = [];
  for (const horizon of horizons) {
    const future = timeframeCandles[signalIndex + horizon];
    if (!future || signalPrice === null) {
      unavailableForwardHorizons.push(horizon);
      continue;
    }
    const rawDelta = future.close - signalPrice;
    forward.push({
      horizonCandles: horizon,
      direction,
      rawReturnPips: rawDelta / pipSize,
      rawReturnPercent: pricePercent(rawDelta, signalPrice),
      directionAdjustedPips: sign === null ? null : rawDelta * sign / pipSize,
      directionAdjustedPercent: sign === null ? null : pricePercent(rawDelta * sign, signalPrice),
    });
    if (sign === null) continue;
    const window = timeframeCandles.slice(signalIndex + 1, signalIndex + horizon + 1);
    if (!window.length) continue;
    const maxHigh = Math.max(...window.map(candle => candle.high));
    const minLow = Math.min(...window.map(candle => candle.low));
    const mfe = sign === 1 ? maxHigh - signalPrice : signalPrice - minLow;
    const mae = sign === 1 ? signalPrice - minLow : maxHigh - signalPrice;
    excursions.push({
      windowCandles: horizon,
      direction,
      mfePips: mfe / pipSize,
      maePips: mae / pipSize,
      mfePercent: pricePercent(mfe, signalPrice),
      maePercent: pricePercent(mae, signalPrice),
    });
  }
  return { forward, excursions, unavailableForwardHorizons };
}

function emptyGroupedMetrics<T>(): Record<TradeSignal, Record<number, T>> {
  return Object.fromEntries(signalValues.map(signal => [signal, {}])) as Record<TradeSignal, Record<number, T>>;
}

function metadataFor(dataset: HistoricalDataset) {
  const timeframeCounts: BacktestResult["datasetMetadata"]["timeframeCounts"] = {};
  const timeframeRanges: BacktestResult["datasetMetadata"]["timeframeRanges"] = {};
  for (const timeframe of historicalTimeframes) {
    const candles = dataset.timeframes[timeframe];
    if (!candles?.length) continue;
    timeframeCounts[timeframe] = candles.length;
    timeframeRanges[timeframe] = { start: candles[0]!.time, end: candles.at(-1)!.time };
  }
  return { id: dataset.id, pair: dataset.pair, timeframeCounts, timeframeRanges };
}

export function replayHistoricalSignals(
  rawDataset: unknown,
  options: Partial<BacktestConfig> = {},
): BacktestResult {
  const validation = validateHistoricalDataset(rawDataset);
  if (!validation.valid) throw new Error(`invalid historical dataset: ${validation.errors.join("; ")}`);
  const dataset = validation.dataset;
  const signalTimeframe = options.signalTimeframe ?? "1h";
  if (!(historicalTimeframes as readonly string[]).includes(signalTimeframe)) throw new Error("signal timeframe is unsupported");
  const forwardHorizons = options.forwardHorizons ?? [...BACKTEST_DEFAULT_HORIZONS];
  if (!forwardHorizons.length || forwardHorizons.some(horizon => !Number.isSafeInteger(horizon) || horizon <= 0) || new Set(forwardHorizons).size !== forwardHorizons.length) {
    throw new Error("forward horizons must be unique positive integer candle counts");
  }
  const timeline = dataset.timeframes[signalTimeframe];
  if (!timeline?.length) throw new Error(`dataset has no ${signalTimeframe} candles`);
  const duration = historicalTimeframeDurationMs[signalTimeframe];
  const timestamps = timeline.map(candle => Date.parse(candle.time) + duration);
  const signals: SignalReplayRecord[] = [];
  const datasetMarketTimeframe = dataset.timeframes[signalTimeframe];

  timestamps.forEach((at, index) => {
    const asOf = buildHistoricalAsOfMarket(dataset, at);
    const { technical, dataQuality } = toTechnicalInput(asOf.market, at);
    const atIso = asOf.at;
    const prefix = asOf.prefixes;
    const mtf = buildMultiTimeframeAnalysis({
      pair: dataset.pair as MarketData["symbol"],
      analyzedAt: atIso,
      daily: resourceForMtf(prefix["1day"], atIso),
      timeframes: {
        "15m": resourceForMtf(prefix["15m"], atIso),
        "1h": resourceForMtf(prefix["1h"], atIso),
        "4h": resourceForMtf(prefix["4h"], atIso),
      },
    });
    const regime = analyzeMarketRegime({ pair: dataset.pair as MarketData["symbol"], candles: prefix["1h"] ?? [], analyzedAt: atIso });
    const analysisInput = buildEconomicEventUnknownInput(dataset.pair, asOf.at, asOf.currentRate, technical, dataQuality);
    const directionOnly = calculateSignalDirection(technical);
    const scenario = directionOnly.direction === "wait" ? null : generateScenario(analysisInput, directionOnly.direction);
    const engine = recordEngineInput(analysisInput, scenario !== null, at);
    const record = technical.ready
      ? {
        at: asOf.at,
        status: "EVALUATED" as const,
        signalTimeframe,
        signalPrice: asOf.currentRate,
        currentRateTimeframe: BACKTEST_CURRENT_RATE_TIMEFRAME,
        direction: directionOnly.direction,
        score: directionOnly.score,
        actionObservation: engine.action,
        scenarioStatus: engine.scenarioStatus,
        waitClassification: waitClassification(engine),
        safetyStatus: engine.safety,
        safetyReasons: engine.safetyReasons,
        mtfAlignment: mtf.alignment,
        regime: regime.regime,
        regimeTrendDirection: regime.trendDirection,
        economicEventStatus: "NOT_EVALUATED" as const,
        aiContextStatus: "UNAVAILABLE_NOT_FABRICATED" as const,
        unavailableForwardHorizons: [],
        forward: [],
        excursions: [],
      }
      : emptyRecord(asOf.at, signalTimeframe, asOf.currentRate, engine, mtf.alignment, regime.regime, regime.trendDirection);
    if (record.status === "EVALUATED" && datasetMarketTimeframe && record.direction) {
      const measured = measureForwardPerformance(record.direction, record.signalPrice, datasetMarketTimeframe, index, forwardHorizons);
      record.forward.push(...measured.forward);
      record.excursions.push(...measured.excursions);
      record.unavailableForwardHorizons.push(...measured.unavailableForwardHorizons);
    }
    signals.push(record);
  });

  const evaluated = signals.filter(signal => signal.status === "EVALUATED");
  const warmupSkipped = signals.length - evaluated.length;
  const directionDistribution = Object.fromEntries(signalValues.map(signal => {
    const count = evaluated.filter(item => item.direction === signal).length;
    return [signal, { count, percentage: evaluated.length ? count / evaluated.length * 100 : null }];
  })) as BacktestResult["directionDistribution"];
  const forwardReturns = emptyGroupedMetrics<BacktestResult["forwardReturns"][TradeSignal][number]>();
  const mfeMae = emptyGroupedMetrics<BacktestResult["mfeMae"][TradeSignal][number]>();
  for (const signal of signalValues) {
    for (const horizon of forwardHorizons) {
      const forwards = evaluated.flatMap(item => item.direction === signal ? item.forward.filter(value => value.horizonCandles === horizon) : []);
      const excursions = evaluated.flatMap(item => item.direction === signal ? item.excursions.filter(value => value.windowCandles === horizon) : []);
      forwardReturns[signal]![horizon] = {
        rawPips: summarize(forwards.flatMap(item => item.rawReturnPips === null ? [] : [item.rawReturnPips])),
        rawPercent: summarize(forwards.flatMap(item => item.rawReturnPercent === null ? [] : [item.rawReturnPercent])),
        directionAdjustedPips: summarize(forwards.flatMap(item => item.directionAdjustedPips === null ? [] : [item.directionAdjustedPips])),
        directionAdjustedPercent: summarize(forwards.flatMap(item => item.directionAdjustedPercent === null ? [] : [item.directionAdjustedPercent])),
      };
      mfeMae[signal]![horizon] = {
        mfePips: summarize(excursions.flatMap(item => item.mfePips === null ? [] : [item.mfePips])),
        maePips: summarize(excursions.flatMap(item => item.maePips === null ? [] : [item.maePips])),
        mfePercent: summarize(excursions.flatMap(item => item.mfePercent === null ? [] : [item.mfePercent])),
        maePercent: summarize(excursions.flatMap(item => item.maePercent === null ? [] : [item.maePercent])),
      };
    }
  }
  const safetyCounts = Object.fromEntries(safetyCodes.map(code => [code, signals.filter(signal => signal.safetyReasons.some(reason => reason.code === code)).length])) as BacktestResult["safetyObservations"]["counts"];
  const waitCounts = Object.fromEntries(waitCategories.map(category => [category, signals.filter(signal => signal.waitClassification.includes(category)).length])) as Record<BacktestWaitClassification, number>;
  return {
    config: { signalTimeframe, forwardHorizons: [...forwardHorizons], currentRateTimeframe: BACKTEST_CURRENT_RATE_TIMEFRAME, minimumTechnicalCandles: BACKTEST_MIN_TECHNICAL_CANDLES },
    datasetMetadata: metadataFor(dataset),
    evaluatedRange: { start: evaluated[0]?.at ?? null, end: evaluated.at(-1)?.at ?? null },
    summary: {
      totalTimestamps: signals.length,
      evaluated: evaluated.length,
      warmupSkipped,
      economicEventNotEvaluated: signals.length,
      aiContextUnavailable: signals.length,
    },
    signals,
    directionDistribution,
    forwardReturns,
    mfeMae,
    safetyObservations: {
      counts: safetyCounts,
      staleDataStatus: "NOT_EVALUATED_NO_SOURCE_FRESHNESS_METADATA",
      economicEventStatus: "NOT_EVALUATED",
      eventNotEvaluatedCount: signals.length,
    },
    waitClassification: waitCounts,
    limitations: [...LIMITATIONS],
  };
}
