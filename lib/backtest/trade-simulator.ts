import { buildHistoricalAsOfMarket, historicalTimeframes, historicalTimeframeDurationMs, replayHistoricalSignals, validateHistoricalDataset, type HistoricalDataset, type HistoricalTimeframe, type SignalReplayRecord } from "./signal-replay";
import { evaluateTechnical } from "../ai/technical";
import { generateScenario, validateScenario } from "../ai/scenario";
import type { AnalysisInput, DataQuality, FactorCategory, TradeScenario, TradeSignal } from "../ai/types";
import { positionSize } from "../risk/position-size";
import { pnl } from "../trades/calculations";
import { symbols, type Candle, type Symbol } from "../market/types";

export const TRADE_SIMULATOR_MODE = "RESEARCH" as const;
export const TRADE_SIMULATOR_ENTRY_POLICY = "NEXT_CANDLE" as const;
export const TRADE_SIMULATOR_SAME_CANDLE_POLICY = "SL_FIRST" as const;
export const TRADE_SIMULATOR_COST_MODEL = "GROSS" as const;

export type EntryFillReason = "FILLED" | "NO_ZONE_TOUCH" | "ENTRY_GAP_AMBIGUOUS";
export type CandidateReasonCode =
  | EntryFillReason
  | "WAIT_DIRECTION"
  | "INVALID_SCENARIO"
  | "INSUFFICIENT_DATA"
  | "SAFETY_BLOCK"
  | "POSITION_LIMIT"
  | "ENTRY_PENDING"
  | "MAX_TRADES_PER_DAY"
  | "DAILY_LOSS_LIMIT"
  | "CONSECUTIVE_LOSS_LIMIT"
  | "INVALID_QUANTITY"
  | "UNKNOWN_EVENT_CONTEXT"
  | "UNKNOWN_AI_CONTEXT"
  | "NO_FUTURE_ENTRY_CANDLE"
  | "UNFILLED_AT_DATASET_END";
export type BlockedCandidateReasonCode = Exclude<CandidateReasonCode, "FILLED" | "NO_ZONE_TOUCH">;
export type ExitReasonCode = "STOP_LOSS" | "TAKE_PROFIT" | "TIMEOUT" | "OPEN_UNREALIZED";
export type ResearchEligibility = "ELIGIBLE" | "INELIGIBLE" | "BLOCKED";
export type ResearchSafetyStatus = "ALLOW" | "BLOCK";

export interface TradeSimulatorConfig {
  signalTimeframe: HistoricalTimeframe;
  initialCapital: number;
  riskPerTradePercent: number;
  tradeUnit: number;
  maxConcurrentPositions: 1;
  maxTradesPerJstDay: number;
  dailyLossLimitPercent: number;
  consecutiveLossLimit: number;
  maxHoldingCandles: number;
  spreadPips: number;
  slippagePips: number;
  commissionJpyPerTrade: number;
}

export const defaultTradeSimulatorConfig: TradeSimulatorConfig = {
  signalTimeframe: "1h",
  initialCapital: 50_000,
  riskPerTradePercent: 0.5,
  tradeUnit: 1000,
  maxConcurrentPositions: 1,
  maxTradesPerJstDay: 3,
  dailyLossLimitPercent: 1,
  consecutiveLossLimit: 3,
  maxHoldingCandles: 24,
  spreadPips: 0,
  slippagePips: 0,
  commissionJpyPerTrade: 0,
};

export interface SimulatedSignal {
  pair: Symbol;
  signalAt: string;
  signalPrice: number | null;
  direction: TradeSignal | null;
  productionAction: "BUY" | "SELL" | "WAIT";
  productionSafety: "ALLOW" | "BLOCK";
  productionSafetyReasons: string[];
  researchSafety: ResearchSafetyStatus;
  researchSafetyReasons: string[];
  contextReasons: ("UNKNOWN_AI_CONTEXT" | "UNKNOWN_EVENT_CONTEXT" | "UNKNOWN_FUNDAMENTAL_CONTEXT")[];
  researchEligibility: ResearchEligibility;
  scenario: TradeScenario | null;
  reason: CandidateReasonCode | null;
  entryFillAt: string | null;
  entryPrice: number | null;
  exitAt: string | null;
  exitPrice: number | null;
  exitReason: ExitReasonCode | null;
  tradeId: string | null;
}

