import type { DataResource, NormalizedBatch } from "./types";
import { ProviderError, unavailable } from "./resource";

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
    if (prior && prior.expires > this.now()) return prior.value as DataResource<T[]>;
    const pending = this.pending.get(id);
    if (pending) return pending as Promise<DataResource<T[]>>;
    const task = (async (): Promise<DataResource<T[]>> => {
      let value: DataResource<T[]>;
      let ttl = typeof ttlMs === "number" ? ttlMs : cachePolicy.calendarMs;
      try {
        const batch = await load();
        if (typeof ttlMs === "function") ttl = ttlMs(batch.items, this.now());
        value = { data: batch.items, status: batch.items.length ? "ok" : "empty", provider, fetchedAt: new Date(this.now()).toISOString(), error: null, warnings: batch.warnings };
      } catch (error) {
        const code = error instanceof ProviderError ? error.code : "network";
        value = unavailable(provider, code);
        ttl = ["unauthorized", "forbidden"].includes(code) ? cachePolicy.entitlementFailureMs : cachePolicy.failureMs;
      }
      if (this.values.size >= 8 && !this.values.has(id)) this.values.delete(this.values.keys().next().value!);
      this.values.set(id, { value, expires: this.now() + ttl });
      return value;
    })();
    this.pending.set(id, task);
    try { return await task; } finally { this.pending.delete(id); }
  }
}
