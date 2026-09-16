import { atr14Series, calculateIndicators } from "./indicators";
import { canonicalCandles, finiteNumber, MTF_MIN_CANDLES } from "./multi-timeframe";
import { symbols, type Candle, type MarketData, type Symbol } from "./types";

export const REGIME_VERSION = 1 as const;
export const REGIME_TIMEFRAME = "1h" as const;
export const REGIME_DURATION_MS = 3_600_000;
export const REGIME_MIN_CANDLES = MTF_MIN_CANDLES;
export const REGIME_ATR_BASELINE_LEN = 100;
export const REGIME_VOL_HIGH_RATIO = 1.3;
export const REGIME_VOL_LOW_RATIO = 0.75;
export const REGIME_TRENDING_SMA_SPREAD_PERCENT = 0.1;
export const REGIME_RANGE_SMA_SPREAD_PERCENT = 0.1;
export const REGIME_RANGE_POSITION_MIN = 0.15;
export const REGIME_RANGE_POSITION_MAX = 0.85;
export const REGIME_REASON_CAP = 4;

export type MarketRegimeKind = "trending" | "range" | "transition" | "unavailable";
export type RegimeTrendDirection = "bullish" | "bearish" | "neutral" | "unavailable";
export type VolatilityRegime = "high" | "normal" | "low" | "unavailable";

export interface MarketRegimeEvidence {
  close: number | null;
  sma20: number | null;
  sma75: number | null;
  sma200: number | null;
  rsi14: number | null;
  atr14: number | null;
  atrPercent: number | null;
  atrRatio: number | null;
  atrBaseline: number | null;
  smaSpreadPercent: number | null;
  rangePosition: number | null;
  recentHigh: number | null;
  recentLow: number | null;
  dataPoints: number;
}

export interface MarketRegimeAnalysis {
  version: typeof REGIME_VERSION;
  pair: Symbol;
  timeframe: typeof REGIME_TIMEFRAME;
  analyzedAt: string;
  regime: MarketRegimeKind;
  trendDirection: RegimeTrendDirection;
  volatility: VolatilityRegime;
  evidence: MarketRegimeEvidence;
  reasons: string[];
}

export const REGIME_LABEL: Record<MarketRegimeKind, string> = {
  trending: "トレンド",
  range: "レンジ",
  transition: "移行・不明瞭",
  unavailable: "未取得",
};

export const REGIME_TREND_LABEL: Record<RegimeTrendDirection, string> = {
  bullish: "上向き",
  bearish: "下向き",
  neutral: "中立",
  unavailable: "未取得",
};

export const VOLATILITY_LABEL: Record<VolatilityRegime, string> = {
  high: "高い",
  normal: "通常",
  low: "低い",
  unavailable: "未取得",
};

export const REGIME_UNAVAILABLE_MESSAGE = "相場環境を判定するための確定足データが不足しています";
export const REGIME_DISCLAIMER = "1時間足の確定足から計算した市場状態です。売買の推奨ではありません。";

const REGIMES: MarketRegimeKind[] = ["trending", "range", "transition", "unavailable"];
const TRENDS: RegimeTrendDirection[] = ["bullish", "bearish", "neutral", "unavailable"];
const VOLS: VolatilityRegime[] = ["high", "normal", "low", "unavailable"];

function nullableFinite(value: unknown): number | null {
  return finiteNumber(value) ? value : null;
}

function analyzedIso(value: string): string {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : new Date(0).toISOString();
}

export function confirmedHourCandles(candles: Candle[], analyzedAt: string): Candle[] {
  const now = Date.parse(analyzedAt);
  if (!Number.isFinite(now)) return [];
  return candles.filter(candle => Date.parse(candle.time) + REGIME_DURATION_MS <= now);
}

export function atrPercent(atr14: number | null, close: number | null): number | null {
  if (!finiteNumber(atr14) || !finiteNumber(close) || close <= 0 || atr14 < 0) return null;
  return atr14 / close * 100;
}

export function smaSpreadPercent(
  sma20: number | null,
  sma75: number | null,
  sma200: number | null,
  close: number | null,
): number | null {
  if (!finiteNumber(sma20) || !finiteNumber(sma75) || !finiteNumber(sma200) || !finiteNumber(close) || close <= 0) return null;
  return (Math.max(sma20, sma75, sma200) - Math.min(sma20, sma75, sma200)) / close * 100;
}

