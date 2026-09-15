import type { Indicators, MarketData, Resource, Technical } from "../../lib/market/types";
import type { Symbol } from "../../lib/market/types";

const rates: Record<Symbol, number> = {
  "USD/JPY": 156.42,
  "EUR/JPY": 169.8,
  "GBP/JPY": 201.24,
};

export type MtfFixtureName =
  | "all-bullish"
  | "all-bearish"
  | "mixed"
  | "partial"
  | "one-unavailable"
  | "all-unavailable"
  | "htf-bullish"
  | "htf-bearish"
  | "htf-unavailable"
  | "neutral";

type FrameTrend = Indicators["trend"] | "unavailable";

function frameFor(
  close: number,
  fetchedAt: string,
  lastClosedAt: string,
  trend: FrameTrend,
  omit: boolean,
): Resource<Technical> {
  if (omit || trend === "unavailable") {
    return { data: null, fetchedAt, error: "E2E timeframe omitted", stale: false };
  }
  const bullish = trend === "bullish";
  const bearish = trend === "bearish";
  return {
    data: {
      candles: [{ time: lastClosedAt, open: close, high: close + 0.1, low: close - 0.1, close }],
      indicators: {
        sma20: bullish ? close - 0.2 : bearish ? close + 0.2 : close - 0.2,
        sma75: bullish ? close - 0.4 : bearish ? close + 0.4 : close - 0.1,
        sma200: bullish ? close - 0.8 : bearish ? close + 0.8 : close - 0.05,
        rsi14: bullish ? 62 : bearish ? 38 : 48,
        atr14: 0.2,
        recentHigh: close + 0.3,
        recentLow: close - 0.3,
        trend,
      },
      lastClosedAt,
    },
    fetchedAt,
    error: null,
    stale: false,
  };
}

function trendsFor(name: MtfFixtureName | undefined): Record<"1day" | "4h" | "1h" | "15m", FrameTrend> {
  switch (name) {
    case "all-bullish":
    case "htf-bullish":
      return { "1day": "bullish", "4h": "bullish", "1h": "bullish", "15m": "bullish" };
    case "all-bearish":
    case "htf-bearish":
      return { "1day": "bearish", "4h": "bearish", "1h": "bearish", "15m": "bearish" };
    case "mixed":
      return { "1day": "bullish", "4h": "bullish", "1h": "bearish", "15m": "bearish" };
    case "partial":
      return { "1day": "bullish", "4h": "bullish", "1h": "bullish", "15m": "unavailable" };
    case "one-unavailable":
      return { "1day": "bullish", "4h": "bullish", "1h": "bullish", "15m": "unavailable" };
    case "all-unavailable":
      return { "1day": "unavailable", "4h": "unavailable", "1h": "unavailable", "15m": "unavailable" };
    case "htf-unavailable":
      return { "1day": "bullish", "4h": "unavailable", "1h": "bullish", "15m": "bullish" };
    default:
      return { "1day": "neutral", "4h": "neutral", "1h": "neutral", "15m": "neutral" };
  }
}

export function marketFixture(
  symbol: Symbol,
  now = Date.now(),
  opts: {
    price?: number;
    candleClose?: number;
    stale?: boolean;
    omitCandles?: boolean;
    mtf?: MtfFixtureName;
  } = {},
): MarketData {
  const fetchedAt = new Date(now).toISOString();
  const lastClosedAt = new Date(now - 15 * 60_000).toISOString();
  const quote = opts.price ?? rates[symbol];
  const close = opts.candleClose ?? quote;
  const trends = trendsFor(opts.omitCandles ? "all-unavailable" : opts.mtf);
  const make = (trend: FrameTrend) => frameFor(close, fetchedAt, lastClosedAt, trend, false);
  return {
    symbol,
    price: { data: quote, fetchedAt, error: null, stale: !!opts.stale },
    timeframes: { "15m": make(trends["15m"]), "1h": make(trends["1h"]), "4h": make(trends["4h"]) },
    daily: make(trends["1day"]),
  };
}
