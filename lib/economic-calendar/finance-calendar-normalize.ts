import { indicatorKey } from "./classification";
import { relatedCurrencies } from "../fundamental/classification";
import { calendarTime, eventStatus } from "../fundamental/normalize";
import type { Currency, EconomicEvent, Importance, NormalizedBatch } from "../fundamental/types";

const PROVIDER = "FinanceCalendar";
const countryLabel: Record<Currency, string> = {
  USD: "United States",
  JPY: "Japan",
  EUR: "Euro Area",
  GBP: "United Kingdom",
};

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

function decodeEntities(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
}

const asText = (value: unknown, limit = 400) => {
  if (typeof value !== "string") return "";
  return decodeEntities(value.replace(/<[^>]*>/g, "").trim()).slice(0, limit);
};

/** Preserve provider strings; never invent 0 / neutral for null or blank. */
export function calendarMetric(value: unknown): number | string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const text = asText(value, 120);
  if (!text || /^(null|n\/a|na|—|-|not applicable(?:[,.].*)?)$/i.test(text)) return null;
  if (/^[+-]?\d+(?:\.\d+)?$/.test(text) && Number.isFinite(Number(text))) return Number(text);
  return text;
}

export function normalizeImpact(value: unknown): Importance | null {
  const impact = asText(value, 16).toLowerCase();
  return impact === "high" || impact === "medium" || impact === "low" ? impact : null;
}

/**
 * Map FinanceCalendar rows to a single app currency.
 * Uses name/title/url only. Ambiguous or non-target regions are skipped — never guessed.
 */
export function mapFinanceCalendarCurrency(name: string, title: string, url: string): Currency | null {
  const blob = `${name} ${title} ${url}`;
  const hits = new Set(relatedCurrencies(blob));
  // FinanceCalendar holiday/hours posts often use TSE/JPX without the word "Japan".
  if (/\b(?:TSE|JPX|Tokyo Stock Exchange)\b/i.test(blob)) hits.add("JPY");
  // URL slug prefixes from financecalendar.com are deterministic geography labels.
  if (/\/event\/(?:us|united-states)[-_/]/i.test(url) || /\bUS\b/.test(`${name} ${title}`)) hits.add("USD");
  if (/\/event\/(?:uk|united-kingdom|boe)[-_/]/i.test(url)) hits.add("GBP");
  if (/\/event\/(?:eurozone|euro-area|ecb|germany|france)[-_/]/i.test(url)) hits.add("EUR");
  if (/\/event\/(?:japan|boj|tse|jpx)[-_/]/i.test(url)) hits.add("JPY");
  return hits.size === 1 ? [...hits][0]! : null;
}

export function normalizeFinanceCalendar(body: unknown, now: number): NormalizedBatch<EconomicEvent> {
  const root = record(body);
  const rows = root?.events;
  if (!Array.isArray(rows) || rows.length > 2000) throw new Error("invalid_response");

  const items: EconomicEvent[] = [];
  let rejected = 0;
  let unmapped = 0;
  let uncertain = 0;

  for (const raw of rows) {
    const row = record(raw);
    if (!row) { rejected++; continue; }
    const name = asText(row.name ?? row.title, 400);
    const title = asText(row.title ?? row.name, 400);
    const url = asText(row.url, 500);
    if (!name) { rejected++; continue; }

    const currency = mapFinanceCalendarCurrency(name, title, url);
    if (!currency) { unmapped++; continue; }

    const timeUtc = asText(row.time_utc, 80);
    const date = asText(row.date, 40);
    const time = calendarTime(timeUtc || null, false);
    if (timeUtc && !time.iso) uncertain++;
    const scheduledAt = time.iso;
    const rawScheduledAt = time.raw ?? (date || null);

    const impact = normalizeImpact(row.impact);
    const key = indicatorKey(name) ?? indicatorKey(title);
    const importance: Importance = impact ?? (key ? "high" : "low");
    const previous = calendarMetric(row.prior);
    const forecast = calendarMetric(row.consensus);
    const actual = calendarMetric(row.actual);
    const category = asText(row.category, 80);
    const id = `fc:${currency}:${name}:${rawScheduledAt ?? "unknown"}`.replace(/\s+/g, "_");

    items.push({
      id,
      name,
      country: countryLabel[currency],
      currency,
      scheduledAt,
      rawScheduledAt,
      timezone: scheduledAt ? "UTC" : null,
      previous,
      forecast,
      actual,
      unit: null,
      status: eventStatus({ actual, scheduledAt }, now),
      source: PROVIDER,
      url: url && /^https?:\/\//i.test(url) ? url : null,
      importance,
      importanceBasis: impact ? "provider" : "keyword",
      isKeyIndicator: !!key,
      indicatorKey: key,
      affectedCurrencies: [currency],
      impactDirection: null,
      reason: category
        ? `FinanceCalendar（${category}）。実績・市場予想・前回値だけで売買方向を断定しません。`
        : "FinanceCalendarの経済指標を正規化しました。実績・市場予想・前回値だけで売買方向を断定しません。",
    });
  }

  if (rows.length && rejected === rows.length) throw new Error("invalid_response");

  return {
    items: items.sort((a, b) => (a.rawScheduledAt ?? "").localeCompare(b.rawScheduledAt ?? "")),
    warnings: [
      ...(rejected ? [`形式不正の指標${rejected}件を除外しました。`] : []),
      ...(unmapped ? [`対象外または通貨が特定できない指標${unmapped}件を除外しました。`] : []),
      ...(uncertain ? ["一部の発表日時（time_utc）を解釈できませんでした。推定時刻への変換はしていません。"] : []),
    ],
  };
}
