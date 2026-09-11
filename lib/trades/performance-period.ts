import type { Trade } from "./types";

export type PerformancePeriod = "all" | "30d" | "90d";

export const PERFORMANCE_PERIODS = [
  { id: "all" as const, label: "全期間" },
  { id: "30d" as const, label: "直近30日" },
  { id: "90d" as const, label: "直近90日" },
] as const;

const DAY_MS = 24 * 60 * 60 * 1000;
export const PERIOD_WINDOW_MS: Record<Exclude<PerformancePeriod, "all">, number> = {
  "30d": 30 * DAY_MS,
  "90d": 90 * DAY_MS,
};

export function periodLabel(period: PerformancePeriod): string {
  return PERFORMANCE_PERIODS.find(p => p.id === period)?.label ?? "全期間";
}

function toMs(now: Date | number | string): number {
  if (typeof now === "number") return now;
  if (typeof now === "string") return Date.parse(now);
  return now.getTime();
}

/**
 * Filter trades by rolling entry window (openedAt).
 * Inclusive lower bound: openedAt >= now - window.
 * Does not mutate input. `now` is injectable for tests.
 */
export function filterTradesByPeriod(
  trades: Trade[],
  period: PerformancePeriod,
  now: Date | number | string,
): Trade[] {
  if (period === "all") return trades;
  const nowMs = toMs(now);
  if (!Number.isFinite(nowMs)) return [];
  const cutoff = nowMs - PERIOD_WINDOW_MS[period];
  return trades.filter(trade => {
    const entry = Date.parse(trade.openedAt);
    return Number.isFinite(entry) && entry >= cutoff && entry <= nowMs;
  });
}

export function periodTradeCounts(trades: Trade[]) {
  const closed = trades.filter(t => t.status === "closed" && t.realizedPnl !== null);
  return { total: trades.length, closed: closed.length, open: trades.length - closed.length };
}
