import { calculateIndicators } from "../../lib/market/indicators";
import type { Candle, Indicators, MarketData, Resource, Technical } from "../../lib/market/types";
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

export type RegimeFixtureName =
  | "trending-bullish"
  | "trending-bearish"
  | "range"
  | "transition"
  | "unavailable"
  | "high-vol"
  | "normal-vol"
  | "low-vol"
  | "forming"
  | "insufficient";

const HOUR_MS = 3_600_000;

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

function iso(at: number) {
  return new Date(at).toISOString();
}

function hourCandle(time: string, close: number, pad: number): Candle {
  return { time, open: close, high: close + pad, low: close - pad, close };
}

export function regimeHourCandles(now: number, name: RegimeFixtureName): Candle[] {
  const count = name === "insufficient" ? 199 : name === "forming" ? 200 : 220;
  if (name === "unavailable") {
    return [hourCandle(iso(now - 15 * 60_000), 150, 0.05)];
  }
  return Array.from({ length: count }, (_, i) => {
    const last = count - 1;
    let close = 150;
    let pad = 0.08;
    if (name === "trending-bullish" || name === "high-vol" || name === "normal-vol") {
      close = 150 + (i - last) * 0.02;
    } else if (name === "trending-bearish" || name === "low-vol") {
      close = 150 + (last - i) * 0.02;
    } else if (name === "transition") {
      close = 150 + (i - last) * 0.00002;
    } else if (name === "range") {
      close = 150;
      pad = 0.12;
    } else if (name === "forming" || name === "insufficient") {
      close = 150 + (i - last) * 0.02;
    }
    if (name === "high-vol" && i >= count - 6) pad = 12;
    if (name === "low-vol") pad = i < count - 50 ? 8 : 0.04;
    if (name === "forming" && i === last) {
      return hourCandle(iso(now - 30 * 60_000), close, pad);
    }
    return hourCandle(iso(now - (count - i) * HOUR_MS), close, pad);
  });
}

function regimeHourFrame(now: number, name: RegimeFixtureName, fetchedAt: string): Resource<Technical> {
  const candles = regimeHourCandles(now, name);
  const confirmed = name === "forming" ? candles.slice(0, -1) : candles;
  return {
    data: {
      candles,
      indicators: calculateIndicators(confirmed.length ? confirmed : candles),
      lastClosedAt: confirmed.at(-1)?.time ?? candles.at(-1)?.time ?? null,
    },
    fetchedAt,
    error: null,
    stale: false,
  };
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
    regime?: RegimeFixtureName;
  } = {},
): MarketData {
  const fetchedAt = new Date(now).toISOString();
  const lastClosedAt = new Date(now - 15 * 60_000).toISOString();
  const quote = opts.price ?? rates[symbol];
  const close = opts.candleClose ?? quote;
  const trends = trendsFor(opts.omitCandles ? "all-unavailable" : opts.mtf);
  const make = (trend: FrameTrend) => frameFor(close, fetchedAt, lastClosedAt, trend, false);
  const hour = opts.regime
    ? regimeHourFrame(now, opts.regime, fetchedAt)
    : make(trends["1h"]);
  return {
    symbol,
    price: { data: quote, fetchedAt, error: null, stale: !!opts.stale },
    timeframes: { "15m": make(trends["15m"]), "1h": hour, "4h": make(trends["4h"]) },
    daily: make(trends["1day"]),
  };
}
