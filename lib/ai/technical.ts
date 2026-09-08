import { calculateIndicators } from "../market/indicators";
import { timeframes, type MarketData, type Resource, type Technical, type Timeframe } from "../market/types";
import type { Direction, TechnicalAnalysis, TechnicalFrame } from "./types";

const duration: Record<Timeframe, number> = { "15m": 900_000, "1h": 3_600_000, "4h": 14_400_000 };
const weights: Record<Timeframe, number> = { "15m": 0.3, "1h": 0.4, "4h": 0.3 };
export const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
export const positive = (value: unknown): value is number => finite(value) && value > 0;
export function fresh(at: string | null | undefined, maxAge: number, now: number) {
  if (!at) return false;
  const age = now - Date.parse(at);
  return Number.isFinite(age) && age >= -5_000 && age <= maxAge;
}
export function currentRate(market: MarketData | null, now: number) {
  const price = market?.price;
  return price && !price.stale && !price.error && fresh(price.fetchedAt, 120_000, now) && positive(price.data) ? price.data : null;
}
export function compare(a: number | null, b: number | null): Direction {
  if (!finite(a) || !finite(b)) return "unknown";
  const difference = a - b;
  return Math.abs(difference) < 0.00001 ? "neutral" : difference > 0 ? "bullish" : "bearish";
}
export const directionValue = (direction: Direction) => direction === "bullish" ? 1 : direction === "bearish" ? -1 : 0;
export const scoreDirection = (score: number): Direction => score >= 20 ? "bullish" : score <= -20 ? "bearish" : "neutral";
function evaluateFrame(frame: Timeframe, resource: Resource<Technical> | undefined, rate: number | null, now: number): TechnicalFrame {
  const empty: TechnicalFrame = { timeframe: frame, available: false, completeness: 0, lastClosedAt: null, score: 0, close: null, sma20: null, sma75: null, sma200: null, priceVsSma: "unknown", shortVsMedium: "unknown", mediumVsLong: "unknown", smaSlopes: { short: null, medium: null, long: null }, rsi: null, rsiState: "unknown", momentum: null, momentumAtr: null, atr: null, recentHigh: null, recentLow: null, extended: false };
  if (!resource?.data || resource.stale || resource.error || !fresh(resource.fetchedAt, 600_000, now)) return empty;
  const candles = resource.data.candles;
  if (!candles.length || !fresh(resource.data.lastClosedAt, duration[frame] * 2 + 300_000, now)) return empty;
  if (candles.some((c, i) => ![c.open, c.close, c.high, c.low].every(positive) || c.high < Math.max(c.open, c.close, c.low) || c.low > Math.min(c.open, c.close) || !Number.isFinite(Date.parse(c.time)) || Date.parse(c.time) + duration[frame] > now || (i > 0 && Date.parse(c.time) <= Date.parse(candles[i - 1].time)))) return empty;
  // Recompute from validated closed candles; never rely on AI arithmetic.
  const indicators = calculateIndicators(candles);
  const previous = calculateIndicators(candles.slice(0, -5));
  const slope = (a: number | null, b: number | null) => finite(a) && finite(b) ? (a - b) / 5 : null;
  const smaSlopes = { short: slope(indicators.sma20, previous.sma20), medium: slope(indicators.sma75, previous.sma75), long: slope(indicators.sma200, previous.sma200) };
  const last = candles.at(-1)!;
  const momentum = candles.length >= 6 ? last.close - candles.at(-6)!.close : null;
  const atr = positive(indicators.atr14) ? indicators.atr14 : null;
  const momentumAtr = momentum !== null && atr ? momentum / atr : null;
  const priceVsSma = compare(rate, indicators.sma20);
  const shortVsMedium = compare(indicators.sma20, indicators.sma75);
  const mediumVsLong = compare(indicators.sma75, indicators.sma200);
  const score = directionValue(priceVsSma) * 15 + directionValue(shortVsMedium) * 20 + directionValue(mediumVsLong) * 20
    + directionValue(compare(smaSlopes.short, 0)) * 10 + directionValue(compare(smaSlopes.medium, 0)) * 10 + directionValue(compare(smaSlopes.long, 0)) * 10 + directionValue(compare(momentum, 0)) * 15;
  const numericFields = [rate, indicators.sma20, indicators.sma75, indicators.sma200, ...Object.values(smaSlopes), indicators.rsi14, atr, momentum, indicators.recentHigh, indicators.recentLow];
  const extended = (momentumAtr !== null && Math.abs(momentumAtr) >= 2) || (rate !== null && indicators.sma20 !== null && atr !== null && Math.abs(rate - indicators.sma20) >= atr * 2);
  return { ...empty, available: true, completeness: numericFields.filter(finite).length / numericFields.length, lastClosedAt: resource.data.lastClosedAt, score, close: last.close, sma20: indicators.sma20, sma75: indicators.sma75, sma200: indicators.sma200, priceVsSma, shortVsMedium, mediumVsLong, smaSlopes, rsi: indicators.rsi14, rsiState: indicators.rsi14 === null ? "unknown" : indicators.rsi14 < 30 ? "oversold" : indicators.rsi14 > 70 ? "overbought" : "normal", momentum, momentumAtr, atr, recentHigh: indicators.recentHigh, recentLow: indicators.recentLow, extended };
}
export function evaluateTechnical(market: MarketData | null, now: number): TechnicalAnalysis {
  const rate = currentRate(market, now);
  const frames = timeframes.map(frame => evaluateFrame(frame, market?.timeframes[frame], rate, now));
  const warnings = frames.flatMap(frame => [
    ...(!frame.available ? [`${frame.timeframe}: 確定足を取得できないか、データが古いため評価対象外です。`] : []),
    ...(frame.rsiState === "oversold" ? [`${frame.timeframe}: RSIは売られすぎ。下降継続と反発の両方に注意し、買いとは断定しません。`] : []),
    ...(frame.rsiState === "overbought" ? [`${frame.timeframe}: RSIは買われすぎ。上昇継続と反落の両方に注意し、売りとは断定しません。`] : []),
    ...(frame.extended ? [`${frame.timeframe}: ATRに対して変動・移動平均線との乖離が大きく、追いかけエントリーに注意。`] : []),
  ]);
  return {
    score: Math.round(frames.reduce((sum, frame) => sum + frame.score * weights[frame.timeframe], 0)), frames, warnings,
    ready: rate !== null && frames.filter(frame => frame.available && frame.completeness === 1).length >= 2,
    extended: frames.some(frame => frame.extended),
    factors: frames.map(frame => ({ category: "technical", title: `${frame.timeframe} テクニカル`, direction: frame.available ? scoreDirection(frame.score) : "unknown", impact: "high", source: "Twelve Data / TypeScript計算", evidenceIds: frame.available ? [`technical:${frame.timeframe}`] : [], reason: frame.available ? `価格対SMA・移動平均線の並びと傾き・5本モメンタムの評価は${frame.score}。RSI ${frame.rsi?.toFixed(1) ?? "未取得"}は過熱度として別評価。` : "新鮮な確定足データが不足しています。" })),
  };
}
