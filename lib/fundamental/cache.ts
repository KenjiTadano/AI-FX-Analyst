import type { DataResource, NormalizedBatch } from "./types";
import { ProviderError, unavailable } from "./resource";
import { recordApiUsage, type ApiUsageProvider } from "../api-usage";

export const cachePolicy = {
  newsMs: 10 * 60_000,
  calendarMs: 30 * 60_000,
  macroMs: 60 * 60_000,
  failureMs: 60_000,
  entitlementFailureMs: 15 * 60_000,
};
// Single-process, bounded cache, shared across currency pairs. No credentials or raw payloads.
// Replace the store with a shared cache/limiter before multi-instance deployment.
export class ResourceCache {
  private values = new Map<string, { expires: number; value: DataResource<unknown> }>();
  private pending = new Map<string, Promise<DataResource<unknown>>>();
  constructor(private now: () => number = Date.now) {}
  async get<T>(id: string, ttlMs: number | ((items: T[], now: number) => number), provider: string, load: () => Promise<NormalizedBatch<T>>): Promise<DataResource<T[]>> {
    const prior = this.values.get(id);
    const priorValue = prior?.value as DataResource<T[]> | undefined;
    const metricProvider = provider as ApiUsageProvider;
    const lastGood = priorValue?.data !== null && priorValue?.data !== undefined && (["ok", "empty"].includes(priorValue.status) || priorValue.stale === true)
      ? priorValue
      : null;
    if (prior && prior.expires > this.now()) { recordApiUsage(metricProvider, "cacheHit"); return priorValue!; }
    const pending = this.pending.get(id);
    if (pending) {
      recordApiUsage(metricProvider, "inFlightDedupe");
      return lastGood ? { ...lastGood, stale: true } : pending as Promise<DataResource<T[]>>;
    }
    recordApiUsage(metricProvider, "cacheMiss");
    const task = (async (): Promise<DataResource<T[]>> => {
      let value: DataResource<T[]>;
      let ttl = typeof ttlMs === "number" ? ttlMs : cachePolicy.calendarMs;
      try {
        const batch = await load();
        if (typeof ttlMs === "function") ttl = ttlMs(batch.items, this.now());
        value = { data: batch.items, status: batch.items.length ? "ok" : "empty", provider, fetchedAt: new Date(this.now()).toISOString(), stale: false, error: null, warnings: batch.warnings };
        recordApiUsage(metricProvider, "success");
      } catch (error) {
        const code = error instanceof ProviderError ? error.code : "network";
        value = lastGood ? { ...lastGood, status: "error", stale: true, error: unavailable(provider, code).error } : unavailable(provider, code);
        ttl = ["unauthorized", "forbidden"].includes(code) ? cachePolicy.entitlementFailureMs : cachePolicy.failureMs;
      }
      if (this.values.size >= 8 && !this.values.has(id)) this.values.delete(this.values.keys().next().value!);
      this.values.set(id, { value, expires: this.now() + ttl });
      return value;
    })();
    this.pending.set(id, task);
    if (lastGood) {
      void task.then(() => this.pending.delete(id), () => this.pending.delete(id));
      return { ...lastGood, stale: true };
    }
    try {
      return await task;
    } finally {
      this.pending.delete(id);
    }
  }
}
