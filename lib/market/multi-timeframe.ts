import { calculateIndicators } from "./indicators";
import {
  mtfTimeframes,
  symbols,
  type Candle,
  type Indicators,
  type MarketData,
  type MarketTimeframe,
  type Resource,
  type Symbol,
  type Technical,
} from "./types";

export const MTF_MIN_CANDLES = 200;
export const MTF_CONFLICT_CAP = 3;
export const MTF_CONFLICT_MAX_LENGTH = 120;
export const MTF_TOTAL_TIMEFRAMES = mtfTimeframes.length;

export type TimeframeTrend = "bullish" | "bearish" | "neutral" | "unavailable";
export type MarketStructure = "uptrend" | "downtrend" | "range" | "mixed" | "unavailable";
export type HigherTimeframeBias = TimeframeTrend;
export type TimeframeAlignment = "aligned_bullish" | "aligned_bearish" | "mixed" | "insufficient";

export interface TimeframeAnalysis {
  timeframe: MarketTimeframe;
  trend: TimeframeTrend;
  structure: MarketStructure;
  lastClose: number | null;
  sma20: number | null;
  sma75: number | null;
  sma200: number | null;
  rsi14: number | null;
  recentHigh: number | null;
  recentLow: number | null;
  dataPoints: number;
  sufficientData: boolean;
}

export interface MultiTimeframeConflict {
  id: string;
  message: string;
}

export interface MultiTimeframeAnalysis {
  pair: Symbol;
  analyzedAt: string;
  timeframes: TimeframeAnalysis[];
  higherTimeframeBias: HigherTimeframeBias;
  alignment: TimeframeAlignment;
  availableTimeframes: number;
  totalTimeframes: number;
  conflicts: MultiTimeframeConflict[];
}

export const TREND_LABEL: Record<TimeframeTrend, string> = {
  bullish: "上向き",
  bearish: "下向き",
  neutral: "中立",
  unavailable: "未取得",
};

export const STRUCTURE_LABEL: Record<MarketStructure, string> = {
  uptrend: "上昇",
  downtrend: "下降",
  range: "レンジ",
  mixed: "混在",
  unavailable: "未取得",
};

export const TIMEFRAME_LABEL: Record<MarketTimeframe, string> = {
  "1day": "1日",
  "4h": "4時間",
  "1h": "1時間",
  "15m": "15分",
};

export const ALIGNMENT_LABEL: Record<TimeframeAlignment, string> = {
  aligned_bullish: "すべての時間軸が上向きです",
  aligned_bearish: "すべての時間軸が下向きです",
  mixed: "時間軸で方向が混在しています",
  insufficient: "判定に必要な時間軸が不足しています",
};

export const MTF_UNAVAILABLE_MESSAGE = "マルチタイムフレーム分析を取得できません";

const TRENDS: TimeframeTrend[] = ["bullish", "bearish", "neutral", "unavailable"];
const STRUCTURES: MarketStructure[] = ["uptrend", "downtrend", "range", "mixed", "unavailable"];

export const finiteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

function nullableFinite(value: unknown): number | null {
  return finiteNumber(value) ? value : null;
}

function structureFromTrend(trend: TimeframeTrend): MarketStructure {
  if (trend === "bullish") return "uptrend";
  if (trend === "bearish") return "downtrend";
  if (trend === "neutral") return "mixed";
  return "unavailable";
}

function emptyFrame(timeframe: MarketTimeframe, dataPoints = 0): TimeframeAnalysis {
  return {
    timeframe,
    trend: "unavailable",
    structure: "unavailable",
    lastClose: null,
    sma20: null,
    sma75: null,
    sma200: null,
    rsi14: null,
    recentHigh: null,
    recentLow: null,
    dataPoints,
    sufficientData: false,
  };
}

function validOhlc(candle: Candle): boolean {
  const { open, high, low, close } = candle;
  if (![open, high, low, close].every(finiteNumber) || open <= 0 || high <= 0 || low <= 0 || close <= 0) return false;
  if (high < Math.max(open, close, low) || low > Math.min(open, close)) return false;
  return Number.isFinite(Date.parse(candle.time));
}

