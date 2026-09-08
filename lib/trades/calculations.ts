import { fraction } from "../risk/decimal";
import type { Quote, Trade } from "./types";
export const validPrice = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0 && n <= 1e6;
export const validQuantity = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n > 0 && n <= 1e8;
export function pnl(side: string, entry: number, exit: number, quantity: number): number | null {
  if (!["long", "short"].includes(side) || !validPrice(entry) || !validPrice(exit) || !validQuantity(quantity)) return null;
  const [en, ed] = fraction(entry), [xn, xd] = fraction(exit);
  const raw = (xn * ed - en * xd) * BigInt(quantity) * (side === "long" ? BigInt(1) : BigInt(-1));
  const denominator = ed * xd;
  const absolute = raw < BigInt(0) ? -raw : raw;
  const cents = (absolute * BigInt(200) + denominator) / (denominator * BigInt(2));
  if (cents > BigInt(1e11)) return null; // Per-trade cap keeps 5,000-record aggregates exact to cents.
  return Number(raw < BigInt(0) ? -cents : cents) / 100;
}
export function unrealizedPnl(trade: Trade, quote: Quote | null, now: number): number | null {
  if (trade.status !== "open" || !quote || quote.pair !== trade.pair || quote.stale || !Number.isFinite(Date.parse(quote.fetchedAt))) return null;
  const age = now - Date.parse(quote.fetchedAt);
  return age >= 0 && age <= 120000 ? pnl(trade.side, trade.entryPrice, quote.price, trade.quantity) : null;
}
export function plannedRiskReward(trade: Trade): number | null {
  const { entryPrice: e, stopLoss: s, takeProfit: t, side } = trade;
  if (s === null || t === null || !validPrice(s) || !validPrice(t)) return null;
  if (side === "long" ? !(s < e && e < t) : !(t < e && e < s)) return null;
  const ratio = Math.abs(t - e) / Math.abs(e - s);
  return Number.isFinite(ratio) ? ratio : null;
}
