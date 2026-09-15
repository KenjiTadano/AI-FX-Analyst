import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { calculateIndicators } from "../lib/market/indicators";
import {
  ALIGNMENT_LABEL,
  MTF_CONFLICT_CAP,
  MTF_MIN_CANDLES,
  TREND_LABEL,
  analyzeTimeframe,
  buildMultiTimeframeAnalysis,
  canonicalCandles,
  mtfEvidencePayload,
  multiTimeframeForPair,
  sanitizeMultiTimeframeAnalysis,
  type MultiTimeframeAnalysis,
  type TimeframeAnalysis,
} from "../lib/market/multi-timeframe";
import { buildInput } from "../lib/ai/input";
import { finalizeAnalysis } from "../lib/ai/engine";
import { createAnalysisService } from "../lib/ai/service";
import { systemPrompt } from "../lib/ai/openai";
import { calculateIndicators as calcAgain } from "../lib/market/indicators";
import type { Candle, MarketData, Resource, Technical, Symbol } from "../lib/market/types";
import { normalizeChartAnalysis } from "../lib/chart-analysis/normalize";
import { factorCategories, type ModelInterpretation } from "../lib/ai/types";
import { MARKET_DASHBOARD_REFRESH_MS, MARKET_SERIES_TTL_SECONDS, timeframes } from "../lib/market/types";

const NOW = Date.parse("2026-09-15T08:00:00.000Z");
const iso = (at = NOW) => new Date(at).toISOString();
const SOURCE = [
  readFileSync(join(process.cwd(), "lib/market/multi-timeframe.ts"), "utf8"),
  readFileSync(join(process.cwd(), "components/dashboard/multi-timeframe.tsx"), "utf8"),
].join("\n");
const CLIENT = readFileSync(join(process.cwd(), "lib/market/client.ts"), "utf8");
const SNAPSHOT = readFileSync(join(process.cwd(), "lib/trades/snapshot.ts"), "utf8");
const TYPES = readFileSync(join(process.cwd(), "lib/trades/types.ts"), "utf8");
const FORBIDDEN = /エントリー|チャンス|おすすめ|Entry OK|GO\b|goodEntry|badEntry/;

function resource<T>(data: T): Resource<T> {
  return { data, fetchedAt: iso(), error: null, stale: false };
}

function candles(count: number, direction: 1 | -1 | 0, durationMs: number, base = 150): Candle[] {
  return Array.from({ length: count }, (_, i) => {
    const close = direction === 0 ? base : base + (i - (count - 1)) * 0.01 * direction;
    return {
      time: iso(NOW - (count - i) * durationMs),
      open: close,
      high: close + 0.05,
      low: close - 0.05,
      close,
    };
  });
}

function tech(direction: 1 | -1 | 0, durationMs: number, count = 240): Resource<Technical> {
  const series = candles(count, direction, durationMs);
  return resource({ candles: series, indicators: calculateIndicators(series), lastClosedAt: series.at(-1)!.time });
}

function missing(): Resource<Technical> {
  return { data: null, fetchedAt: iso(), error: "unavailable", stale: false };
}

function marketFrom(pair: Symbol, dirs: { day: 1 | -1 | 0; h4: 1 | -1 | 0; h1: 1 | -1 | 0; m15: 1 | -1 | 0 }, extra?: Partial<MarketData>): MarketData {
  return {
    symbol: pair,
    price: resource(150),
    timeframes: {
      "15m": tech(dirs.m15, 900_000),
      "1h": tech(dirs.h1, 3_600_000),
      "4h": tech(dirs.h4, 14_400_000),
    },
    daily: tech(dirs.day, 86_400_000),
    ...extra,
  };
}

function mtf(dirs: { day: 1 | -1 | 0; h4: 1 | -1 | 0; h1: 1 | -1 | 0; m15: 1 | -1 | 0 }, pair: Symbol = "USD/JPY", extra: { daily?: Resource<Technical> | null; timeframes?: MarketData["timeframes"] } = {}) {
  const m = marketFrom(pair, dirs);
  return buildMultiTimeframeAnalysis({
    pair,
    analyzedAt: iso(),
    daily: extra.daily === undefined ? m.daily : extra.daily,
    timeframes: extra.timeframes ?? m.timeframes,
  });
}

