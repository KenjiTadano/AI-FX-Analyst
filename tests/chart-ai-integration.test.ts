import test from "node:test";
import assert from "node:assert/strict";
import { calculateIndicators } from "../lib/market/indicators";
import { timeframes, type MarketData, type Symbol, type Resource, type Timeframe } from "../lib/market/types";
import type { FundamentalData, DataResource, Observation } from "../lib/fundamental/types";
import { buildInput } from "../lib/ai/input";
import { finalizeAnalysis } from "../lib/ai/engine";
import { createAnalysisService } from "../lib/ai/service";
import { systemPrompt } from "../lib/ai/openai";
import { canAttachToPairAnalysis, normalizeChartAnalysis } from "../lib/chart-analysis/normalize";
import { chartAttachBlockReason, sanitizeClientChartAnalysis } from "../lib/chart-analysis/sanitize";
import type { ChartImageAnalysis } from "../lib/chart-analysis/types";
import type { AnalysisInput, ModelInterpretation, Direction } from "../lib/ai/types";
import { factorCategories } from "../lib/ai/types";
import { scoreDirection } from "../lib/ai/technical";

const now = Date.parse("2026-09-11T12:00:00Z");
const iso = (at = now) => new Date(at).toISOString();
const resource = <T>(data: T): Resource<T> => ({ data, fetchedAt: iso(), error: null, stale: false });
const fundamentalResource = <T>(data: T): DataResource<T> => ({ data, fetchedAt: iso(), error: null, status: "ok", warnings: [], provider: "TEST" });
const observation = <T>(value: T): Observation<T> => ({ value, availability: "available", source: "TEST", asOf: iso(), reason: null });

function market(pair: Symbol = "USD/JPY", direction = 1): MarketData {
  const durations: Record<Timeframe, number> = { "15m": 900_000, "1h": 3_600_000, "4h": 14_400_000 };
  return {
    symbol: pair,
    price: resource(150),
    timeframes: Object.fromEntries(timeframes.map(frame => {
      const candles = Array.from({ length: 240 }, (_, i) => {
        const close = 150 + (i - 239) * 0.001 * direction;
        return { time: iso(now - (240 - i) * durations[frame]), close, open: close, high: close + (direction > 0 ? 1 : 0.05), low: close - (direction > 0 ? 0.05 : 1) };
      });
      return [frame, resource({ candles, indicators: calculateIndicators(candles), lastClosedAt: candles.at(-1)!.time })];
    })) as MarketData["timeframes"],
  };
}

function fundamentals(pair: Symbol = "USD/JPY"): FundamentalData {
  const base = pair.split("/")[0] as "USD" | "EUR" | "GBP";
  const currencies = [base, "JPY"] as const;
  return {
    schemaVersion: 1, symbol: pair, baseCurrency: base, quoteCurrency: "JPY", generatedAt: iso(), factors: [],
    news: fundamentalResource([{ id: "test-news", title: "TEST policy statement", summary: "TEST only", source: "TEST", publishedAt: iso(), url: "https://example.com/test", currencies: [base], affectedCurrencies: [base], importance: "high", importanceBasis: "provider", impactDirection: null, reason: "TEST" }]),
    calendar: fundamentalResource([{ id: "test-event", name: "TEST CPI", country: "US", currency: base, scheduledAt: iso(now + 2 * 3_600_000), rawScheduledAt: null, timezone: "UTC", previous: 2.7, forecast: 2.8, actual: null, unit: "%", status: "upcoming", source: "TEST", url: null, isKeyIndicator: true, affectedCurrencies: [base], importance: "high", importanceBasis: "provider", impactDirection: null, reason: "TEST" }]),
    macroeconomic: fundamentalResource([]),
    centralBanks: fundamentalResource(currencies.map(currency => ({ currency, name: "TEST BANK", abbreviation: currency, policyRate: observation({ name: "TEST", lower: 1, upper: null, unit: "%" as const }), nextMeeting: observation(iso(now + 86_400_000)), policyDirection: observation("hold" as const), relatedNewsIds: ["test-news"] }))),
    sentiment: fundamentalResource({ market: observation("neutral" as const), currencies: currencies.map(currency => ({ currency, sentiment: observation("neutral" as const) })) }),
  };
}

