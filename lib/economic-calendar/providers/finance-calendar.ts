import { ResourceCache } from "../../fundamental/cache";
import { ProviderError } from "../../fundamental/resource";
import type { EconomicEvent } from "../../fundamental/types";
import type { EconomicCalendarProvider } from "../provider";
import { normalizeFinanceCalendar } from "../finance-calendar-normalize";
import { calendarTtl } from "../risk-window";

export const FINANCE_CALENDAR_URL = "https://www.financecalendar.com/wp-json/fc/v1/calendar";
export const FINANCE_CALENDAR_SITE = "https://www.financecalendar.com";

/** Free edge-cached calendar. No API key. Server-side only. */
export function createFinanceCalendar(options: {
  fetcher?: typeof fetch;
  now?: () => number;
  cache?: ResourceCache;
  url?: string;
} = {}): EconomicCalendarProvider {
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? Date.now;
  const cache = options.cache ?? new ResourceCache(now);
  const url = options.url ?? FINANCE_CALENDAR_URL;
  return {
    async calendar() {
      return cache.get("finance-calendar", calendarTtl, "FinanceCalendar", async () => {
        let response: Response;
        try {
          response = await fetcher(url, {
            cache: "no-store",
            redirect: "error",
            signal: AbortSignal.timeout(10_000),
            headers: { Accept: "application/json" },
          });
        } catch {
          throw new ProviderError("network");
        }
        if (response.status === 429) throw new ProviderError("rate_limited");
        if (!response.ok) throw new ProviderError("network");
        try {
          return normalizeFinanceCalendar(await response.json(), now());
        } catch {
          throw new ProviderError("invalid_response");
        }
      });
    },
  };
}