function frame(analysis: MultiTimeframeAnalysis, tf: TimeframeAnalysis["timeframe"]) {
  return analysis.timeframes.find(item => item.timeframe === tf)!;
}

test("A all bullish", () => {
  const analysis = mtf({ day: 1, h4: 1, h1: 1, m15: 1 });
  assert.equal(analysis.alignment, "aligned_bullish");
  assert.ok(analysis.timeframes.every(item => item.trend === "bullish"));
});

test("B all bearish", () => {
  const analysis = mtf({ day: -1, h4: -1, h1: -1, m15: -1 });
  assert.equal(analysis.alignment, "aligned_bearish");
});

test("C mixed", () => {
  const analysis = mtf({ day: 1, h4: 1, h1: -1, m15: -1 });
  assert.equal(analysis.alignment, "mixed");
  assert.equal(analysis.higherTimeframeBias, "bullish");
});

test("D neutral included => mixed", () => {
  const analysis = mtf({ day: 1, h4: 1, h1: 0, m15: 1 });
  assert.equal(frame(analysis, "1h").trend, "neutral");
  assert.equal(analysis.alignment, "mixed");
});

test("E one unavailable => insufficient", () => {
  const analysis = mtf({ day: 1, h4: 1, h1: 1, m15: 1 }, "USD/JPY", {
    timeframes: { ...marketFrom("USD/JPY", { day: 1, h4: 1, h1: 1, m15: 1 }).timeframes, "15m": missing() },
  });
  assert.equal(frame(analysis, "15m").trend, "unavailable");
  assert.equal(analysis.alignment, "insufficient");
});

test("F all unavailable", () => {
  const analysis = buildMultiTimeframeAnalysis({ pair: "USD/JPY", analyzedAt: iso() });
  assert.equal(analysis.availableTimeframes, 0);
  assert.equal(analysis.alignment, "insufficient");
});

test("G higher TF bullish", () => {
  assert.equal(mtf({ day: 1, h4: 1, h1: -1, m15: -1 }).higherTimeframeBias, "bullish");
});

test("H higher TF bearish", () => {
  assert.equal(mtf({ day: -1, h4: -1, h1: 1, m15: 1 }).higherTimeframeBias, "bearish");
});

test("I higher TF disagreement", () => {
  assert.equal(mtf({ day: 1, h4: -1, h1: 1, m15: 1 }).higherTimeframeBias, "neutral");
});

test("J higher TF missing", () => {
  const analysis = mtf({ day: 1, h4: 1, h1: 1, m15: 1 }, "USD/JPY", { daily: missing() });
  assert.equal(analysis.higherTimeframeBias, "unavailable");
});

test("K 1D missing", () => {
  const analysis = mtf({ day: 1, h4: 1, h1: 1, m15: 1 }, "USD/JPY", { daily: null });
  assert.equal(frame(analysis, "1day").trend, "unavailable");
  assert.equal(analysis.higherTimeframeBias, "unavailable");
});

test("L 4H missing", () => {
  const base = marketFrom("USD/JPY", { day: 1, h4: 1, h1: 1, m15: 1 });
  const analysis = mtf({ day: 1, h4: 1, h1: 1, m15: 1 }, "USD/JPY", {
    timeframes: { ...base.timeframes, "4h": missing() },
  });
  assert.equal(frame(analysis, "4h").trend, "unavailable");
  assert.equal(analysis.higherTimeframeBias, "unavailable");
});