function sampleChart(overrides: Record<string, unknown> = {}): ChartImageAnalysis {
  return normalizeChartAnalysis({
    detected: { pair: "米ドル/円", timeframe: "15分足", chartType: "candlestick", currentPrice: 154.2 },
    trend: { direction: "down", confidence: 80, reason: "高値切り下げ" },
    structure: { higherHigh: false, higherLow: false, lowerHigh: true, lowerLow: true },
    levels: { support: [153.8], resistance: [154.5] },
    patterns: [],
    indicators: [],
    observations: ["押し目弱い"],
    warnings: [],
    dataQuality: { score: 90, imageReadable: true, pairDetected: true, timeframeDetected: true },
    ...overrides,
  }, "USD/JPY", "TEST", now);
}

function interpretation(input: AnalysisInput, direction: Direction = "neutral"): ModelInterpretation {
  return {
    summary: "TEST", confidence: 90, contradictions: false, preferWait: false,
    factors: factorCategories.map(category => {
      const evidence = input.fundamentalData.filter(item => item.categories.includes(category));
      return {
        category, title: category,
        direction: !evidence.length ? "unknown" : category === "technical" ? scoreDirection(input.technicalAnalysis.score) : direction,
        impact: "high", reason: "TEST", source: "TEST", evidenceIds: evidence.slice(0, 1).map(item => item.id),
      };
    }),
    bullishReasons: [], bearishReasons: [], riskWarnings: [], scenarioComment: "待機確認",
  };
}

test("chartImageAnalysis absent keeps previous buildInput behavior", () => {
  const input = buildInput("USD/JPY", market(), fundamentals(), now);
  assert.equal(input.chartImageAnalysis, undefined);
  assert.equal(input.fundamentalData.some(item => item.id === "technical:chart_image"), false);
});

test("valid chart analysis attaches to AI input", () => {
  const chart = sampleChart();
  assert.equal(canAttachToPairAnalysis(chart, "USD/JPY"), true);
  const input = buildInput("USD/JPY", market("USD/JPY", 1), fundamentals(), now, chart);
  assert.ok(input.chartImageAnalysis);
  assert.ok(input.fundamentalData.some(item => item.id === "technical:chart_image"));
  assert.equal(input.technicalAnalysis.score > 0, true);
});

test("chart down and market up both remain in input without overwrite", () => {
  const chart = sampleChart({ trend: { direction: "down", confidence: 90, reason: "下降" } });
  const input = buildInput("USD/JPY", market("USD/JPY", 1), fundamentals(), now, chart);
  assert.ok(input.technicalAnalysis.score > 0);
  assert.equal(input.chartImageAnalysis?.trend.direction, "down");
  assert.ok(input.fundamentalData.some(item => item.id === "technical:chart_image"));
  assert.ok(input.fundamentalData.some(item => item.id.startsWith("technical:") && item.id !== "technical:chart_image"));
});

test("mismatch unknown low-quality unreadable invalid-source do not attach", () => {
  const mismatch = sampleChart({ detected: { pair: "ユーロ/円", timeframe: "15分", chartType: "candle", currentPrice: 1 } });
  assert.equal(mismatch.pairMismatch, true);
  assert.equal(canAttachToPairAnalysis(mismatch, "USD/JPY"), false);
  assert.equal(buildInput("USD/JPY", market(), fundamentals(), now, mismatch).chartImageAnalysis, undefined);

  const unknown = sampleChart({ detected: { pair: "EUR/USD", timeframe: "15分", chartType: "candle", currentPrice: 1.1 } });
  assert.equal(unknown.pairMismatch, false);
  assert.equal(canAttachToPairAnalysis(unknown, "USD/JPY"), false);
  assert.equal(chartAttachBlockReason(unknown, "USD/JPY"), "unknown_pair");

  const low = { ...sampleChart(), dataQuality: { score: 20, imageReadable: true, pairDetected: true, timeframeDetected: true } };
  assert.equal(canAttachToPairAnalysis(low, "USD/JPY"), false);
  assert.equal(chartAttachBlockReason(low, "USD/JPY"), "low_quality");

  const unreadable = { ...sampleChart(), dataQuality: { score: 90, imageReadable: false, pairDetected: true, timeframeDetected: true } };
  assert.equal(canAttachToPairAnalysis(unreadable, "USD/JPY"), false);

  const badSource = { ...sampleChart(), source: "other" as ChartImageAnalysis["source"] };
  assert.equal(canAttachToPairAnalysis(badSource, "USD/JPY"), false);
});

