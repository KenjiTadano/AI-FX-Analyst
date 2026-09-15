import type { MarketData } from "../../lib/market/types";
import type { Symbol } from "../../lib/market/types";

const rates: Record<Symbol, number> = {
  "USD/JPY": 156.42,
  "EUR/JPY": 169.8,
  "GBP/JPY": 201.24,
};

export function marketFixture(symbol: Symbol, now = Date.now()): MarketData {
  const fetchedAt = new Date(now).toISOString();
  const lastClosedAt = new Date(now - 15 * 60_000).toISOString();
  const frame = {
    data: {
      candles: [{ time: lastClosedAt, open: rates[symbol], high: rates[symbol] + 0.1, low: rates[symbol] - 0.1, close: rates[symbol] }],
      indicators: {
        sma20: rates[symbol] - 0.2,
        sma75: rates[symbol] - 0.4,
        sma200: rates[symbol] - 0.8,
        rsi14: 48,
        atr14: 0.2,
        recentHigh: rates[symbol] + 0.3,
        recentLow: rates[symbol] - 0.3,
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
    price: { data: rates[symbol], fetchedAt, error: null, stale: false },
    timeframes: { "15m": frame, "1h": frame, "4h": frame },
  };
}