test("M partial 3/4", () => {
  const base = marketFrom("USD/JPY", { day: 1, h4: 1, h1: 1, m15: 1 });
  const analysis = mtf({ day: 1, h4: 1, h1: 1, m15: 1 }, "USD/JPY", {
    timeframes: { ...base.timeframes, "15m": missing() },
  });
  assert.equal(analysis.availableTimeframes, 3);
  assert.equal(analysis.totalTimeframes, 4);
  assert.equal(analysis.alignment, "insufficient");
});

test("N minimum candle count", () => {
  const series = candles(MTF_MIN_CANDLES, 1, 86_400_000);
  const analysis = analyzeTimeframe("1day", resource({ candles: series, indicators: calculateIndicators(series), lastClosedAt: series.at(-1)!.time }));
  assert.equal(analysis.sufficientData, true);
  assert.equal(analysis.trend, "bullish");
});

test("O insufficient candles", () => {
  const series = candles(20, 1, 86_400_000);
  const analysis = analyzeTimeframe("1day", resource({ candles: series, indicators: calculateIndicators(series), lastClosedAt: series.at(-1)!.time }));
  assert.equal(analysis.sufficientData, false);
  assert.equal(analysis.trend, "unavailable");
});

test("P invalid NaN", () => {
  const series = candles(240, 1, 900_000);
  series[10]!.close = Number.NaN;
  assert.equal(analyzeTimeframe("15m", resource({ candles: series, indicators: calculateIndicators(candles(240, 1, 900_000)), lastClosedAt: iso() })).trend, "unavailable");
});

test("Q Infinity", () => {
  const series = candles(240, 1, 900_000);
  series[10]!.high = Number.POSITIVE_INFINITY;
  assert.equal(analyzeTimeframe("15m", tech(1, 900_000)).trend, "bullish");
  assert.equal(analyzeTimeframe("15m", resource({ candles: series, indicators: calculateIndicators(candles(240, 1, 900_000)), lastClosedAt: iso() })).trend, "unavailable");
});

test("R empty candles", () => {
  assert.equal(analyzeTimeframe("1h", resource({ candles: [], indicators: calculateIndicators([]), lastClosedAt: null })).trend, "unavailable");
});

test("S chronological input", () => {
  const series = candles(240, 1, 3_600_000);
  assert.ok(Date.parse(series[0]!.time) < Date.parse(series.at(-1)!.time));
  assert.equal(analyzeTimeframe("1h", tech(1, 3_600_000)).trend, "bullish");
});

test("T reverse-order input normalization", () => {
  const series = candles(240, 1, 3_600_000);
  const reversed = [...series].reverse();
  const normalized = canonicalCandles(reversed)!;
  assert.ok(Date.parse(normalized[0]!.time) < Date.parse(normalized.at(-1)!.time));
  assert.equal(analyzeTimeframe("1h", resource({ candles: reversed, indicators: calculateIndicators(series), lastClosedAt: series.at(-1)!.time })).trend, "bullish");
});

test("U duplicate timestamp behavior", () => {
  const series = candles(240, 1, 3_600_000);
  const dup = [...series, { ...series.at(-1)!, close: series.at(-1)!.close + 5, high: series.at(-1)!.close + 5.05 }];
  const normalized = canonicalCandles(dup)!;
  assert.equal(normalized.filter(item => item.time === series.at(-1)!.time).length, 1);
  assert.equal(normalized.at(-1)!.close, series.at(-1)!.close + 5);
});

test("V EMA reuse", () => {
  assert.doesNotMatch(SOURCE, /ema20|function ema/i);
  assert.match(SOURCE, /calculateIndicators/);
  assert.equal(calcAgain, calculateIndicators);
});

test("W RSI reuse if used", () => {
  assert.match(SOURCE, /rsi14/);
  const analysis = analyzeTimeframe("1h", tech(1, 3_600_000));
  assert.equal(analysis.rsi14, calculateIndicators(candles(240, 1, 3_600_000)).rsi14);
});

test("X recent high", () => {
  const analysis = analyzeTimeframe("1h", tech(1, 3_600_000));
  assert.ok(analysis.recentHigh !== null && analysis.recentHigh >= analysis.lastClose!);
});

