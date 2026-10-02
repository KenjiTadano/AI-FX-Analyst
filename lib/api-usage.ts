export const apiUsageProviders = [
  "Twelve Data",
  "Finnhub",
  "FRED",
  "FinanceCalendar",
  "EODHD",
  "Trading Economics",
  "OpenRouter",
  "OpenAI",
] as const;

export type ApiUsageProvider = (typeof apiUsageProviders)[number];
type ApiUsageEvent = "request" | "cacheHit" | "cacheMiss" | "inFlightDedupe" | "rateLimited" | "dailyQuota" | "timeout" | "providerError" | "error" | "call" | "fallback" | "success";
type ProviderUsage = { requests: number; cacheHits: number; cacheMisses: number; inFlightDedupes: number; rateLimited: number; dailyQuota: number; timeouts: number; providerErrors: number; errors: number; calls: number; fallbacks: number; successes: number; lastRequestAt: string | null; lastSuccessAt: string | null };

function emptyUsage(): ProviderUsage {
  return { requests: 0, cacheHits: 0, cacheMisses: 0, inFlightDedupes: 0, rateLimited: 0, dailyQuota: 0, timeouts: 0, providerErrors: 0, errors: 0, calls: 0, fallbacks: 0, successes: 0, lastRequestAt: null, lastSuccessAt: null };
}

const usage = new Map<ApiUsageProvider, ProviderUsage>(apiUsageProviders.map(provider => [provider, emptyUsage()]));
const fields: Record<ApiUsageEvent, keyof ProviderUsage> = {
  request: "requests", cacheHit: "cacheHits", cacheMiss: "cacheMisses", inFlightDedupe: "inFlightDedupes",
  rateLimited: "rateLimited", dailyQuota: "dailyQuota", timeout: "timeouts", providerError: "providerErrors",
  error: "errors", call: "calls", fallback: "fallbacks", success: "successes",
};

export function recordApiUsage(provider: ApiUsageProvider, event: ApiUsageEvent): void {
  const counters = usage.get(provider);
  if (!counters) return;
  const field = fields[event];
  const numericCounters = counters as unknown as Record<string, number>;
  numericCounters[field]++;
  const at = new Date().toISOString();
  if (event === "request") counters.lastRequestAt = at;
  if (event === "success") counters.lastSuccessAt = at;
}

export function recordApiFailure(provider: ApiUsageProvider, kind: "rateLimited" | "dailyQuota" | "timeout" | "providerError" | boolean = "providerError"): void {
  recordApiUsage(provider, "error");
  const failureKind = typeof kind === "boolean" ? kind ? "rateLimited" : "providerError" : kind;
  recordApiUsage(provider, failureKind);
}

export function getApiUsageSnapshot() {
  return {
    scope: "process" as const,
    capturedAt: new Date().toISOString(),
    providers: Object.fromEntries([...usage].map(([provider, counters]) => [provider, { ...counters }])),
  };
}