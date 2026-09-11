import test from "node:test";
import assert from "node:assert/strict";
import { calculateIndicators } from "../lib/market/indicators";
import { timeframes, type MarketData, type Symbol, type Resource, type Timeframe } from "../lib/market/types";
import type { FundamentalData, DataResource, Observation } from "../lib/fundamental/types";
import { buildInput } from "../lib/ai/input";
import { evaluateTechnical, scoreDirection } from "../lib/ai/technical";
import { finalizeAnalysis, signalFromScore } from "../lib/ai/engine";
import { generateScenario, validateScenario } from "../lib/ai/scenario";
import { AnalysisError, createOpenAI, systemPrompt, validateInterpretation } from "../lib/ai/openai";
import { createAnalysisService } from "../lib/ai/service";
import { factorCategories, type AnalysisInput, type ModelInterpretation, type TradeScenario, type Direction } from "../lib/ai/types";

const now = Date.parse("2026-09-08T04:00:00Z");
const iso = (at = now) => new Date(at).toISOString();
const resource = <T>(data: T): Resource<T> => ({ data, fetchedAt: iso(), error: null, stale: false });
const fundamentalResource = <T>(data: T): DataResource<T> => ({ data, fetchedAt: iso(), error: null, status: "ok", warnings: [], provider: "TEST" });
const observation = <T>(value: T): Observation<T> => ({ value, availability: "available", source: "TEST", asOf: iso(), reason: null });
function market(pair: Symbol = "USD/JPY", direction = 1): MarketData {
  const durations: Record<Timeframe, number> = { "15m": 900_000, "1h": 3_600_000, "4h": 14_400_000 };
  return { symbol: pair, price: resource(150), timeframes: Object.fromEntries(timeframes.map(frame => {
    const candles = Array.from({ length: 240 }, (_, i) => {
      const close = 150 + (i - 239) * 0.001 * direction;
      return { time: iso(now - (240 - i) * durations[frame]), close, open: close, high: close + (direction > 0 ? 1 : 0.05), low: close - (direction > 0 ? 0.05 : 1) };
    });
    return [frame, resource({ candles, indicators: calculateIndicators(candles), lastClosedAt: candles.at(-1)!.time })];
  })) as MarketData["timeframes"] };
}
function fundamentals(pair: Symbol = "USD/JPY"): FundamentalData {
  const base = pair.split("/")[0] as "USD" | "EUR" | "GBP";
  const currencies = [base, "JPY"] as const;
  return {
    schemaVersion: 1, symbol: pair, baseCurrency: base, quoteCurrency: "JPY", generatedAt: iso(), factors: [],
    news: fundamentalResource([{ id: "test-news", title: "TEST policy statement", summary: "TEST only", source: "TEST", publishedAt: iso(), url: "https://example.com/test", currencies: [base], affectedCurrencies: [base], importance: "high", importanceBasis: "provider", impactDirection: null, reason: "TEST" }]),
    calendar: fundamentalResource([{ id: "test-event", name: "TEST CPI", country: "US", currency: base, scheduledAt: iso(now + 2 * 3_600_000), rawScheduledAt: null, timezone: "UTC", previous: 2.7, forecast: 2.8, actual: null, unit: "%", status: "upcoming", source: "TEST", url: null, isKeyIndicator: true, affectedCurrencies: [base], importance: "high", importanceBasis: "provider", impactDirection: null, reason: "TEST" }]),
    macroeconomic: fundamentalResource([
      { id: "us-cpi-yoy", name: "米CPI（前年比）", shortName: "米CPI", country: "US" as const, currency: "USD" as const, seriesId: "CPIAUCSL", seriesTitle: "TEST CPI", value: 2.8, previousValue: 2.7, unit: "% 前年比", frequency: "Monthly", observationDate: "2026-07-01", previousObservationDate: "2026-06-01", category: "inflation" as const, seasonalAdjustment: "Seasonally Adjusted", transformation: "pc1" as const, source: "FRED" as const, updatedAt: iso(), stale: false, ageDays: 30 },
      { id: "us-core-cpi-yoy", name: "米Core CPI（前年比）", shortName: "Core CPI", country: "US" as const, currency: "USD" as const, seriesId: "CPILFESL", seriesTitle: "TEST Core CPI", value: 2.5, previousValue: 2.6, unit: "% 前年比", frequency: "Monthly", observationDate: "2026-07-01", previousObservationDate: "2026-06-01", category: "inflation" as const, seasonalAdjustment: "Seasonally Adjusted", transformation: "pc1" as const, source: "FRED" as const, updatedAt: iso(), stale: false, ageDays: 30 },
      { id: "us-pce-yoy", name: "米PCE（前年比）", shortName: "米PCE", country: "US" as const, currency: "USD" as const, seriesId: "PCEPI", seriesTitle: "TEST PCE", value: 3.7, previousValue: 3.7, unit: "% 前年比", frequency: "Monthly", observationDate: "2026-07-01", previousObservationDate: "2026-06-01", category: "inflation" as const, seasonalAdjustment: "Seasonally Adjusted", transformation: "pc1" as const, source: "FRED" as const, updatedAt: iso(), stale: false, ageDays: 30 },
      { id: "us-core-pce-yoy", name: "米Core PCE（前年比）", shortName: "Core PCE", country: "US" as const, currency: "USD" as const, seriesId: "PCEPILFE", seriesTitle: "TEST Core PCE", value: 3.3, previousValue: 3.3, unit: "% 前年比", frequency: "Monthly", observationDate: "2026-07-01", previousObservationDate: "2026-06-01", category: "inflation" as const, seasonalAdjustment: "Seasonally Adjusted", transformation: "pc1" as const, source: "FRED" as const, updatedAt: iso(), stale: false, ageDays: 30 },
      { id: "us-nfp-change", name: "米非農業部門雇用者数増減（NFP）", shortName: "NFP増減", country: "US" as const, currency: "USD" as const, seriesId: "PAYEMS", seriesTitle: "TEST NFP", value: 162, previousValue: 21, unit: "千人（前月差）", frequency: "Monthly", observationDate: "2026-08-01", previousObservationDate: "2026-07-01", category: "labor" as const, seasonalAdjustment: "Seasonally Adjusted", transformation: "chg" as const, source: "FRED" as const, updatedAt: iso(), stale: false, ageDays: 30 },
      { id: "us-unemployment", name: "米失業率", shortName: "失業率", country: "US" as const, currency: "USD" as const, seriesId: "UNRATE", seriesTitle: "TEST UNRATE", value: 4.1, previousValue: 4.1, unit: "%", frequency: "Monthly", observationDate: "2026-08-01", previousObservationDate: "2026-07-01", category: "labor" as const, seasonalAdjustment: "Seasonally Adjusted", transformation: "lin" as const, source: "FRED" as const, updatedAt: iso(), stale: false, ageDays: 30 },
      { id: "us-real-gdp-growth", name: "米実質GDP成長率（前期比年率）", shortName: "実質GDP", country: "US" as const, currency: "USD" as const, seriesId: "A191RL1Q225SBEA", seriesTitle: "TEST GDP", value: 1.5, previousValue: 2.1, unit: "% 前期比年率", frequency: "Quarterly", observationDate: "2026-04-01", previousObservationDate: "2026-01-01", category: "growth" as const, seasonalAdjustment: "Seasonally Adjusted Annual Rate", transformation: "lin" as const, source: "FRED" as const, updatedAt: iso(), stale: false, ageDays: 30 },
      { id: "us-effr", name: "米実効FF金利", shortName: "実効FF金利", country: "US" as const, currency: "USD" as const, seriesId: "FEDFUNDS", seriesTitle: "TEST FEDFUNDS", value: 3.63, previousValue: 3.63, unit: "%", frequency: "Monthly", observationDate: "2026-08-01", previousObservationDate: "2026-07-01", category: "rates" as const, seasonalAdjustment: "Not Seasonally Adjusted", transformation: "lin" as const, source: "FRED" as const, updatedAt: iso(), stale: false, ageDays: 30 },
    ]),
    centralBanks: fundamentalResource(currencies.map(currency => ({ currency, name: "TEST BANK", abbreviation: currency, policyRate: observation({ name: "TEST", lower: 1, upper: null, unit: "%" as const }), nextMeeting: observation(iso(now + 86_400_000)), policyDirection: observation("hold" as const), relatedNewsIds: ["test-news"] }))),
    sentiment: fundamentalResource({ market: observation("neutral" as const), currencies: currencies.map(currency => ({ currency, sentiment: observation("neutral" as const) })) }),
  };
}
function interpretation(input: AnalysisInput, direction: Direction = "neutral"): ModelInterpretation {
  return {
    summary: "TEST: 取得済みの材料を統合した説明です。", confidence: 90, contradictions: false, preferWait: false,
    factors: factorCategories.map(category => { const evidence = input.fundamentalData.filter(item => item.categories.includes(category)); return {
      category, title: category, direction: !evidence.length ? "unknown" : category === "technical" ? scoreDirection(input.technicalAnalysis.score) : direction,
      impact: "high", reason: "TEST: 取得した材料に基づく評価です。", source: "TEST", evidenceIds: evidence.slice(0, 1).map(item => item.id),
    }; }),
    bullishReasons: [], bearishReasons: [], riskWarnings: [], scenarioComment: "条件成立を待って確認します。",
  };
}
function input(direction = 1) { return buildInput("USD/JPY", market("USD/JPY", direction), fundamentals(), now); }
const model = "gpt-4.1-mini";

