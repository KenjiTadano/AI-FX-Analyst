import { tradeSignals } from "../ai/types";
import { pairs, type Trade, type TradeDraft, type TradeAnalysisSnapshot, type Result } from "./types";
import { pnl, validPrice, validQuantity } from "./calculations";
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
export function validDate(v: unknown): v is string {
  if (typeof v !== "string" || Number(v.slice(0, 4)) < 1000 || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v)) return false;
  const date = new Date(v);
  return Number.isFinite(date.getTime()) && date.toISOString() === v;
}
export function validateDraft(v: unknown): Result<TradeDraft> {
  if (!object(v)) return { data: null, error: "取引データが不正です。" };
  if (!pairs.includes(v.pair as never) || !["long", "short"].includes(v.side as string) || !["open", "closed"].includes(v.status as string)) return { data: null, error: "通貨ペア・方向・状態を確認してください。" };
  if (!validQuantity(v.quantity) || !validPrice(v.entryPrice)) return { data: null, error: "数量は1〜1億の整数、価格は0より大きく100万以下で入力してください。" };
  if (!validDate(v.openedAt) || (v.stopLoss !== null && !validPrice(v.stopLoss)) || (v.takeProfit !== null && !validPrice(v.takeProfit)) || typeof v.notes !== "string" || v.notes.length > 4000) return { data: null, error: "エントリー日時・損切り・利確・メモ（4,000文字以内）を確認してください。" };
  if (v.status === "closed" && (!validPrice(v.exitPrice) || !validDate(v.closedAt) || Date.parse(v.closedAt) < Date.parse(v.openedAt))) return { data: null, error: "決済価格と日時を確認してください。決済日時はエントリー日時以降にしてください。" };
  if (v.status === "open" && (v.exitPrice !== null || v.closedAt !== null)) return { data: null, error: "未決済の取引には決済値を保存できません。" };
  if (v.status === "closed" && pnl(v.side as string, v.entryPrice, v.exitPrice as number, v.quantity) === null) return { data: null, error: "取引損益が計算範囲（絶対値10億円）を超えています。" };
  const { pair, side, status, quantity, entryPrice, exitPrice, openedAt, closedAt, stopLoss, takeProfit, notes } = v;
  return { data: { pair, side, status, quantity, entryPrice, exitPrice, openedAt, closedAt, stopLoss, takeProfit, notes } as TradeDraft, error: null };
}
function validSnapshot(v: unknown): v is TradeAnalysisSnapshot {
  if (!object(v)) return false;
  const bounded = (n: unknown, min: number, max: number) => typeof n === "number" && Number.isFinite(n) && n >= min && n <= max;
  return pairs.includes(v.pair as never) && tradeSignals.includes(v.signal as never) && bounded(v.score, -100, 100) && bounded(v.confidence, 0, 100) && bounded(v.dataQualityScore, 0, 100) && typeof v.summary === "string" && v.summary.length <= 10000 && validDate(v.analyzedAt) && validDate(v.capturedAt) && validDate(v.expiresAt) && ["available", "unavailable", "error"].includes(v.aiStatus as string) && (v.model === null || typeof v.model === "string" && v.model.length <= 200) && [v.bullishReasons, v.bearishReasons].every(a => Array.isArray(a) && a.length <= 30 && a.every(t => typeof t === "string" && t.length <= 4000));
}
export function validateTrade(v: unknown): Result<Trade> {
  const draft = validateDraft(v);
  if (!draft.data || !object(v)) return { data: null, error: draft.error ?? "取引が不正です。" };
  if (typeof v.id !== "string" || !v.id || v.id.length > 100 || !validDate(v.createdAt) || !validDate(v.updatedAt) || Date.parse(v.updatedAt) < Date.parse(v.createdAt) || (v.analysisSnapshot !== null && !validSnapshot(v.analysisSnapshot))) return { data: null, error: "記録のID・保存日時・AIスナップショットが不正です。" };
  const realizedPnl = draft.data.status === "closed" ? pnl(draft.data.side, draft.data.entryPrice, draft.data.exitPrice!, draft.data.quantity) : null;
  if (v.realizedPnl !== realizedPnl) return { data: null, error: "保存された損益と取引価格が一致しません。" };
  return { data: { ...draft.data, id: v.id, createdAt: v.createdAt, updatedAt: v.updatedAt, analysisSnapshot: v.analysisSnapshot as TradeAnalysisSnapshot | null, realizedPnl }, error: null };
}
