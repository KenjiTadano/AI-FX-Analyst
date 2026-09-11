import { ResourceCache } from "../fundamental/cache";
import { ProviderError, unavailable } from "../fundamental/resource";
import type { EconomicEvent } from "../fundamental/types";
import type { EconomicCalendarProvider } from "./provider";
import { normalizeTradingEconomics } from "./normalize";
import { calendarTtl } from "./risk-window";
export function createTradingEconomics(apiKey: string, fetcher: typeof fetch = fetch, now = Date.now, cache = new ResourceCache(now)): EconomicCalendarProvider {
  return { async calendar() {
    if (!apiKey) return unavailable<EconomicEvent[]>("Trading Economics", "not_configured");
    return cache.get("te-calendar", calendarTtl, "Trading Economics", async () => {
      const date = (offset: number) => new Date(now() + offset * 86_400_000).toISOString().slice(0, 10);
      const countries = "united states,japan,euro area,united kingdom".split(",").map(encodeURIComponent).join(",");
      const url = `https://api.tradingeconomics.com/calendar/country/${countries}/${date(-1)}/${date(7)}?f=json`;
      let response: Response;
      try { response = await fetcher(url, { headers: { Authorization: apiKey }, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(10_000) }); }
      catch { throw new ProviderError("network"); }
      if ([401, 403, 429].includes(response.status)) throw new ProviderError(response.status === 401 ? "unauthorized" : response.status === 403 ? "forbidden" : "rate_limited");
      if (!response.ok) throw new ProviderError("network");
      try { return normalizeTradingEconomics(await response.json(), now()); } catch { throw new ProviderError("invalid_response"); }
    });
  } };
}