test("Y recent low", () => {
  const analysis = analyzeTimeframe("1h", tech(1, 3_600_000));
  assert.ok(analysis.recentLow !== null && analysis.recentLow <= analysis.lastClose!);
});

test("Z no mutation", () => {
  const series = candles(240, 1, 3_600_000);
  const snapshot = JSON.stringify(series);
  analyzeTimeframe("1h", resource({ candles: series, indicators: calculateIndicators(series), lastClosedAt: series.at(-1)!.time }));
  assert.equal(JSON.stringify(series), snapshot);
});

test("AA deterministic", () => {
  const a = mtf({ day: 1, h4: 1, h1: -1, m15: -1 });
  const b = mtf({ day: 1, h4: 1, h1: -1, m15: -1 });
  assert.deepEqual(a.timeframes.map(item => item.trend), b.timeframes.map(item => item.trend));
  assert.equal(a.alignment, b.alignment);
});

test("AB pair USDJPY", () => {
  assert.equal(mtf({ day: 1, h4: 1, h1: 1, m15: 1 }, "USD/JPY").pair, "USD/JPY");
});

test("AC EURJPY", () => {
  assert.equal(mtf({ day: 1, h4: 1, h1: 1, m15: 1 }, "EUR/JPY").pair, "EUR/JPY");
});

test("AD GBPJPY", () => {
  assert.equal(mtf({ day: 1, h4: 1, h1: 1, m15: 1 }, "GBP/JPY").pair, "GBP/JPY");
});

test("AE pair mismatch", () => {
  assert.equal(multiTimeframeForPair(marketFrom("USD/JPY", { day: 1, h4: 1, h1: 1, m15: 1 }), "EUR/JPY"), null);
});

test("AF conflict bullish HTF vs bearish 1H", () => {
  const analysis = mtf({ day: 1, h4: 1, h1: -1, m15: 1 });
  assert.ok(analysis.conflicts.some(item => item.message.includes("1時間足") && item.message.includes("下向き")));
});

test("AG conflict bearish HTF vs bullish 15m", () => {
  const analysis = mtf({ day: -1, h4: -1, h1: -1, m15: 1 });
  assert.ok(analysis.conflicts.some(item => item.message.includes("15分足") && item.message.includes("上向き")));
});

test("AH conflict cap", () => {
  const analysis = mtf({ day: 1, h4: -1, h1: -1, m15: 1 });
  assert.ok(analysis.conflicts.length <= MTF_CONFLICT_CAP);
});

test("AI no recommendation wording", () => {
  assert.doesNotMatch(SOURCE, FORBIDDEN);
  assert.doesNotMatch(JSON.stringify(mtf({ day: 1, h4: 1, h1: 1, m15: 1 })), FORBIDDEN);
});

test("AJ no BUY/SELL Action generated", () => {
  const analysis = mtf({ day: 1, h4: 1, h1: 1, m15: 1 }) as MultiTimeframeAnalysis & { action?: string };
  assert.equal(analysis.action, undefined);
  assert.doesNotMatch(JSON.stringify(analysis), /"action"/);
});

test("AK unavailable not neutral", () => {
  const analysis = analyzeTimeframe("1day", missing());
  assert.equal(analysis.trend, "unavailable");
  assert.notEqual(analysis.trend, "neutral");
});

test("AL alignment exact 4/4", () => {
  assert.equal(mtf({ day: 1, h4: 1, h1: 1, m15: 1 }).alignment, "aligned_bullish");
});

test("AM 3/4 not aligned", () => {
  const base = marketFrom("USD/JPY", { day: 1, h4: 1, h1: 1, m15: 1 });
  const analysis = mtf({ day: 1, h4: 1, h1: 1, m15: 1 }, "USD/JPY", {
    timeframes: { ...base.timeframes, "15m": missing() },
  });
  assert.notEqual(analysis.alignment, "aligned_bullish");
  assert.equal(analysis.alignment, "insufficient");
});

