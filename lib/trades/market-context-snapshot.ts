import {
  multiTimeframeForPair,
  sanitizeMultiTimeframeAnalysis,
  type MultiTimeframeAnalysis,
  type TimeframeAnalysis,
} from "../market/multi-timeframe";
import {
  marketRegimeForPair,
  sanitizeMarketRegimeAnalysis,
  type MarketRegimeAnalysis,
} from "../market/market-regime";
import { finiteNumber } from "../market/multi-timeframe";
import type { MarketData, Symbol as MarketSymbol } from "../market/types";
import { pairs, type Trade, type TradePair } from "./types";

export const MARKET_CONTEXT_SNAPSHOT_VERSION = 1 as const;
export const MARKET_CONTEXT_TITLE = "Market Context Snapshot";
export const MARKET_CONTEXT_EYEBROW = "MARKET CONTEXT";
export const MARKET_CONTEXT_NOTE =
  "取引記録時点の市場コンテキストです。AI分析の成否に依存せず、現在値や決済結果では書き換えません。";
export const MARKET_CONTEXT_LEGACY = "legacy（market context snapshot なし）";
export const MARKET_CONTEXT_DISCLAIMER =
  "保存済みの確定足コンテキストです。売買の推奨ではありません。";

const ISO = (value: unknown): string | null =>
  typeof value === "string"
  && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
  && new Date(value).toISOString() === value
    ? value
    : null;

const NUM = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 1_000_000 ? value : null;

const SECRET = /sk-[a-zA-Z0-9]{10,}|api[_-]?key\s*[:=]|data:image\/|BEGIN (RSA )?PRIVATE|systemPrompt|developerPrompt/i;

export type MarketContextTechnical = {
  timeframe: "1h";
  lastClose: number | null;
  sma20: number | null;
  sma75: number | null;
  sma200: number | null;
  rsi14: number | null;
  source: "mtf_1h" | "regime_1h";
};

/** Independent of AI analysisSnapshot. No provider/model fields. */
export type MarketContextSnapshot = {
  version: typeof MARKET_CONTEXT_SNAPSHOT_VERSION;
  capturedAt: string;
  pair: TradePair;
  /** Live market rate at capture. Never used as entry price. */
  marketRate: number | null;
  multiTimeframe: MultiTimeframeAnalysis | null;
  marketRegime: MarketRegimeAnalysis | null;
  /** Projection from multiTimeframe 1h or regime evidence. Same capture pass — not recomputed later from live data. */
  technicalContext: MarketContextTechnical | null;
};

export type CaptureMarketContextInput = {
  pair: string;
  capturedAt: string;
  market?: MarketData | null;
  /** Optional explicit rate (e.g. dashboard quote). Must not invent values. */
  marketRate?: number | null;
};

function frame1h(mtf: MultiTimeframeAnalysis | null): TimeframeAnalysis | null {
  return mtf?.timeframes.find(frame => frame.timeframe === "1h") ?? null;
}

/** Derive technical projection from already-sanitized MTF/Regime (no new indicator math). */
export function deriveTechnicalContext(
  mtf: MultiTimeframeAnalysis | null,
  regime: MarketRegimeAnalysis | null,
): MarketContextTechnical | null {
  const frame = frame1h(mtf);
  if (frame && frame.sufficientData && finiteNumber(frame.lastClose)) {
    return {
      timeframe: "1h",
      lastClose: frame.lastClose,
      sma20: finiteNumber(frame.sma20) ? frame.sma20 : null,
      sma75: finiteNumber(frame.sma75) ? frame.sma75 : null,
      sma200: finiteNumber(frame.sma200) ? frame.sma200 : null,
      rsi14: finiteNumber(frame.rsi14) ? frame.rsi14 : null,
      source: "mtf_1h",
    };
  }
  if (regime && finiteNumber(regime.evidence.close)) {
    const e = regime.evidence;
    return {
      timeframe: "1h",
      lastClose: e.close,
      sma20: finiteNumber(e.sma20) ? e.sma20 : null,
      sma75: finiteNumber(e.sma75) ? e.sma75 : null,
      sma200: finiteNumber(e.sma200) ? e.sma200 : null,
      rsi14: finiteNumber(e.rsi14) ? e.rsi14 : null,
      source: "regime_1h",
    };
  }
  return null;
}

function sanitizeTechnical(raw: unknown): MarketContextTechnical | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (value.timeframe !== "1h") return null;
  if (value.source !== "mtf_1h" && value.source !== "regime_1h") return null;
  const lastClose = NUM(value.lastClose);
  return {
    timeframe: "1h",
    lastClose,
    sma20: NUM(value.sma20),
    sma75: NUM(value.sma75),
    sma200: NUM(value.sma200),
    rsi14: typeof value.rsi14 === "number" && Number.isFinite(value.rsi14) && value.rsi14 >= 0 && value.rsi14 <= 100
      ? value.rsi14
      : null,
    source: value.source,
  };
}

