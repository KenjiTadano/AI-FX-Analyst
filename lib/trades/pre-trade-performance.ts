import { summarize } from "./analytics";
import { MIN_INSIGHT_SAMPLE_SIZE } from "./analysis-price";
import {
  actionAtEntry,
  eventRiskAtEntry,
  sanitizePreTradeContext,
  triggerStatusAtEntry,
} from "./pre-trade-context";
import { isRichSnapshot } from "./snapshot";
import type { PreTradeContextSnapshot, Trade } from "./types";

export {
  MIN_INSIGHT_SAMPLE_SIZE,
} from "./analysis-price";

export const PRE_TRADE_PERFORMANCE_TITLE = "エントリー時判断状況別の成績";
export const PRE_TRADE_PERFORMANCE_EYEBROW = "PRE-TRADE CONTEXT PERFORMANCE";
export const PRE_TRADE_PERFORMANCE_DISCLAIMER =
  "この分析は保存済みのエントリー時情報と過去の取引結果を集計したものです。因果関係や将来の勝率・収益を示すものではありません。";
export const PRE_TRADE_PERFORMANCE_SAMPLE_NOTE = "サンプル数が少ないグループは参考値です。";
export const PRE_TRADE_PERFORMANCE_WINRATE_NOTE =
  "勝率は過去の取引結果です。将来の勝率を示すものではありません。";
export const PRE_TRADE_PERFORMANCE_EMPTY = "この期間には分析できる決済済み取引がありません";
export const PRE_TRADE_PERFORMANCE_NO_CONTEXT =
  "この期間の決済済み取引には、エントリー時の判断状況が保存されていません";
export const PRE_TRADE_PERFORMANCE_COVERAGE_LABEL = "保存率";

const FORBIDDEN =
  /ルール遵守|ルール違反|正しいEntry|悪いEntry|Trigger成立を待つべき|条件成立を待つ方が有利|WAITを無視|勝ちパターン|Trigger成立が有効|staleだから負け|古い分析が損失原因|損失原因|High Event Riskが損失|disciplineScore|goodEntry|badEntry|ruleFollowed|ruleBroken|勝率予測|将来の勝率|必ず勝て/;

export const TRIGGER_GROUP_ORDER = ["met", "not_met", "unavailable", "invalid", "no_trigger"] as const;
export const ACTION_GROUP_ORDER = ["BUY", "SELL", "WAIT", "unavailable"] as const;
export const FRESHNESS_GROUP_ORDER = ["fresh", "stale"] as const;
export const EVENT_GROUP_ORDER = ["low", "medium", "high", "unavailable"] as const;
export const DLL_GROUP_ORDER = ["not_reached", "reached"] as const;

export const TRIGGER_GROUP_LABELS: Record<typeof TRIGGER_GROUP_ORDER[number], string> = {
  met: "条件成立",
  not_met: "条件未成立",
  unavailable: "判定データ不足",
  invalid: "構造化条件利用不可",
  no_trigger: "Triggerなし",
};

export const ACTION_GROUP_LABELS: Record<typeof ACTION_GROUP_ORDER[number], string> = {
  BUY: "BUY",
  SELL: "SELL",
  WAIT: "WAIT",
  unavailable: "Action未保存",
};

export const FRESHNESS_GROUP_LABELS: Record<typeof FRESHNESS_GROUP_ORDER[number], string> = {
  fresh: "最新分析",
  stale: "期限切れ分析",
};

export const EVENT_GROUP_LABELS: Record<typeof EVENT_GROUP_ORDER[number], string> = {
  low: "LOW",
  medium: "MEDIUM",
  high: "HIGH",
  unavailable: "未取得",
};

export const DLL_GROUP_LABELS: Record<typeof DLL_GROUP_ORDER[number], string> = {
  not_reached: "Daily Loss Limit 未到達",
  reached: "Daily Loss Limit 到達",
};

export type ContextPerformanceGroup = {
  key: string;
  label: string;
  sampleSize: number;
  wins: number;
  losses: number;
  breakEven: number;
  winRate: number | null;
  totalPnl: number;
  averagePnl: number | null;
  profitFactor: number | null;
  sufficientSample: boolean;
};

export type ContextPerformanceComparison = {
  id: string;
  text: string;
};

