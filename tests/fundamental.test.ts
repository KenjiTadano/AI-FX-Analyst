import test from "node:test";
import assert from "node:assert/strict";
import { normalizeNews, normalizeCalendar, calendarTime, eventStatus, safeUrl } from "../lib/fundamental/normalize";
import { createFinnhub } from "../lib/fundamental/providers/finnhub";
import { ResourceCache } from "../lib/fundamental/cache";
import { ProviderError } from "../lib/fundamental/resource";
import { assembleFundamentals } from "../lib/fundamental/service";
import { getCentralBanks } from "../lib/fundamental/central-banks";
import { getSentiment } from "../lib/fundamental/sentiment";
import { relatedCurrencies, classifyImportance } from "../lib/fundamental/classification";
import { calculateIndicators } from "../lib/market/indicators";
import type { FundamentalProviders, NewsItem, EconomicEvent, DataResource } from "../lib/fundamental/types";

const now = Date.parse("2026-09-08T00:00:00Z");
// Synthetic values are used only in tests, never as production fallbacks.
const article = { headline: "Fed and BOJ interest rate decision", summary: "Policy announcement", datetime: now / 1000, source: "TEST FIXTURE", url: "https://example.com/test-news" };
const event = { event: "US CPI", country: "US", time: "2026-09-08 12:30:00", actual: null, estimate: 2.8, prev: 2.7, impact: "high", unit: "%" };
const ok = <T>(data: T): DataResource<T> => ({ data, status: "ok", provider: "test", fetchedAt: new Date(now).toISOString(), error: null, warnings: [] });
function providers(news: NewsItem[] = [], events: EconomicEvent[] = []): FundamentalProviders {
  return { news: async () => ok(news), calendar: async () => ok(events), centralBanks: getCentralBanks, sentiment: getSentiment };
}
const config = { apiKey: "test-secret-not-a-real-key", calendarEnabled: true, calendarAssumeUtc: true };

