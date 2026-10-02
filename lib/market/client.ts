import "server-only";
import { recordApiUsage } from "../api-usage";
import { calculateIndicators } from "./indicators";
import {
  MARKET_FAILURE_TTL_SECONDS,
  MARKET_PRICE_TTL_SECONDS,
  MARKET_SERIES_TTL_SECONDS,
  type Candle,
  type MarketData,
  type Resource,
  type Symbol,
  type Technical,
} from "./types";

const intervals = { "15m": "15min", "1h": "1h", "4h": "4h", "1day": "1day" } as const;
const durations = { "15m": 900000, "1h": 3600000, "4h": 14400000, "1day": 86_400_000 } as const;
// Single-process MVP guard. A distributed deployment needs a shared limiter/cache.
const cache = new Map<string, { value: Resource<unknown>; expires: number }>();
const pending = new Map<string, Promise<Resource<unknown>>>();
let calls: number[] = [];
let blockedUntil = 0;
let dailyBlockedUntil = 0;
let day = "";
let dailyCalls = 0;
const number = (value: unknown): number => {
  if ((typeof value !== "string" && typeof value !== "number") || value === "" || !Number.isFinite(Number(value)) || Number(value) <= 0) throw new Error("市場データの形式が正しくありません。");
  return Number(value);
};

function requestKey(endpoint: string, params: Record<string, string>): string {
  const sorted = Object.entries(params).sort(([a], [b]) => a.localeCompare(b));
  return `${endpoint}:${new URLSearchParams(sorted).toString()}`;
}

function nextUtcDay(now: number): number {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
}

function retryDelayMs(value: string | null, now: number): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0 && seconds <= 86_400) return seconds * 1000;
  const at = Date.parse(value);
  return Number.isFinite(at) && at > now && at - now <= 86_400_000 ? at - now : null;
}

async function resource<T>(endpoint: string, params: Record<string, string>, ttl: number, normalize: (body: Record<string, unknown>) => T): Promise<Resource<T>> {
  const id = requestKey(endpoint, params);
  const apiKey = process.env.TWELVE_DATA_API_KEY?.trim();
  if (!apiKey) return { data: null, fetchedAt: null, stale: false, error: "TWELVE_DATA_API_KEY が未設定です。設定後にサーバーを再起動してください。" };
  const prior = cache.get(id);
  const priorValue = prior?.value as Resource<T> | undefined;
  const lastGood = priorValue?.data !== null && priorValue?.data !== undefined ? priorValue : null;
  if (prior && prior.expires > Date.now()) { recordApiUsage("Twelve Data", "cacheHit"); return priorValue!; }
  if (pending.has(id)) {
    recordApiUsage("Twelve Data", "inFlightDedupe");
    return lastGood ? { ...lastGood, stale: true } : pending.get(id)! as Promise<Resource<T>>;
  }
  recordApiUsage("Twelve Data", "cacheMiss");
  const task = (async (): Promise<Resource<T>> => {
    let failureKind: "rateLimited" | "dailyQuota" | "providerError" = "providerError";
    try {
      const now = Date.now();
      const today = new Date(now).toISOString().slice(0, 10);
      if (day !== today) { day = today; dailyCalls = 0; dailyBlockedUntil = 0; }
      calls = calls.filter(at => now - at < 60000);
      if (now < blockedUntil) {
        failureKind = now < dailyBlockedUntil ? "dailyQuota" : "rateLimited";
        throw new Error(failureKind === "dailyQuota" ? "API日次利用上限に達しました。UTC 0時以降に再試行します。" : "API利用上限に達しました。時間をおいて再試行します。");
      }
      if (calls.length >= 8) {
        failureKind = "rateLimited";
        throw new Error("API利用上限に達しました。時間をおいて再試行します。");
      }
      if (dailyCalls >= 800) {
        blockedUntil = nextUtcDay(now);
        dailyBlockedUntil = blockedUntil;
        failureKind = "dailyQuota";
        throw new Error("API日次利用上限に達しました。UTC 0時以降に再試行します。");
      }
      calls.push(now); dailyCalls++;
      const url = new URL(`https://api.twelvedata.com/${endpoint}`);
      url.search = new URLSearchParams(params).toString();
      // Keep the key out of URLs and logs. Bound caching here to validated successes;
      // provider errors may arrive with HTTP 200 and must not enter a long-lived cache.
      recordApiUsage("Twelve Data", "request");
      const response = await fetch(url, { headers: { Authorization: `apikey ${apiKey}` }, cache: "no-store", signal: AbortSignal.timeout(12000) });
      const body = await response.json();
      if (response.status === 429 || body?.code === 429) {
        const dailyQuota = typeof body?.message === "string" && /daily|per day|day limit/i.test(body.message);
        const retryDelay = retryDelayMs(response.headers?.get?.("retry-after") ?? null, Date.now());
        blockedUntil = dailyQuota ? nextUtcDay(Date.now()) : Date.now() + (retryDelay ?? 60_000);
        dailyBlockedUntil = dailyQuota ? blockedUntil : 0;
        failureKind = dailyQuota ? "dailyQuota" : "rateLimited";
        throw new Error(dailyQuota ? "API日次利用上限に達しました。UTC 0時以降に再試行します。" : "Twelve Dataの利用上限に達しました。時間をおいて再試行します。");
      }
      if (!response.ok || !body || body.status === "error") throw new Error(response.status === 401 || body?.code === 401 ? "APIキーが無効です。設定を確認してください。" : "Twelve Dataから取得できませんでした。キーの権限・契約プランをご確認ください。");
      const value: Resource<T> = { data: normalize(body), fetchedAt: new Date().toISOString(), stale: false, error: null };
      cache.set(id, { value, expires: Date.now() + ttl * 1000 });
      recordApiUsage("Twelve Data", "success");
      return value;
    } catch (error) {
      recordApiUsage("Twelve Data", "error");
      if (failureKind === "dailyQuota") recordApiUsage("Twelve Data", "dailyQuota");
      else if (failureKind === "rateLimited") recordApiUsage("Twelve Data", "rateLimited");
      else if (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name)) recordApiUsage("Twelve Data", "timeout");
      else recordApiUsage("Twelve Data", "providerError");
      // Never forward upstream exceptions: they may contain request credentials.
      const safeMessages = ["API利用上限", "Twelve Data", "APIキー", "市場データ"];
      const message = error instanceof Error && safeMessages.some(prefix => error.message.startsWith(prefix)) ? error.message : "市場データの通信に失敗しました。自動再試行します。";
      const value: Resource<T> = { data: (prior?.value.data as T) ?? null, fetchedAt: prior?.value.fetchedAt ?? null, stale: !!prior?.value.data, error: message };
      cache.set(id, { value, expires: Date.now() + MARKET_FAILURE_TTL_SECONDS * 1000 });
      return value;
    }
  })();
  pending.set(id, task);
  if (lastGood) {
    void task.then(() => pending.delete(id), () => pending.delete(id));
    return { ...lastGood, stale: true };
  }
  try { return await task; } finally { pending.delete(id); }
}

