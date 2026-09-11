import { indicatorKey } from "./classification";
import { calendarTime, eventStatus } from "../fundamental/normalize";
import type { Currency, EconomicEvent, NormalizedBatch } from "../fundamental/types";

type EodhdRow = Record<string, unknown>;
const currencyByCountry: Record<string, Currency> = { US: "USD", JP: "JPY", GB: "GBP", EU: "EUR", EA: "EUR", EMU: "EUR" };
const asText = (value: unknown, limit = 160) => typeof value === "string" ? value.replace(/<[^>]*>/g, "").trim().slice(0, limit) : "";
const asValue = (value: unknown): number | string | null => {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const text = asText(value, 80);
  if (!text || /^(null|n\/a|na|—)$/i.test(text)) return null;
  return /^[+-]?\d+(?:\.\d+)?$/.test(text) && Number.isFinite(Number(text)) ? Number(text) : text;
};

export function normalizeEodhd(rows: unknown, now: number, assumeUtc = true): NormalizedBatch<EconomicEvent> {
  if (!Array.isArray(rows) || rows.length > 1000) throw new Error("invalid_response");
  const items: EconomicEvent[] = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== "object") throw new Error("invalid_response");
    const row = raw as EodhdRow;
    const country = asText(row.country, 8).toUpperCase();
    const currency = currencyByCountry[country];
    const name = asText(row.type ?? row.name);
    const date = asText(row.date ?? row.datetime);
    if (!currency || !name || !date) throw new Error("invalid_response");
    const time = calendarTime(date, assumeUtc);
    const scheduledAt = time.iso;
    const actual = asValue(row.actual);
    const forecast = asValue(row.estimate ?? row.forecast);
    const previous = asValue(row.previous);
    const key = indicatorKey(name);
    const providerImportance = asText(row.importance ?? row.impact, 16).toLowerCase();
    const importance = providerImportance === "high" || providerImportance === "3" ? "high" : providerImportance === "medium" || providerImportance === "2" ? "medium" : providerImportance === "low" || providerImportance === "1" ? "low" : key ? "high" : "low";
    const period = asText(row.period, 40);
    const comparison = asText(row.comparison, 12);
    const id = `eodhd:${country}:${name}:${period}:${comparison}:${date}`.replace(/\s+/g, "_");
    items.push({ id, currency, country, name: period ? `${name} (${period})` : name, scheduledAt, rawScheduledAt: date, timezone: scheduledAt ? (assumeUtc ? "UTC" : null) : null,
      previous, forecast, actual, unit: null, status: eventStatus({ actual, scheduledAt }, now), source: "EODHD", url: null,
      updatedAt: undefined, importance, importanceBasis: providerImportance ? "provider" : "keyword", isKeyIndicator: !!key, indicatorKey: key,
      affectedCurrencies: [currency], impactDirection: null, reason: "EODHDの経済指標データを正規化しました。値だけで通貨の売買方向を断定しません。" });
  }
  return { items, warnings: rows.length ? [] : ["指定期間のEODHD経済指標は0件でした。"] };
}
