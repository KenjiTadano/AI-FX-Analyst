import { ResourceCache } from "../../fundamental/cache";
import { ProviderError, unavailable } from "../../fundamental/resource";
import type { EconomicEvent } from "../../fundamental/types";
import type { EconomicCalendarProvider } from "../provider";
import { normalizeEodhd } from "../eodhd-normalize";
import { calendarTtl } from "../risk-window";

export const EODHD_COUNTRIES = { USD: "US", JPY: "JP", GBP: "GB" } as const;
export type EodhdErrorLog = { provider: "EODHD"; country: string; httpStatus: number | null; code: string };
export function createEodhd(apiToken: string, options: { fetcher?: typeof fetch; now?: () => number; cache?: ResourceCache; euroCountry?: string; assumeUtc?: boolean; onError?: (entry: EodhdErrorLog) => void } = {}): EconomicCalendarProvider {
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? Date.now;
  const cache = options.cache ?? new ResourceCache(now);
  const euroCountry = options.euroCountry?.trim().toUpperCase() || "EU";
  return { async calendar() {
    if (!apiToken) return unavailable<EconomicEvent[]>("EODHD", "not_configured");
    return cache.get("eodhd-calendar", calendarTtl, "EODHD", async () => {
      const from = new Date(now() - 86_400_000).toISOString().slice(0, 10);
      const to = new Date(now() + 8 * 86_400_000).toISOString().slice(0, 10);
      const countries = [...Object.values(EODHD_COUNTRIES), euroCountry];
      const batches = await Promise.all(countries.map(async country => {
        const url = new URL("https://eodhd.com/api/economic-events");
        url.searchParams.set("api_token", apiToken); url.searchParams.set("from", from); url.searchParams.set("to", to); url.searchParams.set("country", country); url.searchParams.set("fmt", "json");
        let response: Response;
        try { response = await fetcher(url.toString(), { cache: "no-store", redirect: "error", signal: AbortSignal.timeout(10_000) }); } catch { options.onError?.({ provider: "EODHD", country, httpStatus: null, code: "network" }); throw new ProviderError("network"); }
        const code = response.status === 401 ? "unauthorized" : response.status === 403 ? "forbidden" : response.status === 429 ? "rate_limited" : response.status >= 500 ? "network" : !response.ok ? "network" : null;
        if (code) { options.onError?.({ provider: "EODHD", country, httpStatus: response.status, code }); throw new ProviderError(code as "unauthorized" | "forbidden" | "rate_limited" | "network"); }
        try { return normalizeEodhd(await response.json(), now(), options.assumeUtc ?? true).items; } catch { options.onError?.({ provider: "EODHD", country, httpStatus: response.status, code: "invalid_response" }); throw new ProviderError("invalid_response"); }
      }));
      return { items: batches.flat(), warnings: euroCountry === "EU" ? ["EODHDのEuro Areaコードは契約レスポンスで確認できるまでEUとして設定しています。"] : [] };
    });
  } };
}
