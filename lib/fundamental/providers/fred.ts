import { ResourceCache, cachePolicy } from "../cache";
import { FRED_SERIES, type FredSeriesDefinition } from "../fred-series";
import { ProviderError, unavailable } from "../resource";
import type { EconomicIndicatorValue, ErrorCode, NormalizedBatch } from "../types";

type FredObservation = { date?: unknown; value?: unknown };
type FredObservationsBody = { observations?: unknown; error_code?: unknown; error_message?: unknown };

function parseObservationValue(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed === ".") return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

function parseObservationDate(raw: unknown): string | null {
  if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const ms = Date.parse(`${raw}T00:00:00Z`);
  return Number.isFinite(ms) ? raw : null;
}

function ageDays(observationDate: string | null, now: number): number | null {
  if (!observationDate) return null;
  const ms = Date.parse(`${observationDate}T00:00:00Z`);
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.floor((now - ms) / 86_400_000));
}

export function pickLatestPrevious(observations: FredObservation[]): {
  value: number | null;
  previousValue: number | null;
  observationDate: string | null;
  previousObservationDate: string | null;
} {
  const valid: { date: string; value: number }[] = [];
  for (const row of observations) {
    const date = parseObservationDate(row.date);
    const value = parseObservationValue(row.value);
    if (date === null || value === null) continue;
    valid.push({ date, value });
  }
  valid.sort((a, b) => b.date.localeCompare(a.date));
  const latest = valid[0] ?? null;
  const previous = valid[1] ?? null;
  return {
    value: latest?.value ?? null,
    previousValue: previous?.value ?? null,
    observationDate: latest?.date ?? null,
    previousObservationDate: previous?.date ?? null,
  };
}

export function toIndicator(def: FredSeriesDefinition, observations: FredObservation[], now: number, updatedAt: string): EconomicIndicatorValue {
  const picked = pickLatestPrevious(observations);
  const days = ageDays(picked.observationDate, now);
  return {
    id: def.id,
    name: def.name,
    shortName: def.shortName,
    country: "US",
    currency: "USD",
    seriesId: def.seriesId,
    seriesTitle: def.seriesTitle,
    value: picked.value,
    previousValue: picked.previousValue,
    unit: def.displayUnit,
    frequency: def.frequency,
    observationDate: picked.observationDate,
    previousObservationDate: picked.previousObservationDate,
    category: def.category,
    seasonalAdjustment: def.seasonalAdjustment,
    transformation: def.transformation,
    source: "FRED",
    sourceUrl: `https://fred.stlouisfed.org/series/${def.seriesId}`,
    updatedAt,
    stale: days !== null && days > def.staleAfterDays,
    ageDays: days,
  };
}

function classifyHttp(status: number): ErrorCode {
  if (status === 400) return "invalid_response";
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "network";
  return "network";
}

export function createFred(apiKey: string, fetcher: typeof fetch = fetch, cache = new ResourceCache(), now: () => number = Date.now) {
  async function fetchSeries(def: FredSeriesDefinition): Promise<EconomicIndicatorValue> {
    const url = new URL("https://api.stlouisfed.org/fred/series/observations");
    url.searchParams.set("series_id", def.seriesId);
    url.searchParams.set("api_key", apiKey);
    url.searchParams.set("file_type", "json");
    url.searchParams.set("sort_order", "desc");
    url.searchParams.set("limit", "8");
    if (def.transformation !== "lin") url.searchParams.set("units", def.transformation);
    let response: Response;
    try {
      response = await fetcher(url.toString(), { cache: "no-store", redirect: "error", signal: AbortSignal.timeout(10_000) });
    } catch (error) {
      if (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name)) throw new ProviderError("network");
      throw new ProviderError("network");
    }
    if (!response.ok) throw new ProviderError(classifyHttp(response.status));
    let body: FredObservationsBody;
    try { body = await response.json() as FredObservationsBody; } catch { throw new ProviderError("invalid_response"); }
    if (body && typeof body === "object" && (body.error_code != null || typeof body.error_message === "string")) throw new ProviderError("invalid_response");
    if (!Array.isArray(body.observations)) throw new ProviderError("invalid_response");
    const updatedAt = new Date(now()).toISOString();
    const indicator = toIndicator(def, body.observations as FredObservation[], now(), updatedAt);
    if (indicator.value === null || indicator.observationDate === null) throw new ProviderError("invalid_response");
    return indicator;
  }

  return {
    async macroeconomic() {
      if (!apiKey) return unavailable<EconomicIndicatorValue[]>("FRED", "not_configured");
      return cache.get("fred-macro", cachePolicy.macroMs, "FRED", async (): Promise<NormalizedBatch<EconomicIndicatorValue>> => {
        const settled = await Promise.allSettled(FRED_SERIES.map(def => fetchSeries(def)));
        const items: EconomicIndicatorValue[] = [];
        const warnings: string[] = [];
        let fatal: ProviderError | null = null;
        settled.forEach((result, index) => {
          const def = FRED_SERIES[index]!;
          if (result.status === "fulfilled") {
            items.push(result.value);
            return;
          }
          const code = result.reason instanceof ProviderError ? result.reason.code : "network";
          if (!fatal) fatal = new ProviderError(code);
          warnings.push(`${def.name}（${def.seriesId}）を取得できませんでした。`);
        });
        if (!items.length) throw fatal ?? new ProviderError("network");
        return { items, warnings };
      });
    },
  };
}
