import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { atr14Series, calculateIndicators } from "../lib/market/indicators";
import {
  REGIME_ATR_BASELINE_LEN,
  REGIME_DURATION_MS,
  REGIME_LABEL,
  REGIME_MIN_CANDLES,
  REGIME_RANGE_POSITION_MAX,
  REGIME_RANGE_POSITION_MIN,
  REGIME_RANGE_SMA_SPREAD_PERCENT,
  REGIME_REASON_CAP,
  REGIME_TIMEFRAME,
  REGIME_TRENDING_SMA_SPREAD_PERCENT,
  REGIME_TREND_LABEL,
  REGIME_UNAVAILABLE_MESSAGE,
  REGIME_VOL_HIGH_RATIO,
  REGIME_VOL_LOW_RATIO,
  VOLATILITY_LABEL,
  analyzeMarketRegime,
  atrPercent,
  classifyVolatility,
  confirmedHourCandles,
  marketRegimeForPair,
  medianPositive,
  rangePosition,
  regimeEvidencePayload,
  sanitizeMarketRegimeAnalysis,
  smaSpreadPercent,
  type MarketRegimeAnalysis,
} from "../lib/market/market-regime";
import { canonicalCandles } from "../lib/market/multi-timeframe";
import { buildInput } from "../lib/ai/input";
import { finalizeAnalysis } from "../lib/ai/engine";
import { createAnalysisService } from "../lib/ai/service";
import { systemPrompt } from "../lib/ai/openai";
import { READINESS_FIXED_TOTAL } from "../lib/trading-plan/entry-readiness";
import { STATUS_PRIORITY } from "../lib/trading-plan/daily-plan";
import { MARKET_DASHBOARD_REFRESH_MS, type Candle, type MarketData, type Resource, type Symbol, type Technical } from "../lib/market/types";
import { factorCategories, type ModelInterpretation } from "../lib/ai/types";

const NOW = Date.parse("2026-09-16T08:00:00.000Z");
const iso = (at = NOW) => new Date(at).toISOString();
const HOUR = REGIME_DURATION_MS;
const ROOT = process.cwd();
const SOURCE = [
  readFileSync(join(ROOT, "lib/market/market-regime.ts"), "utf8"),
  readFileSync(join(ROOT, "components/dashboard/market-regime.tsx"), "utf8"),
].join("\n");
const FORBIDDEN = /チャンス|買い優勢|エントリー好機|おすすめ|Entry OK|買い相場|売り相場|強い買い/;
const ENGINE = readFileSync(join(ROOT, "lib/ai/engine.ts"), "utf8");
const CLIENT = readFileSync(join(ROOT, "lib/market/client.ts"), "utf8");

function resource<T>(data: T): Resource<T> {
  return { data, fetchedAt: iso(), error: null, stale: false };
}

function candle(time: string, close: number, pad = 0.08): Candle {
  return { time, open: close, high: close + pad, low: close - pad, close };
}

function series(count: number, opts: {
  direction?: 1 | -1 | 0;
  step?: number;
  pad?: number;
  highTail?: number;
  highPad?: number;
  lowHead?: number;
  headPad?: number;
  lastClose?: number;
  lastPad?: number;
  formingLast?: boolean;
} = {}): Candle[] {
  const direction = opts.direction ?? 1;
  const step = opts.step ?? 0.02;
  const pad = opts.pad ?? 0.08;
  return Array.from({ length: count }, (_, i) => {
    const last = count - 1;
    const close = direction === 0 ? 150 : 150 + (i - last) * step * direction;
    let width = pad;
    if (opts.highTail && i >= count - opts.highTail) width = opts.highPad ?? 12;
    if (opts.lowHead && i < opts.lowHead) width = opts.headPad ?? 8;
    if (opts.formingLast && i === last) return candle(iso(NOW - 30 * 60_000), opts.lastClose ?? close, opts.lastPad ?? width);
    const row = candle(iso(NOW - (count - i) * HOUR), opts.lastClose != null && i === last ? opts.lastClose : close, opts.lastPad != null && i === last ? opts.lastPad : width);
    return row;
  });
}

function analyze(candles: Candle[], pair: Symbol = "USD/JPY", at = iso()): MarketRegimeAnalysis {
  return analyzeMarketRegime({ pair, candles, analyzedAt: at });
}

