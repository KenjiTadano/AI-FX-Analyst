import type { Account, FxAnalysis, Signal } from "@/types/analysis";

export const signalLabels: Record<Signal, string> = {
  "strong-buy": "すごく買い", buy: "買い", wait: "待った", sell: "売り", "strong-sell": "すごく売り",
};
export function signalTone(signal: Signal) {
  return signal.includes("buy") ? "positive" : signal.includes("sell") ? "negative" : "neutral";
}
export const yen = (value: number) => new Intl.NumberFormat("ja-JP", { style: "currency", currency: "JPY", maximumFractionDigits: 0 }).format(value);
export function calculateRisk(analysis: FxAnalysis, account: Account) {
  const trade = analysis.trade;
  const loss = trade ? Math.abs(trade.entry - trade.stopLoss) * trade.units * analysis.quoteToJpy : 0;
  return { loss, percent: account.balance > 0 ? loss / account.balance * 100 : 0 };
}
