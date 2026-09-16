export const symbols = ["USD/JPY", "EUR/JPY", "GBP/JPY"] as const;
export type Symbol = (typeof symbols)[number];
export const timeframes = ["15m", "1h", "4h"] as const;
export type Timeframe = (typeof timeframes)[number];
/** Task026 MTF set. Reuses Task003 keys for 15m/1h/4h and adds provider 1day. */
export const mtfTimeframes = ["1day", "4h", "1h", "15m"] as const;
export type MarketTimeframe = (typeof mtfTimeframes)[number];
export const MARKET_PRICE_TTL_SECONDS = 60;
export const MARKET_SERIES_TTL_SECONDS = 300;
export const MARKET_FAILURE_TTL_SECONDS = 60;
export const MARKET_DASHBOARD_REFRESH_MS = 60_000;
export type Candle = { time: string; open: number; high: number; low: number; close: number };
export type Indicators = {
  sma20: number | null; sma75: number | null; sma200: number | null;
  rsi14: number | null; atr14: number | null; recentHigh: number | null; recentLow: number | null;
  trend: "bullish" | "bearish" | "neutral";
};
export type Resource<T> = { data: T | null; fetchedAt: string | null; error: string | null; stale: boolean };
export type Technical = { candles: Candle[]; indicators: Indicators; lastClosedAt: string | null };
export type MarketData = {
  symbol: Symbol;
  price: Resource<number>;
  timeframes: Record<Timeframe, Resource<Technical>>;
  /** Task026 1day series. Optional so Task003 fixtures stay valid. */
  daily?: Resource<Technical>;
  /** Task029 live regime. Optional so Task003/026 fixtures stay valid. Computed from 1h candles, never a trade signal. */
  marketRegimeAnalysis?: import("./market-regime").MarketRegimeAnalysis;
}