function tech(direction: 1 | -1 | 0, durationMs: number, count = 240): Resource<Technical> {
  const rows = Array.from({ length: count }, (_, i) => {
    const close = direction === 0 ? 150 : 150 + (i - (count - 1)) * 0.01 * direction;
    return candle(iso(NOW - (count - i) * durationMs), close, 0.05);
  });
  return resource({ candles: rows, indicators: calculateIndicators(rows), lastClosedAt: rows.at(-1)!.time });
}

function marketFrom(pair: Symbol, hour: Candle[], extra?: Partial<MarketData>): MarketData {
  return {
    symbol: pair,
    price: resource(150),
    timeframes: {
      "15m": tech(1, 900_000),
      "1h": resource({ candles: hour, indicators: calculateIndicators(hour), lastClosedAt: hour.at(-1)?.time ?? null }),
      "4h": tech(1, 14_400_000),
    },
    daily: tech(1, 86_400_000),
    ...extra,
  };
}

function interpretation(input: ReturnType<typeof buildInput>, preferWait = true): ModelInterpretation {
  return {
    summary: "TEST",
    confidence: 90,
    contradictions: false,
    preferWait,
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
}

test("A 200未満 unavailable", () => {
  const result = analyze(series(199));
  assert.equal(result.regime, "unavailable");
  assert.equal(result.trendDirection, "unavailable");
  assert.equal(result.volatility, "unavailable");
  assert.equal(result.evidence.dataPoints, 199);
  assert.equal(result.reasons[0], REGIME_UNAVAILABLE_MESSAGE);
});

test("B exactly minimum", () => {
  const result = analyze(series(REGIME_MIN_CANDLES));
  assert.notEqual(result.regime, "unavailable");
  assert.notEqual(result.trendDirection, "unavailable");
  assert.equal(result.evidence.dataPoints, 200);
});

test("C bullish trend", () => {
  const result = analyze(series(220, { direction: 1 }));
  assert.equal(result.trendDirection, "bullish");
});

test("D bearish trend", () => {
  const result = analyze(series(220, { direction: -1 }));
  assert.equal(result.trendDirection, "bearish");
});

test("E neutral trend", () => {
  const result = analyze(series(220, { direction: 0, pad: 0.12 }));
  assert.equal(result.trendDirection, "neutral");
});

test("F trending bullish", () => {
  const result = analyze(series(220, { direction: 1 }));
  assert.equal(result.regime, "trending");
  assert.equal(result.trendDirection, "bullish");
  assert.ok((result.evidence.smaSpreadPercent ?? 0) >= REGIME_TRENDING_SMA_SPREAD_PERCENT);
});

test("G trending bearish", () => {
  const result = analyze(series(220, { direction: -1 }));
  assert.equal(result.regime, "trending");
  assert.equal(result.trendDirection, "bearish");
});

test("H range", () => {
  const result = analyze(series(220, { direction: 0, pad: 0.12 }));
  assert.equal(result.regime, "range");
  assert.equal(result.trendDirection, "neutral");
  assert.ok((result.evidence.smaSpreadPercent ?? 1) <= REGIME_RANGE_SMA_SPREAD_PERCENT);
  const pos = result.evidence.rangePosition;
  assert.ok(pos !== null && pos >= REGIME_RANGE_POSITION_MIN && pos <= REGIME_RANGE_POSITION_MAX);
});

test("I transition", () => {
  const result = analyze(series(220, { direction: 1, step: 0.00002 }));
  assert.equal(result.trendDirection, "bullish");
  assert.ok((result.evidence.smaSpreadPercent ?? 1) < REGIME_TRENDING_SMA_SPREAD_PERCENT);
  assert.equal(result.regime, "transition");
});

test("J unavailable", () => {
  const result = analyze([]);
  assert.equal(result.regime, "unavailable");
  assert.equal(result.trendDirection, "unavailable");
  assert.equal(result.volatility, "unavailable");
});

test("K ATR percent", () => {
  assert.equal(atrPercent(0.315, 150), 0.21);
  const result = analyze(series(220));
  assert.ok(result.evidence.atrPercent !== null);
  assert.equal(result.evidence.atrPercent, atrPercent(result.evidence.atr14, result.evidence.close));
});

test("L invalid ATR percent", () => {
  assert.equal(atrPercent(null, 150), null);
  assert.equal(atrPercent(0.2, 0), null);
  assert.equal(atrPercent(0.2, -1), null);
  assert.equal(atrPercent(Number.NaN, 150), null);
});

test("M ATR baseline", () => {
  const result = analyze(series(220));
  assert.ok(result.evidence.atrBaseline !== null && result.evidence.atrBaseline > 0);
  assert.equal(REGIME_ATR_BASELINE_LEN, 100);
});

test("N high volatility", () => {
  const result = analyze(series(220, { direction: 1, highTail: 6, highPad: 12 }));
  assert.equal(result.volatility, "high");
  assert.ok((result.evidence.atrRatio ?? 0) >= REGIME_VOL_HIGH_RATIO);
  assert.equal(result.regime, "trending");
});

test("O normal volatility", () => {
  const result = analyze(series(220, { direction: 1 }));
  assert.equal(result.volatility, "normal");
});

test("P low volatility", () => {
  const result = analyze(series(220, { direction: -1, lowHead: 170, headPad: 8, pad: 0.04 }));
  assert.equal(result.volatility, "low");
  assert.ok((result.evidence.atrRatio ?? 1) <= REGIME_VOL_LOW_RATIO);
});

test("Q volatility unavailable", () => {
  const short = analyze(series(30, { direction: 1 }));
  assert.equal(short.volatility, "unavailable");
  const independent = analyze(series(220, { direction: 0, pad: 0 }));
  assert.notEqual(independent.trendDirection, "unavailable");
  assert.equal(independent.volatility, "unavailable");
});

test("R SMA spread percent", () => {
  assert.equal(Number(smaSpreadPercent(150.2, 150.1, 150, 150)?.toFixed(4)), 0.1333);
  const result = analyze(series(220, { direction: 1 }));
  assert.ok((result.evidence.smaSpreadPercent ?? 0) > 0);
});

test("S invalid SMA spread", () => {
  assert.equal(smaSpreadPercent(null, 1, 1, 150), null);
  assert.equal(smaSpreadPercent(1, 1, 1, 0), null);
  assert.equal(smaSpreadPercent(1, 1, 1, -5), null);
});

test("T range position", () => {
  assert.equal(rangePosition(150, 151, 149), 0.5);
});

test("U invalid range width", () => {
  assert.equal(rangePosition(150, 150, 150), null);
  assert.equal(rangePosition(150, 149, 151), null);
  assert.equal(rangePosition(null, 151, 149), null);
});

test("V edge 0.15", () => {
  assert.equal(rangePosition(0.15, 1, 0), 0.15);
  const rows = series(220, { direction: 0, pad: 0.12 });
  for (const row of rows.slice(-20)) {
    row.high = 167;
    row.low = 147;
  }
  const result = analyze(rows);
  assert.equal(result.evidence.rangePosition, 0.15);
  assert.equal(result.trendDirection, "neutral");
  assert.equal(result.regime, "range");
});

test("W edge 0.85", () => {
  assert.equal(rangePosition(0.85, 1, 0), 0.85);
  const rows = series(220, { direction: 0, pad: 0.12 });
  for (const row of rows.slice(-20)) {
    row.high = 153;
    row.low = 133;
  }
  const result = analyze(rows);
  assert.equal(result.evidence.rangePosition, 0.85);
  assert.equal(result.trendDirection, "neutral");
  assert.equal(result.regime, "range");
});

test("X confirmed candles only", () => {
  const confirmed = series(200);
  const withForming = [...confirmed, candle(iso(NOW - 30 * 60_000), 160, 0.08)];
  const result = analyze(withForming);
  assert.equal(result.evidence.dataPoints, 200);
  assert.equal(result.regime, "trending");
});

test("Y forming candle excluded", () => {
  const rows = series(200, { formingLast: true });
  assert.equal(confirmedHourCandles(canonicalCandles(rows)!, iso()).length, 199);
  const result = analyze(rows);
  assert.equal(result.regime, "unavailable");
  assert.equal(result.evidence.dataPoints, 199);
});

test("Z pair safety", () => {
  const market = marketFrom("EUR/JPY", series(220));
  assert.equal(marketRegimeForPair(market, "USD/JPY", iso()), null);
  const sanitized = sanitizeMarketRegimeAnalysis(analyze(series(220), "EUR/JPY"), "USD/JPY");
  assert.equal(sanitized, null);
});

test("AA reasons max4", () => {
  const result = analyze(series(220));
  assert.ok(result.reasons.length <= REGIME_REASON_CAP);
});

test("AB no recommendation words", () => {
  const result = analyze(series(220, { direction: 1, highTail: 6, highPad: 12 }));
  assert.doesNotMatch(result.reasons.join("\n"), FORBIDDEN);
  assert.doesNotMatch(SOURCE, FORBIDDEN);
  assert.equal(REGIME_LABEL.trending, "トレンド");
  assert.equal(REGIME_TREND_LABEL.bullish, "上向き");
  assert.equal(VOLATILITY_LABEL.high, "高い");
});

test("AC deterministic", () => {
  const candles = series(220);
  const a = analyze(candles);
  const b = analyze(candles);
  assert.deepEqual(a, b);
});

test("AD no mutation", () => {
  const candles = series(220);
  const snapshot = candles.map(row => ({ ...row }));
  const result = analyze(candles);
  candles[0]!.close = 1;
  candles.push(candle(iso(), 999));
  assert.deepEqual(analyze(snapshot), result);
  assert.equal(result.pair, "USD/JPY");
});

test("AE invalid candle fail-soft", () => {
  const rows = series(220);
  rows[10] = { ...rows[10]!, high: 1, low: 10, close: 5, open: 5 };
  assert.doesNotThrow(() => analyze(rows));
  const result = analyze(rows);
  assert.equal(result.regime, "unavailable");
});

test("AF MarketData integration", () => {
  const market = marketFrom("USD/JPY", series(220));
  assert.equal("marketRegimeAnalysis" in market, false);
  const live = marketRegimeForPair(market, "USD/JPY", iso());
  assert.equal(live?.timeframe, REGIME_TIMEFRAME);
  assert.equal(live?.regime, "trending");
});

test("AG AI evidence present", () => {
  const input = buildInput("USD/JPY", marketFrom("USD/JPY", series(220)), null, NOW);
  assert.ok(input.marketRegimeAnalysis);
  assert.ok(input.fundamentalData.some(item => item.id === "technical:regime"));
});

test("AH AI evidence absent", () => {
  const input = buildInput("USD/JPY", null, null, NOW);
  assert.equal(input.marketRegimeAnalysis, undefined);
  assert.equal(input.fundamentalData.some(item => item.id === "technical:regime"), false);
});

test("AI no raw candles in AI payload", () => {
  const input = buildInput("USD/JPY", marketFrom("USD/JPY", series(220)), null, NOW);
  const payload = JSON.stringify(input.fundamentalData.find(item => item.id === "technical:regime")?.data);
  assert.doesNotMatch(payload, /"candles"/);
  assert.doesNotMatch(JSON.stringify(regimeEvidencePayload(input.marketRegimeAnalysis!)), /"candles"/);
});

test("AJ no ATR series in AI payload", () => {
  const input = buildInput("USD/JPY", marketFrom("USD/JPY", series(220)), null, NOW);
  const payload = JSON.stringify(input.fundamentalData.find(item => item.id === "technical:regime")?.data);
  assert.doesNotMatch(payload, /atr14Series/);
});

test("AK no provider metadata", () => {
  const input = buildInput("USD/JPY", marketFrom("USD/JPY", series(220)), null, NOW);
  const payload = JSON.stringify(input.fundamentalData.find(item => item.id === "technical:regime")?.data);
  assert.doesNotMatch(payload, /apikey|apiKey|"code":429|provider raw/i);
});

test("AL existing Action WAIT remains WAIT", () => {
  const input = buildInput("USD/JPY", marketFrom("USD/JPY", series(220, { direction: 1, highTail: 6, highPad: 12 })), null, NOW);
  assert.equal(input.marketRegimeAnalysis?.regime, "trending");
  assert.equal(input.marketRegimeAnalysis?.trendDirection, "bullish");
  assert.equal(input.marketRegimeAnalysis?.volatility, "high");
  const result = finalizeAnalysis(input, interpretation(input, true), "test", null, NOW);
  assert.equal(result.action, "WAIT");
});

test("AM Readiness still 5", () => {
  assert.equal(READINESS_FIXED_TOTAL, 5);
  const readiness = readFileSync(join(ROOT, "lib/trading-plan/entry-readiness.ts"), "utf8");
  assert.doesNotMatch(readiness, /market-regime|marketRegimeAnalysis/);
  assert.match(readiness, /READINESS_FIXED_TOTAL = 5/);
});

test("AN Trigger unchanged", () => {
  const trigger = readFileSync(join(ROOT, "lib/ai/entry-trigger.ts"), "utf8");
  const watch = readFileSync(join(ROOT, "lib/trading-plan/entry-trigger-watch.ts"), "utf8");
  assert.doesNotMatch(trigger, /market-regime|marketRegimeAnalysis/);
  assert.doesNotMatch(watch, /market-regime|marketRegimeAnalysis/);
});

test("AO Daily Plan unchanged", () => {
  const plan = readFileSync(join(ROOT, "lib/trading-plan/daily-plan.ts"), "utf8");
  assert.doesNotMatch(plan, /market-regime|marketRegimeAnalysis/);
  assert.deepEqual(STATUS_PRIORITY, ["risk_limit", "stale", "unavailable", "wait", "review_buy", "review_sell"]);
});

test("AP economic WAIT unchanged", () => {
  const input = buildInput("USD/JPY", marketFrom("USD/JPY", series(220)), null, NOW);
  input.eventRisk.imminent = true;
  input.eventRisk.reasons = ["指標直前"];
  input.technicalAnalysis.ready = true;
  const result = finalizeAnalysis(input, interpretation(input, false), "test", null, NOW);
  assert.equal(result.action, "WAIT");
  assert.equal(input.marketRegimeAnalysis?.regime, "trending");
});

test("AQ no Twelve fetch", () => {
  assert.doesNotMatch(SOURCE, /twelvedata|fetch\(/);
  assert.match(CLIENT, /outputsize: "300"/);
  assert.match(CLIENT, /series\(symbol, "1h"\)/);
});

test("AR no extra OpenAI call", async () => {
  let calls = 0;
  const service = createAnalysisService({
    market: async () => marketFrom("USD/JPY", series(220)),
    fundamental: async () => { throw new Error("skip"); },
    interpret: async input => {
      calls++;
      assert.ok(input.marketRegimeAnalysis);
      return interpretation(input, true);
    },
    model: "test",
    enabled: true,
    now: () => NOW,
  });
  await service("USD/JPY");
  assert.equal(calls, 1);
});

test("AS no Supabase query", () => {
  assert.doesNotMatch(SOURCE, /supabase/i);
});

test("AT no polling", () => {
  const ui = readFileSync(join(ROOT, "components/dashboard/market-regime.tsx"), "utf8");
  assert.doesNotMatch(ui, /setInterval|setTimeout/);
  assert.equal(MARKET_DASHBOARD_REFRESH_MS, 60_000);
});

test("AU no migration", () => {
  assert.doesNotMatch(SOURCE, /migration|alter table|create table/i);
  assert.equal(existsSync(join(ROOT, "supabase/migrations")), true);
});

test("AV 390 UI", () => {
  const css = readFileSync(join(ROOT, "app/globals.css"), "utf8");
  assert.match(css, /\.regime-panel \{ min-width: 0; \}/);
  assert.match(css, /\.regime-reasons[\s\S]*overflow-wrap: anywhere/);
});

test("AW unavailable UI", () => {
  const ui = readFileSync(join(ROOT, "components/dashboard/market-regime.tsx"), "utf8");
  assert.match(ui, /REGIME_UNAVAILABLE_MESSAGE/);
  assert.equal(REGIME_UNAVAILABLE_MESSAGE, "相場環境を判定するための確定足データが不足しています");
});

test("AX trend UI", () => {
  const ui = readFileSync(join(ROOT, "components/dashboard/market-regime.tsx"), "utf8");
  assert.match(ui, /REGIME_LABEL/);
  assert.match(ui, /REGIME_TREND_LABEL/);
  assert.equal(REGIME_LABEL.trending, "トレンド");
});

test("AY range UI", () => {
  assert.equal(REGIME_LABEL.range, "レンジ");
});

test("AZ transition UI", () => {
  assert.equal(REGIME_LABEL.transition, "移行・不明瞭");
});

test("critical 1: trending bullish high vol keeps WAIT", () => {
  const input = buildInput("USD/JPY", marketFrom("USD/JPY", series(220, { direction: 1, highTail: 6, highPad: 12 })), null, NOW);
  assert.equal(input.marketRegimeAnalysis?.regime, "trending");
  assert.equal(input.marketRegimeAnalysis?.trendDirection, "bullish");
  assert.equal(input.marketRegimeAnalysis?.volatility, "high");
  const result = finalizeAnalysis(input, interpretation(input, true), "test", null, NOW);
  assert.equal(result.action, "WAIT");
  assert.equal(result.signal, "wait");
  assert.doesNotMatch(ENGINE, /marketRegimeAnalysis|analyzeMarketRegime/);
});

test("critical 2: range does not force WAIT mutation", () => {
  const withRange = buildInput("USD/JPY", marketFrom("USD/JPY", series(220, { direction: 0, pad: 0.12 })), null, NOW);
  const without = buildInput("USD/JPY", null, null, NOW);
  assert.equal(withRange.marketRegimeAnalysis?.regime, "range");
  const a = finalizeAnalysis(withRange, interpretation(withRange, true), "test", null, NOW);
  const b = finalizeAnalysis(without, interpretation(without, true), "test", null, NOW);
  assert.equal(a.action, "WAIT");
  assert.equal(a.action, b.action);
});

test("critical 3: 199 confirmed + 1 forming is unavailable", () => {
  const rows = series(200, { formingLast: true });
  const result = analyze(rows);
  assert.equal(confirmedHourCandles(canonicalCandles(rows)!, iso()).length, 199);
  assert.equal(result.regime, "unavailable");
});

test("critical 4: foreign pair regime hidden", () => {
  assert.equal(marketRegimeForPair(marketFrom("EUR/JPY", series(220)), "USD/JPY", iso()), null);
});

test("critical 5: same candles + analyzedAt deepEqual", () => {
  const candles = series(220);
  assert.deepEqual(analyze(candles), analyze(candles));
});

test("prompt treats regime as evidence not signal", () => {
  assert.match(systemPrompt, /marketRegimeAnalysis/);
  assert.match(systemPrompt, /TrendingはBUYではありません/);
  assert.match(systemPrompt, /Rangeは自動的にWAITではありません/);
});

test("volatility is independent of regime", () => {
  const highTrend = analyze(series(220, { direction: 1, highTail: 6, highPad: 12 }));
  const lowTrend = analyze(series(220, { direction: -1, lowHead: 170, headPad: 8, pad: 0.04 }));
  assert.equal(highTrend.regime, "trending");
  assert.equal(highTrend.volatility, "high");
  assert.equal(lowTrend.regime, "trending");
  assert.equal(lowTrend.volatility, "low");
});

test("no Date.now inside helper", () => {
  assert.doesNotMatch(readFileSync(join(ROOT, "lib/market/market-regime.ts"), "utf8"), /Date\.now/);
});

test("atr14Series matches calculateIndicators", () => {
  const rows = series(80);
  const indicators = calculateIndicators(rows);
  assert.equal(indicators.atr14, atr14Series(rows).at(-1));
});

test("medianPositive ignores non-positive", () => {
  assert.equal(medianPositive([2, 0, -1, 4]), 3);
  assert.equal(medianPositive([1, 2, 3]), 2);
  assert.equal(medianPositive([]), null);
});

test("classifyVolatility thresholds", () => {
  assert.equal(classifyVolatility(1.3, 1), "high");
  assert.equal(classifyVolatility(0.75, 1), "low");
  assert.equal(classifyVolatility(1, 1), "normal");
  assert.equal(classifyVolatility(1, 0), "unavailable");
});

test("MTF snapshot helper and performance stay regime-free", () => {
  const mtfSnap = readFileSync(join(ROOT, "lib/trades/mtf-snapshot.ts"), "utf8");
  const perf = readFileSync(join(ROOT, "lib/trades/mtf-performance.ts"), "utf8");
  assert.doesNotMatch(mtfSnap, /marketRegimeAnalysis/);
  assert.doesNotMatch(perf, /marketRegimeAnalysis/);
});

test("sanitize rejects raw candles and series", () => {
  const raw = { ...analyze(series(220)), candles: series(3) };
  assert.equal(sanitizeMarketRegimeAnalysis(raw, "USD/JPY"), null);
  assert.equal(sanitizeMarketRegimeAnalysis({ ...analyze(series(220)), atr14Series: [1, 2] }, "USD/JPY"), null);
});