export interface SimulatedTrade {
  id: string;
  pair: Symbol;
  direction: Exclude<TradeSignal, "wait">;
  side: "long" | "short";
  signalAt: string;
  signalPrice: number;
  entryAt: string;
  entryBarTime: string;
  entryBarTimeIndex: number;
  entryPrice: number;
  entryReason: "FILLED";
  quantity: number;
  projectedLossJpy: number;
  initialStopLoss: number;
  takeProfit1: number;
  initialRiskJpy: number;
  exitAt: string | null;
  exitPrice: number | null;
  exitReason: ExitReasonCode;
  holdingCandles: number;
  realizedGrossPnlJpy: number | null;
  realizedR: number | null;
  unrealizedGrossPnlJpy: number | null;
  status: "CLOSED" | "OPEN_UNREALIZED";
  sameCandleEntryExit: boolean;
  productionAction: "BUY" | "SELL" | "WAIT";
  productionSafety: "ALLOW" | "BLOCK";
  productionSafetyReasons: string[];
  aiContext: "UNAVAILABLE";
  fundamentalContext: "UNAVAILABLE";
  economicEventContext: "NOT_EVALUATED";
}

export interface EquityPoint {
  at: string | null;
  equityJpy: number;
  peakEquityJpy: number;
  drawdownJpy: number;
  drawdownPercent: number;
}

export interface TradeSimulatorResult {
  config: TradeSimulatorConfig;
  metadata: {
    simulationMode: typeof TRADE_SIMULATOR_MODE;
    productionActionReplayed: false;
    historicalAiContext: "UNAVAILABLE";
    historicalFundamentalContext: "UNAVAILABLE";
    historicalEconomicEventContext: "NOT_EVALUATED";
    costModel: typeof TRADE_SIMULATOR_COST_MODEL;
    spreadModeled: false;
    slippageModeled: false;
    commissionModeled: false;
    sameCandlePolicy: typeof TRADE_SIMULATOR_SAME_CANDLE_POLICY;
    signalEntryPolicy: typeof TRADE_SIMULATOR_ENTRY_POLICY;
    maxConcurrentPositions: 1;
    dailyTimezone: "Asia/Tokyo";
    datasetIds: string[];
  };
  signals: SimulatedSignal[];
  trades: SimulatedTrade[];
  equityCurve: EquityPoint[];
  openPositions: SimulatedTrade[];
  blockedCandidateReasons: Record<BlockedCandidateReasonCode, number>;
  entryOpportunityReasons: Record<EntryFillReason, number>;
  exitReasonDistribution: Record<ExitReasonCode, number>;
  pairDistribution: Record<Symbol, number>;
  directionDistribution: Record<Exclude<TradeSignal, "wait">, number>;
  metrics: {
    closedTradeCount: number;
    wins: number;
    losses: number;
    breakEven: number;
    winRatePercent: number | null;
    realizedGrossPnlJpy: number;
    grossReturnPercent: number;
    averageWinJpy: number | null;
    averageLossJpy: number | null;
    profitFactor: number | null;
    totalR: number | null;
    averageR: number | null;
    medianR: number | null;
    expectancyJpyPerTrade: number | null;
    expectancyRPerTrade: number | null;
    maxDrawdownJpy: number;
    maxDrawdownPercent: number;
    maxConsecutiveWins: number;
    maxConsecutiveLosses: number;
    averageHoldingCandles: number | null;
    endingRealizedEquityJpy: number;
    endingUnrealizedGrossPnlJpy: number;
  };
  limitations: string[];
}

interface PreparedDataset {
  dataset: HistoricalDataset;
  replay: ReturnType<typeof replayHistoricalSignals>;
  candles: Candle[];
  signalIndexByAt: Map<string, number>;
  scenarioByAt: Map<string, TradeScenario | null>;
}

interface PendingCandidate {
  signal: SimulatedSignal;
  scenario: TradeScenario;
  signalIndex: number;
}

interface DailyState {
  startEquityJpy: number;
  realizedPnlJpy: number;
  entryCount: number;
}

type ExitDecision = { reason: "STOP_LOSS" | "TAKE_PROFIT" | "TIMEOUT"; price: number; holdingCandles: number } | null;

const categoryWeights: Record<FactorCategory, number> = { technical: 40, news: 20, economic: 20, central_bank: 10, market_environment: 10 };
const researchSafetyBlockReasons = new Set(["STALE_DATA", "INSUFFICIENT_DATA", "EXTENDED_MARKET", "ECONOMIC_EVENT"]);
const candidateReasons: BlockedCandidateReasonCode[] = [
  "ENTRY_GAP_AMBIGUOUS",
  "WAIT_DIRECTION",
  "INVALID_SCENARIO",
  "INSUFFICIENT_DATA",
  "SAFETY_BLOCK",
  "POSITION_LIMIT",
  "ENTRY_PENDING",
  "MAX_TRADES_PER_DAY",
  "DAILY_LOSS_LIMIT",
  "CONSECUTIVE_LOSS_LIMIT",
  "INVALID_QUANTITY",
  "UNKNOWN_EVENT_CONTEXT",
  "UNKNOWN_AI_CONTEXT",
  "NO_FUTURE_ENTRY_CANDLE",
  "UNFILLED_AT_DATASET_END",
];
const exitReasons: ExitReasonCode[] = ["STOP_LOSS", "TAKE_PROFIT", "TIMEOUT", "OPEN_UNREALIZED"];

