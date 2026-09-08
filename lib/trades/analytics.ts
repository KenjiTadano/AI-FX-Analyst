import { tradeSignals } from "../ai/types";
import { plannedRiskReward } from "./calculations";
import { pairs, type Trade } from "./types";
const sumMoney = (values: number[]) => values.reduce((sum, n) => sum + Math.round(n * 100), 0) / 100;
export function summarize(trades: Trade[]) {
  const closed = trades.filter(t => t.status === "closed" && t.realizedPnl !== null);
  const wins = closed.filter(t => t.realizedPnl! > 0), losses = closed.filter(t => t.realizedPnl! < 0);
  const grossProfit = sumMoney(wins.map(t => t.realizedPnl!)), grossLoss = Math.abs(sumMoney(losses.map(t => t.realizedPnl!)));
  const ratios = closed.map(plannedRiskReward).filter((n): n is number => n !== null);
  return { count: closed.length, wins: wins.length, losses: losses.length, draws: closed.length - wins.length - losses.length, totalPnl: sumMoney(closed.map(t => t.realizedPnl!)), winRate: closed.length ? wins.length / closed.length * 100 : null, averageProfit: wins.length ? grossProfit / wins.length : null, averageLoss: losses.length ? -grossLoss / losses.length : null, profitFactor: grossLoss ? grossProfit / grossLoss : null, noLosses: closed.length > 0 && grossLoss === 0, maxProfit: wins.length ? Math.max(...wins.map(t => t.realizedPnl!)) : null, maxLoss: losses.length ? Math.min(...losses.map(t => t.realizedPnl!)) : null, averageRiskReward: ratios.length ? ratios.reduce((a, b) => a + b / ratios.length, 0) : null, riskRewardSamples: ratios.length };
}
export function dayKey(iso: string): string { return new Date(Date.parse(iso) + 9 * 3600000).toISOString().slice(0, 10); }
export function dailyPnl(trades: Trade[]): Record<string, { pnl: number; trades: Trade[] }> {
  const result: Record<string, { pnl: number; trades: Trade[] }> = {};
  for (const t of trades) if (t.status === "closed" && t.closedAt) {
    const day = dayKey(t.closedAt); const entry = result[day] ??= { pnl: 0, trades: [] }; entry.trades.push(t); entry.pnl = sumMoney(entry.trades.map(t => t.realizedPnl!));
  }
  return result;
}
export function equityCurve(trades: Trade[], initialBalance: number) {
  if (!Number.isFinite(initialBalance) || initialBalance < 0 || initialBalance > 1e12) return [];
  const sorted = trades.filter(t => t.status === "closed").toSorted((a, b) => a.closedAt!.localeCompare(b.closedAt!) || a.id.localeCompare(b.id));
  let cents = Math.round(initialBalance * 100);
  return [{ at: null as string | null, balance: cents / 100, tradeId: null as string | null }, ...sorted.map(t => { cents += Math.round(t.realizedPnl! * 100); return { at: t.closedAt, balance: cents / 100, tradeId: t.id }; })];
}
export function signalPerformance(trades: Trade[]) {
  return [...tradeSignals, "unrecorded" as const].map(signal => {
    const selected = trades.filter(t => signal === "unrecorded" ? !t.analysisSnapshot || t.analysisSnapshot.pair !== t.pair : t.analysisSnapshot?.pair === t.pair && t.analysisSnapshot.signal === signal);
    const stats = summarize(selected);
    return { signal, ...stats, insufficientData: stats.count < 10 };
  });
}
export function pairPerformance(trades: Trade[]) { return pairs.map(pair => ({ pair, ...summarize(trades.filter(t => t.pair === pair)) })); }
export function monthCells(month: string): (string | null)[] {
  if (!/^[1-9]\d{3}-(0[1-9]|1[0-2])$/.test(month)) return [];
  const [year, m] = month.split("-").map(Number);
  const date = new Date(Date.UTC(year, m - 1, 1));
  const offset = (date.getUTCDay() + 6) % 7;
  const days = new Date(Date.UTC(year, m, 0)).getUTCDate();
  return Array.from({ length: Math.ceil((offset + days) / 7) * 7 }, (_, i) => i < offset || i >= offset + days ? null : `${month}-${String(i - offset + 1).padStart(2, "0")}`);
}
