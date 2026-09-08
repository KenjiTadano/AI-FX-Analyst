export const signals = ["strong-buy", "buy", "wait", "sell", "strong-sell"] as const;
export type Signal = (typeof signals)[number];
export type Reason = {
  category: "テクニカル" | "ニュース" | "経済指標" | "マクロ";
  assessment: string;
  tone: "positive" | "negative" | "neutral";
  summary: string;
  detail: string;
};
export interface FxAnalysis {
  pair: string;
  name: string;
  quoteCurrency: string;
  decimals: number;
  rate: number;
  changePercent: number;
  asOf: string;
  signal: Signal;
  score: number;
  trade: { direction: "buy" | "sell"; entry: number; stopLoss: number; takeProfit1: number; takeProfit2: number; units: number } | null;
  /** Quote currency to JPY conversion, used for account risk calculations. */
  quoteToJpy: number;
  reasons: Reason[];
  comment: string;
}
export interface Account { balance: number; target: number }