/**
 * Capture market context at trade registration.
 * AI-independent. Pair mismatch with market → null (do not save wrong pair).
 * Does not call AI or start background refresh loops.
 */
export function captureMarketContextSnapshot(input: CaptureMarketContextInput): MarketContextSnapshot | null {
  const capturedAt = ISO(input.capturedAt);
  if (!capturedAt || !pairs.includes(input.pair as TradePair)) return null;
  const pair = input.pair as TradePair;
  const market = input.market ?? null;
  if (market && market.symbol !== pair) return null;

  const analyzedAt = ISO(market?.price.fetchedAt)
    ?? ISO(market?.daily?.fetchedAt)
    ?? ISO(market?.timeframes["1h"]?.fetchedAt)
    ?? capturedAt;

  const multiTimeframe = market
    ? sanitizeMultiTimeframeAnalysis(multiTimeframeForPair(market, pair as MarketSymbol, analyzedAt), pair as MarketSymbol)
    : null;
  const marketRegime = market
    ? sanitizeMarketRegimeAnalysis(marketRegimeForPair(market, pair as MarketSymbol, analyzedAt), pair as MarketSymbol)
    : null;

  const rateFromMarket = market && !market.price.stale ? NUM(market.price.data) : null;
  const rateFromOption = NUM(input.marketRate ?? null);
  const marketRate = rateFromOption ?? rateFromMarket;

  const snapshot: MarketContextSnapshot = {
    version: MARKET_CONTEXT_SNAPSHOT_VERSION,
    capturedAt,
    pair,
    marketRate,
    multiTimeframe,
    marketRegime,
    technicalContext: deriveTechnicalContext(multiTimeframe, marketRegime),
  };
  return sanitizeMarketContextSnapshot(snapshot, pair);
}

/** Re-validate before persistence. Malformed → null (trade still saves). */
export function sanitizeMarketContextSnapshot(raw: unknown, expectedPair?: string): MarketContextSnapshot | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (value.version !== MARKET_CONTEXT_SNAPSHOT_VERSION) return null;
  if (!pairs.includes(value.pair as TradePair)) return null;
  const pair = value.pair as TradePair;
  if (expectedPair && pair !== expectedPair) return null;
  const capturedAt = ISO(value.capturedAt);
  if (!capturedAt) return null;
  if ("aiStatus" in value || "model" in value || "provider" in value || "analysis" in value) return null;
  if ("candles" in value || "values" in value) return null;
  const multiTimeframe = sanitizeMultiTimeframeAnalysis(value.multiTimeframe, pair as MarketSymbol);
  const marketRegime = sanitizeMarketRegimeAnalysis(value.marketRegime, pair as MarketSymbol);
  let technicalContext = sanitizeTechnical(value.technicalContext);
  if (!technicalContext) technicalContext = deriveTechnicalContext(multiTimeframe, marketRegime);
  const snapshot: MarketContextSnapshot = {
    version: 1,
    capturedAt,
    pair,
    marketRate: NUM(value.marketRate),
    multiTimeframe,
    marketRegime,
    technicalContext,
  };
  if (SECRET.test(JSON.stringify({
    version: snapshot.version,
    capturedAt: snapshot.capturedAt,
    pair: snapshot.pair,
    marketRate: snapshot.marketRate,
    technicalContext: snapshot.technicalContext,
  }))) return null;
  return snapshot;
}

export function marketContextFromTrade(trade: Trade): MarketContextSnapshot | null {
  const ctx = sanitizeMarketContextSnapshot(trade.marketContextSnapshot);
  if (!ctx) return null;
  // After pair edit, registration context stays on the original pair — do not apply to a different trade.pair.
  if (ctx.pair !== trade.pair) return null;
  return ctx;
}

export type MarketContextFieldState = "saved" | "unavailable" | "legacy";

export function marketContextFieldStates(trade: Trade): {
  snapshot: MarketContextFieldState;
  mtf: MarketContextFieldState;
  regime: MarketContextFieldState;
  technical: MarketContextFieldState;
  marketRate: MarketContextFieldState;
} {
  const ctx = marketContextFromTrade(trade);
  if (!ctx) {
    return { snapshot: "legacy", mtf: "legacy", regime: "legacy", technical: "legacy", marketRate: "legacy" };
  }
  return {
    snapshot: "saved",
    mtf: ctx.multiTimeframe ? "saved" : "unavailable",
    regime: ctx.marketRegime ? "saved" : "unavailable",
    technical: ctx.technicalContext ? "saved" : "unavailable",
    marketRate: ctx.marketRate != null ? "saved" : "unavailable",
  };
}
