import type { TradeSignal, AnalysisFactor, Availability } from "../ai/types";
import type { ChartTrendDirection } from "../chart-analysis/types";

export const pairs = ["USD/JPY", "EUR/JPY", "GBP/JPY"] as const;
export type TradePair = (typeof pairs)[number];

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
