import { bankNames } from "./central-banks";
import { eventStatus } from "./normalize";
import { settled } from "./resource";
import type { Currency, DataResource, FundamentalData, FundamentalProviders } from "./types";
import type { Symbol } from "../market/types";

function filterResource<T>(resource: DataResource<T[]>, predicate: (item: T) => boolean): DataResource<T[]> {
  if (resource.data === null) return resource;
  const data = resource.data.filter(predicate);
  return { ...resource, data, status: resource.status === "ok" || resource.status === "empty" ? data.length ? "ok" : "empty" : resource.status };
}
export async function assembleFundamentals(symbol: Symbol, providers: FundamentalProviders, now = Date.now()): Promise<FundamentalData> {
  const [baseCurrency, quoteCurrency] = symbol.split("/") as [Currency, Currency];
  const currencies = [baseCurrency, quoteCurrency];
  const [newsResult, calendarResult] = await Promise.allSettled([
    Promise.resolve().then(() => providers.news()), Promise.resolve().then(() => providers.calendar()),
  ]);
  const news = filterResource(settled(newsResult, "news"), item => item.currencies.some(currency => currencies.includes(currency)) && Date.parse(item.publishedAt) <= now && Date.parse(item.publishedAt) >= now - 7 * 86_400_000);
  const calendar = filterResource(settled(calendarResult, "calendar"), event => currencies.includes(event.currency));
  // Re-evaluate temporal state even when values came from cache; elapsed time is not proof of release.
  if (calendar.data) calendar.data = calendar.data.map(event => ({ ...event, status: eventStatus(event, now) }));
  const [bankResult, sentimentResult] = await Promise.allSettled([
    Promise.resolve().then(() => providers.centralBanks({ currencies, news, calendar })),
    Promise.resolve().then(() => providers.sentiment(currencies)),
  ]);
  return {
    schemaVersion: 1, symbol, baseCurrency, quoteCurrency, generatedAt: new Date(now).toISOString(), news, calendar,
    centralBanks: settled(bankResult, "centralBanks"), sentiment: settled(sentimentResult, "sentiment"),
    factors: currencies.map(currency => ({ currency, newsIds: (news.data ?? []).filter(item => item.currencies.includes(currency)).map(item => item.id), economicEventIds: (calendar.data ?? []).filter(event => event.currency === currency).map(event => event.id), centralBank: bankNames[currency].abbreviation, impactDirection: null })),
  };
}
