export const symbols = ["USD/JPY", "EUR/JPY", "GBP/JPY"] as const;
export type Symbol = (typeof symbols)[number];
export const timeframes = ["15m", "1h", "4h"] as const;
export type Timeframe = (typeof timeframes)[number];
export type Candle = { time: string; open: number; high: number; low: number; close: number };
export type Indicators = {
  sma20: number | null; sma75: number | null; sma200: number | null;
  rsi14: number | null; atr14: number | null; recentHigh: number | null; recentLow: number | null;
  trend: "bullish" | "bearish" | "neutral";
};
export type Resource<T> = { data: T | null; fetchedAt: string | null; error: string | null; stale: boolean };
export type Technical = { candles: Candle[]; indicators: Indicators; lastClosedAt: string | null };
export type MarketData = { symbol: Symbol; price: Resource<number>; timeframes: Record<Timeframe, Resource<Technical>> };
