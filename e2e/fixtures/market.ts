import type { MarketData } from "../../lib/market/types";
import type { Symbol } from "../../lib/market/types";

const rates: Record<Symbol, number> = {
  "USD/JPY": 156.42,
  "EUR/JPY": 169.8,
  "GBP/JPY": 201.24,
};

export function marketFixture(
  symbol: Symbol,
  now = Date.now(),
  opts: { price?: number; candleClose?: number; stale?: boolean; omitCandles?: boolean } = {},
): MarketData {
  const fetchedAt = new Date(now).toISOString();
  const lastClosedAt = new Date(now - 15 * 60_000).toISOString();
  const quote = opts.price ?? rates[symbol];
  const close = opts.candleClose ?? quote;
  const frame = opts.omitCandles
    ? { data: null, fetchedAt, error: "E2E candle omitted", stale: false }
    : {
      data: {
        candles: [{ time: lastClosedAt, open: close, high: close + 0.1, low: close - 0.1, close }],
        indicators: {
          sma20: close - 0.2,
          sma75: close - 0.4,
          sma200: close - 0.8,
          rsi14: 48,
          atr14: 0.2,
          recentHigh: close + 0.3,
          recentLow: close - 0.3,
          trend: "neutral" as const,
        },
        lastClosedAt,
      },
      fetchedAt,
      error: null,
      stale: false,
    };
  return {
    symbol,
    price: { data: quote, fetchedAt, error: null, stale: !!opts.stale },
    timeframes: { "15m": frame, "1h": frame, "4h": frame },
  };
}