export type PreTradeContextPerformance = {
  periodLabel: string;
  eligibleClosedTrades: number;
  contextTrades: number;
  missingContextTrades: number;
  coverageRate: number | null;
  triggerGroups: ContextPerformanceGroup[];
  actionGroups: ContextPerformanceGroup[];
  freshnessGroups: ContextPerformanceGroup[];
  eventRiskGroups: ContextPerformanceGroup[];
  dailyLossLimitGroups: ContextPerformanceGroup[];
  comparisons: ContextPerformanceComparison[];
};

function eligibleClosed(trades: Trade[]): Trade[] {
  return trades.filter(trade =>
    trade.status === "closed"
    && trade.realizedPnl !== null
    && Number.isFinite(trade.realizedPnl),
  );
}

export function contextFromTrade(trade: Trade): PreTradeContextSnapshot | null {
  const snap = trade.analysisSnapshot;
  if (!isRichSnapshot(snap)) return null;
  return sanitizePreTradeContext(snap.preTradeContext, trade.pair);
}

function statsGroup(key: string, label: string, trades: Trade[]): ContextPerformanceGroup {
  const stats = summarize(trades);
  return {
    key,
    label,
    sampleSize: stats.count,
    wins: stats.wins,
    losses: stats.losses,
    breakEven: stats.draws,
    winRate: stats.winRate,
    totalPnl: stats.totalPnl,
    averagePnl: stats.count ? stats.totalPnl / stats.count : null,
    profitFactor: stats.profitFactor,
    sufficientSample: stats.count >= MIN_INSIGHT_SAMPLE_SIZE,
  };
}

function present<K extends string>(
  order: readonly K[],
  labels: Record<K, string>,
  buckets: Record<K, Trade[]>,
): ContextPerformanceGroup[] {
  return order
    .map(key => statsGroup(key, labels[key], buckets[key]))
    .filter(group => group.sampleSize > 0);
}

function emptyBuckets<K extends string>(keys: readonly K[]): Record<K, Trade[]> {
  return Object.fromEntries(keys.map(key => [key, [] as Trade[]])) as Record<K, Trade[]>;
}

function fmtMoney(n: number): string {
  return `${n > 0 ? "+" : ""}${n.toLocaleString("ja-JP", { maximumFractionDigits: 2 })}円`;
}

function safeText(text: string): string {
  if (FORBIDDEN.test(text)) throw new Error(`pre-trade performance wording rejected: ${text}`);
  return text;
}

export function formatContextProfitFactor(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return value.toFixed(2);
}

const MAX_COMPARISONS = 3;

function comparisonsFrom(groups: {
  trigger: ContextPerformanceGroup[];
  action: ContextPerformanceGroup[];
  freshness: ContextPerformanceGroup[];
}): ContextPerformanceComparison[] {
  const byKey = (list: ContextPerformanceGroup[], key: string) => list.find(group => group.key === key);
  const items: ContextPerformanceComparison[] = [];
  const met = byKey(groups.trigger, "met");
  const notMet = byKey(groups.trigger, "not_met");
  if (met && notMet && met.sufficientSample && notMet.sufficientSample) {
    items.push({
      id: "trigger-met-not-met",
      text: safeText(
        `この期間の保存済み取引では、条件成立グループの平均損益は ${met.averagePnl === null ? "—" : fmtMoney(met.averagePnl)}、条件未成立グループは ${notMet.averagePnl === null ? "—" : fmtMoney(notMet.averagePnl)} でした。`,
      ),
    });
  }

  const buy = byKey(groups.action, "BUY");
  const sell = byKey(groups.action, "SELL");
  const wait = byKey(groups.action, "WAIT");
  if (buy?.sufficientSample && sell?.sufficientSample && wait?.sufficientSample) {
    items.push({
      id: "action-buy-sell-wait",
      text: safeText(
        `この期間の保存済み取引では、エントリー時Action BUYは${buy.sampleSize}件・平均 ${buy.averagePnl === null ? "—" : fmtMoney(buy.averagePnl)}、SELLは${sell.sampleSize}件・平均 ${sell.averagePnl === null ? "—" : fmtMoney(sell.averagePnl)}、WAITは${wait.sampleSize}件・平均 ${wait.averagePnl === null ? "—" : fmtMoney(wait.averagePnl)} でした。`,
      ),
    });
  } else if (wait?.sufficientSample) {
    items.push({
      id: "action-wait",
      text: safeText(
        `WAIT時に登録された決済済み取引は${wait.sampleSize}件、平均損益は ${wait.averagePnl === null ? "—" : fmtMoney(wait.averagePnl)}でした。`,
      ),
    });
  }

  const fresh = byKey(groups.freshness, "fresh");
  const stale = byKey(groups.freshness, "stale");
  if (fresh && stale && fresh.sufficientSample && stale.sufficientSample) {
    items.push({
      id: "freshness-fresh-stale",
      text: safeText(
        `最新分析グループは平均${fresh.averagePnl === null ? "—" : fmtMoney(fresh.averagePnl)}、期限切れ分析グループは平均${stale.averagePnl === null ? "—" : fmtMoney(stale.averagePnl)}でした。`,
      ),
    });
  }

  return items.slice(0, MAX_COMPARISONS);
}