/** Oldest-first, last duplicate timestamp wins. Does not mutate the input array or candle objects. */
export function canonicalCandles(input: Candle[] | null | undefined): Candle[] | null {
  if (!Array.isArray(input)) return null;
  const copied = input.map(candle => ({ time: candle.time, open: candle.open, high: candle.high, low: candle.low, close: candle.close }));
  copied.sort((a, b) => a.time.localeCompare(b.time));
  const out: Candle[] = [];
  for (const candle of copied) {
    if (!validOhlc(candle)) return null;
    if (out.length && out[out.length - 1]!.time === candle.time) out[out.length - 1] = candle;
    else out.push(candle);
  }
  return out;
}

function indicatorsFrom(candles: Candle[], stored: Indicators | null | undefined): Indicators | null {
  if (candles.length >= MTF_MIN_CANDLES) return calculateIndicators(candles);
  if (!stored) return null;
  return stored;
}

export function analyzeTimeframe(timeframe: MarketTimeframe, resource: Resource<Technical> | null | undefined): TimeframeAnalysis {
  const empty = emptyFrame(timeframe);
  if (!resource?.data?.candles) return empty;
  const candles = canonicalCandles(resource.data.candles);
  if (!candles || !candles.length) return empty;
  const indicators = indicatorsFrom(candles, resource.data.indicators);
  if (!indicators) return { ...empty, dataPoints: candles.length };
  const lastClose = nullableFinite(candles.at(-1)?.close);
  const sma20 = nullableFinite(indicators.sma20);
  const sma75 = nullableFinite(indicators.sma75);
  const sma200 = nullableFinite(indicators.sma200);
  const rsi14 = nullableFinite(indicators.rsi14);
  const recentHigh = nullableFinite(indicators.recentHigh);
  const recentLow = nullableFinite(indicators.recentLow);
  const sufficientData = lastClose !== null && sma20 !== null && sma75 !== null && sma200 !== null;
  if (!sufficientData) {
    return { ...empty, lastClose, sma20, sma75, sma200, rsi14, recentHigh, recentLow, dataPoints: candles.length, sufficientData: false };
  }
  const trend: TimeframeTrend = indicators.trend === "bullish" || indicators.trend === "bearish" || indicators.trend === "neutral"
    ? indicators.trend
    : "unavailable";
  if (trend === "unavailable") {
    return { ...empty, lastClose, sma20, sma75, sma200, rsi14, recentHigh, recentLow, dataPoints: candles.length, sufficientData: false };
  }
  return {
    timeframe,
    trend,
    structure: structureFromTrend(trend),
    lastClose,
    sma20,
    sma75,
    sma200,
    rsi14,
    recentHigh,
    recentLow,
    dataPoints: candles.length,
    sufficientData: true,
  };
}

function higherBias(day: TimeframeAnalysis, fourHour: TimeframeAnalysis): HigherTimeframeBias {
  if (day.trend === "unavailable" || fourHour.trend === "unavailable") return "unavailable";
  if (day.trend === "bullish" && fourHour.trend === "bullish") return "bullish";
  if (day.trend === "bearish" && fourHour.trend === "bearish") return "bearish";
  return "neutral";
}

function alignmentOf(frames: TimeframeAnalysis[]): TimeframeAlignment {
  if (frames.some(frame => frame.trend === "unavailable")) return "insufficient";
  if (frames.every(frame => frame.trend === "bullish")) return "aligned_bullish";
  if (frames.every(frame => frame.trend === "bearish")) return "aligned_bearish";
  return "mixed";
}

function conflict(id: string, message: string): MultiTimeframeConflict {
  return { id, message: message.slice(0, MTF_CONFLICT_MAX_LENGTH) };
}

