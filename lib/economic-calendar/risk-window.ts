import type { DataResource, EconomicEvent, Importance } from "../fundamental/types";
export const riskWindowPolicy: Record<Importance, { beforeMinutes: number; afterMinutes: number; block: boolean }> = {
  high: { beforeMinutes: 30, afterMinutes: 15, block: true },
  medium: { beforeMinutes: 15, afterMinutes: 5, block: true },
  low: { beforeMinutes: 0, afterMinutes: 0, block: false },
};
export function windowFor(event: EconomicEvent, policy = riskWindowPolicy) {
  const rule = policy[event.importance];
  if (!rule.block || !event.scheduledAt) return null;
  const at = Date.parse(event.scheduledAt);
  if (!Number.isFinite(at)) return null;
  return { start: at - rule.beforeMinutes * 60_000, end: at + rule.afterMinutes * 60_000 };
}
export function riskState(events: EconomicEvent[], now: number, policy = riskWindowPolicy) {
  const active = events.filter(event => { const window = windowFor(event, policy); return window && now >= window.start && now <= window.end; });
  const uncertain = events.filter(event => event.importance === "high" && !event.scheduledAt);
  const starts = events.map(event => windowFor(event, policy)?.start).filter((at): at is number => at !== undefined && at > now);
  const ends = active.map(event => windowFor(event, policy)!.end + 1);
  return {
    imminent: active.length > 0, uncertainTime: uncertain.length > 0,
    nextRiskAt: starts.length ? new Date(Math.min(...starts)).toISOString() : null,
    nextBoundaryAt: [...starts, ...ends].length ? new Date(Math.min(...starts, ...ends)).toISOString() : null,
    reasons: [...active.map(event => `${event.currency} ${event.name}（${formatJst(event.scheduledAt!)}）：発表${policy[event.importance].beforeMinutes}分前〜${policy[event.importance].afterMinutes}分後のため、新規エントリーは待機します。`), ...uncertain.map(event => `${event.name}：重要指標の発表時刻を確認できません。`)],
    activeIds: active.map(event => event.id),
  };
}
export function calendarKnown(resource: DataResource<EconomicEvent[]> | undefined, now: number) {
  const age = resource?.fetchedAt ? now - Date.parse(resource.fetchedAt) : Infinity;
  return !!resource && resource.data !== null && ["ok", "empty"].includes(resource.status) && age >= 0 && age <= 60 * 60_000;
}
export function nextHigh(events: EconomicEvent[], now: number) {
  return events.filter(event => event.importance === "high" && event.scheduledAt && Date.parse(event.scheduledAt) > now && event.actual === null).sort((a, b) => a.scheduledAt!.localeCompare(b.scheduledAt!))[0] ?? null;
}
export function formatJst(iso: string) {
  return new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso)) + " JST";
}
export function countdown(iso: string, now: number) {
  const minutes = Math.ceil((Date.parse(iso) - now) / 60_000);
  return minutes > 0 ? `あと${Math.floor(minutes / 60)}時間${minutes % 60}分` : "予定時刻を経過";
}
// Normal 30 minutes; expire at a known release, then at most once/minute for 15 minutes.
export function calendarTtl(events: EconomicEvent[], now: number) {
  let ttl = 30 * 60_000;
  for (const event of events) {
    if (!event.scheduledAt || event.importance === "low") continue;
    const until = Date.parse(event.scheduledAt) - now;
    if (until > 0) ttl = Math.min(ttl, until);
    else if (until >= -15 * 60_000) ttl = Math.min(ttl, 60_000);
  }
  return Math.max(1000, ttl);
}