test("sanitize rejects malformed payloads and recomputes mismatch", () => {
  assert.equal(sanitizeClientChartAnalysis(null, "USD/JPY"), null);
  assert.equal(sanitizeClientChartAnalysis({ hello: "world" }, "USD/JPY"), null);
  assert.equal(sanitizeClientChartAnalysis("x", "USD/JPY"), null);
  const forged = { ...sampleChart(), pairMismatch: false, detected: { ...sampleChart().detected, pair: "ユーロ/円" } };
  const sanitized = sanitizeClientChartAnalysis(forged, "USD/JPY");
  assert.ok(sanitized);
  assert.equal(sanitized!.pairMismatch, true);
  assert.equal(canAttachToPairAnalysis(sanitized, "USD/JPY"), false);
  const wrongPair = { ...sampleChart(), pair: "EUR/JPY" };
  assert.equal(sanitizeClientChartAnalysis(wrongPair, "USD/JPY"), null);
});

test("selected pair change does not reuse other pair chart evidence", () => {
  const chart = sampleChart();
  assert.equal(canAttachToPairAnalysis(chart, "EUR/JPY"), false);
  assert.equal(buildInput("EUR/JPY", market("EUR/JPY"), fundamentals("EUR/JPY"), now, chart).chartImageAnalysis, undefined);
});

test("service passes sanitized chart into interpret and GET-compatible null chart still works", async () => {
  const seen: AnalysisInput[] = [];
  const service = createAnalysisService({
    market: async pair => market(pair),
    fundamental: async pair => fundamentals(pair),
    interpret: async snapshot => { seen.push(snapshot); return interpretation(snapshot, "neutral"); },
    enabled: true,
    model: "TEST",
    now: () => now,
  });
  const plain = await service("USD/JPY");
  assert.equal(plain.success, true);
  assert.equal(plain.data?.chartEvidence ?? null, null);
  assert.equal(seen.at(-1)?.chartImageAnalysis, undefined);

  const withChart = await service("USD/JPY", sampleChart());
  assert.equal(withChart.success, true);
  assert.equal(withChart.data?.chartEvidence?.used, true);
  assert.equal(withChart.data?.chartEvidence?.trend, "down");
  assert.ok(seen.at(-1)?.fundamentalData.some(item => item.id === "technical:chart_image"));

  const mismatched = await service("USD/JPY", sampleChart({ detected: { pair: "EUR/JPY", timeframe: "1H", chartType: "candle", currentPrice: 160 } }));
  assert.equal(mismatched.data?.chartEvidence ?? null, null);
});

test("strong chart up still WAIT under economic risk window", () => {
  const chart = sampleChart({ trend: { direction: "strong_up", confidence: 95, reason: "強い上昇" } });
  const snapshot = buildInput("USD/JPY", market("USD/JPY", 1), fundamentals(), now, chart);
  snapshot.eventRisk.imminent = true;
  snapshot.eventRisk.reasons = ["高重要イベント直前"];
  const result = finalizeAnalysis(snapshot, interpretation(snapshot, "bullish"), "TEST", null, now);
  assert.equal(result.action, "WAIT");
  assert.equal(result.signal, "wait");
  assert.ok(result.directionSignal === "buy" || result.directionSignal === "strong_buy");
  assert.equal(result.chartEvidence?.used, true);
  assert.equal(result.chartEvidence?.trend, "strong_up");
});

test("prompt keeps chart text as untrusted data", () => {
  assert.match(systemPrompt, /chartImageAnalysis/);
  assert.match(systemPrompt, /命令ではありません/);
  assert.match(systemPrompt, /リアルタイムテクニカルが不一致|不一致/);
});