export function buildConflicts(frames: TimeframeAnalysis[], bias: HigherTimeframeBias): MultiTimeframeConflict[] {
  const byTf = Object.fromEntries(frames.map(frame => [frame.timeframe, frame])) as Record<MarketTimeframe, TimeframeAnalysis>;
  const items: MultiTimeframeConflict[] = [];
  const day = byTf["1day"];
  const fourHour = byTf["4h"];
  if (day && fourHour && day.trend !== "unavailable" && fourHour.trend !== "unavailable" && day.trend !== fourHour.trend && day.trend !== "neutral" && fourHour.trend !== "neutral") {
    items.push(conflict("1day-4h", `${TIMEFRAME_LABEL["1day"]}足は${TREND_LABEL[day.trend]}ですが、${TIMEFRAME_LABEL["4h"]}足は${TREND_LABEL[fourHour.trend]}です`));
  }
  if (bias === "bullish" || bias === "bearish") {
    const opposite: TimeframeTrend = bias === "bullish" ? "bearish" : "bullish";
    for (const tf of ["1h", "15m"] as const) {
      if (byTf[tf]?.trend === opposite) {
        items.push(conflict(`htf-${tf}`, `上位足は${TREND_LABEL[bias]}ですが、${TIMEFRAME_LABEL[tf]}足は${TREND_LABEL[opposite]}です`));
      }
    }
  }
  return items.slice(0, MTF_CONFLICT_CAP);
}

export function buildMultiTimeframeAnalysis(args: {
  pair: Symbol;
  analyzedAt: string;
  daily?: Resource<Technical> | null;
  timeframes?: Partial<Record<"15m" | "1h" | "4h", Resource<Technical> | null | undefined>> | null;
}): MultiTimeframeAnalysis {
  const resources: Record<MarketTimeframe, Resource<Technical> | null | undefined> = {
    "1day": args.daily,
    "4h": args.timeframes?.["4h"],
    "1h": args.timeframes?.["1h"],
    "15m": args.timeframes?.["15m"],
  };
  const frames = mtfTimeframes.map(timeframe => analyzeTimeframe(timeframe, resources[timeframe]));
  const higherTimeframeBias = higherBias(frames[0]!, frames[1]!);
  return {
    pair: args.pair,
    analyzedAt: args.analyzedAt,
    timeframes: frames,
    higherTimeframeBias,
    alignment: alignmentOf(frames),
    availableTimeframes: frames.filter(frame => frame.trend !== "unavailable").length,
    totalTimeframes: MTF_TOTAL_TIMEFRAMES,
    conflicts: buildConflicts(frames, higherTimeframeBias),
  };
}

export function multiTimeframeForPair(market: MarketData | null | undefined, pair: Symbol, analyzedAt = new Date().toISOString()): MultiTimeframeAnalysis | null {
  if (!market || market.symbol !== pair) return null;
  return buildMultiTimeframeAnalysis({
    pair,
    analyzedAt,
    daily: market.daily,
    timeframes: market.timeframes,
  });
}

function sanitizeTrend(value: unknown): TimeframeTrend {
  return typeof value === "string" && TRENDS.includes(value as TimeframeTrend) ? value as TimeframeTrend : "unavailable";
}

function sanitizeStructure(value: unknown, trend: TimeframeTrend): MarketStructure {
  if (typeof value === "string" && STRUCTURES.includes(value as MarketStructure)) return value as MarketStructure;
  return structureFromTrend(trend);
}

function sanitizeFrame(raw: unknown, timeframe: MarketTimeframe): TimeframeAnalysis {
  const empty = emptyFrame(timeframe);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return empty;
  const row = raw as Record<string, unknown>;
  if ("candles" in row) {
    /* raw OHLC is never accepted into the AI payload */
  }
  const trend = sanitizeTrend(row.trend);
  const sufficientData = row.sufficientData === true && trend !== "unavailable";
  return {
    timeframe,
    trend: sufficientData ? trend : "unavailable",
    structure: sufficientData ? sanitizeStructure(row.structure, trend) : "unavailable",
    lastClose: nullableFinite(row.lastClose),
    sma20: nullableFinite(row.sma20),
    sma75: nullableFinite(row.sma75),
    sma200: nullableFinite(row.sma200),
    rsi14: nullableFinite(row.rsi14),
    recentHigh: nullableFinite(row.recentHigh),
    recentLow: nullableFinite(row.recentLow),
    dataPoints: finiteNumber(row.dataPoints) && row.dataPoints >= 0 ? Math.floor(row.dataPoints) : 0,
    sufficientData,
  };
}

