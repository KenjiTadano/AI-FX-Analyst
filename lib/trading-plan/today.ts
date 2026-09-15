/**
 * Local calendar-day helpers for Daily Trading Plan.
 * Uses the runtime's local timezone (browser/OS). Does not hardcode JST.
 * `now` is injectable for tests.
 */
export function toEpochMs(now: Date | number | string): number {
  if (typeof now === "number") return now;
  if (typeof now === "string") return Date.parse(now);
  return now.getTime();
}

export function localDayKey(value: Date | number | string): string {
  const ms = toEpochMs(value);
  if (!Number.isFinite(ms)) return "";
  const date = new Date(ms);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function isSameLocalDay(value: Date | number | string, now: Date | number | string): boolean {
  const left = localDayKey(value);
  const right = localDayKey(now);
  return !!left && left === right;
}
