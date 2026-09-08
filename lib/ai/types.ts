import type { Symbol, Timeframe } from "../market/types";
import type { FundamentalData } from "../fundamental/types";

export const tradeSignals = ["strong_buy", "buy", "wait", "sell", "strong_sell"] as const;
export type TradeSignal = (typeof tradeSignals)[number];
export const factorCategories = ["technical", "news", "economic", "central_bank", "market_environment"] as const;
export type FactorCategory = (typeof factorCategories)[number];
export type Direction = "bullish" | "bearish" | "neutral" | "unknown";
export type Impact = "high" | "medium" | "low";
export type Availability = "ok" | "partial" | "missing";
export interface AnalysisFactor {
  category: FactorCategory;
  title: string;
  direction: Direction;
  impact: Impact;
  reason: string;
  source: string;
  evidenceIds: string[];
}
export interface TechnicalFrame {
  timeframe: Timeframe;
  available: boolean;
  completeness: number;
  lastClosedAt: string | null;
  score: number;
  close: number | null;
  sma20: number | null;
  sma75: number | null;
  sma200: number | null;
  priceVsSma: Direction;
  shortVsMedium: Direction;
  mediumVsLong: Direction;
  smaSlopes: { short: number | null; medium: number | null; long: number | null };
  rsi: number | null;
  rsiState: "oversold" | "overbought" | "normal" | "unknown";
  momentum: number | null;
  momentumAtr: number | null;
  atr: number | null;
  recentHigh: number | null;
  recentLow: number | null;
  extended: boolean;
}
export interface TechnicalAnalysis { score: number; frames: TechnicalFrame[]; factors: AnalysisFactor[]; warnings: string[]; ready: boolean; extended: boolean }
export interface DataQuality {
  score: number;
  missingData: string[];
  categories: Record<FactorCategory, { status: Availability; detail: string; fraction: number }>;
}
export interface Evidence { id: string; categories: FactorCategory[]; title: string; source: string; observedAt: string | null; data: unknown }
export interface AnalysisInput {
  pair: Symbol;
  currentRate: number | null;
  technicalAnalysis: TechnicalAnalysis;
  fundamentalData: Evidence[];
  dataAvailability: DataQuality;
  timestamp: string;
  eventRisk: { imminent: boolean; uncertainTime: boolean; nextRiskAt: string | null; reasons: string[] };
}
export interface TradeScenario {
  direction: "long" | "short";
  entryZone: { min: number; max: number };
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  riskReward: number;
  condition: string;
  invalidation: string;
  sourceTimeframe: Timeframe;
}
export interface ModelInterpretation {
  summary: string;
  factors: AnalysisFactor[];
  bullishReasons: string[];
  bearishReasons: string[];
  riskWarnings: string[];
  confidence: number;
  contradictions: boolean;
  preferWait: boolean;
  scenarioComment: string;
}
export type AIErrorCode = "not_configured" | "api_error" | "invalid_response" | "timeout" | "rate_limited" | "insufficient_data";
export interface AIAnalysis {
  pair: Symbol;
  signal: TradeSignal;
  score: number;
  technicalScore: number;
  confidence: number;
  summary: string;
  factors: AnalysisFactor[];
  bullishReasons: string[];
  bearishReasons: string[];
  riskWarnings: string[];
  scenario: TradeScenario | null;
  dataQuality: DataQuality;
  currentRate: number | null;
  analyzedAt: string;
  expiresAt: string;
  decisionReasons: string[];
  ai: { status: "available" | "unavailable" | "error"; model: string | null; code: AIErrorCode | null; message: string | null };
}
export type AnalysisResponse = { success: boolean; data: AIAnalysis | null; error: { code: string; message: string } | null; cached: boolean };
export type FundamentalSnapshot = FundamentalData | null;
