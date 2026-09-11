import test from "node:test";
import assert from "node:assert/strict";
import { normalizeTradingEconomics, surprise, indicatorKey } from "../lib/economic-calendar/normalize";
import { riskState, calendarTtl, nextHigh, formatJst, countdown, calendarKnown } from "../lib/economic-calendar/risk-window";
import { createTradingEconomics } from "../lib/economic-calendar/trading-economics";
import { normalizeEodhd } from "../lib/economic-calendar/eodhd-normalize";
import { createEodhd } from "../lib/economic-calendar/providers/eodhd";
import { calendarWithFallback } from "../lib/economic-calendar/service";
import { ResourceCache } from "../lib/fundamental/cache";
import { unavailable } from "../lib/fundamental/resource";
import { assembleFundamentals } from "../lib/fundamental/service";
import { getCentralBanks } from "../lib/fundamental/central-banks";
import { getSentiment } from "../lib/fundamental/sentiment";
import { buildInput } from "../lib/ai/input";
import { finalizeAnalysis } from "../lib/ai/engine";
import { createOpenAI, systemPrompt } from "../lib/ai/openai";
import type { EconomicEvent, DataResource } from "../lib/fundamental/types";
import type { ModelInterpretation } from "../lib/ai/types";
const now = Date.parse("2026-09-11T12:00:00Z");
const raw = { CalendarId: "test-1", Country: "United States", Event: "Core CPI YoY", Date: "2026-09-11T12:30:00", DateSpan: "0", Importance: 3, Previous: "2.7%", Forecast: "2.8%", Actual: "", TEForecast: "999%", Unit: "%", LastUpdate: "2026-09-11T11:30:00", SourceURL: "https://example.com" };
const event = (change: Partial<EconomicEvent> = {}): EconomicEvent => ({ ...normalizeTradingEconomics([raw], now).items[0], ...change });
const ok = (events: EconomicEvent[]): DataResource<EconomicEvent[]> => ({ data: events, status: events.length ? "ok" : "empty", error: null, warnings: [], fetchedAt: new Date(now).toISOString(), provider: "TEST" });
const iso = (ms: number) => new Date(ms).toISOString();
for (const [offset, blocked] of [[-1, false], [0, true], [30 * 60_000, true], [45 * 60_000, true], [45 * 60_000 + 1, false]] as const) test(`high risk boundary ${offset}`, () => assert.equal(riskState([event()], now + offset).imminent, blocked));
test("actual received does not cancel post-release hold", () => assert.equal(riskState([event({ actual: 3.1 })], now + 31 * 60_000).imminent, true));
test("medium blocks 15 minutes before through 5 minutes after", () => {
  const e = event({ importance: "medium" });
  assert.equal(riskState([e], now + 14 * 60_000).imminent, false);
  assert.equal(riskState([e], now + 15 * 60_000).imminent, true);
  assert.equal(riskState([e], now + 35 * 60_000).imminent, true);
  assert.equal(riskState([e], now + 35 * 60_000 + 1).imminent, false);
});
test("low never blocks; empty events have no risk window", () => {
  assert.equal(riskState([event({ importance: "low" })], now + 30 * 60_000).imminent, false);
  assert.equal(riskState([], now).imminent, false);
});
test("estimated or unknown time does not become a precise release", () => {
  for (const DateSpan of ["1", "", undefined]) {
    const e = normalizeTradingEconomics([{ ...raw, DateSpan }], now).items[0];
    assert.equal(e.scheduledAt, null); assert.equal(riskState([e], now).uncertainTime, true);
  }
});
test("UTC, explicit offsets, JST date rollover and invalid date", () => {
  assert.equal(event().scheduledAt, "2026-09-11T12:30:00.000Z");
  assert.equal(normalizeTradingEconomics([{ ...raw, Date: "2026-09-11T21:30:00+09:00" }], now).items[0].scheduledAt, event().scheduledAt);
  assert.match(formatJst("2026-09-11T16:30:00Z"), /2026\/09\/12 01:30 JST/);
  assert.equal(normalizeTradingEconomics([{ ...raw, Date: "2026-02-30T12:30:00" }], now).items[0].scheduledAt, null);
  assert.equal(countdown(event().scheduledAt!, now), "あと0時間30分");
});
test("previous forecast actual normalize independently and never use TEForecast as consensus", () => {
  const e = event(); assert.equal(e.previous, 2.7); assert.equal(e.forecast, 2.8); assert.equal(e.actual, null);
  for (const field of ["Previous", "Forecast", "Actual"]) {
    const e = normalizeTradingEconomics([{ ...raw, [field]: null }], now).items[0];
    assert.equal(e[field.toLowerCase() as "previous" | "forecast" | "actual"], null);
  }
  assert.equal(normalizeTradingEconomics([{ ...raw, Actual: 0 }], now).items[0].actual, 0);
});
for (const [actual, relation, difference] of [[3.1, "above", .3], [2.5, "below", -.3], [2.8, "equal", 0]] as const) test(`surprise ${relation} forecast`, () => assert.deepEqual(surprise(event({ actual })), { difference, relation, unit: "pt" }));
test("strings, missing values, unknown/mismatched units are not forced into surprise", () => {
  for (const e of [event(), event({ actual: 3, forecast: null }), event({ actual: "3%" }), event({ actual: 3, unit: null }), event({ actual: Infinity })]) assert.equal(surprise(e), null);
  const e = normalizeTradingEconomics([{ ...raw, Actual: "3.1K", Unit: "%" }], now).items[0]; assert.equal(e.actual, "3.1K"); assert.equal(surprise(e), null);
});
test("indicator variants cover requested policy, inflation, labor, growth and surveys", () => {
  for (const name of ["Core CPI", "Consumer Price Index", "Non-farm Payrolls", "Unemployment Rate", "Core PCE", "Personal Consumption Expenditures", "GDP Growth", "Retail Sales", "ISM Services PMI", "Federal Funds Rate", "FOMC", "BOJ Policy Rate", "BOJ Meeting", "Tokyo CPI", "Average Cash Earnings", "Tankan", "ECB Rate Decision", "Euro Area Employment", "BOE Rate Decision", "UK PMI"]) assert.ok(indicatorKey(name), name);
  assert.equal(indicatorKey("4 Week Bill Auction"), null);
});
test("provider importance is retained while key indicator classification is separate", () => {
  assert.equal(normalizeTradingEconomics([{ ...raw, Importance: 2 }], now).items[0].importance, "medium");
  assert.equal(normalizeTradingEconomics([{ ...raw, Importance: null }], now).items[0].importance, "high");
});
for (const pair of ["USD/JPY", "EUR/JPY", "GBP/JPY"] as const) test(`${pair} includes only pair currencies`, async () => {
  const events = normalizeTradingEconomics(["United States", "Japan", "Euro Area", "United Kingdom"].map((Country, index) => ({ ...raw, CalendarId: index, Country })), now).items;
  const data = await assembleFundamentals(pair, { calendar: async () => ok(events), news: async () => ({ ...ok([]), data: [] }), centralBanks: getCentralBanks, sentiment: getSentiment }, now);
  assert.deepEqual(data.calendar.data?.map(e => e.currency).sort(), pair.split("/").sort());
  assert.equal(buildInput(pair, null, data, now).eventRisk.events?.length, 2);
});
test("next high is chronological, future and ignores medium", () => {
  const events = [event({ id: "later", scheduledAt: iso(now + 60 * 60_000) }), event({ importance: "medium", scheduledAt: iso(now + 1000) }), event({ id: "first" })];
  assert.equal(nextHigh(events, now)?.id, "first"); assert.equal(nextHigh([], now), null);
});
test("cache TTL normal, at release and immediately after release", () => {
  assert.equal(calendarTtl([], now), 1_800_000);
  assert.equal(calendarTtl([event({ scheduledAt: iso(now + 5000) })], now), 5000);
  assert.equal(calendarTtl([event({ scheduledAt: iso(now - 1000), actual: 3 })], now), 60_000);
});
test("cache deduplicates and refreshes at release then throttles post-release", async () => {
  let clock = now, calls = 0;
  const provider = createTradingEconomics("synthetic-key", async () => { calls++; return Response.json([{ ...raw, Date: iso(now + 1000) }]); }, () => clock, new ResourceCache(() => clock));
  await Promise.all([provider.calendar(), provider.calendar()]); assert.equal(calls, 1);
  clock += 1000; await provider.calendar(); assert.equal(calls, 2);
  clock += 59000; await provider.calendar(); assert.equal(calls, 2);
  clock += 1000; await provider.calendar(); assert.equal(calls, 3);
});
test("unconfigured provider performs no requests", async () => {
  let calls = 0; const p = createTradingEconomics("", async () => { calls++; return Response.json([]); });
  assert.equal((await p.calendar()).error?.code, "not_configured"); assert.equal(calls, 0);
});
for (const [status, code] of [[401, "unauthorized"], [403, "forbidden"], [429, "rate_limited"], [500, "network"]] as const) test(`provider HTTP ${status} is isolated and sanitized`, async () => {
  const result = await createTradingEconomics("synthetic-secret", async () => new Response("synthetic-secret", { status })).calendar();
  assert.equal(result.data, null); assert.equal(result.error?.code, code); assert.ok(!JSON.stringify(result).includes("synthetic-secret"));
});
test("network and malformed/restricted/capped responses never become empty calendars", async () => {
  assert.equal((await createTradingEconomics("test", async () => { throw new Error("secret"); }).calendar()).error?.code, "network");
  for (const body of [{ error: "plan" }, [{ ...raw, Country: "Sweden" }], Array.from({ length: 1000 }, () => raw)]) assert.throws(() => normalizeTradingEconomics(body, now));
});
test("authorization is in header, country date request is bounded", async () => {
  await createTradingEconomics("synthetic-secret", async (input, init) => {
    const url = String(input); assert.ok(!url.includes("synthetic-secret")); assert.ok(url.includes("2026-09-10/2026-09-18"));
    assert.equal(new Headers(init?.headers).get("Authorization"), "synthetic-secret"); return Response.json([]);
  }, () => now).calendar();
});
test("fallback uses Finnhub only after primary unavailable and does not fallback for valid empty", async () => {
  let calls = 0; const fallback = { calendar: async () => { calls++; return ok([event()]); } };
  const result = await calendarWithFallback({ calendar: async () => unavailable("TE", "forbidden") }, fallback).calendar();
  assert.equal(result.data?.length, 1); assert.equal(calls, 1);
  await calendarWithFallback({ calendar: async () => ok([]) }, fallback).calendar(); assert.equal(calls, 1);
});
test("calendar missing is distinguished from a successful empty response in AI quality", async () => {
  const deps = { news: async () => ({ ...ok([]), data: [] }), centralBanks: getCentralBanks, sentiment: getSentiment };
  const missing = await assembleFundamentals("USD/JPY", { ...deps, calendar: async () => unavailable("TE", "network") }, now);
  const empty = await assembleFundamentals("USD/JPY", { ...deps, calendar: async () => ok([]) }, now);
  assert.equal(buildInput("USD/JPY", null, missing, now).dataAvailability.categories.economic.status, "missing");
  assert.equal(buildInput("USD/JPY", null, empty, now).eventRisk.known, true);
  assert.equal(calendarKnown({ ...ok([]), fetchedAt: iso(now - 3_600_001) }, now), false);
});
test("AI receives factual values and deterministic WAIT while direction survives", async () => {
  const fundamental = await assembleFundamentals("USD/JPY", { news: async () => ({ ...ok([]), data: [] }), calendar: async () => ok([event({ actual: 3.1 })]), centralBanks: getCentralBanks, sentiment: getSentiment }, now);
  const input = buildInput("USD/JPY", null, fundamental, now);
  input.technicalAnalysis.score = -100; input.technicalAnalysis.ready = true; input.dataAvailability.score = 100;
  const interpretation: ModelInterpretation = { summary: "TEST", factors: [], bullishReasons: [], bearishReasons: [], riskWarnings: [], confidence: 90, contradictions: false, preferWait: false, scenarioComment: "TEST" };
  const result = finalizeAnalysis(input, interpretation, "TEST", null, now);
  assert.equal(result.signal, "wait"); assert.equal(result.action, "WAIT"); assert.equal(result.directionSignal, "strong_sell"); assert.equal(result.scenario, null); assert.ok(result.confidence < 90);
  const evidence = input.fundamentalData.find(e => e.categories.includes("economic"))!.data as Record<string, unknown>;
  assert.equal(evidence.forecast, 2.8); assert.equal(evidence.actual, 3.1); assert.equal(evidence.previous, 2.7); assert.equal(evidence.inRiskWindow, true); assert.equal(evidence.minutesUntil, 30);
  assert.match(systemPrompt, /actual未発表時はactualを推測せず/);
});