test("AN raw candles excluded from AI payload", () => {
  const payload = mtfEvidencePayload(mtf({ day: 1, h4: 1, h1: 1, m15: 1 }));
  assert.doesNotMatch(JSON.stringify(payload), /"candles"/);
  const input = buildInput("USD/JPY", marketFrom("USD/JPY", { day: 1, h4: 1, h1: 1, m15: 1 }), null, NOW);
  assert.doesNotMatch(JSON.stringify(input), /"candles"/);
});

test("AO sanitizer valid", () => {
  const raw = mtf({ day: 1, h4: 1, h1: 1, m15: 1 });
  const sanitized = sanitizeMultiTimeframeAnalysis(raw, "USD/JPY");
  assert.equal(sanitized?.alignment, "aligned_bullish");
});

test("AP sanitizer invalid pair", () => {
  const raw = { ...mtf({ day: 1, h4: 1, h1: 1, m15: 1 }), pair: "EUR/USD" };
  assert.equal(sanitizeMultiTimeframeAnalysis(raw), null);
});

test("AQ sanitizer invalid trend", () => {
  const raw = mtf({ day: 1, h4: 1, h1: 1, m15: 1 });
  (raw.timeframes[0] as { trend: string }).trend = "BUY";
  const sanitized = sanitizeMultiTimeframeAnalysis(raw, "USD/JPY")!;
  assert.equal(sanitized.timeframes[0]!.trend, "unavailable");
  assert.doesNotMatch(JSON.stringify(sanitized), /"BUY"/);
});

test("AR sanitizer invalid structure", () => {
  const raw = mtf({ day: 1, h4: 1, h1: 1, m15: 1 });
  (raw.timeframes[0] as { structure: string }).structure = "Order Block";
  const sanitized = sanitizeMultiTimeframeAnalysis(raw, "USD/JPY")!;
  assert.doesNotMatch(JSON.stringify(sanitized), /Order Block/);
});

test("AS conflict truncation", () => {
  const raw = mtf({ day: 1, h4: 1, h1: -1, m15: -1 });
  raw.conflicts = [
    { id: "a", message: "x".repeat(400) },
    { id: "b", message: "y".repeat(400) },
    { id: "c", message: "z".repeat(400) },
    { id: "d", message: "w".repeat(400) },
  ];
  const sanitized = sanitizeMultiTimeframeAnalysis(raw, "USD/JPY")!;
  assert.equal(sanitized.conflicts.length, MTF_CONFLICT_CAP);
  assert.ok(sanitized.conflicts.every(item => item.message.length <= 120));
});

test("AT optional AI evidence", () => {
  const without = buildInput("USD/JPY", null, null, NOW);
  assert.equal(without.multiTimeframeAnalysis, undefined);
  const withMtf = buildInput("USD/JPY", marketFrom("USD/JPY", { day: 1, h4: 1, h1: 1, m15: 1 }), null, NOW);
  assert.ok(withMtf.multiTimeframeAnalysis);
  assert.ok(withMtf.fundamentalData.some(item => item.id === "technical:mtf"));
});

test("AU AI without MTF works", () => {
  const input = buildInput("USD/JPY", null, null, NOW);
  const result = finalizeAnalysis(input, null, "test", "insufficient_data", NOW);
  assert.equal(result.action, "WAIT");
  assert.equal(result.pair, "USD/JPY");
});

test("AV chart + MTF coexist", () => {
  const chart = normalizeChartAnalysis({
    detected: { pair: "米ドル/円", timeframe: "4時間足", chartType: "candlestick", currentPrice: 154.2 },
    trend: { direction: "down", confidence: 80, reason: "高値切り下げ" },
    structure: { higherHigh: false, higherLow: false, lowerHigh: true, lowerLow: true },
    levels: { support: [153.8], resistance: [154.5] },
    patterns: [],
    indicators: [],
    observations: ["押し目弱い"],
    warnings: [],
    dataQuality: { score: 90, imageReadable: true, pairDetected: true, timeframeDetected: true },
  }, "USD/JPY", "TEST", NOW)!;
  const input = buildInput("USD/JPY", marketFrom("USD/JPY", { day: 1, h4: 1, h1: 1, m15: 1 }), null, NOW, chart);
  assert.ok(input.chartImageAnalysis);
  assert.ok(input.multiTimeframeAnalysis);
  assert.ok(input.fundamentalData.some(item => item.id === "technical:chart_image"));
  assert.ok(input.fundamentalData.some(item => item.id === "technical:mtf"));
});