export function rangePosition(close: number | null, recentHigh: number | null, recentLow: number | null): number | null {
  if (!finiteNumber(close) || !finiteNumber(recentHigh) || !finiteNumber(recentLow)) return null;
  const width = recentHigh - recentLow;
  if (width <= 0) return null;
  return (close - recentLow) / width;
}

export function medianPositive(values: number[]): number | null {
  const xs = values.filter(value => Number.isFinite(value) && value > 0);
  if (!xs.length) return null;
  xs.sort((a, b) => a - b);
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 === 1 ? xs[mid]! : (xs[mid - 1]! + xs[mid]!) / 2;
}

export function classifyVolatility(currentAtr: number | null, baselineAtr: number | null): VolatilityRegime {
  if (!finiteNumber(currentAtr) || !finiteNumber(baselineAtr) || currentAtr <= 0 || baselineAtr <= 0) return "unavailable";
  const ratio = currentAtr / baselineAtr;
  if (ratio >= REGIME_VOL_HIGH_RATIO) return "high";
  if (ratio <= REGIME_VOL_LOW_RATIO) return "low";
  return "normal";
}

function emptyEvidence(dataPoints = 0): MarketRegimeEvidence {
  return {
    close: null,
    sma20: null,
    sma75: null,
    sma200: null,
    rsi14: null,
    atr14: null,
    atrPercent: null,
    atrRatio: null,
    atrBaseline: null,
    smaSpreadPercent: null,
    rangePosition: null,
    recentHigh: null,
    recentLow: null,
    dataPoints,
  };
}

function unavailable(pair: Symbol, analyzedAt: string, dataPoints = 0, extra?: Partial<MarketRegimeEvidence>): MarketRegimeAnalysis {
  const evidence = { ...emptyEvidence(dataPoints), ...extra, dataPoints };
  return {
    version: REGIME_VERSION,
    pair,
    timeframe: REGIME_TIMEFRAME,
    analyzedAt,
    regime: "unavailable",
    trendDirection: "unavailable",
    volatility: extra && "atrRatio" in extra ? classifyVolatility(extra.atr14 ?? null, extra.atrBaseline ?? null) : "unavailable",
    evidence,
    reasons: [REGIME_UNAVAILABLE_MESSAGE],
  };
}

function classifyRegime(
  trendDirection: RegimeTrendDirection,
  spread: number | null,
  position: number | null,
): MarketRegimeKind {
  if (trendDirection === "unavailable") return "unavailable";
  if (
    (trendDirection === "bullish" || trendDirection === "bearish")
    && spread !== null
    && spread >= REGIME_TRENDING_SMA_SPREAD_PERCENT
  ) {
    return "trending";
  }
  if (
    trendDirection === "neutral"
    && spread !== null
    && spread <= REGIME_RANGE_SMA_SPREAD_PERCENT
    && position !== null
    && position >= REGIME_RANGE_POSITION_MIN
    && position <= REGIME_RANGE_POSITION_MAX
  ) {
    return "range";
  }
  return "transition";
}

function buildReasons(args: {
  regime: MarketRegimeKind;
  trendDirection: RegimeTrendDirection;
  spread: number | null;
  atrRatio: number | null;
  position: number | null;
}): string[] {
  if (args.regime === "unavailable" || args.trendDirection === "unavailable") {
    return [REGIME_UNAVAILABLE_MESSAGE];
  }
  const reasons: string[] = [];
  if (args.trendDirection === "bullish") {
    reasons.push("1時間足の価格とSMA20・75・200が上向き順に並んでいます");
  } else if (args.trendDirection === "bearish") {
    reasons.push("1時間足の価格とSMA20・75・200が下向き順に並んでいます");
  } else {
    reasons.push("1時間足の価格とSMA20・75・200は明確な上下の並びではありません");
  }
  if (args.spread !== null) {
    reasons.push(`SMA間の価格比スプレッドは${args.spread.toFixed(2)}%です`);
  }
  if (args.atrRatio !== null) {
    reasons.push(`ATR14は直近基準の${args.atrRatio.toFixed(2)}倍です`);
  }
  if (args.regime === "range" && args.position !== null) {
    reasons.push(`終値は直近高値・安値レンジの${(args.position * 100).toFixed(0)}%付近にあります`);
  } else if (args.regime === "transition") {
    reasons.push("明確なトレンド条件でもレンジ条件でもないため移行・不明瞭です");
  }
  return reasons.slice(0, REGIME_REASON_CAP);
}

