import type { TradeSignal, AnalysisFactor, Availability } from "../ai/types";
import type { ChartTrendDirection } from "../chart-analysis/types";
import type { EntryTriggerEvaluationStatus, StructuredEntryTrigger } from "../ai/entry-trigger";
import type { MultiTimeframeAnalysis } from "../market/multi-timeframe";
import type { MarketRegimeAnalysis } from "../market/market-regime";
import type { TradeExitPlan } from "./exit-plan";
import type { MarketContextRevision, MarketContextSnapshot } from "./market-context-snapshot";

export const pairs = ["USD/JPY", "EUR/JPY", "GBP/JPY"] as const;
export type TradePair = (typeof pairs)[number];

export interface PreTradeTriggerEvaluationSnapshot {
  status: EntryTriggerEvaluationStatus;
  observedValue: number | null;
  checkedAt: string | null;
  distanceToTriggerPips: number | null;
}

export interface PreTradeContextSnapshot {
  version: 1;
  capturedAt: string;
  pair: TradePair;
  direction: "BUY" | "SELL" | "NEUTRAL" | null;
  action: "BUY" | "SELL" | "WAIT" | null;
  readiness: {
    confirmedCount: number;
    totalCount: 5;
    state: "ready_to_review" | "waiting" | "warning" | "unavailable";
  } | null;
  trigger: {
    structuredTrigger: StructuredEntryTrigger;
    evaluation: PreTradeTriggerEvaluationSnapshot;
  } | null;
  dataQuality: { score: number | null } | null;
  confidence: number | null;
  eventRisk: { level: "high" | "medium" | "low" | "unknown"; available: boolean } | null;
  risk: { capital: number; riskPercent: number; riskPerTrade: number } | null;
  dailyLossLimitPercent: number | null;
  dailyLossRemaining: number | null;
  dailyLossLimitReached: boolean;
  analysisStale: boolean;
  eventRiskHigh: boolean;
}

/** Legacy Task007/008 snapshot (no version). Still accepted for backward compatibility. */
export interface TradeAnalysisSnapshot {
  pair: TradePair;
  signal: TradeSignal;
  score: number;
  confidence: number;
  summary: string;
  dataQualityScore: number;
  analyzedAt: string;
  capturedAt: string;
  expiresAt: string;
  aiStatus: "available" | "unavailable" | "error";
  model: string | null;
  bullishReasons: string[];
  bearishReasons: string[];
}

export interface TradeChartAnalysisSnapshot {
  source: "chart_image";
  detectedPairRaw: string | null;
  detectedPairCanonical: TradePair;
  timeframe: string | null;
  chartType: string | null;
  currentPrice: number | null;
  trend: { direction: ChartTrendDirection; confidence: number; reason: string };
  marketStructure: {
    higherHigh: boolean | null;
    higherLow: boolean | null;
    lowerHigh: boolean | null;
    lowerLow: boolean | null;
  };
  supportLevels: number[];
  resistanceLevels: number[];
  patterns: { name: string; confidence: number; description: string }[];
  indicators: { name: string; value: string | number | null; interpretation: string }[];
  dataQuality: { score: number; imageReadable: boolean; pairDetected: boolean; timeframeDetected: boolean };
  warnings: string[];
  imageReadable: boolean;
  analyzedAt: string;
}

/** Task013 versioned snapshot. Includes legacy fields so existing DB checks remain satisfied. */
export interface TradeAiAnalysisSnapshot extends TradeAnalysisSnapshot {
  version: 1;
  directionSignal: TradeSignal;
  action: "BUY" | "SELL" | "WAIT";
  marketPrice: number | null;
  analysisPrice: number | null;
  factors: AnalysisFactor[];
  scenario: {
    direction: "long" | "short";
    entryZone: { min: number; max: number };
    stopLoss: number;
    takeProfit1: number;
    takeProfit2: number;
    riskReward: number;
    condition: string;
    invalidation: string;
    sourceTimeframe: string;
  } | null;
  dataQuality: {
    score: number;
    missingData: string[];
    categories: Record<"technical" | "news" | "economic" | "central_bank" | "market_environment", { status: Availability; detail: string; fraction: number }>;
    macroeconomicData: { status: Availability; detail: string; fraction: number };
  };
  economicRisk: {
    active: boolean;
    known: boolean;
    reasons: string[];
    nextHigh: { name: string; scheduledAt: string | null; importance: "high" | "medium" | "low" | null } | null;
  } | null;
  chartEvidence: {
    used: boolean;
    timeframe: string | null;
    trend: ChartTrendDirection;
    qualityScore: number;
  } | null;
  chartAnalysis: TradeChartAnalysisSnapshot | null;
  aiCode: string | null;
  isFallback: boolean;
  entryTrigger?: StructuredEntryTrigger | null;
  preTradeContext?: PreTradeContextSnapshot | null;
  multiTimeframeAnalysis?: MultiTimeframeAnalysis | null;
  /** Task030 optional sibling. Isolated fail-soft. Never a quality score. */
  marketRegimeAnalysis?: MarketRegimeAnalysis | null;
}

export type AiAlignment = "aligned" | "contrary" | "wait_override" | "neutral" | "unavailable";

export interface TradeDraft {
  pair: TradePair;
  side: "long" | "short";
  status: "open" | "closed";
  quantity: number;
  entryPrice: number;
  exitPrice: number | null;
  openedAt: string;
  closedAt: string | null;
  stopLoss: number | null;
  takeProfit: number | null;
  notes: string;
}
export interface Trade extends TradeDraft {
  id: string;
  realizedPnl: number | null;
  analysisSnapshot: TradeAnalysisSnapshot | TradeAiAnalysisSnapshot | null;
  /** Task031 registration-time Exit Plan. Immutable after create. Optional for legacy. */
  exitPlan?: TradeExitPlan | null;
  /** Task104 registration-time market context. AI-independent. Immutable after create. Optional for legacy. */
  marketContextSnapshot?: MarketContextSnapshot | null;
  /** Task105 manual market context re-captures. Append-only. Never used as entry original / PI input. */
  marketContextRevisions?: MarketContextRevision[] | null;
  createdAt: string;
  updatedAt: string;
}
export interface Journal { schemaVersion: 1; revision: number; trades: Trade[] }
export type Result<T> = { data: T; error: null } | { data: null; error: string };
export interface TradeRepository {
  load(): Result<Journal>;
  save(trades: Trade[], expectedRevision: number): Result<Journal>;
}
export interface Quote { pair: string; price: number; fetchedAt: string; stale: boolean }
