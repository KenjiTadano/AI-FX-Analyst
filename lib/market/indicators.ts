import type { Candle, Indicators } from "./types";

export function calculateIndicators(candles: Candle[]): Indicators {
  const closes = candles.map(c => c.close);
  const sma = (period: number) => closes.length < period ? null : closes.slice(-period).reduce((a, b) => a + b, 0) / period;
  let rsi14: number | null = null;
  let atr14: number | null = null;
  // Wilder smoothing, seeded with the mean of the first 14 changes / true ranges.
  if (candles.length >= 15) {
    let gain = 0, loss = 0, range = 0;
    for (let i = 1; i < candles.length; i++) {
      const change = closes[i] - closes[i - 1];
      const tr = Math.max(candles[i].high - candles[i].low, Math.abs(candles[i].high - closes[i - 1]), Math.abs(candles[i].low - closes[i - 1]));
      if (i <= 14) { gain += Math.max(change, 0) / 14; loss += Math.max(-change, 0) / 14; range += tr / 14; }
      else { gain = (gain * 13 + Math.max(change, 0)) / 14; loss = (loss * 13 + Math.max(-change, 0)) / 14; range = (range * 13 + tr) / 14; }
    }
    rsi14 = loss === 0 ? gain === 0 ? 50 : 100 : 100 - 100 / (1 + gain / loss);
    atr14 = range;
  }
  const sma20 = sma(20), sma75 = sma(75), sma200 = sma(200);
  const last = closes.at(-1);
  const trend = last !== undefined && sma20 !== null && sma75 !== null && sma200 !== null
    ? last > sma20 && sma20 > sma75 && sma75 > sma200 ? "bullish"
      : last < sma20 && sma20 < sma75 && sma75 < sma200 ? "bearish" : "neutral" : "neutral";
  const recent = candles.slice(-20);
  return { sma20, sma75, sma200, rsi14, atr14, trend, recentHigh: recent.length ? Math.max(...recent.map(c => c.high)) : null, recentLow: recent.length ? Math.min(...recent.map(c => c.low)) : null };
}
