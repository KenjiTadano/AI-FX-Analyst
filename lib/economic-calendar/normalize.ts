import { indicatorKey } from "./classification";
export { indicatorKey } from "./classification";
import { calendarTime, eventStatus, safeUrl } from "../fundamental/normalize";
import type { Currency, EconomicEvent, NormalizedBatch } from "../fundamental/types";
const countries: Record<string, Currency> = { "united states": "USD", japan: "JPY", "euro area": "EUR", "united kingdom": "GBP" };
const text = (value: unknown, limit = 400) => typeof value === "string" ? value.replace(/<[^>]*>/g, "").trim().slice(0, limit) : "";
function value(raw: unknown, unit: string | null): number | string | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  const source = text(raw, 80);
  if (!source || /^(null|n\/a|na|—|-)$/i.test(source)) return null;
  // Only strip an explicitly identical unit. K/M/ranges and mixed units stay strings.
  const candidate = unit && source.endsWith(unit) ? source.slice(0, -unit.length).trim() : source;
  if (/^[+-]?\d+(?:\.\d+)?$/.test(candidate) && Number.isFinite(Number(candidate))) return Number(candidate);
  return source;
}
export function normalizeTradingEconomics(body: unknown, now: number): NormalizedBatch<EconomicEvent> {
  if (!Array.isArray(body) || body.length >= 1000) throw new Error("invalid_response");
  const items = new Map<string, EconomicEvent>(); let rejected = 0, uncertain = 0;
  for (const raw of body) {
    if (!raw || typeof raw !== "object") { rejected++; continue; }
    const row = raw as Record<string, unknown>, country = text(row.Country), currency = countries[country.toLowerCase()], name = text(row.Event);
    const calendarId = row.CalendarId ?? row.CalendarID;
    if (!currency || !name || (!["string", "number"].includes(typeof calendarId) || !String(calendarId).trim() || (typeof calendarId === "number" && !Number.isFinite(calendarId)))) { rejected++; continue; }
    const unit = text(row.Unit, 30) || null;
    const time = calendarTime(row.Date, true);
    // DateSpan=1 means estimated time, not a confirmed timestamp for risk gating.
    const precise = String(row.DateSpan) === "0";
    const scheduledAt = precise ? time.iso : null;
    if (!scheduledAt) uncertain++;
    const actual = value(row.Actual, unit);
    const rank = Number(row.Importance), key = indicatorKey(name);
    const importance = rank === 3 ? "high" : rank === 2 ? "medium" : rank === 1 ? "low" : key ? "high" : "low";
    const id = `te:calendar:${calendarId}`;
    items.set(id, { id, name, country, currency, scheduledAt, rawScheduledAt: time.raw, timezone: scheduledAt ? "UTC" : null,
      previous: value(row.Previous, unit), forecast: value(row.Forecast, unit), actual, unit,
      status: eventStatus({ actual, scheduledAt }, now), source: "Trading Economics", url: safeUrl(row.SourceURL),
      updatedAt: calendarTime(row.LastUpdate, true).iso ?? undefined, importance, importanceBasis: [1, 2, 3].includes(rank) ? "provider" : "keyword",
      isKeyIndicator: !!key, indicatorKey: key, affectedCurrencies: [currency], impactDirection: null,
      reason: "Forecastは市場予想であり実績ではありません。結果の差分だけで通貨の売買方向を断定しません。",
    });
  }
  if (rejected) throw new Error("invalid_response"); // Incomplete/guest/restricted responses cannot mean no events.
  return { items: [...items.values()].sort((a, b) => (a.scheduledAt ?? "~").localeCompare(b.scheduledAt ?? "~")), warnings: uncertain ? ["推定時刻・未確認時刻の指標があります。確定時刻として変換・カウントダウンしません。"] : [] };
}
export function surprise(event: Pick<EconomicEvent, "actual" | "forecast" | "unit">) {
  if (typeof event.actual !== "number" || typeof event.forecast !== "number" || !Number.isFinite(event.actual) || !Number.isFinite(event.forecast) || !event.unit) return null;
  const difference = Number((event.actual - event.forecast).toPrecision(12));
  if (!Number.isFinite(difference)) return null;
  const equal = Math.abs(difference) <= Number.EPSILON * Math.max(1, Math.abs(event.actual), Math.abs(event.forecast)) * 8;
  return { difference: equal ? 0 : difference, relation: equal ? "equal" : difference > 0 ? "above" : "below", unit: event.unit === "%" ? "pt" : event.unit };
}
