import { validateTrade } from "../trades/validation";
import type { Trade } from "../trades/types";
import type { RiskSettings } from "../risk/types";
import type { Json, TradeRow } from "./database.types";
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function numeric(value: unknown): number {
  if (typeof value !== "number" && (typeof value !== "string" || !/^-?\d+(\.\d+)?$/.test(value))) throw new Error("数値形式が不正です。");
  const n = Number(value);
  if (!Number.isFinite(n) || Math.abs(n) > Number.MAX_SAFE_INTEGER) throw new Error("数値が計算範囲外です。");
  return n;
}
function iso(value: unknown): string { if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error("日時が不正です。"); return new Date(value).toISOString(); }
const nullable = (n: unknown) => n === null ? null : numeric(n);
export function fromTradeRow(row: Record<string, unknown>, userId: string): Trade {
  if (row.user_id !== userId || !UUID.test(String(row.id))) throw new Error("取引の所有者を確認できません。");
  const result = validateTrade({ id: row.id, pair: row.pair, side: row.side, status: row.status, quantity: numeric(row.quantity), entryPrice: numeric(row.entry_price), exitPrice: nullable(row.exit_price), openedAt: iso(row.opened_at), closedAt: row.closed_at === null ? null : iso(row.closed_at), stopLoss: nullable(row.stop_loss), takeProfit: nullable(row.take_profit), realizedPnl: nullable(row.realized_pnl), notes: row.notes ?? "", analysisSnapshot: row.analysis_snapshot, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) });
  if (!result.data) throw new Error(result.error);
  return result.data;
}
export function toTradeRow(trade: Trade, userId: string): Partial<TradeRow> {
  const checked = validateTrade(trade);
  if (!checked.data || !UUID.test(userId)) throw new Error(checked.error ?? "ユーザーが不正です。");
  return { id: trade.id, user_id: userId, pair: trade.pair, side: trade.side, status: trade.status, quantity: trade.quantity, entry_price: trade.entryPrice, exit_price: trade.exitPrice, opened_at: trade.openedAt, closed_at: trade.closedAt, stop_loss: trade.stopLoss, take_profit: trade.takeProfit, realized_pnl: trade.realizedPnl, notes: trade.notes, analysis_snapshot: trade.analysisSnapshot as unknown as Json, created_at: trade.createdAt, updated_at: trade.updatedAt };
}
export function validateSettings(settings: RiskSettings): RiskSettings {
  const { balance, target, riskPercent, tradeUnit } = settings;
  if (![balance, target, riskPercent].every(Number.isFinite) || balance < 0 || balance > 1e12 || target < .01 || target > 1e12 || riskPercent <= 0 || riskPercent > 10 || !Number.isSafeInteger(tradeUnit) || tradeUnit < 1 || tradeUnit > 1e8) throw new Error("資産・目標は1兆円以下、リスク率は0より大きく10%以下、取引単位は1〜1億の整数で入力してください。");
  return settings;
}
export function fromSettingsRow(row: Record<string, unknown>, userId: string): RiskSettings {
  if (row.user_id !== userId) throw new Error("設定の所有者を確認できません。");
  return validateSettings({ balance: numeric(row.current_capital), target: numeric(row.target_capital), riskPercent: numeric(row.risk_percent), tradeUnit: numeric(row.trade_unit) });
}
export function toSettingsRow(settings: RiskSettings) {
  const s = validateSettings(settings);
  return { current_capital: s.balance, target_capital: s.target, risk_percent: s.riskPercent, trade_unit: s.tradeUnit };
}
