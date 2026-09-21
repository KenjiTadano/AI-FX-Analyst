import test from "node:test";
import assert from "node:assert/strict";
import {
  calendarMetric,
  mapFinanceCalendarCurrency,
  normalizeFinanceCalendar,
  normalizeImpact,
} from "../lib/economic-calendar/finance-calendar-normalize";
import { createFinanceCalendar } from "../lib/economic-calendar/providers/finance-calendar";
import { calendarWithFallback } from "../lib/economic-calendar/service";
import { ResourceCache } from "../lib/fundamental/cache";
import { unavailable } from "../lib/fundamental/resource";
import type { EconomicEvent, DataResource } from "../lib/fundamental/types";

const now = Date.parse("2026-09-21T12:00:00.000Z");

function row(change: Record<string, unknown> = {}) {
  return {
    date: "2026-09-30",
    time_utc: "2026-09-30T12:30:00+00:00",
    time_et: "08:30",
    all_day: false,
    name: "US GDP",
    title: "US Gross Domestic Product September 2026",
    impact: "high",
    category: "economic-indicators",
    consensus: null,
    prior: null,
    actual: null,
    url: "https://www.financecalendar.com/event/us-gross-domestic-product-september-2026/",
    ...change,
  };
}

function payload(events: Record<string, unknown>[]) {
  return {
    from: "2026-09-21",
    to: "2026-10-05",
    count: events.length,
    events,
    attribution: { source: "financecalendar.com", terms: "Free for any use with attribution", docs: "https://www.financecalendar.com/api/" },
  };
}

const ok = (events: EconomicEvent[]): DataResource<EconomicEvent[]> => ({
  data: events, status: events.length ? "ok" : "empty", error: null, warnings: [], fetchedAt: new Date(now).toISOString(), provider: "TEST",
});

test("FinanceCalendar response normalization maps core fields", () => {
  const batch = normalizeFinanceCalendar(payload([row({
    consensus: "2.1",
    prior: "1.9",
    actual: "2.0",
  })]), now);
  assert.equal(batch.items.length, 1);
  const event = batch.items[0]!;
  assert.equal(event.source, "FinanceCalendar");
  assert.equal(event.name, "US GDP");
  assert.equal(event.currency, "USD");
  assert.equal(event.country, "United States");
  assert.equal(event.importance, "high");
  assert.equal(event.importanceBasis, "provider");
  assert.equal(event.forecast, 2.1);
  assert.equal(event.previous, 1.9);
  assert.equal(event.actual, 2.0);
  assert.equal(event.scheduledAt, "2026-09-30T12:30:00.000Z");
  assert.equal(event.timezone, "UTC");
  assert.equal(event.rawScheduledAt, "2026-09-30T12:30:00+00:00");
  assert.match(event.url ?? "", /financecalendar\.com/);
});

test("USD event mapping from title and url", () => {
  assert.equal(mapFinanceCalendarCurrency("Jobless claims", "US Initial Jobless Claims", "https://www.financecalendar.com/event/us-initial-jobless-claims/"), "USD");
  assert.equal(mapFinanceCalendarCurrency("NFP", "US Employment Situation (Non-Farm Payrolls)", "https://example.com/us-nfp"), "USD");
});

test("JPY event mapping from TSE/JPX and BOJ", () => {
  assert.equal(mapFinanceCalendarCurrency("TSE/JPX Hours", "Is the Stock Market Open — TSE/JPX Hours", "https://www.financecalendar.com/event/tse-jpx-autumnal-equinox-day-2026/"), "JPY");
  assert.equal(mapFinanceCalendarCurrency("BOJ Rate Decision", "Bank of Japan Rate Decision", "https://www.financecalendar.com/event/boj-rate-decision/"), "JPY");
});

test("EUR / ECB / Eurozone / Germany event mapping", () => {
  assert.equal(mapFinanceCalendarCurrency("Eurozone Flash CPI", "Eurozone Flash CPI October 2026", "https://www.financecalendar.com/event/eurozone-flash-cpi/"), "EUR");
  assert.equal(mapFinanceCalendarCurrency("ECB Rate Decision", "ECB Monetary Policy Decision", "https://www.financecalendar.com/event/ecb-rate-decision/"), "EUR");
  assert.equal(mapFinanceCalendarCurrency("Germany Ifo Business Climate", "Germany Ifo Business Climate", "https://www.financecalendar.com/event/germany-ifo/"), "EUR");
});

test("GBP / BOE / United Kingdom event mapping", () => {
  assert.equal(mapFinanceCalendarCurrency("BOE Rate Decision", "Bank of England Rate Decision", "https://www.financecalendar.com/event/boe-rate-decision/"), "GBP");
  assert.equal(mapFinanceCalendarCurrency("UK CPI", "United Kingdom CPI", "https://www.financecalendar.com/event/uk-cpi/"), "GBP");
});

test("high/medium/low impact normalization", () => {
  assert.equal(normalizeImpact("high"), "high");
  assert.equal(normalizeImpact("MEDIUM"), "medium");
  assert.equal(normalizeImpact("low"), "low");
  assert.equal(normalizeImpact("critical"), null);
  assert.equal(normalizeFinanceCalendar(payload([row({ impact: "medium", name: "New Home Sales", title: "US New Home Sales" })]), now).items[0]!.importance, "medium");
});