for (const [score, signal] of [[100, "strong_buy"], [60, "strong_buy"], [59, "buy"], [20, "buy"], [19, "wait"], [-19, "wait"], [-20, "sell"], [-59, "sell"], [-60, "strong_sell"], [-100, "strong_sell"]] as const) {
  test(`score threshold ${score}: ${signal}`, () => assert.equal(signalFromScore(score), signal));
}
for (const [direction, score, fundamentalDirection, signal] of [[1, 100, "bullish", "strong_buy"], [1, 40, "neutral", "buy"], [1, 0, "neutral", "wait"], [-1, -40, "neutral", "sell"], [-1, -100, "bearish", "strong_sell"]] as const) {
  test(`complete pipeline produces ${signal} with validated prices`, () => {
    const snapshot = input(direction);
    snapshot.technicalAnalysis.score = score;
    if (score === 0) snapshot.technicalAnalysis.frames.forEach(frame => { frame.score = 0; });
    const result = finalizeAnalysis(snapshot, interpretation(snapshot, fundamentalDirection), model, null, now);
    assert.equal(result.signal, signal);
    assert.ok(result.score >= -100 && result.score <= 100);
    assert.ok(result.confidence >= 0 && result.confidence <= 100);
    if (signal === "wait") assert.equal(result.scenario, null);
    else { assert.ok(result.scenario); assert.ok(result.scenario.riskReward >= 1.5); assert.ok(validateScenario(result.scenario)); }
  });
}
test("evaluates SMA slopes, comparisons, RSI, highs/lows and momentum without reversing oversold trend", () => {
  const result = evaluateTechnical(market("USD/JPY", -1), now);
  assert.equal(result.score, -100);
  assert.equal(result.ready, true);
  for (const frame of result.frames) {
    assert.equal(frame.priceVsSma, "bearish");
    assert.equal(frame.shortVsMedium, "bearish");
    assert.ok(frame.smaSlopes.long! < 0);
    assert.ok(frame.momentum! < 0);
    assert.equal(frame.rsiState, "oversold");
    assert.ok(frame.recentHigh! > frame.recentLow!);
  }
});
test("missing and stale data never become directional fundamentals", () => {
  const data = market(); data.price.stale = true;
  const snapshot = buildInput("USD/JPY", data, null, now);
  assert.equal(snapshot.currentRate, null);
  assert.equal(snapshot.technicalAnalysis.ready, false);
  assert.equal(snapshot.dataAvailability.categories.news.status, "missing");
  const result = finalizeAnalysis(snapshot, null, model, "not_configured", now);
  assert.equal(result.signal, "wait"); assert.equal(result.scenario, null);
  assert.ok(result.factors.filter(factor => factor.category !== "technical").every(factor => factor.direction === "unknown"));
});
test("wrong pair, future candles and expired snapshots are excluded", () => {
  assert.equal(buildInput("GBP/JPY", market(), fundamentals(), now).dataAvailability.score, 0);
  const data = market(); data.timeframes["15m"].data!.candles.at(-1)!.time = iso(now + 1000);
  assert.equal(evaluateTechnical(data, now).frames[0].available, false);
  assert.equal(evaluateTechnical(market(), now + 600_001).ready, false);
});
test("quality measures missing, partial and complete observations and excludes account data", () => {
  assert.equal(input().dataAvailability.score, 100);
  const full = fundamentals(); full.centralBanks.data![0].policyRate = { value: null, availability: "unavailable", asOf: null, source: null, reason: "missing" };
  const snapshot = buildInput("USD/JPY", market(), full, now);
  assert.equal(snapshot.dataAvailability.categories.central_bank.status, "partial");
  full.centralBanks.data = []; full.news.data = [];
  assert.equal(buildInput("USD/JPY", market(), full, now).dataAvailability.categories.central_bank.status, "missing");
  assert.ok(!JSON.stringify(snapshot).includes("balance"));
  assert.ok(!JSON.stringify(snapshot).includes("https://example.com"));
});
test("low confidence, contradictions, acute moves and imminent events each force WAIT", () => {
  for (const condition of ["confidence", "contradictions", "acute", "event", "unknown-time", "quality", "preferWait"]) {
    const snapshot = input(); const result = interpretation(snapshot, "bullish");
    if (condition === "confidence") result.confidence = 35;
    if (condition === "contradictions") result.contradictions = true;
    if (condition === "acute") snapshot.technicalAnalysis.extended = true;
    if (condition === "event") { snapshot.eventRisk.imminent = true; snapshot.eventRisk.reasons = ["指標直前"]; }
    if (condition === "unknown-time") { snapshot.eventRisk.uncertainTime = true; snapshot.eventRisk.reasons = ["時刻未確認"]; }
    if (condition === "quality") snapshot.dataAvailability.score = 40;
    if (condition === "preferWait") result.preferWait = true;
    assert.equal(finalizeAnalysis(snapshot, result, model, null, now).signal, "wait", condition);
  }
});
test("opposing fundamental factors lower confidence and block a technical-only sell", () => {
  const snapshot = input(-1);
  const aligned = finalizeAnalysis(snapshot, interpretation(snapshot, "bearish"), model, null, now);
  const conflict = finalizeAnalysis(snapshot, interpretation(snapshot, "bullish"), model, null, now);
  assert.equal(conflict.signal, "wait"); assert.ok(conflict.confidence < aligned.confidence);
});
test("high-impact release timing is detected, actual zero is preserved", () => {
  const f = fundamentals(); f.calendar.data![0].scheduledAt = iso(now + 10 * 60_000);
  assert.equal(buildInput("USD/JPY", market(), f, now).eventRisk.imminent, true);
  f.calendar.data![0].actual = 0;
  assert.equal(buildInput("USD/JPY", market(), f, now).eventRisk.imminent, true);
  f.calendar.data![0].actual = null; f.calendar.data![0].scheduledAt = null;
  assert.equal(buildInput("USD/JPY", market(), f, now).eventRisk.uncertainTime, true);
});
test("long/short use a pullback zone, worst-case RR, and reject reversed prices, NaN and low RR", () => {
  for (const direction of [1, -1]) {
    const snapshot = input(direction);
    const scenario = generateScenario(snapshot, direction === 1 ? "buy" : "sell")!;
    assert.ok(scenario);
    assert.notEqual(scenario.entryZone.min, snapshot.currentRate);
    assert.notEqual(scenario.entryZone.max, snapshot.currentRate);
    const { min, max } = scenario.entryZone;
    if (direction === 1) assert.ok(scenario.stopLoss < min && max < scenario.takeProfit1 && scenario.takeProfit1 < scenario.takeProfit2);
    else assert.ok(scenario.takeProfit2 < scenario.takeProfit1 && scenario.takeProfit1 < min && max < scenario.stopLoss);
    assert.equal(validateScenario({ ...scenario, stopLoss: min }), null);
    assert.equal(validateScenario({ ...scenario, takeProfit1: Number.NaN }), null);
    assert.equal(validateScenario({ ...scenario, entryZone: { min: max + 1, max } }), null);
    const lowRR: TradeScenario = { ...scenario, takeProfit1: direction === 1 ? max + 0.001 : min - 0.001 };
    assert.equal(validateScenario(lowRR), null);
  }
});
test("RR failure changes a directional analysis to WAIT without a scenario", () => {
  const snapshot = input(); snapshot.technicalAnalysis.frames.find(frame => frame.timeframe === "1h")!.recentHigh = 150;
  const result = finalizeAnalysis(snapshot, interpretation(snapshot, "bullish"), model, null, now);
  assert.equal(result.signal, "wait"); assert.equal(result.scenario, null); assert.ok(result.decisionReasons.some(reason => reason.includes("RR")));
});
test("model JSON must have exactly five categories and grounded evidence", () => {
  const snapshot = input(); const valid = interpretation(snapshot);
  assert.deepEqual(validateInterpretation(valid, snapshot), valid);
  assert.throws(() => validateInterpretation({ ...valid, confidence: 101 }, snapshot));
  assert.throws(() => validateInterpretation({ ...valid, factors: [...valid.factors, valid.factors[0]] }, snapshot));
  const wrong = structuredClone(valid); wrong.factors[1].evidenceIds = ["invented"];
  assert.throws(() => validateInterpretation(wrong, snapshot));
  const missing = buildInput("USD/JPY", market(), null, now);
  assert.throws(() => validateInterpretation(valid, missing));
});
test("Responses request uses server header, strict schema, no storage, and no secrets in input", async () => {
  const snapshot = input();
  const interpret = createOpenAI({ apiKey: "TEST-SECRET", model }, async (url, init) => {
    assert.equal(url, "https://api.openai.com/v1/responses");
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer TEST-SECRET");
    assert.ok(!String(init?.body).includes("TEST-SECRET"));
    const body = JSON.parse(String(init?.body));
    assert.equal(body.store, false); assert.equal(body.text.format.strict, true);
    assert.equal(body.input[0].content, systemPrompt);
    assert.equal(body.input[1].role, "user");
    return Response.json({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(interpretation(snapshot)) }] }] });
  });
  assert.equal((await interpret(snapshot)).confidence, 90);
});
test("missing OpenAI key makes no network call", async () => {
  const interpret = createOpenAI({ apiKey: "", model }, async () => { throw new Error("should never run"); });
  await assert.rejects(interpret(input()), (error: unknown) => error instanceof AnalysisError && error.code === "not_configured");
});
for (const [kind, response] of [
  ["HTTP 500", () => Response.json({ error: "SECRET" }, { status: 500 })],
  ["HTTP 429", () => Response.json({}, { status: 429 })],
  ["invalid JSON", () => new Response("not JSON")],
  ["invalid output JSON", () => Response.json({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "{" }] }] })],
  ["refusal", () => Response.json({ status: "completed", output: [{ type: "message", content: [{ type: "refusal", refusal: "no" }] }] })],
  ["incomplete", () => Response.json({ status: "incomplete", output: [] })],
] as const) {
  test(`OpenAI ${kind} fails closed`, async () => {
    await assert.rejects(createOpenAI({ apiKey: "SECRET", model }, async () => response())(input()), (error: unknown) => error instanceof AnalysisError && !error.message.includes("SECRET"));
  });
}
test("timeout abort is bounded and produces the timeout fallback code", async () => {
  const interpret = createOpenAI({ apiKey: "TEST", model, timeoutMs: 5 }, async (_url, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("SECRET timeout", "TimeoutError")), { once: true });
    // Keep Node's event loop alive while AbortSignal.timeout's unref timer fires.
    setTimeout(() => reject(new Error("failed to abort")), 50);
  }));
  await assert.rejects(interpret(input()), (error: unknown) => error instanceof AnalysisError && error.code === "timeout");
});
test("five-minute per-pair cache, concurrent deduplication and market revision invalidation", async () => {
  let time = now, calls = 0, revision = "a";
  const service = createAnalysisService({ market: async pair => market(pair), fundamental: async pair => fundamentals(pair), interpret: async snapshot => { calls++; return interpretation(snapshot); }, enabled: true, model, now: () => time, revision: () => revision });
  const [a, b] = await Promise.all([service("USD/JPY"), service("USD/JPY")]);
  assert.equal(calls, 1); assert.deepEqual(a.data, b.data);
  assert.equal((await service("USD/JPY")).cached, true);
  revision = "b"; await service("USD/JPY"); assert.equal(calls, 2);
  for (const pair of ["EUR/JPY", "GBP/JPY"] as const) assert.equal((await service(pair)).data?.pair, pair);
  assert.equal(calls, 4);
  time += 300_001;
  assert.equal((await service("USD/JPY")).cached, false);
});
test("AI failure is WAIT with technical factors, retry cache and no leaked exception", async () => {
  let time = now, calls = 0;
  const service = createAnalysisService({ market: async () => market(), fundamental: async () => fundamentals(), interpret: async () => { calls++; throw new Error("SECRET"); }, enabled: true, model, now: () => time });
  const first = await service("USD/JPY");
  assert.equal(first.success, true); assert.equal(first.data?.signal, "wait"); assert.equal(first.data?.scenario, null);
  assert.equal(first.data?.technicalScore, 100); assert.ok(!JSON.stringify(first).includes("SECRET"));
  await service("USD/JPY"); assert.equal(calls, 1);
  time += 60_001; await service("USD/JPY"); assert.equal(calls, 2);
});
test("daily/hourly guard blocks extra AI calls and data-source failures still return analysis", async () => {
  let calls = 0;
  const service = createAnalysisService({ market: async pair => market(pair), fundamental: async pair => fundamentals(pair), interpret: async snapshot => { calls++; return interpretation(snapshot); }, enabled: true, model, now: () => now, hourlyLimit: 1 });
  await service("USD/JPY");
  assert.equal((await service("EUR/JPY")).data?.ai.code, "rate_limited"); assert.equal(calls, 1);
  const failing = createAnalysisService({ market: async () => { throw new Error("SECRET"); }, fundamental: async () => { throw new Error("SECRET"); }, interpret: async () => { throw new Error("should not run"); }, enabled: true, model, now: () => now });
  const result = await failing("USD/JPY");
  assert.equal(result.data?.ai.code, "insufficient_data"); assert.equal(result.data?.dataQuality.score, 0);
});

test("analysis cache expires before a high-impact release enters its risk window", () => {
  const f = fundamentals();
  f.calendar.data![0].scheduledAt = iso(now + 32 * 60_000);
  const snapshot = buildInput("USD/JPY", market(), f, now);
  const result = finalizeAnalysis(snapshot, interpretation(snapshot), model, null, now);
  assert.equal(result.expiresAt, iso(now + 2 * 60_000));
  const late = finalizeAnalysis(snapshot, interpretation(snapshot), model, null, now + 2 * 60_000);
  assert.equal(late.signal, "wait");
});