test("normalizes news, deduplicates URLs, and leaves impact unassessed", () => {
  const result = normalizeNews([article, article]);
  assert.equal(result.items.length, 1);
  assert.deepEqual(result.items[0].currencies, ["USD", "JPY"]);
  assert.equal(result.items[0].impactDirection, null);
  assert.equal(result.items[0].importance, "high");
  assert.equal(result.items[0].importanceBasis, "keyword");
  assert.equal(result.items[0].publishedAt, "2026-09-08T00:00:00.000Z");
});
test("classifies all four currencies without matching unrelated word fragments", () => {
  assert.deepEqual(relatedCurrencies("ECB and BOE meet BOJ and FOMC"), ["USD", "JPY", "EUR", "GBP"]);
  assert.deepEqual(relatedCurrencies("The company fed its customers"), ["USD"]); // Keyword classifier has documented false positives.
  assert.deepEqual(relatedCurrencies("usable feedback"), []);
  for (const indicator of ["Core CPI", "Nonfarm Payrolls", "Unemployment Rate", "PCE", "GDP", "Retail Sales", "ISM", "FOMC", "BOJ interest rate decision", "Japan wages", "UK employment"]) assert.equal(classifyImportance(indicator), "high");
});
test("rejects unsafe links, invalid dates and malformed payloads without leaking data", () => {
  assert.equal(safeUrl("javascript:alert(1)"), null);
  assert.equal(safeUrl("https://name:secret@example.com"), null);
  assert.throws(() => normalizeNews({ error: "test-secret" }));
  assert.throws(() => normalizeNews([{ ...article, datetime: "bad" }]));
  const result = normalizeNews([article, { ...article, url: "javascript:alert(1)" }]);
  assert.equal(result.items.length, 1);
  assert.equal(result.warnings.length, 1);
});
test("calendar preserves zero/negative readings and null missing values", () => {
  const [item] = normalizeCalendar({ economicCalendar: [{ ...event, actual: 0, prev: -0.1, estimate: "" }] }, now, true).items;
  assert.equal(item.actual, 0);
  assert.equal(item.previous, -0.1);
  assert.equal(item.forecast, null);
  assert.equal(item.status, "released");
  assert.equal(item.scheduledAt, "2026-09-08T12:30:00.000Z");
  assert.equal(item.impactDirection, null);
});
test("does not invent timezone, actual readings, or released state", () => {
  const [item] = normalizeCalendar({ economicCalendar: [event] }, now).items;
  assert.equal(item.scheduledAt, null);
  assert.equal(item.rawScheduledAt, event.time);
  assert.equal(item.status, "unknown");
  assert.equal(calendarTime("2026-09-08T21:30:00+09:00").iso, "2026-09-08T12:30:00.000Z");
  assert.equal(eventStatus({ actual: null, scheduledAt: "2026-09-08T00:00:00Z" }, now), "awaiting_actual");
  assert.equal(eventStatus({ actual: null, scheduledAt: "2026-09-08T01:00:00Z" }, now), "upcoming");
});
test("normalizes country mapping and excludes unrelated economies", () => {
  const rows = ["US", "JP", "EU", "GB", "DE", "AU"].map(country => ({ ...event, country }));
  assert.deepEqual(normalizeCalendar({ economicCalendar: rows }, now).items.map(item => item.currency), ["USD", "JPY", "EUR", "GBP", "EUR"]);
});
test("missing keys / disabled calendar make zero external requests", async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => { calls++; throw new Error("should not fetch"); };
  const api = createFinnhub({ ...config, apiKey: "", calendarEnabled: false }, fetcher);
  assert.equal((await api.news()).error?.code, "not_configured");
  assert.equal((await api.calendar()).error?.code, "disabled");
  assert.equal(calls, 0);
});
test("uses header auth, shared normalized caches, and bounded timeout", async () => {
  let calls = 0;
  const fetcher: typeof fetch = async (input, init) => {
    calls++;
    assert.ok(!String(input).includes(config.apiKey));
    assert.equal(new Headers(init?.headers).get("X-Finnhub-Token"), config.apiKey);
    assert.equal(init?.redirect, "error");
    assert.ok(init?.signal);
    return Response.json([article]);
  };
  const api = createFinnhub(config, fetcher);
  const results = await Promise.all([api.news(), api.news(), api.news()]);
  assert.equal(calls, 1);
  assert.equal(results[0].data?.length, 1);
  assert.equal((await api.news()).status, "ok");
  assert.equal(calls, 1);
});
for (const [http, code] of [[401, "unauthorized"], [403, "forbidden"], [429, "rate_limited"], [500, "network"]] as const) {
  test(`HTTP ${http} is isolated, sanitized and cached`, async () => {
    let calls = 0;
    const api = createFinnhub(config, async () => { calls++; return Response.json({ error: config.apiKey }, { status: http }); });
    const result = await api.news();
    assert.equal(result.error?.code, code);
    assert.equal(result.data, null);
    assert.ok(!JSON.stringify(result).includes(config.apiKey));
    await api.news();
    assert.equal(calls, 1);
  });
}
test("invalid JSON, HTTP 200 errors and network exceptions never become successful empty feeds", async () => {
  const fetchers: (typeof fetch)[] = [async () => new Response("not-json"), async () => Response.json({ error: "private-token" }), async () => { throw new Error("private-token"); }];
  for (const fetcher of fetchers) {
    const result = await createFinnhub(config, fetcher).news();
    assert.equal(result.status, "error");
    assert.equal(result.data, null);
    assert.ok(!JSON.stringify(result).includes("private-token"));
  }
});
test("calendar provider sends bounded dates and normalizes successful data", async () => {
  const api = createFinnhub(config, async input => {
    const url = new URL(String(input));
    assert.equal(url.pathname, "/api/v1/calendar/economic");
    assert.equal(Date.parse(url.searchParams.get("to")!) - Date.parse(url.searchParams.get("from")!), 8 * 86_400_000);
    return Response.json({ economicCalendar: [event] });
  });
  assert.equal((await api.calendar()).data?.[0].forecast, 2.8);
});
test("cache expires, suppresses failure retries and recovers without serving stale data", async () => {
  let time = now, calls = 0;
  const cache = new ResourceCache(() => time);
  const loader = async () => { calls++; return { items: [1], warnings: [] }; };
  await cache.get("a", 1000, "test", loader);
  time += 999;
  await cache.get("a", 1000, "test", loader);
  assert.equal(calls, 1);
  time++;
  const failed = await cache.get("a", 1000, "test", async () => { throw new ProviderError("network"); });
  assert.equal(failed.data, null);
  assert.equal(failed.fetchedAt, null);
  time += 59_999;
  assert.equal((await cache.get("a", 1000, "test", loader)).status, "error");
  time++;
  assert.equal((await cache.get("a", 1000, "test", loader)).status, "ok");
  assert.equal(calls, 2);
});
test("each pair receives only relevant currencies and excludes old/future news", async () => {
  const rows = ["USD Fed", "JPY BOJ", "EUR ECB", "GBP BOE"].map((headline, index) => ({ ...article, headline, url: `https://example.com/${index}` }));
  rows.push({ ...article, datetime: (now - 8 * 86_400_000) / 1000, url: "https://example.com/old" });
  rows.push({ ...article, datetime: (now + 86_400_000) / 1000, url: "https://example.com/future" });
  const source = providers(normalizeNews(rows).items);
  for (const pair of ["USD/JPY", "EUR/JPY", "GBP/JPY"] as const) {
    const result = await assembleFundamentals(pair, source, now);
    assert.equal(result.news.data?.length, 2);
    assert.deepEqual(result.factors.map(item => item.currency), pair.split("/"));
    assert.ok(result.factors.every(item => item.impactDirection === null));
  }
});
test("failure of one provider does not break other materials; synchronous throws also isolated", async () => {
  const source = providers([], normalizeCalendar({ economicCalendar: [event] }, now, true).items);
  source.news = () => { throw new Error("private-token"); };
  source.sentiment = async () => { throw new Error("down"); };
  const result = await assembleFundamentals("USD/JPY", source, now);
  assert.equal(result.news.status, "error");
  assert.equal(result.calendar.data?.length, 1);
  assert.equal(result.sentiment.status, "error");
  assert.equal(result.centralBanks.data?.length, 2);
  assert.ok(!JSON.stringify(result).includes("private-token"));
});
test("re-evaluates release state after a cached scheduled time passes", async () => {
  const source = providers([], normalizeCalendar({ economicCalendar: [event] }, now, true).items);
  const data = await assembleFundamentals("USD/JPY", source, now + 13 * 60 * 60_000);
  assert.equal(data.calendar.data?.[0].status, "awaiting_actual");
});
test("central bank rates stay unavailable and sentiment is not fabricated as neutral", async () => {
  const data = await assembleFundamentals("EUR/JPY", providers(), now);
  assert.equal(data.centralBanks.data?.[0].abbreviation, "ECB");
  assert.ok(data.centralBanks.data?.every(bank => bank.policyRate.value === null && bank.policyDirection.value === null));
  assert.equal(data.sentiment.data?.market.value, null);
  assert.ok(data.sentiment.data?.currencies.every(currency => currency.sentiment.value === null));
});
test("existing Task003 technical calculation still handles a known uptrend", () => {
  const candles = Array.from({ length: 220 }, (_, i) => ({ time: new Date(now + i * 60_000).toISOString(), open: 100 + i, high: 102 + i, low: 99 + i, close: 101 + i }));
  const result = calculateIndicators(candles);
  assert.equal(result.trend, "bullish");
  assert.equal(result.sma20, 310.5);
  assert.equal(result.rsi14, 100);
});

test("rejects impossible calendar dates and overflowing numeric strings", () => {
  assert.equal(calendarTime("2026-02-30 12:30:00", true).iso, null);
  assert.equal(calendarTime("2026-09-08 24:30:00", true).iso, null);
  const [item] = normalizeCalendar({ economicCalendar: [{ ...event, actual: "9".repeat(400) }] }, now, true).items;
  assert.equal(item.actual, null);
});
test("links a confirmed future bank meeting but never interprets its forecast as current policy rate", async () => {
  const events = normalizeCalendar({ economicCalendar: [{ ...event, event: "Fed interest rate decision" }] }, now, true).items;
  const data = await assembleFundamentals("USD/JPY", providers(normalizeNews([article]).items, events), now);
  const bank = data.centralBanks.data![0];
  assert.equal(bank.nextMeeting.value, "2026-09-08T12:30:00.000Z");
  assert.equal(bank.relatedNewsIds.length, 1);
  assert.equal(bank.policyRate.value, null);
});
test("an aborted provider request becomes a retryable network error", async () => {
  const api = createFinnhub(config, async () => { throw new DOMException("test timeout", "TimeoutError"); });
  const result = await api.news();
  assert.equal(result.error?.code, "network");
  assert.equal(result.data, null);
});
