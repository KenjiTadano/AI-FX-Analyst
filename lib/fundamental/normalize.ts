import { indicatorKey } from "../economic-calendar/classification";
import { classifyImportance, countryCurrencies, relatedCurrencies } from "./classification";
import type { EconomicEvent, Importance, NewsItem, NormalizedBatch } from "./types";

const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown, limit = 2000) => typeof value === "string" ? value.replace(/<[^>]*>/g, "").trim().slice(0, limit) : "";
const number = (value: unknown): number | null => {
  if (typeof value !== "number" && !(typeof value === "string" && /^[-+]?\d+(\.\d+)?$/.test(value.trim()))) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
export function safeUrl(value: unknown): string | null {
  try { const url = new URL(String(value)); return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : null; } catch { return null; }
}
export function normalizeNews(body: unknown): NormalizedBatch<NewsItem> {
  if (!Array.isArray(body)) throw new Error("invalid_response");
  const items = new Map<string, NewsItem>();
  let rejected = 0;
  for (const raw of body) {
    const row = record(raw);
    if (!row) { rejected++; continue; }
    const title = text(row.headline, 500), url = safeUrl(row.url), timestamp = number(row.datetime);
    const source = text(row.source, 120);
    if (!title || !url || !source || timestamp === null || timestamp <= 0 || !Number.isFinite(new Date(timestamp * 1000).getTime())) { rejected++; continue; }
    const summary = text(row.summary) || null;
    const associated = relatedCurrencies(`${title} ${summary ?? ""}`);
    if (!associated.length) continue;
    items.set(url, {
      id: `finnhub:news:${url}`, title, url, summary, source, publishedAt: new Date(timestamp * 1000).toISOString(),
      currencies: associated, affectedCurrencies: associated, impactDirection: null,
      importance: classifyImportance(`${title} ${summary ?? ""}`), importanceBasis: "keyword",
      reason: "通貨・金融政策・経済関連の語句から関連性と表示優先度を分類。価格への影響方向は未評価。",
    });
  }
  if (body.length && rejected === body.length) throw new Error("invalid_response");
  return { items: [...items.values()].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)), warnings: rejected ? [`形式不正のニュース${rejected}件を除外しました。`] : [] };
}

// The public provider schema does not specify a timezone for offset-less times.
// Preserve that uncertainty unless the account's feed timezone is explicitly confirmed.
export function calendarTime(raw: unknown, assumeUtc = false): { iso: string | null; raw: string | null; timezone: "UTC" | null } {
  const value = text(raw, 80);
  if (!value) return { iso: null, raw: null, timezone: null };
  const normalized = value.replace(" ", "T");
  const hasOffset = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/i.test(normalized) || (!hasOffset && !assumeUtc)) return { iso: null, raw: value, timezone: null };
  const day = new Date(`${normalized.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== normalized.slice(0, 10) || Number(normalized.slice(11, 13)) > 23 || Number(normalized.slice(14, 16)) > 59 || Number(normalized.slice(17, 19)) > 59) return { iso: null, raw: value, timezone: null };
  const date = new Date(hasOffset ? normalized : `${normalized}Z`);
  return Number.isFinite(date.getTime()) ? { iso: date.toISOString(), raw: value, timezone: "UTC" } : { iso: null, raw: value, timezone: null };
}
export function eventStatus(event: Pick<EconomicEvent, "actual" | "scheduledAt">, now: number): EconomicEvent["status"] {
  if (event.actual !== null) return "released";
  if (!event.scheduledAt) return "unknown";
  return Date.parse(event.scheduledAt) > now ? "upcoming" : "awaiting_actual";
}
export function normalizeCalendar(body: unknown, now = Date.now(), assumeUtc = false): NormalizedBatch<EconomicEvent> {
  const rows = record(body)?.economicCalendar;
  if (!Array.isArray(rows)) throw new Error("invalid_response");
  let rejected = 0, uncertain = 0;
  const items = new Map<string, EconomicEvent>();
  for (const raw of rows) {
    const row = record(raw);
    if (!row) { rejected++; continue; }
    const name = text(row.event, 400), country = text(row.country, 20).toUpperCase();
    if (!name || !country) { rejected++; continue; }
    const currency = countryCurrencies[country];
    if (!currency) continue;
    const time = calendarTime(row.time, assumeUtc);
    if (!time.iso) uncertain++;
    const actual = number(row.actual);
    const providerImportance = typeof row.impact === "string" ? row.impact.toLowerCase() : "";
    const knownImportance = ["high", "medium", "low"].includes(providerImportance);
    const id = `finnhub:calendar:${country}:${name}:${time.raw ?? "unknown"}`;
    items.set(id, {
      id, name, country, currency, scheduledAt: time.iso, rawScheduledAt: time.raw, timezone: time.timezone,
      previous: number(row.prev), forecast: number(row.estimate), actual, unit: text(row.unit, 30) || null,
      status: eventStatus({ actual, scheduledAt: time.iso }, now), source: "Finnhub", url: null,
      importance: knownImportance ? providerImportance as Importance : indicatorKey(name) ? "high" : classifyImportance(name),
      importanceBasis: knownImportance ? "provider" : "keyword", isKeyIndicator: !!indicatorKey(name), indicatorKey: indicatorKey(name),
      affectedCurrencies: [currency], impactDirection: null,
      reason: "実績・市場予想・前回値は同じ指標と単位で比較するための材料です。差分だけで通貨の売買方向を断定しません。",
    });
  }
  if (rows.length && rejected === rows.length) throw new Error("invalid_response");
  return { items: [...items.values()].sort((a, b) => (a.rawScheduledAt ?? "").localeCompare(b.rawScheduledAt ?? "")), warnings: [
    ...(rejected ? [`形式不正の指標${rejected}件を除外しました。`] : []),
    ...(uncertain ? ["一部の発表日時はタイムゾーン未確認です。時刻の変換・発表前後の推定を行っていません。"] : []),
  ] };
}