function finiteConfig(config: TradeSimulatorConfig): void {
  if (!(historicalTimeframes as readonly string[]).includes(config.signalTimeframe)) throw new Error("signalTimeframe is unsupported");
  if (!Number.isFinite(config.initialCapital) || config.initialCapital <= 0 || config.initialCapital > 1e12) throw new Error("initialCapital must be positive and <= 1e12");
  if (!Number.isFinite(config.riskPerTradePercent) || config.riskPerTradePercent <= 0 || config.riskPerTradePercent > 10) throw new Error("riskPerTradePercent must be in (0, 10]");
  if (!Number.isSafeInteger(config.tradeUnit) || config.tradeUnit <= 0) throw new Error("tradeUnit must be a positive integer");
  if (config.maxConcurrentPositions !== 1) throw new Error("Task115 v1 fixes maxConcurrentPositions at 1");
  if (!Number.isSafeInteger(config.maxTradesPerJstDay) || config.maxTradesPerJstDay <= 0) throw new Error("maxTradesPerJstDay must be a positive integer");
  if (!Number.isFinite(config.dailyLossLimitPercent) || config.dailyLossLimitPercent <= 0 || config.dailyLossLimitPercent > 10) throw new Error("dailyLossLimitPercent must be in (0, 10]");
  if (!Number.isSafeInteger(config.consecutiveLossLimit) || config.consecutiveLossLimit <= 0) throw new Error("consecutiveLossLimit must be a positive integer");
  if (!Number.isSafeInteger(config.maxHoldingCandles) || config.maxHoldingCandles <= 0) throw new Error("maxHoldingCandles must be a positive integer");
  if (![config.spreadPips, config.slippagePips, config.commissionJpyPerTrade].every((value) => Number.isFinite(value) && value === 0)) {
    throw new Error("non-zero spread/slippage/commission is not modeled in Task115 v1");
  }
}