function volatilityFromSeries(series: number[], currentAtr: number | null): {
  volatility: VolatilityRegime;
  atrBaseline: number | null;
  atrRatio: number | null;
} {
  const window = series.slice(-REGIME_ATR_BASELINE_LEN);
  const samples = window.filter(value => Number.isFinite(value) && value > 0);
  if (samples.length < REGIME_ATR_BASELINE_LEN) {
    return { volatility: "unavailable", atrBaseline: null, atrRatio: null };
  }
  const atrBaseline = medianPositive(samples);
  const volatility = classifyVolatility(currentAtr, atrBaseline);
  const atrRatio = finiteNumber(currentAtr) && finiteNumber(atrBaseline) && atrBaseline > 0 && currentAtr > 0
    ? currentAtr / atrBaseline
    : null;
  return { volatility, atrBaseline, atrRatio };
}

export function analyzeMarketRegime(args: {
  pair: Symbol;
  candles: Candle[] | null | undefined;
  analyzedAt: string;
}): MarketRegimeAnalysis {
  const analyzedAt = analyzedIso(args.analyzedAt);
  const pair = symbols.includes(args.pair) ? args.pair : "USD/JPY";
  try {
    const canonical = canonicalCandles(args.candles);
    if (!canonical) return unavailable(pair, analyzedAt, Array.isArray(args.candles) ? args.candles.length : 0);
    const confirmed = confirmedHourCandles(canonical, analyzedAt);
    const dataPoints = confirmed.length;
    if (dataPoints < REGIME_MIN_CANDLES) return unavailable(pair, analyzedAt, dataPoints);
    const indicators = calculateIndicators(confirmed);
    const close = nullableFinite(confirmed.at(-1)?.close);
    const sma20 = nullableFinite(indicators.sma20);
    const sma75 = nullableFinite(indicators.sma75);
    const sma200 = nullableFinite(indicators.sma200);
    const rsi14 = nullableFinite(indicators.rsi14);
    const atr14 = nullableFinite(indicators.atr14);
    const recentHigh = nullableFinite(indicators.recentHigh);
    const recentLow = nullableFinite(indicators.recentLow);
    const sufficientTrend = close !== null && sma20 !== null && sma75 !== null && sma200 !== null;
    if (!sufficientTrend) {
      const vol = volatilityFromSeries(atr14Series(confirmed), atr14);
      return {
        ...unavailable(pair, analyzedAt, dataPoints, {
          close, sma20, sma75, sma200, rsi14, atr14,
          atrPercent: atrPercent(atr14, close),
          atrRatio: vol.atrRatio,
          atrBaseline: vol.atrBaseline,
          recentHigh, recentLow,
        }),
        volatility: vol.volatility,
      };
    }
    const trendDirection: RegimeTrendDirection = indicators.trend === "bullish" || indicators.trend === "bearish" || indicators.trend === "neutral"
      ? indicators.trend
      : "unavailable";
    const spread = smaSpreadPercent(sma20, sma75, sma200, close);
    const position = rangePosition(close, recentHigh, recentLow);
    const vol = volatilityFromSeries(atr14Series(confirmed), atr14);
    const regime = classifyRegime(trendDirection, spread, position);
    const evidence: MarketRegimeEvidence = {
      close,
      sma20,
      sma75,
      sma200,
      rsi14,
      atr14,
      atrPercent: atrPercent(atr14, close),
      atrRatio: vol.atrRatio,
      atrBaseline: vol.atrBaseline,
      smaSpreadPercent: spread,
      rangePosition: position,
      recentHigh,
      recentLow,
      dataPoints,
    };
    return {
      version: REGIME_VERSION,
      pair,
      timeframe: REGIME_TIMEFRAME,
      analyzedAt,
      regime,
      trendDirection,
      volatility: vol.volatility,
      evidence,
      reasons: buildReasons({ regime, trendDirection, spread, atrRatio: vol.atrRatio, position }),
    };
  } catch {
    return unavailable(pair, analyzedAt);
  }
}

