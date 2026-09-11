import type { AIAnalysis } from "../ai/types";
import type { ChartImageAnalysis } from "../chart-analysis/types";
import { pnl } from "./calculations";
import { captureTradeAiSnapshot } from "./snapshot";
import { validateDraft, validateTrade } from "./validation";
import type { Result, Trade, TradeAnalysisSnapshot, TradeDraft } from "./types";

export type CreateTradeOptions = {
  chartImageAnalysis?: ChartImageAnalysis | null;
  marketPrice?: number | null;
  saveSnapshot?: boolean;
};

/** @deprecated Prefer createTrade options; kept for existing tests. */
export function captureAnalysis(analysis: AIAnalysis | null, pair: string, now: string, options?: Omit<CreateTradeOptions, "saveSnapshot">): TradeAnalysisSnapshot | null {
  return captureTradeAiSnapshot({ analysis, pair, now, marketPrice: options?.marketPrice ?? null, chartImageAnalysis: options?.chartImageAnalysis ?? null, saveSnapshot: true });
}

export function createTrade(draft: TradeDraft, analysis: AIAnalysis | null, id: string, now: string, options?: CreateTradeOptions): Result<Trade> {
  const checked = validateDraft(draft);
  if (!checked.data) return { data: null, error: checked.error };
  return validateTrade({
    ...checked.data,
    id,
    createdAt: now,
    updatedAt: now,
    realizedPnl: draft.status === "closed" ? pnl(draft.side, draft.entryPrice, draft.exitPrice!, draft.quantity) : null,
    analysisSnapshot: captureTradeAiSnapshot({
      analysis,
      pair: draft.pair,
      now,
      marketPrice: options?.marketPrice ?? null,
      chartImageAnalysis: options?.chartImageAnalysis ?? null,
      saveSnapshot: options?.saveSnapshot !== false,
    }),
  });
}

export function editTrade(trade: Trade, draft: TradeDraft, now: string): Result<Trade> {
  // Entry edits never replace the registration-time analysis, even if the pair changes.
  return validateTrade({ ...draft, id: trade.id, createdAt: trade.createdAt, updatedAt: now, analysisSnapshot: trade.analysisSnapshot, realizedPnl: draft.status === "closed" ? pnl(draft.side, draft.entryPrice, draft.exitPrice!, draft.quantity) : null });
}

export function closeTrade(trade: Trade, exitPrice: number, closedAt: string, now: string): Result<Trade> {
  if (trade.status !== "open") return { data: null, error: "この取引はすでに決済済みです。" };
  return editTrade(trade, { ...trade, status: "closed", exitPrice, closedAt }, now);
}
