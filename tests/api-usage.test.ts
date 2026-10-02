import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getApiUsageSnapshot, recordApiFailure, recordApiUsage } from "../lib/api-usage";
import { ResourceCache } from "../lib/fundamental/cache";
import { createFinnhub } from "../lib/fundamental/providers/finnhub";
import { createFred } from "../lib/fundamental/providers/fred";
import { FRED_SERIES_COUNT } from "../lib/fundamental/fred-series";
import { createFinanceCalendar } from "../lib/economic-calendar/providers/finance-calendar";
import { createEodhd } from "../lib/economic-calendar/providers/eodhd";
import { createTradingEconomics } from "../lib/economic-calendar/trading-economics";
import { calendarWithFallback } from "../lib/economic-calendar/service";
import { ProviderError } from "../lib/fundamental/resource";
import { createAnalysisService } from "../lib/ai/service";
import { createTextInterpreter } from "../lib/ai/interpret";
import { factorCategories } from "../lib/ai/types";
import { calculateIndicators } from "../lib/market/indicators";
import { timeframes, type MarketData, type Resource, type Technical, type Timeframe } from "../lib/market/types";
import type { FundamentalData } from "../lib/fundamental/types";

test("ResourceCache exposes request, hit, miss, dedupe and rate-limit counters", async () => {
  const before = getApiUsageSnapshot().providers.Finnhub;
  const cache = new ResourceCache();
  let requests = 0;
  const load = async () => {
    requests++;
    recordApiUsage("Finnhub", "request");
    return { items: ["fixture"], warnings: [] };
  };
  await Promise.all([
    cache.get("shared", 60_000, "Finnhub", load),
    cache.get("shared", 60_000, "Finnhub", load),
  ]);
  await cache.get("shared", 60_000, "Finnhub", load);
  await cache.get("limited", 60_000, "Finnhub", async () => {
    recordApiUsage("Finnhub", "request");
    recordApiFailure("Finnhub", true);
    throw new ProviderError("rate_limited");
  });

  const after = getApiUsageSnapshot().providers.Finnhub;
  assert.equal(requests, 1);
  assert.equal(after.requests - before.requests, 2);
  assert.equal(after.cacheHits - before.cacheHits, 1);
  assert.equal(after.cacheMisses - before.cacheMisses, 2);
  assert.equal(after.inFlightDedupes - before.inFlightDedupes, 1);
  assert.equal(after.rateLimited - before.rateLimited, 1);
  assert.equal(after.errors - before.errors, 1);
});

test("Finnhub counters track actual fetches across concurrent and cached reads", async () => {
  const before = getApiUsageSnapshot().providers.Finnhub;
  let fetches = 0;
  const provider = createFinnhub({ apiKey: "fixture-key", calendarEnabled: false, calendarAssumeUtc: true }, async () => {
    fetches++;
    return Response.json([]);
  });
  await Promise.all([provider.news(), provider.news(), provider.news()]);
  await provider.news();
  const after = getApiUsageSnapshot().providers.Finnhub;
  assert.equal(fetches, 1);
  assert.equal(after.requests - before.requests, 1);
  assert.equal(after.cacheMisses - before.cacheMisses, 1);
  assert.equal(after.inFlightDedupes - before.inFlightDedupes, 2);
  assert.equal(after.cacheHits - before.cacheHits, 1);
  assert.equal(after.successes - before.successes, 1);
});

test("10-minute fundamental polling stays within existing provider cache budgets", async () => {
  const start = Date.parse("2026-09-08T00:00:00.000Z");
  let clock = start;
  let finnhubRequests = 0, fredRequests = 0, financeCalendarRequests = 0, eodhdRequests = 0, tradingEconomicsRequests = 0;
  const before = getApiUsageSnapshot();
  const finnhub = createFinnhub({ apiKey: "fixture", calendarEnabled: true, calendarAssumeUtc: true }, async () => {
    finnhubRequests++;
    return Response.json([]);
  }, new ResourceCache(() => clock));
  const fred = createFred("fixture", async () => {
    fredRequests++;
    return Response.json({ observations: [{ date: "2026-09-07", value: "1.0" }, { date: "2026-08-07", value: "0.9" }] });
  }, new ResourceCache(() => clock), () => clock);
  const financeCalendar = createFinanceCalendar({
    now: () => clock,
    cache: new ResourceCache(() => clock),
    fetcher: async () => {
      financeCalendarRequests++;
      return Response.json({ from: "2026-09-08", to: "2026-09-22", count: 0, events: [], attribution: { source: "financecalendar.com", terms: "test", docs: "https://www.financecalendar.com/api/" } });
    },
  });
  const eodhd = createEodhd("fixture", { now: () => clock, cache: new ResourceCache(() => clock), fetcher: async () => { eodhdRequests++; return Response.json([]); } });
  const tradingEconomics = createTradingEconomics("fixture", async () => { tradingEconomicsRequests++; return Response.json([]); }, () => clock, new ResourceCache(() => clock));
  const calendar = calendarWithFallback(financeCalendar, calendarWithFallback(eodhd, calendarWithFallback(tradingEconomics, finnhub)));

  for (let minute = 0; minute < 10; minute++) {
    clock = start + minute * 60_000;
    await Promise.all([finnhub.news(), fred.macroeconomic(), calendar.calendar()]);
  }

  const after = getApiUsageSnapshot();
  assert.equal(finnhubRequests, 1);
  assert.equal(fredRequests, FRED_SERIES_COUNT);
  assert.equal(financeCalendarRequests, 1);
  assert.equal(eodhdRequests, 0);
  assert.equal(tradingEconomicsRequests, 0);
  assert.equal(after.providers.Finnhub.requests - before.providers.Finnhub.requests, 1);
  assert.equal(after.providers.FRED.requests - before.providers.FRED.requests, FRED_SERIES_COUNT);
  assert.equal(after.providers.FinanceCalendar.requests - before.providers.FinanceCalendar.requests, 1);
  assert.equal(after.providers.EODHD.requests - before.providers.EODHD.requests, 0);
  assert.equal(after.providers["Trading Economics"].requests - before.providers["Trading Economics"].requests, 0);
});