export function marketRegimeForPair(
  market: MarketData | null | undefined,
  pair: Symbol,
  analyzedAt?: string,
): MarketRegimeAnalysis | null {
  if (!market || market.symbol !== pair) return null;
  const fetchedAt = market.timeframes["1h"]?.fetchedAt ?? market.price.fetchedAt ?? new Date(0).toISOString();
  return analyzeMarketRegime({
    pair,
    candles: market.timeframes["1h"]?.data?.candles ?? [],
    analyzedAt: analyzedAt ?? fetchedAt,
  });
}

function sanitizeEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? value as T : fallback;
}

export function sanitizeMarketRegimeAnalysis(raw: unknown, expectedPair?: Symbol): MarketRegimeAnalysis | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if ("candles" in value || "values" in value || "atr14Series" in value || "apikey" in value || "apiKey" in value) return null;
  if (typeof value.pair !== "string" || !symbols.includes(value.pair as Symbol)) return null;
  const pair = value.pair as Symbol;
  if (expectedPair && pair !== expectedPair) return null;
  const evidenceRaw = value.evidence && typeof value.evidence === "object" && !Array.isArray(value.evidence)
    ? value.evidence as Record<string, unknown>
    : {};
  if ("candles" in evidenceRaw || "atr14Series" in evidenceRaw) return null;
  const reasonsRaw = Array.isArray(value.reasons) ? value.reasons : [];
  const reasons: string[] = [];
  for (const item of reasonsRaw) {
    if (typeof item !== "string" || !item.trim()) continue;
    reasons.push(item.trim().slice(0, 200));
    if (reasons.length >= REGIME_REASON_CAP) break;
  }
  const evidence: MarketRegimeEvidence = {
    close: nullableFinite(evidenceRaw.close),
    sma20: nullableFinite(evidenceRaw.sma20),
    sma75: nullableFinite(evidenceRaw.sma75),
    sma200: nullableFinite(evidenceRaw.sma200),
    rsi14: nullableFinite(evidenceRaw.rsi14),
    atr14: nullableFinite(evidenceRaw.atr14),
    atrPercent: nullableFinite(evidenceRaw.atrPercent),
    atrRatio: nullableFinite(evidenceRaw.atrRatio),
    atrBaseline: nullableFinite(evidenceRaw.atrBaseline),
    smaSpreadPercent: nullableFinite(evidenceRaw.smaSpreadPercent),
    rangePosition: nullableFinite(evidenceRaw.rangePosition),
    recentHigh: nullableFinite(evidenceRaw.recentHigh),
    recentLow: nullableFinite(evidenceRaw.recentLow),
    dataPoints: finiteNumber(evidenceRaw.dataPoints) && evidenceRaw.dataPoints >= 0 ? Math.floor(evidenceRaw.dataPoints) : 0,
  };
  return {
    version: REGIME_VERSION,
    pair,
    timeframe: REGIME_TIMEFRAME,
    analyzedAt: typeof value.analyzedAt === "string" ? analyzedIso(value.analyzedAt) : new Date(0).toISOString(),
    regime: sanitizeEnum(value.regime, REGIMES, "unavailable"),
    trendDirection: sanitizeEnum(value.trendDirection, TRENDS, "unavailable"),
    volatility: sanitizeEnum(value.volatility, VOLS, "unavailable"),
    evidence,
    reasons,
  };
}

export function regimeEvidencePayload(analysis: MarketRegimeAnalysis): Record<string, unknown> {
  return {
    kind: "market_regime_summary",
    version: analysis.version,
    pair: analysis.pair,
    timeframe: analysis.timeframe,
    analyzedAt: analysis.analyzedAt,
    regime: analysis.regime,
    trendDirection: analysis.trendDirection,
    volatility: analysis.volatility,
    atrPercent: analysis.evidence.atrPercent,
    atrRatio: analysis.evidence.atrRatio,
    smaSpreadPercent: analysis.evidence.smaSpreadPercent,
    reasons: analysis.reasons.slice(0, REGIME_REASON_CAP),
  };
}
