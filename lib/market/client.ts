import "server-only";
import { calculateIndicators } from "./indicators";
import { timeframes, type Candle, type MarketData, type Resource, type Symbol, type Technical, type Timeframe } from "./types";

const intervals = { "15m": "15min", "1h": "1h", "4h": "4h" };
const durations = { "15m": 900000, "1h": 3600000, "4h": 14400000 };
// Single-process MVP guard. A distributed deployment needs a shared limiter/cache.
const cache = new Map<string, { value: Resource<unknown>; expires: number }>();
const pending = new Map<string, Promise<Resource<unknown>>>();
let calls: number[] = [];
let blockedUntil = 0;
let day = "";
let dailyCalls = 0;
const number = (value: unknown): number => {
  if ((typeof value !== "string" && typeof value !== "number") || value === "" || !Number.isFinite(Number(value)) || Number(value) <= 0) throw new Error("市場データの形式が正しくありません。");
  return Number(value);
};

async function resource<T>(id: string, endpoint: string, params: Record<string, string>, ttl: number, normalize: (body: Record<string, unknown>) => T): Promise<Resource<T>> {
  const apiKey = process.env.TWELVE_DATA_API_KEY?.trim();
  if (!apiKey) return { data: null, fetchedAt: null, stale: false, error: "TWELVE_DATA_API_KEY が未設定です。設定後にサーバーを再起動してください。" };
  const prior = cache.get(id);
  if (prior && prior.expires > Date.now()) return prior.value as Resource<T>;
  if (pending.has(id)) return pending.get(id)! as Promise<Resource<T>>;
  const task = (async (): Promise<Resource<T>> => {
    try {
      const now = Date.now();
      const today = new Date(now).toISOString().slice(0, 10);
      if (day !== today) { day = today; dailyCalls = 0; }
      calls = calls.filter(at => now - at < 60000);
      if (now < blockedUntil || calls.length >= 8 || dailyCalls >= 800) throw new Error("API利用上限に達しました。時間をおいて自動再試行します（日次上限はUTC 0時にリセット）。");
      calls.push(now); dailyCalls++;
      const url = new URL(`https://api.twelvedata.com/${endpoint}`);
      url.search = new URLSearchParams(params).toString();
      // Keep the key out of URLs and logs. Bound caching here to validated successes;
      // provider errors may arrive with HTTP 200 and must not enter a long-lived cache.
      const response = await fetch(url, { headers: { Authorization: `apikey ${apiKey}` }, cache: "no-store", signal: AbortSignal.timeout(12000) });
      const body = await response.json();
      if (response.status === 429 || body?.code === 429) {
        blockedUntil = Date.now() + 60000;
        throw new Error("Twelve Dataの利用上限に達しました。1分後に再試行します。日次上限の場合はUTC 0時までお待ちください。");
      }
      if (!response.ok || !body || body.status === "error") throw new Error(response.status === 401 || body?.code === 401 ? "APIキーが無効です。設定を確認してください。" : "Twelve Dataから取得できませんでした。キーの権限・契約プランをご確認ください。");
      const value: Resource<T> = { data: normalize(body), fetchedAt: new Date().toISOString(), stale: false, error: null };
      cache.set(id, { value, expires: Date.now() + ttl * 1000 });
      return value;
    } catch (error) {
      // Never forward upstream exceptions: they may contain request credentials.
      const safeMessages = ["API利用上限", "Twelve Data", "APIキー", "市場データ"];
      const message = error instanceof Error && safeMessages.some(prefix => error.message.startsWith(prefix)) ? error.message : "市場データの通信に失敗しました。自動再試行します。";
      const value: Resource<T> = { data: (prior?.value.data as T) ?? null, fetchedAt: prior?.value.fetchedAt ?? null, stale: !!prior?.value.data, error: message };
      cache.set(id, { value, expires: Date.now() + 60000 });
      return value;
    }
  })();
  pending.set(id, task);
  try { return await task; } finally { pending.delete(id); }
}

function normalizeSeries(body: Record<string, unknown>, frame: Timeframe): Technical {
  if (!Array.isArray(body.values) || !body.values.length) throw new Error("市場データのOHLCが空です。");
  const candles: Candle[] = body.values.map(value => {
    const time = new Date(String(value.datetime).replace(" ", "T") + "Z");
    if (!Number.isFinite(time.getTime())) throw new Error("市場データの日時が不正です。");
    const candle = { time: time.toISOString(), open: number(value.open), high: number(value.high), low: number(value.low), close: number(value.close) };
    if (candle.high < Math.max(candle.open, candle.close, candle.low) || candle.low > Math.min(candle.open, candle.close)) throw new Error("市場データのOHLCが不正です。");
    return candle;
  }).sort((a, b) => a.time.localeCompare(b.time));
  const closed = [...new Map(candles.map(c => [c.time, c])).values()].filter(c => Date.parse(c.time) + durations[frame] <= Date.now());
  if (!closed.length) throw new Error("市場データの確定足がありません。");
  return { candles: closed, indicators: calculateIndicators(closed), lastClosedAt: closed.at(-1)?.time ?? null };
}

export async function getMarketData(symbol: Symbol): Promise<MarketData> {
  const [price, ...series] = await Promise.all([
    resource(`${symbol}:price`, "price", { symbol }, 60, body => number(body.price)),
    ...timeframes.map(frame => resource(`${symbol}:${frame}`, "time_series", { symbol, interval: intervals[frame], outputsize: "300", timezone: "UTC", order: "asc" }, 300, body => normalizeSeries(body, frame))),
  ]);
  return { symbol, price, timeframes: Object.fromEntries(timeframes.map((frame, i) => [frame, series[i]])) as Record<Timeframe, Resource<Technical>> };
}