test("10-minute analysis cache makes two mocked OpenAI calls and no duplicate calls", async () => {
  const start = Date.parse("2026-09-08T00:00:00.000Z");
  let clock = start;
  const before = getApiUsageSnapshot();
  const durations: Record<Timeframe, number> = { "15m": 900_000, "1h": 3_600_000, "4h": 14_400_000 };
  const marketResource = <T,>(data: T, fetchedAt: string): Resource<T> => ({ data, fetchedAt, stale: false, error: null });
  const market = (): MarketData => {
    const fetchedAt = new Date(clock).toISOString();
    return {
      symbol: "USD/JPY",
      price: { data: 150.125, fetchedAt, stale: false, error: null },
      timeframes: Object.fromEntries(timeframes.map(frame => {
        const candles = Array.from({ length: 220 }, (_, index) => {
          const close = 150 + index * 0.001;
          return { time: new Date(clock - (220 - index) * durations[frame]).toISOString(), open: close, high: close + 0.01, low: close - 0.01, close };
        });
        return [frame, marketResource<Technical>({ candles, indicators: calculateIndicators(candles), lastClosedAt: candles.at(-1)!.time }, fetchedAt)];
      })) as MarketData["timeframes"],
    };
  };
  const fundamental = (): FundamentalData => {
    const fetchedAt = new Date(clock).toISOString();
    const empty = { data: [], status: "empty" as const, provider: "mock", fetchedAt, stale: false, error: null, warnings: [] };
    return {
      schemaVersion: 1, symbol: "USD/JPY", baseCurrency: "USD", quoteCurrency: "JPY", generatedAt: fetchedAt, factors: [],
      news: empty, calendar: empty,
      macroeconomic: { data: null, status: "unavailable", provider: "FRED", fetchedAt: null, stale: false, error: { code: "not_configured", message: "not configured" }, warnings: [] },
      centralBanks: { ...empty, status: "unavailable", data: [] },
      sentiment: { data: null, status: "unavailable", provider: "mock", fetchedAt: null, stale: false, error: null, warnings: [] },
    };
  };
  const modelJson = JSON.stringify({
    summary: "Mocked analysis.",
    factors: factorCategories.map(category => ({ category, title: category, direction: "unknown", impact: "low", reason: "No directional evidence.", source: "mock", evidenceIds: [] })),
    bullishReasons: [], bearishReasons: [], riskWarnings: [], confidence: 40, contradictions: false, preferWait: true,
    scenarioComment: "Wait for conditions.", entryTrigger: null,
  });
  const text = createTextInterpreter({
    env: { AI_PROVIDER: "openai", OPENAI_API_KEY: "fixture", OPENAI_ANALYSIS_MODEL: "fixture-model" },
    fetcher: async () => Response.json({ status: "completed", model: "fixture-model", output: [{ type: "message", content: [{ type: "output_text", text: modelJson }] }] }),
  });
  const service = createAnalysisService({ market: async () => market(), fundamental: async () => fundamental(), interpret: text.interpret, enabled: text.enabled, provider: text.provider, model: text.model, now: () => clock });
  for (let minute = 0; minute < 10; minute++) {
    clock = start + minute * 60_000;
    await service("USD/JPY");
  }
  const after = getApiUsageSnapshot();
  assert.equal(after.providers.OpenAI.requests - before.providers.OpenAI.requests, 2);
  assert.equal(after.providers.OpenAI.calls - before.providers.OpenAI.calls, 2);
  assert.equal(after.providers.OpenRouter.requests - before.providers.OpenRouter.requests, 0);
});

test("usage snapshots are process-scoped and contain no request data", () => {
  recordApiUsage("OpenRouter", "call");
  recordApiUsage("OpenRouter", "fallback");
  const snapshot = getApiUsageSnapshot();
  assert.equal(snapshot.scope, "process");
  assert.equal(snapshot.providers.OpenRouter.calls, 1);
  assert.equal(snapshot.providers.OpenRouter.fallbacks, 1);
  assert.doesNotMatch(JSON.stringify(snapshot), /api[_-]?key|authorization|request body/i);
  const route = readFileSync("app/api/api-usage/route.ts", "utf8");
  assert.match(route, /NODE_ENV === "production"/);
  assert.doesNotMatch(route, /fetch\(|setInterval/);
});