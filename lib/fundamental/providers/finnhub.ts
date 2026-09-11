import { calendarTtl } from "../../economic-calendar/risk-window";
import { ResourceCache, cachePolicy } from "../cache";
import { normalizeCalendar, normalizeNews } from "../normalize";
import { ProviderError, unavailable } from "../resource";
import type { EconomicEvent, NewsItem } from "../types";

export interface FinnhubConfig {
  apiKey: string;
  calendarEnabled: boolean;
  calendarAssumeUtc: boolean;
  // Injection seam for a future release-window refresh policy.
  calendarTtlMs?: number;
}
export function createFinnhub(config: FinnhubConfig, fetcher: typeof fetch = fetch, cache = new ResourceCache()) {
  async function request(path: string, params: Record<string, string>): Promise<unknown> {
    const url = new URL(`https://finnhub.io/api/v1/${path}`);
    url.search = new URLSearchParams(params).toString();
    let response: Response;
    try {
      response = await fetcher(url, { headers: { "X-Finnhub-Token": config.apiKey }, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(10_000) });
    } catch { throw new ProviderError("network"); }
    if (response.status === 401) throw new ProviderError("unauthorized");
    if (response.status === 403) throw new ProviderError("forbidden");
    if (response.status === 429) throw new ProviderError("rate_limited");
    if (!response.ok) throw new ProviderError("network");
    let body: unknown;
    try { body = await response.json(); } catch { throw new ProviderError("invalid_response"); }
    if (body && typeof body === "object" && "error" in body) throw new ProviderError("invalid_response");
    return body;
  }
  return {
    async news() {
      if (!config.apiKey) return unavailable<NewsItem[]>("Finnhub", "not_configured");
      return cache.get("news", cachePolicy.newsMs, "Finnhub", async () => {
        const body = await request("news", { category: "forex" });
        try { return normalizeNews(body); } catch { throw new ProviderError("invalid_response"); }
      });
    },
    async calendar() {
      if (!config.calendarEnabled) return unavailable<EconomicEvent[]>("Finnhub", "disabled");
      if (!config.apiKey) return unavailable<EconomicEvent[]>("Finnhub", "not_configured");
      return cache.get("calendar", config.calendarTtlMs ?? calendarTtl, "Finnhub", async () => {
        const now = Date.now();
        const date = (offset: number) => new Date(now + offset * 86_400_000).toISOString().slice(0, 10);
        const body = await request("calendar/economic", { from: date(-1), to: date(7) });
        try { return normalizeCalendar(body, now, config.calendarAssumeUtc); } catch { throw new ProviderError("invalid_response"); }
      });
    },
  };
}
