import type { CentralBank, DataResource, EconomicEvent, FundamentalData, NewsItem, SentimentData } from "../../lib/fundamental/types";
import type { Symbol } from "../../lib/market/types";

function resource<T>(data: T, now: number, provider: string): DataResource<T> {
  return { data, status: "ok", provider, fetchedAt: new Date(now).toISOString(), error: null, warnings: [] };
}

function emptyArray<T>(now: number, provider: string): DataResource<T[]> {
  return { data: [], status: "empty", provider, fetchedAt: new Date(now).toISOString(), error: null, warnings: [] };
}

function emptyObject<T>(now: number, provider: string): DataResource<T> {
  return { data: null, status: "empty", provider, fetchedAt: new Date(now).toISOString(), error: null, warnings: [] };
}

export function upcomingEvent(now = Date.now()): EconomicEvent {
  return {
    id: "e2e-cpi",
    name: "米CPI",
    country: "US",
    currency: "USD",
    scheduledAt: new Date(now + 3_600_000).toISOString(),
    rawScheduledAt: null,
    timezone: "UTC",
    previous: 3.0,
    forecast: 3.1,
    actual: null,
    unit: "%",
    status: "upcoming",
    source: "E2E",
    url: null,
    isKeyIndicator: true,
    affectedCurrencies: ["USD"],
    importance: "high",
    importanceBasis: "provider",
    impactDirection: null,
    reason: "provider importance",
  };
}

export function fundamentalFixture(symbol: Symbol, now = Date.now()): FundamentalData {
  const [baseCurrency, quoteCurrency] = symbol.split("/") as ["USD" | "EUR" | "GBP", "JPY"];
  const news: NewsItem[] = [];
  const calendar = symbol === "USD/JPY" ? [upcomingEvent(now)] : [];
  return {
    schemaVersion: 1,
    symbol,
    baseCurrency,
    quoteCurrency,
    generatedAt: new Date(now).toISOString(),
    news: resource(news, now, "E2E"),
    calendar: calendar.length ? resource(calendar, now, "E2E") : emptyArray<EconomicEvent>(now, "E2E"),
    macroeconomic: {
      data: [],
      status: "empty",
      provider: "FRED",
      fetchedAt: new Date(now).toISOString(),
      error: null,
      warnings: ["E2E does not convert FRED actuals into future events"],
    },
    centralBanks: emptyArray<CentralBank>(now, "E2E"),
    sentiment: emptyObject<SentimentData>(now, "E2E"),
    factors: [
      { currency: baseCurrency, newsIds: [], economicEventIds: calendar.map(event => event.id), centralBank: "TEST", impactDirection: null },
      { currency: quoteCurrency, newsIds: [], economicEventIds: [], centralBank: "BOJ", impactDirection: null },
    ],
  };
}