/**
 * Aggregate realized results by saved Pre-Trade Context.
 * Uses already-filtered trades; does not apply a period window.
 */
export function buildPreTradeContextPerformance(
  trades: Trade[],
  periodLabel = "全期間",
): PreTradeContextPerformance {
  const closed = eligibleClosed(trades);
  const withContext: { trade: Trade; context: PreTradeContextSnapshot }[] = [];
  for (const trade of closed) {
    const context = contextFromTrade(trade);
    if (context) withContext.push({ trade, context });
  }

  const triggerBuckets = emptyBuckets(TRIGGER_GROUP_ORDER);
  const actionBuckets = emptyBuckets(ACTION_GROUP_ORDER);
  const freshnessBuckets = emptyBuckets(FRESHNESS_GROUP_ORDER);
  const eventBuckets = emptyBuckets(EVENT_GROUP_ORDER);
  const dllBuckets = emptyBuckets(DLL_GROUP_ORDER);

  for (const { trade, context } of withContext) {
    const trigger = triggerStatusAtEntry(context) as typeof TRIGGER_GROUP_ORDER[number];
    triggerBuckets[TRIGGER_GROUP_ORDER.includes(trigger) ? trigger : "no_trigger"].push(trade);

    const action = actionAtEntry(context) as typeof ACTION_GROUP_ORDER[number];
    actionBuckets[ACTION_GROUP_ORDER.includes(action) ? action : "unavailable"].push(trade);

    freshnessBuckets[context.analysisStale ? "stale" : "fresh"].push(trade);

    const event = eventRiskAtEntry(context) as typeof EVENT_GROUP_ORDER[number];
    eventBuckets[EVENT_GROUP_ORDER.includes(event) ? event : "unavailable"].push(trade);

    dllBuckets[context.dailyLossLimitReached ? "reached" : "not_reached"].push(trade);
  }

  const triggerGroups = present(TRIGGER_GROUP_ORDER, TRIGGER_GROUP_LABELS, triggerBuckets);
  const actionGroups = present(ACTION_GROUP_ORDER, ACTION_GROUP_LABELS, actionBuckets);
  const freshnessGroups = present(FRESHNESS_GROUP_ORDER, FRESHNESS_GROUP_LABELS, freshnessBuckets);
  const eventRiskGroups = present(EVENT_GROUP_ORDER, EVENT_GROUP_LABELS, eventBuckets);
  const dailyLossLimitGroups = present(DLL_GROUP_ORDER, DLL_GROUP_LABELS, dllBuckets);

  const eligibleClosedTrades = closed.length;
  const contextTrades = withContext.length;
  const missingContextTrades = eligibleClosedTrades - contextTrades;

  return {
    periodLabel,
    eligibleClosedTrades,
    contextTrades,
    missingContextTrades,
    coverageRate: eligibleClosedTrades ? (contextTrades / eligibleClosedTrades) * 100 : null,
    triggerGroups,
    actionGroups,
    freshnessGroups,
    eventRiskGroups,
    dailyLossLimitGroups,
    comparisons: comparisonsFrom({ trigger: triggerGroups, action: actionGroups, freshness: freshnessGroups }),
  };
}