test("AW chart mismatch does not become MTF", () => {
  const base = marketFrom("USD/JPY", { day: 1, h4: 1, h1: 1, m15: 1 });
  const input = buildInput("USD/JPY", { ...base, timeframes: { ...base.timeframes, "4h": missing() } }, null, NOW, normalizeChartAnalysis({
    detected: { pair: "米ドル/円", timeframe: "4H", chartType: "candlestick", currentPrice: 154 },
    trend: { direction: "down", confidence: 80, reason: "x" },
    structure: { higherHigh: false, higherLow: false, lowerHigh: true, lowerLow: true },
    levels: { support: [], resistance: [] },
    patterns: [],
    indicators: [],
    observations: [],
    warnings: [],
    dataQuality: { score: 90, imageReadable: true, pairDetected: true, timeframeDetected: true },
  }, "USD/JPY", "TEST", NOW));
  assert.equal(input.multiTimeframeAnalysis?.timeframes.find(item => item.timeframe === "4h")?.trend, "unavailable");
});

test("AX economic override preserved", () => {
  const input = buildInput("USD/JPY", marketFrom("USD/JPY", { day: 1, h4: 1, h1: 1, m15: 1 }), null, NOW);
  input.eventRisk.imminent = true;
  input.eventRisk.reasons = ["指標直前"];
  input.technicalAnalysis.ready = true;
  input.technicalAnalysis.score = 80;
  const interpretation: ModelInterpretation = {
    summary: "TEST",
    confidence: 90,
    contradictions: false,
    preferWait: false,
    factors: factorCategories.map(category => ({
      category,
      title: category,
      direction: category === "technical" ? "bullish" : "unknown",
      impact: "low",
      reason: "TEST",
      source: "TEST",
      evidenceIds: input.fundamentalData.filter(item => item.categories.includes(category)).slice(0, 1).map(item => item.id),
    })),
    bullishReasons: [],
    bearishReasons: [],
    riskWarnings: [],
    scenarioComment: "条件を確認します。",
    entryTrigger: null,
  };
  const result = finalizeAnalysis(input, interpretation, "test", null, NOW);
  assert.equal(result.action, "WAIT");
  assert.equal(input.multiTimeframeAnalysis?.alignment, "aligned_bullish");
});

test("AY no OpenAI extra call", async () => {
  let calls = 0;
  const service = createAnalysisService({
    market: async () => marketFrom("USD/JPY", { day: 1, h4: 1, h1: 1, m15: 1 }),
    fundamental: async () => { throw new Error("skip"); },
    interpret: async input => {
      calls++;
      return {
        summary: "TEST",
        confidence: 40,
        contradictions: false,
        preferWait: true,
        factors: factorCategories.map(category => ({
          category,
          title: category,
          direction: "unknown",
          impact: "low",
          reason: "TEST",
          source: "TEST",
          evidenceIds: input.fundamentalData.filter(item => item.categories.includes(category)).slice(0, 1).map(item => item.id),
        })),
        bullishReasons: [],
        bearishReasons: [],
        riskWarnings: [],
        scenarioComment: "条件を確認します。",
        entryTrigger: null,
      };
    },
    model: "test",
    enabled: true,
    now: () => NOW,
  });
  await service("USD/JPY");
  assert.equal(calls, 1);
});

test("AZ no Supabase", () => {
  assert.doesNotMatch(SOURCE, /supabase/i);
  assert.doesNotMatch(CLIENT, /supabase/i);
});