test("model payload is bounded while full calendar remains available for server risk checks", async () => {
  const input = buildInput("USD/JPY", null, null, now);
  input.eventRisk.events = Array.from({ length: 200 }, (_, index) => event({ id: String(index) }));
  input.eventRisk.reasons = Array.from({ length: 200 }, () => "TEST");
  let sent = false;
  const interpret = createOpenAI({ apiKey: "test", model: "TEST" }, async (_url, options) => {
    const payload = JSON.parse(String(options?.body));
    const data = JSON.parse(payload.input[1].content);
    assert.equal(data.eventRisk.events, undefined); assert.equal(data.eventRisk.reasons.length, 20); sent = true;
    return new Response(null, { status: 500 });
  });
  await assert.rejects(interpret(input)); assert.equal(sent, true); assert.equal(input.eventRisk.events.length, 200);
});

test("EODHD response fields normalize without manufacturing unit, id, or update fields", () => {
  const result = normalizeEodhd([{ type: "CPI", comparison: "yoy", period: "Aug", country: "US", date: "2026-09-11 12:30:00", actual: null, previous: 2.7, estimate: 2.8 }], now);
  const item = result.items[0];
  assert.equal(item.currency, "USD"); assert.equal(item.forecast, 2.8); assert.equal(item.previous, 2.7); assert.equal(item.actual, null);
  assert.equal(item.unit, null); assert.equal(item.updatedAt, undefined); assert.equal(item.status, "upcoming"); assert.equal(item.timezone, "UTC");
  assert.equal(item.importance, "high"); assert.match(item.id, /^eodhd:US:/);
});
test("EODHD provider keeps API failures in Economic Calendar and never leaks the token", async () => {
  const token = "synthetic-secret";
  for (const [status, code] of [[401, "unauthorized"], [403, "forbidden"], [429, "rate_limited"], [503, "network"]] as const) {
    const result = await createEodhd(token, { fetcher: async (input) => { assert.ok(String(input).includes("api_token=")); return new Response("error", { status }); }, now: () => now }).calendar();
    assert.equal(result.data, null); assert.equal(result.error?.code, code); assert.ok(!JSON.stringify(result).includes(token));
  }
});
test("EODHD provider makes bounded country requests and preserves null releases", async () => {
  const seen: string[] = [];
  const result = await createEodhd("token", { now: () => now, euroCountry: "EA", fetcher: async input => {
    const url = new URL(String(input)); seen.push(url.searchParams.get("country")!);
    return Response.json([{ type: "GDP", country: url.searchParams.get("country"), date: "2026-09-12 01:00:00", actual: null, estimate: null, previous: null }]);
  }}).calendar();
  assert.deepEqual(seen.sort(), ["EA", "GB", "JP", "US"]); assert.equal(result.data?.length, 4); assert.equal(result.data?.[0].actual, null); assert.equal(result.data?.[0].forecast, null); assert.equal(result.data?.[0].previous, null);
});
