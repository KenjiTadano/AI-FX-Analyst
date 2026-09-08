import type { AIAnalysis } from "../ai/types";
import { pnl } from "./calculations";
import { validateDraft, validateTrade } from "./validation";
import type { Result, Trade, TradeAnalysisSnapshot, TradeDraft } from "./types";
export function captureAnalysis(analysis: AIAnalysis | null, pair: string, now: string): TradeAnalysisSnapshot | null {
  if (!analysis || analysis.pair !== pair) return null;
  return { pair: analysis.pair, signal: analysis.signal, score: analysis.score, confidence: analysis.confidence, summary: analysis.summary, dataQualityScore: analysis.dataQuality.score, analyzedAt: analysis.analyzedAt, capturedAt: now, expiresAt: analysis.expiresAt, aiStatus: analysis.ai.status, model: analysis.ai.model, bullishReasons: [...analysis.bullishReasons], bearishReasons: [...analysis.bearishReasons] };
}
export function createTrade(draft: TradeDraft, analysis: AIAnalysis | null, id: string, now: string): Result<Trade> {
  const checked = validateDraft(draft);
  if (!checked.data) return { data: null, error: checked.error };
  return validateTrade({ ...checked.data, id, createdAt: now, updatedAt: now, realizedPnl: draft.status === "closed" ? pnl(draft.side, draft.entryPrice, draft.exitPrice!, draft.quantity) : null, analysisSnapshot: captureAnalysis(analysis, draft.pair, now) });
}
export function editTrade(trade: Trade, draft: TradeDraft, now: string): Result<Trade> {
  // Entry edits never replace the registration-time analysis, even if the pair changes.
  return validateTrade({ ...draft, id: trade.id, createdAt: trade.createdAt, updatedAt: now, analysisSnapshot: trade.analysisSnapshot, realizedPnl: draft.status === "closed" ? pnl(draft.side, draft.entryPrice, draft.exitPrice!, draft.quantity) : null });
}
export function closeTrade(trade: Trade, exitPrice: number, closedAt: string, now: string): Result<Trade> {
  if (trade.status !== "open") return { data: null, error: "この取引はすでに決済済みです。" };
  return editTrade(trade, { ...trade, status: "closed", exitPrice, closedAt }, now);
}
