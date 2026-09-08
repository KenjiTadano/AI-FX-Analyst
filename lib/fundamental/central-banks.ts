import { bankPatterns } from "./classification";
import type { CentralBank, Currency, DataResource, EconomicEvent, NewsItem, Observation } from "./types";

export const bankNames: Record<Currency, { name: string; abbreviation: string }> = {
  USD: { name: "Federal Reserve", abbreviation: "Fed" },
  JPY: { name: "Bank of Japan", abbreviation: "BOJ" },
  EUR: { name: "European Central Bank", abbreviation: "ECB" },
  GBP: { name: "Bank of England", abbreviation: "BOE" },
};
export function missing<T>(reason: string): Observation<T> {
  return { value: null, availability: "unavailable", asOf: null, source: null, reason };
}
export async function getCentralBanks({ currencies, news, calendar }: { currencies: Currency[]; news: DataResource<NewsItem[]>; calendar: DataResource<EconomicEvent[]> }): Promise<DataResource<CentralBank[]>> {
  const data = currencies.map((currency): CentralBank => {
    const next = calendar.data?.filter(event => event.currency === currency && event.status === "upcoming" && event.scheduledAt && bankPatterns[currency].test(event.name) && /rate decision|monetary policy|政策金利|金融政策|会合/i.test(event.name)).sort((a, b) => a.scheduledAt!.localeCompare(b.scheduledAt!))[0];
    return {
      currency, ...bankNames[currency],
      // Calendar releases are not a reliable snapshot of the currently effective policy rate.
      policyRate: missing("現行政策金利の取得元は未接続です。"),
      policyDirection: missing("金融政策の方向は未評価です。"),
      nextMeeting: next ? { value: next.scheduledAt, availability: "available", source: calendar.provider, asOf: calendar.fetchedAt, reason: `カレンダーの金融政策イベント: ${next.name}` } : missing("取得範囲内で日時を確認できる金融政策会合がありません。"),
      relatedNewsIds: (news.data ?? []).filter(item => bankPatterns[currency].test(`${item.title} ${item.summary ?? ""}`)).map(item => item.id),
    };
  });
  return { data, provider: "calendar/news linkage", status: data.some(bank => bank.nextMeeting.value || bank.relatedNewsIds.length) ? "ok" : "unavailable", fetchedAt: calendar.fetchedAt ?? news.fetchedAt, error: null, warnings: ["政策金利・政策方向は未取得です。会合情報は取得範囲内の候補のみです。"] };
}