test("consensus null stays null and is not zero-filled", () => {
  const event = normalizeFinanceCalendar(payload([row({ consensus: null })]), now).items[0]!;
  assert.equal(event.forecast, null);
  assert.equal(calendarMetric(null), null);
  assert.equal(calendarMetric(""), null);
  assert.equal(calendarMetric("n/a"), null);
});

test("actual null stays null; numeric zero is preserved when provided", () => {
  assert.equal(normalizeFinanceCalendar(payload([row({ actual: null })]), now).items[0]!.actual, null);
  assert.equal(normalizeFinanceCalendar(payload([row({ actual: 0 })]), now).items[0]!.actual, 0);
  assert.equal(calendarMetric("Not applicable, annual fixed…"), null);
});

test("invalid FinanceCalendar response fails closed", () => {
  assert.throws(() => normalizeFinanceCalendar(null, now));
  assert.throws(() => normalizeFinanceCalendar({ events: "nope" }, now));
  assert.throws(() => normalizeFinanceCalendar({ events: [{}, {}, {}] }, now));
});

test("unmapped regions are skipped without guessing currency", () => {
  const batch = normalizeFinanceCalendar(payload([
    row({ name: "Australia Labour Force", title: "Australia Labour Force", url: "https://www.financecalendar.com/event/australia-labour-force/", impact: "high" }),
    row({ name: "China Official PMI", title: "China Official PMI", url: "https://www.financecalendar.com/event/china-official-pmi/", impact: "medium" }),
    row(),
  ]), now);
  assert.equal(batch.items.length, 1);
  assert.equal(batch.items[0]!.currency, "USD");
  assert.ok(batch.warnings.some(w => w.includes("対象外")));
});

test("time_utc with offset is preserved as UTC ISO", () => {
  const event = normalizeFinanceCalendar(payload([row({ time_utc: "2026-10-02T09:00:00+00:00", name: "Eurozone Flash CPI", title: "Eurozone Flash CPI", url: "https://www.financecalendar.com/event/eurozone-flash-cpi/" })]), now).items[0]!;
  assert.equal(event.scheduledAt, "2026-10-02T09:00:00.000Z");
  assert.equal(event.timezone, "UTC");
  assert.equal(event.rawScheduledAt, "2026-10-02T09:00:00+00:00");
});

test("all-day / missing time_utc does not invent a release time", () => {
  const event = normalizeFinanceCalendar(payload([row({
    name: "TSE/JPX Hours",
    title: "Is the Stock Market Open on Autumnal Equinox Day — TSE/JPX Hours",
    url: "https://www.financecalendar.com/event/tse-jpx-autumnal-equinox-day-2026/",
    time_utc: null,
    all_day: true,
    date: "2026-09-23",
    impact: "low",
  })]), now).items[0]!;
  assert.equal(event.currency, "JPY");
  assert.equal(event.scheduledAt, null);
  assert.equal(event.timezone, null);
  assert.equal(event.rawScheduledAt, "2026-09-23");
});

test("provider failure falls back to next calendar provider", async () => {
  let fallbackCalls = 0;
  const primary = createFinanceCalendar({
    fetcher: async () => { throw new Error("network"); },
    now: () => now,
    cache: new ResourceCache(() => now),
  });
  const fallback = {
    calendar: async () => {
      fallbackCalls++;
      return ok([{
        id: "fallback",
        name: "Fallback CPI",
        country: "United States",
        currency: "USD" as const,
        scheduledAt: "2026-09-30T12:30:00.000Z",
        rawScheduledAt: "2026-09-30T12:30:00Z",
        timezone: "UTC" as const,
        previous: null,
        forecast: null,
        actual: null,
        unit: null,
        status: "upcoming" as const,
        source: "EODHD",
        url: null,
        importance: "high" as const,
        importanceBasis: "provider" as const,
        isKeyIndicator: true,
        indicatorKey: "cpi",
        affectedCurrencies: ["USD" as const],
        impactDirection: null,
        reason: "fallback",
      }]);
    },
  };
  const result = await calendarWithFallback(primary, fallback).calendar();
  assert.equal(fallbackCalls, 1);
  assert.equal(result.provider, "TEST");
  assert.equal(result.data?.[0]?.id, "fallback");
  assert.ok(result.warnings.some(w => w.includes("代替取得元")));
});

test("FinanceCalendar success does not continue to EODHD forbidden", async () => {
  let eodhdCalls = 0;
  const primary = createFinanceCalendar({
    fetcher: async () => Response.json(payload([row()])),
    now: () => now,
    cache: new ResourceCache(() => now),
  });
  const eodhdForbidden = {
    calendar: async () => {
      eodhdCalls++;
      return unavailable<EconomicEvent[]>("EODHD", "forbidden");
    },
  };
  const result = await calendarWithFallback(primary, eodhdForbidden).calendar();
  assert.equal(eodhdCalls, 0);
  assert.equal(result.provider, "FinanceCalendar");
  assert.equal(result.status, "ok");
  assert.equal(result.data?.[0]?.currency, "USD");
  assert.equal(result.error, null);
});

test("FinanceCalendar provider caches and does not invent secrets", async () => {
  let calls = 0;
  const provider = createFinanceCalendar({
    fetcher: async () => { calls++; return Response.json(payload([row()])); },
    now: () => now,
    cache: new ResourceCache(() => now),
  });
  await Promise.all([provider.calendar(), provider.calendar()]);
  assert.equal(calls, 1);
  const first = await provider.calendar();
  assert.equal(calls, 1);
  assert.ok(!JSON.stringify(first).toLowerCase().includes("api_key"));
});
