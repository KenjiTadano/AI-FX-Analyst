import type { TradeSignal } from "../ai/types";
export const pairs = ["USD/JPY", "EUR/JPY", "GBP/JPY"] as const;
export type TradePair = (typeof pairs)[number];
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
  analysisSnapshot: TradeAnalysisSnapshot | null;
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