test("BA cache key pair+timeframe", () => {
  assert.match(CLIENT, /\$\{symbol\}:\$\{frame\}/);
  assert.match(CLIENT, /1day/);
  assert.match(CLIENT, /outputsize: "300"/);
});

test("BB cache hit / BC cache miss documented by existing market.mjs", () => {
  assert.match(CLIENT, /if \(prior && prior.expires > Date.now\(\)\)/);
  assert.equal(MARKET_SERIES_TTL_SECONDS, 300);
});

test("BD timeframe failure isolated", () => {
  const analysis = mtf({ day: 1, h4: 1, h1: 1, m15: 1 }, "USD/JPY", { daily: missing() });
  assert.equal(frame(analysis, "1h").trend, "bullish");
  assert.equal(frame(analysis, "1day").trend, "unavailable");
});

test("BE 429 isolated via resource catch", () => {
  assert.match(CLIENT, /code === 429/);
  assert.match(CLIENT, /Promise\.all/);
});

test("BF selected pair only", () => {
  assert.match(CLIENT, /getMarketData\(symbol: Symbol\)/);
  assert.doesNotMatch(CLIENT, /symbols\.map/);
});

test("BG no all-pair preload", () => {
  const dash = readFileSync(join(process.cwd(), "components/dashboard/dashboard.tsx"), "utf8");
  assert.match(dash, /useMarket\(selectedPair\)/);
  assert.doesNotMatch(dash, /USD\/JPY[\s\S]*EUR\/JPY[\s\S]*GBP\/JPY[\s\S]*getMarketData/);
});

test("BH no new polling", () => {
  const ui = readFileSync(join(process.cwd(), "components/dashboard/multi-timeframe.tsx"), "utf8");
  assert.doesNotMatch(ui, /setInterval|setTimeout/);
  assert.equal(MARKET_DASHBOARD_REFRESH_MS, 60_000);
});

test("BI request budget deterministic", () => {
  assert.match(CLIENT, /series\(symbol, "1day"\)/);
  assert.equal(timeframes.length, 3);
});

test("BJ no snapshot schema change", () => {
  assert.doesNotMatch(SNAPSHOT, /multiTimeframe|mtfTimeframe/);
  assert.doesNotMatch(TYPES, /multiTimeframeAnalysis/);
});

test("critical: HTF bullish lower bearish is mixed without Action", () => {
  const analysis = mtf({ day: 1, h4: 1, h1: -1, m15: -1 });
  assert.equal(analysis.higherTimeframeBias, "bullish");
  assert.equal(analysis.alignment, "mixed");
  assert.ok(analysis.conflicts.length >= 1);
  assert.equal("action" in analysis, false);
});

test("critical: 4/4 bullish is aligned without GO", () => {
  const analysis = mtf({ day: 1, h4: 1, h1: 1, m15: 1 });
  assert.equal(analysis.alignment, "aligned_bullish");
  assert.doesNotMatch(JSON.stringify(analysis), /Entry OK|GO|BUY recommendation/);
});

test("critical: missing 4H is not substituted", () => {
  const base = marketFrom("USD/JPY", { day: 1, h4: 1, h1: 1, m15: 1 });
  const analysis = mtf({ day: 1, h4: 1, h1: 1, m15: 1 }, "USD/JPY", {
    timeframes: { ...base.timeframes, "4h": missing() },
  });
  assert.equal(analysis.higherTimeframeBias, "unavailable");
  assert.equal(analysis.alignment, "insufficient");
  assert.equal(frame(analysis, "4h").trend, "unavailable");
  assert.equal(frame(analysis, "1h").trend, "bullish");
});

test("prompt treats MTF as evidence not override", () => {
  assert.match(systemPrompt, /multiTimeframeAnalysis/);
  assert.match(systemPrompt, /単独で売買判断を決定しません/);
  assert.doesNotMatch(ALIGNMENT_LABEL.aligned_bullish, /買い/);
  assert.equal(TREND_LABEL.bullish, "上向き");
});