export function jstDate(timestamp: number): string {
  return new Date(timestamp + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function evaluateEntryLimit(input: { entriesToday: number; maxTradesPerJstDay: number; realizedPnlTodayJpy: number; startOfDayEquityJpy: number; dailyLossLimitPercent: number; consecutiveLosses: number; consecutiveLossLimit: number }): "MAX_TRADES_PER_DAY" | "DAILY_LOSS_LIMIT" | "CONSECUTIVE_LOSS_LIMIT" | null {
  if (input.entriesToday >= input.maxTradesPerJstDay) return "MAX_TRADES_PER_DAY";
  if (input.realizedPnlTodayJpy <= -((input.startOfDayEquityJpy * input.dailyLossLimitPercent) / 100)) return "DAILY_LOSS_LIMIT";
  if (input.consecutiveLosses >= input.consecutiveLossLimit) return "CONSECUTIVE_LOSS_LIMIT";
  return null;
}

export function updateConsecutiveLosses(current: number, realizedGrossPnlJpy: number): number {
  return realizedGrossPnlJpy < 0 ? current + 1 : 0;
}

export function evaluateResearchSafety(input: { technicalReady: boolean; productionReasonCodes: readonly string[] }): { status: ResearchSafetyStatus; reasons: string[] } {
  const reasons = new Set(input.productionReasonCodes.filter((code) => researchSafetyBlockReasons.has(code)));
  if (!input.technicalReady) reasons.add("INSUFFICIENT_DATA");
  return { status: reasons.size ? "BLOCK" : "ALLOW", reasons: [...reasons] };
}

function technicalQuality(technical: ReturnType<typeof evaluateTechnical>, hasRate: boolean): DataQuality {
  const fractions: Record<FactorCategory, number> = {
    technical: (hasRate ? 0.2 : 0) + technical.frames.reduce((sum, frame) => sum + (frame.completeness * 0.8) / 3, 0),
    news: 0,
    economic: 0,
    central_bank: 0,
    market_environment: 0,
  };
  const categories = Object.fromEntries(
    Object.entries(fractions).map(([category, fraction]) => [
      category,
      {
        status: fraction >= 0.999 ? ("ok" as const) : fraction > 0 ? ("partial" as const) : ("missing" as const),
        detail: `${category}: historical context unavailable`,
        fraction,
      },
    ]),
  ) as DataQuality["categories"];
  return {
    score: Math.round(Object.entries(fractions).reduce((sum, [category, fraction]) => sum + categoryWeights[category as FactorCategory] * fraction, 0)),
    missingData: Object.values(categories)
      .filter((item) => item.status !== "ok")
      .map((item) => item.detail),
    categories,
    macroeconomicData: { status: "missing", detail: "Historical macro unavailable", fraction: 0 },
  };
}

function scenarioAt(dataset: HistoricalDataset, replayRecord: SignalReplayRecord): TradeScenario | null {
  if (replayRecord.status !== "EVALUATED" || !replayRecord.direction || replayRecord.direction === "wait") return null;
  const at = Date.parse(replayRecord.at);
  const asOf = buildHistoricalAsOfMarket(dataset, at);
  const technical = evaluateTechnical(asOf.market, at);
  const input: AnalysisInput = {
    pair: dataset.pair as Symbol,
    currentRate: asOf.currentRate,
    technicalAnalysis: technical,
    fundamentalData: [],
    dataAvailability: technicalQuality(technical, asOf.currentRate !== null),
    timestamp: asOf.at,
    eventRisk: { imminent: false, uncertainTime: false, nextRiskAt: null, reasons: [], known: false },
  };
  return validateScenario(generateScenario(input, replayRecord.direction));
}

function prepareDatasets(rawDatasets: HistoricalDataset[], signalTimeframe: HistoricalTimeframe): PreparedDataset[] {
  if (!rawDatasets.length) throw new Error("at least one historical dataset is required");
  const seen = new Set<string>();
  const prepared = rawDatasets.map((raw) => {
    const validated = validateHistoricalDataset(raw);
    if (!validated.valid) throw new Error(`invalid historical dataset: ${validated.errors.join("; ")}`);
    const dataset = validated.dataset;
    if (seen.has(dataset.pair)) throw new Error(`duplicate pair dataset: ${dataset.pair}`);
    seen.add(dataset.pair);
    const candles = dataset.timeframes[signalTimeframe];
    if (!candles?.length) throw new Error(`${dataset.pair} has no ${signalTimeframe} candles`);
    const replay = replayHistoricalSignals(dataset, { signalTimeframe });
    const signalIndexByAt = new Map(replay.signals.map((record, index) => [record.at, index]));
    const scenarioByAt = new Map(replay.signals.map((record) => [record.at, scenarioAt(dataset, record)]));
    return { dataset, replay, candles, signalIndexByAt, scenarioByAt };
  });

  const reference = prepared[0]!.candles.map((candle) => Date.parse(candle.time) + historicalTimeframeDurationMs[signalTimeframe]);
  for (const current of prepared.slice(1)) {
    const timestamps = current.candles.map((candle) => Date.parse(candle.time) + historicalTimeframeDurationMs[signalTimeframe]);
    if (timestamps.length !== reference.length || timestamps.some((at, index) => at !== reference[index])) {
      throw new Error("multi-pair simulation requires identical signal-timeframe candle close timestamps");
    }
  }
  return prepared;
}

export function resolveEntryFill(scenario: TradeScenario, candle: Candle): { reason: EntryFillReason; price: number | null } {
  const { min, max } = scenario.entryZone;
  if (candle.open >= min && candle.open <= max) return { reason: "FILLED", price: candle.open };
  const intersects = candle.low <= max && candle.high >= min;
  if (intersects) return { reason: "ENTRY_GAP_AMBIGUOUS", price: null };
  return { reason: "NO_ZONE_TOUCH", price: null };
}

export function resolvePositionExit(position: Pick<SimulatedTrade, "side" | "initialStopLoss" | "takeProfit1">, candle: Candle, holdingCandles: number, maxHoldingCandles: number): ExitDecision {
  const isLong = position.side === "long";
  const stopGap = isLong ? candle.open < position.initialStopLoss : candle.open > position.initialStopLoss;
  if (stopGap) return { reason: "STOP_LOSS", price: candle.open, holdingCandles };

  const stopTouched = isLong ? candle.low <= position.initialStopLoss : candle.high >= position.initialStopLoss;
  const targetTouched = isLong ? candle.high >= position.takeProfit1 : candle.low <= position.takeProfit1;
  if (stopTouched && targetTouched) return { reason: "STOP_LOSS", price: position.initialStopLoss, holdingCandles };
  if (stopTouched) return { reason: "STOP_LOSS", price: position.initialStopLoss, holdingCandles };
  if (targetTouched) return { reason: "TAKE_PROFIT", price: position.takeProfit1, holdingCandles };
  if (holdingCandles >= maxHoldingCandles) return { reason: "TIMEOUT", price: candle.close, holdingCandles };
  return null;
}

function recordExit(position: SimulatedTrade, decision: Exclude<ExitDecision, null>, closedAt: string): void {
  const grossPnl = pnl(position.side, position.entryPrice, decision.price, position.quantity);
  if (grossPnl === null) throw new Error("simulated gross PnL is outside supported range");
  position.exitAt = closedAt;
  position.exitPrice = decision.price;
  position.exitReason = decision.reason;
  position.holdingCandles = decision.holdingCandles;
  position.realizedGrossPnlJpy = grossPnl;
  position.realizedR = position.initialRiskJpy > 0 ? grossPnl / position.initialRiskJpy : null;
  position.unrealizedGrossPnlJpy = 0;
  position.status = "CLOSED";
}

function emptyCandidateCounts(): Record<BlockedCandidateReasonCode, number> {
  return Object.fromEntries(candidateReasons.map((reason) => [reason, 0])) as Record<BlockedCandidateReasonCode, number>;
}

function emptyEntryOpportunityCounts(): Record<EntryFillReason, number> {
  return { FILLED: 0, NO_ZONE_TOUCH: 0, ENTRY_GAP_AMBIGUOUS: 0 };
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export function simulateTrades(rawDatasets: HistoricalDataset | HistoricalDataset[], inputConfig: Partial<TradeSimulatorConfig> = {}, options: { evaluationStartAt?: string } = {}): TradeSimulatorResult {
  const config: TradeSimulatorConfig = { ...defaultTradeSimulatorConfig, ...inputConfig };
  if (!(historicalTimeframes as readonly string[]).includes(config.signalTimeframe)) throw new Error("signalTimeframe is unsupported");
  finiteConfig(config);
  const rawList = Array.isArray(rawDatasets) ? rawDatasets : [rawDatasets];
  const prepared = prepareDatasets(rawList, config.signalTimeframe);
  const timeline = prepared[0]!.candles;
  const duration = historicalTimeframeDurationMs[config.signalTimeframe];
  const evaluationStartAt = options.evaluationStartAt === undefined ? null : Date.parse(options.evaluationStartAt);
  if (evaluationStartAt !== null && !Number.isFinite(evaluationStartAt)) throw new Error("evaluationStartAt must be a valid timestamp");
  const signals: SimulatedSignal[] = [];
  const trades: SimulatedTrade[] = [];
  const blockedCandidateReasons = emptyCandidateCounts();
  const entryOpportunityReasons = emptyEntryOpportunityCounts();
  let pending: PendingCandidate | null = null;
  let position: SimulatedTrade | null = null;
  let equity = config.initialCapital;
  let currentJstDay: string | null = null;
  let currentDayStartEquity = equity;
  let currentDayRealizedPnl = 0;
  let currentDayEntryCount = 0;
  let consecutiveLosses = 0;
  const dailyStates = new Map<string, DailyState>();
  const equityCurve: EquityPoint[] = [{ at: null, equityJpy: equity, peakEquityJpy: equity, drawdownJpy: 0, drawdownPercent: 0 }];
  let peakEquity = equity;
  let maxDrawdownJpy = 0;
  let maxDrawdownPercent = 0;
  let nextTradeId = 1;

  const ensureDay = (at: number): void => {
    const day = jstDate(at);
    if (currentJstDay !== day) {
      currentJstDay = day;
      currentDayStartEquity = equity;
      currentDayRealizedPnl = 0;
      currentDayEntryCount = 0;
      consecutiveLosses = 0;
      dailyStates.set(day, { startEquityJpy: equity, realizedPnlJpy: 0, entryCount: 0 });
    }
  };

  const emitBlocked = (signal: SimulatedSignal, reason: BlockedCandidateReasonCode): void => {
    signal.reason = reason;
    signal.researchEligibility = "BLOCKED";
    blockedCandidateReasons[reason]++;
  };

  const finalizePosition = (closedAt: string): void => {
    if (!position) return;
    const closedPosition = position;
    ensureDay(Date.parse(closedAt));
    equity += closedPosition.realizedGrossPnlJpy!;
    currentDayRealizedPnl += closedPosition.realizedGrossPnlJpy!;
    const dayState = dailyStates.get(currentJstDay!)!;
    dayState.realizedPnlJpy = currentDayRealizedPnl;
    consecutiveLosses = updateConsecutiveLosses(consecutiveLosses, closedPosition.realizedGrossPnlJpy!);
    peakEquity = Math.max(peakEquity, equity);
    const drawdownJpy = peakEquity - equity;
    const drawdownPercent = peakEquity > 0 ? (drawdownJpy / peakEquity) * 100 : 0;
    maxDrawdownJpy = Math.max(maxDrawdownJpy, drawdownJpy);
    maxDrawdownPercent = Math.max(maxDrawdownPercent, drawdownPercent);
    equityCurve.push({ at: closedAt, equityJpy: equity, peakEquityJpy: peakEquity, drawdownJpy, drawdownPercent });
    trades.push(closedPosition);
    const signal = signals.find((row) => row.tradeId === closedPosition.id);
    if (signal) {
      signal.exitAt = closedPosition.exitAt;
      signal.exitPrice = closedPosition.exitPrice;
      signal.exitReason = closedPosition.exitReason;
    }
    position = null;
  };

  const maybeClosePosition = (dataset: HistoricalDataset, candle: Candle, index: number): void => {
    if (!position || position.pair !== dataset.pair || index < position.entryBarTimeIndex) return;
    const holdingCandles = index - position.entryBarTimeIndex + 1;
    const closedAt = new Date(Date.parse(candle.time) + duration).toISOString();
    const decision = resolvePositionExit(position, candle, holdingCandles, config.maxHoldingCandles);
    if (!decision) return;
    recordExit(position, decision, closedAt);
    finalizePosition(closedAt);
  };

  for (let index = 0; index < timeline.length; index++) {
    const signalBarTime = Date.parse(timeline[index]!.time);
    if (evaluationStartAt !== null && signalBarTime + duration < evaluationStartAt) continue;
    ensureDay(signalBarTime);

    const eligibleAtTimestamp: { signal: SimulatedSignal; scenario: TradeScenario; item: PreparedDataset }[] = [];
    for (const item of prepared) {
      const candle = item.candles[index]!;
      if (pending && pending.signal.pair === item.dataset.pair && index > pending.signalIndex) {
        const fill = resolveEntryFill(pending.scenario, candle);
        pending.signal.reason = fill.reason;
        entryOpportunityReasons[fill.reason]++;
        if (fill.reason === "ENTRY_GAP_AMBIGUOUS") {
          pending.signal.researchEligibility = "BLOCKED";
          blockedCandidateReasons.ENTRY_GAP_AMBIGUOUS++;
          pending = null;
        } else if (fill.reason === "FILLED" && fill.price !== null) {
          const fillAt = candle.time;
          ensureDay(Date.parse(fillAt));
          const limitReason = evaluateEntryLimit({
            entriesToday: currentDayEntryCount,
            maxTradesPerJstDay: config.maxTradesPerJstDay,
            realizedPnlTodayJpy: currentDayRealizedPnl,
            startOfDayEquityJpy: currentDayStartEquity,
            dailyLossLimitPercent: config.dailyLossLimitPercent,
            consecutiveLosses,
            consecutiveLossLimit: config.consecutiveLossLimit,
          });
          if (limitReason) {
            emitBlocked(pending.signal, limitReason);
            pending = null;
          } else {
            const size = positionSize(equity, config.riskPerTradePercent, fill.price, pending.scenario.stopLoss, config.tradeUnit);
            if (!size.data || size.data.maxUnits <= 0) {
              emitBlocked(pending.signal, "INVALID_QUANTITY");
              pending = null;
            } else {
              const dayState = dailyStates.get(currentJstDay!)!;
              dayState.entryCount++;
              currentDayEntryCount = dayState.entryCount;
              const direction = pending.signal.direction! as Exclude<TradeSignal, "wait">;
              const side = direction.includes("buy") ? "long" : "short";
              const riskJpy = Math.abs(fill.price - pending.scenario.stopLoss) * size.data.maxUnits;
              position = {
                id: `sim-${nextTradeId++}`,
                pair: pending.signal.pair,
                direction,
                side,
                signalAt: pending.signal.signalAt,
                signalPrice: pending.signal.signalPrice!,
                entryAt: fillAt,
                entryBarTime: candle.time,
                entryBarTimeIndex: index,
                entryPrice: fill.price,
                entryReason: "FILLED",
                quantity: size.data.maxUnits,
                projectedLossJpy: size.data.estimatedLoss,
                initialStopLoss: pending.scenario.stopLoss,
                takeProfit1: pending.scenario.takeProfit1,
                initialRiskJpy: riskJpy,
                exitAt: null,
                exitPrice: null,
                exitReason: "OPEN_UNREALIZED",
                holdingCandles: 0,
                realizedGrossPnlJpy: null,
                realizedR: null,
                unrealizedGrossPnlJpy: null,
                status: "OPEN_UNREALIZED",
                sameCandleEntryExit: false,
                productionAction: pending.signal.productionAction,
                productionSafety: pending.signal.productionSafety,
                productionSafetyReasons: [...pending.signal.productionSafetyReasons],
                aiContext: "UNAVAILABLE",
                fundamentalContext: "UNAVAILABLE",
                economicEventContext: "NOT_EVALUATED",
              };
              pending.signal.entryFillAt = fillAt;
              pending.signal.entryPrice = fill.price;
              pending.signal.tradeId = position.id;
              const entryExit = resolvePositionExit(position, candle, 1, config.maxHoldingCandles);
              if (entryExit) {
                position.sameCandleEntryExit = true;
                recordExit(position, entryExit, new Date(Date.parse(candle.time) + duration).toISOString());
                finalizePosition(position.exitAt!);
              }
              pending = null;
            }
          }
        }
      }

      if (position && position.pair === item.dataset.pair) {
        const before: SimulatedTrade | null = position;
        maybeClosePosition(item.dataset, candle, index);
        if (before !== position) continue;
      }
    }

    for (const item of prepared) {
      const signalAt = new Date(signalBarTime + duration).toISOString();
      const indexInReplay = item.signalIndexByAt.get(signalAt);
      if (indexInReplay === undefined) continue;
      const replayRecord = item.replay.signals[indexInReplay]!;
      const scenario = item.scenarioByAt.get(signalAt) ?? null;
      const researchSafety = evaluateResearchSafety({
        technicalReady: replayRecord.status === "EVALUATED",
        productionReasonCodes: replayRecord.safetyReasons.map((reason) => reason.code),
      });
      const row: SimulatedSignal = {
        pair: item.dataset.pair as Symbol,
        signalAt,
        signalPrice: replayRecord.signalPrice,
        direction: replayRecord.direction,
        productionAction: replayRecord.actionObservation,
        productionSafety: replayRecord.safetyStatus,
        productionSafetyReasons: replayRecord.safetyReasons.map((reason) => reason.code),
        researchSafety: researchSafety.status,
        researchSafetyReasons: researchSafety.reasons,
        contextReasons: ["UNKNOWN_AI_CONTEXT", "UNKNOWN_FUNDAMENTAL_CONTEXT", "UNKNOWN_EVENT_CONTEXT"],
        researchEligibility: "INELIGIBLE",
        scenario,
        reason: null,
        entryFillAt: null,
        entryPrice: null,
        exitAt: null,
        exitPrice: null,
        exitReason: null,
        tradeId: null,
      };
      signals.push(row);
      if (replayRecord.status !== "EVALUATED" || !replayRecord.direction || replayRecord.direction === "wait") {
        emitBlocked(row, replayRecord.status !== "EVALUATED" ? "INSUFFICIENT_DATA" : "WAIT_DIRECTION");
        continue;
      }
      if (!scenario) {
        emitBlocked(row, "INVALID_SCENARIO");
        continue;
      }
      if (researchSafety.status === "BLOCK") {
        emitBlocked(row, "SAFETY_BLOCK");
        continue;
      }
      // Production DATA_QUALITY is retained above; absent historical AI/Fundamental context alone does not disqualify research eligibility.
      if (position) {
        emitBlocked(row, "POSITION_LIMIT");
        continue;
      }
      if (pending) {
        emitBlocked(row, "ENTRY_PENDING");
        continue;
      }
      if (index + 1 >= item.candles.length) {
        emitBlocked(row, "NO_FUTURE_ENTRY_CANDLE");
        continue;
      }
      row.researchEligibility = "ELIGIBLE";
      eligibleAtTimestamp.push({ signal: row, scenario, item });
    }
    if (eligibleAtTimestamp.length > 1) {
      for (const candidate of eligibleAtTimestamp) emitBlocked(candidate.signal, "POSITION_LIMIT");
    } else if (eligibleAtTimestamp.length === 1) {
      const candidate = eligibleAtTimestamp[0]!;
      pending = { signal: candidate.signal, scenario: candidate.scenario, signalIndex: index };
    }
  }

  if (pending) {
    pending.signal.reason = "UNFILLED_AT_DATASET_END";
    blockedCandidateReasons.UNFILLED_AT_DATASET_END++;
  }
  if (position) {
    const item = prepared.find((entry) => entry.dataset.pair === position!.pair)!;
    const lastBar = item.candles.at(-1)!;
    position.holdingCandles = Math.max(0, item.candles.length - Number(position.entryBarTimeIndex));
    position.unrealizedGrossPnlJpy = pnl(position.side, position.entryPrice, lastBar.close, position.quantity);
    position.status = "OPEN_UNREALIZED";
    position.exitReason = "OPEN_UNREALIZED";
    trades.push(position);
  }

  const closed = trades.filter((trade) => trade.status === "CLOSED").toSorted((a, b) => a.exitAt!.localeCompare(b.exitAt!) || a.id.localeCompare(b.id));
  const wins = closed.filter((trade) => trade.realizedGrossPnlJpy! > 0);
  const losses = closed.filter((trade) => trade.realizedGrossPnlJpy! < 0);
  const breakEven = closed.length - wins.length - losses.length;
  const gross = closed.reduce((sum, trade) => sum + trade.realizedGrossPnlJpy!, 0);
  const grossWins = wins.reduce((sum, trade) => sum + trade.realizedGrossPnlJpy!, 0);
  const grossLosses = Math.abs(losses.reduce((sum, trade) => sum + trade.realizedGrossPnlJpy!, 0));
  const rValues = closed.map((trade) => trade.realizedR!).filter(Number.isFinite);
  let maxWins = 0,
    maxLosses = 0,
    runWins = 0,
    runLosses = 0;
  for (const trade of closed) {
    if (trade.realizedGrossPnlJpy! > 0) {
      runWins++;
      runLosses = 0;
    } else if (trade.realizedGrossPnlJpy! < 0) {
      runLosses++;
      runWins = 0;
    } else {
      runWins = 0;
      runLosses = 0;
    }
    maxWins = Math.max(maxWins, runWins);
    maxLosses = Math.max(maxLosses, runLosses);
  }
  const exitReasonDistribution = Object.fromEntries(exitReasons.map((reason) => [reason, trades.filter((trade) => trade.exitReason === reason).length])) as Record<ExitReasonCode, number>;
  const pairDistribution = Object.fromEntries(symbols.map((pair) => [pair, trades.filter((trade) => trade.pair === pair).length])) as Record<Symbol, number>;
  const directions = ["strong_buy", "buy", "strong_sell", "sell"] as const;
  const directionDistribution = Object.fromEntries(directions.map((direction) => [direction, trades.filter((trade) => trade.direction === direction).length])) as TradeSimulatorResult["directionDistribution"];
  const openPositions = trades.filter((trade) => trade.status === "OPEN_UNREALIZED");
  return {
    config,
    metadata: {
      simulationMode: TRADE_SIMULATOR_MODE,
      productionActionReplayed: false,
      historicalAiContext: "UNAVAILABLE",
      historicalFundamentalContext: "UNAVAILABLE",
      historicalEconomicEventContext: "NOT_EVALUATED",
      costModel: TRADE_SIMULATOR_COST_MODEL,
      spreadModeled: false,
      slippageModeled: false,
      commissionModeled: false,
      sameCandlePolicy: TRADE_SIMULATOR_SAME_CANDLE_POLICY,
      signalEntryPolicy: TRADE_SIMULATOR_ENTRY_POLICY,
      maxConcurrentPositions: 1,
      dailyTimezone: "Asia/Tokyo",
      datasetIds: prepared.map((item) => item.dataset.id),
    },
    signals,
    trades,
    equityCurve,
    openPositions,
    blockedCandidateReasons,
    entryOpportunityReasons,
    exitReasonDistribution,
    pairDistribution,
    directionDistribution,
    metrics: {
      closedTradeCount: closed.length,
      wins: wins.length,
      losses: losses.length,
      breakEven,
      winRatePercent: closed.length ? (wins.length / closed.length) * 100 : null,
      realizedGrossPnlJpy: gross,
      grossReturnPercent: config.initialCapital > 0 ? (gross / config.initialCapital) * 100 : 0,
      averageWinJpy: wins.length ? grossWins / wins.length : null,
      averageLossJpy: losses.length ? -grossLosses / losses.length : null,
      profitFactor: grossLosses ? grossWins / grossLosses : null,
      totalR: rValues.length ? rValues.reduce((sum, value) => sum + value, 0) : null,
      averageR: rValues.length ? rValues.reduce((sum, value) => sum + value, 0) / rValues.length : null,
      medianR: median(rValues),
      expectancyJpyPerTrade: closed.length ? gross / closed.length : null,
      expectancyRPerTrade: rValues.length ? rValues.reduce((sum, value) => sum + value, 0) / rValues.length : null,
      maxDrawdownJpy,
      maxDrawdownPercent,
      maxConsecutiveWins: maxWins,
      maxConsecutiveLosses: maxLosses,
      averageHoldingCandles: closed.length ? closed.reduce((sum, trade) => sum + trade.holdingCandles, 0) / closed.length : null,
      endingRealizedEquityJpy: equity,
      endingUnrealizedGrossPnlJpy: openPositions.reduce((sum, trade) => sum + (trade.unrealizedGrossPnlJpy ?? 0), 0),
    },
    limitations: [
      "Research simulation only; production Action remains unchanged and is not replayed as eligibility.",
      "Historical AI/Fundamental contexts are unavailable; their absence is recorded and not fabricated.",
      "Economic Event context is NOT_EVALUATED and does not mean event-safe.",
      "Spread, slippage and commission are not modeled; reported PnL/return/R are gross, not net or expected live results.",
      "Entry touch and same-candle order rely on the explicit deterministic policies in metadata/config.",
    ],
  };
}