function normalizeSeries(body: Record<string, unknown>, durationMs: number): Technical {
  if (!Array.isArray(body.values) || !body.values.length) throw new Error("市場データのOHLCが空です。");
  const candles: Candle[] = body.values.map(value => {
    const time = new Date(String(value.datetime).replace(" ", "T") + "Z");
    if (!Number.isFinite(time.getTime())) throw new Error("市場データの日時が不正です。");
    const candle = { time: time.toISOString(), open: number(value.open), high: number(value.high), low: number(value.low), close: number(value.close) };
    if (candle.high < Math.max(candle.open, candle.close, candle.low) || candle.low > Math.min(candle.open, candle.close)) throw new Error("市場データのOHLCが不正です。");
    return candle;
  }).sort((a, b) => a.time.localeCompare(b.time));
  const closed = [...new Map(candles.map(c => [c.time, c])).values()].filter(c => Date.parse(c.time) + durationMs <= Date.now());
  if (!closed.length) throw new Error("市場データの確定足がありません。");
  return { candles: closed, indicators: calculateIndicators(closed), lastClosedAt: closed.at(-1)?.time ?? null };
}

function series(symbol: Symbol, frame: keyof typeof intervals) {
  return resource(
    "time_series",
    { symbol, interval: intervals[frame], outputsize: "300", timezone: "UTC", order: "asc" },
    MARKET_SERIES_TTL_SECONDS[frame],
    body => normalizeSeries(body, durations[frame]),
  );
}

export async function getMarketData(symbol: Symbol): Promise<MarketData> {
  const [price, m15, h1, h4, daily] = await Promise.all([
    resource("price", { symbol }, MARKET_PRICE_TTL_SECONDS, body => number(body.price)),
    series(symbol, "15m"),
    series(symbol, "1h"),
    series(symbol, "4h"),
    series(symbol, "1day"),
  ]);
  return { symbol, price, timeframes: { "15m": m15, "1h": h1, "4h": h4 }, daily };
}