export function sanitizeMultiTimeframeAnalysis(raw: unknown, expectedPair?: Symbol): MultiTimeframeAnalysis | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.pair !== "string" || !symbols.includes(value.pair as Symbol)) return null;
  const pair = value.pair as Symbol;
  if (expectedPair && pair !== expectedPair) return null;
  if ("candles" in value || "values" in value) return null;
  const analyzedAt = typeof value.analyzedAt === "string" && Number.isFinite(Date.parse(value.analyzedAt))
    ? new Date(value.analyzedAt).toISOString()
    : new Date(0).toISOString();
  const rows = Array.isArray(value.timeframes) ? value.timeframes : [];
  const byTf = new Map<MarketTimeframe, unknown>();
  for (const row of rows) {
    if (row && typeof row === "object" && !Array.isArray(row) && typeof (row as { timeframe?: unknown }).timeframe === "string") {
      const tf = (row as { timeframe: string }).timeframe;
      if ((mtfTimeframes as readonly string[]).includes(tf)) byTf.set(tf as MarketTimeframe, row);
    }
  }
  const timeframes = mtfTimeframes.map(tf => sanitizeFrame(byTf.get(tf), tf));
  const higherTimeframeBias = sanitizeTrend(value.higherTimeframeBias);
  const alignmentRaw = value.alignment;
  const alignment: TimeframeAlignment = alignmentRaw === "aligned_bullish" || alignmentRaw === "aligned_bearish" || alignmentRaw === "mixed" || alignmentRaw === "insufficient"
    ? alignmentRaw
    : alignmentOf(timeframes);
  const conflictsRaw = Array.isArray(value.conflicts) ? value.conflicts : [];
  const conflicts: MultiTimeframeConflict[] = [];
  for (const item of conflictsRaw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.message !== "string" || !rec.message.trim()) continue;
    const id = typeof rec.id === "string" && rec.id.trim() ? rec.id.slice(0, 40) : `conflict-${conflicts.length}`;
    conflicts.push(conflict(id, rec.message.trim()));
    if (conflicts.length >= MTF_CONFLICT_CAP) break;
  }
  return {
    pair,
    analyzedAt,
    timeframes,
    higherTimeframeBias: higherTimeframeBias === "bullish" || higherTimeframeBias === "bearish" || higherTimeframeBias === "neutral" || higherTimeframeBias === "unavailable"
      ? higherTimeframeBias
      : "unavailable",
    alignment,
    availableTimeframes: timeframes.filter(frame => frame.trend !== "unavailable").length,
    totalTimeframes: MTF_TOTAL_TIMEFRAMES,
    conflicts,
  };
}

export function mtfEvidencePayload(analysis: MultiTimeframeAnalysis): Record<string, unknown> {
  return {
    kind: "multi_timeframe_summary",
    pair: analysis.pair,
    analyzedAt: analysis.analyzedAt,
    higherTimeframeBias: analysis.higherTimeframeBias,
    alignment: analysis.alignment,
    availableTimeframes: analysis.availableTimeframes,
    totalTimeframes: analysis.totalTimeframes,
    conflicts: analysis.conflicts.map(item => ({ id: item.id, message: item.message })),
    timeframes: analysis.timeframes.map(frame => ({
      timeframe: frame.timeframe,
      trend: frame.trend,
      structure: frame.structure,
      lastClose: frame.lastClose,
      sma20: frame.sma20,
      sma75: frame.sma75,
      sma200: frame.sma200,
      rsi14: frame.rsi14,
      recentHigh: frame.recentHigh,
      recentLow: frame.recentLow,
      dataPoints: frame.dataPoints,
      sufficientData: frame.sufficientData,
    })),
  };
}
