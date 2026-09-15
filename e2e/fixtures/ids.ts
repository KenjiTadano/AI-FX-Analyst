export const E2E_USER_ID = "11111111-1111-4111-8111-111111111111";
export const E2E_USER_EMAIL = "e2e@example.test";

export const TRADE_IDS = {
  todayOpen: "11111111-1111-4111-8111-111111111201",
  todayClosed: "11111111-1111-4111-8111-111111111202",
  yesterdayClosed: "11111111-1111-4111-8111-111111111203",
  recentClosed: "11111111-1111-4111-8111-111111111204",
  monthClosed: "11111111-1111-4111-8111-111111111205",
  oldClosed: "11111111-1111-4111-8111-111111111206",
  waitSellClosed: "11111111-1111-4111-8111-111111111207",
  contraryClosed: "11111111-1111-4111-8111-111111111208",
} as const;

export function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export function daysAgo(days: number, now = Date.now()): string {
  return iso(now - days * 24 * 60 * 60 * 1000);
}

export function localDayOffset(days: number, hour = 12, now = new Date()): string {
  const date = new Date(now.getTime());
  date.setDate(date.getDate() + days);
  date.setHours(hour, 0, 0, 0);
  return date.toISOString();
}
