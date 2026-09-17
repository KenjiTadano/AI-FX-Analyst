import { calculateRealizedR, formatRealizedR } from "./exit-plan";
import { formatWatchDistancePips } from "../trading-plan/entry-trigger-watch";
import {
  actionAtEntry,
  eventRiskAtEntry,
  formatPreTradeEvent,
  formatPreTradeTriggerStatus,
  sanitizePreTradeContext,
  triggerStatusAtEntry,
} from "./pre-trade-context";
import { isRichSnapshot } from "./snapshot";
import type { PreTradeContextSnapshot, Trade, TradePair } from "./types";

export const POST_TRADE_REVIEW_TITLE = "決済後レビュー";
export const POST_TRADE_REVIEW_EYEBROW = "POST-TRADE REVIEW";
export const POST_TRADE_REVIEW_SNAPSHOT_NOTE =
  "エントリー時の情報は取引登録時に保存されたスナップショットです。取引結果によって後から変更・再評価していません。";
export const POST_TRADE_REVIEW_DISCLAIMER =
  "この表示は過去の取引事実を振り返るためのもので、判断の正誤や将来の成果を示すものではありません。";
export const POST_TRADE_REVIEW_MISSING = "エントリー時の判断状況は保存されていません";
export const POST_TRADE_REVIEW_UNREADABLE = "エントリー時の判断状況は確認できません";
export const POST_TRADE_REVIEW_MAX_LABELS = 5;

export type PostTradeResult = "profit" | "loss" | "flat";
export type PostTradeContextState = "ok" | "absent" | "unreadable";

export type PostTradeReviewModel = {
  pair: TradePair;
  tradeSide: "BUY" | "SELL";
  outcome: {
    realizedPnl: number | null;
    realizedR: number | null;
    realizedRLabel: string;
    result: PostTradeResult | null;
    resultLabel: string;
    holdingDurationMinutes: number | null;
    holdingDurationLabel: string;
  };
  context: PreTradeContextSnapshot | null;
  contextState: PostTradeContextState;
  direction: "BUY" | "SELL" | "NEUTRAL" | "未取得";
  action: "BUY" | "SELL" | "WAIT" | "未取得";
  readinessCount: string;
  triggerStatus: string;
  triggerDistance: string | null;
  triggerCheckedAt: string | null;
  eventRisk: string;
  freshness: string;
  risk: string;
  dailyLossLimit: string | null;
  contextLabels: string[];
};

const TRIGGER_LABELS: Record<ReturnType<typeof triggerStatusAtEntry>, string> = {
  met: "Trigger条件成立時に登録",
  not_met: "Trigger条件未成立時に登録",
  unavailable: "Trigger判定データ不足時に登録",
  invalid: "Trigger構造化条件利用不可時に登録",
  no_trigger: "Triggerなしで登録",
};

const RESULT_LABEL: Record<PostTradeResult, string> = {
  profit: "利益",
  loss: "損失",
  flat: "損益なし",
};

export function holdingDurationMinutes(openedAt: string, closedAt: string | null | undefined): number | null {
  const opened = Date.parse(openedAt);
  const closed = typeof closedAt === "string" ? Date.parse(closedAt) : NaN;
  if (!Number.isFinite(opened) || !Number.isFinite(closed) || closed < opened) return null;
  return Math.floor((closed - opened) / 60_000);
}

export function formatHoldingDuration(minutes: number | null): string {
  if (minutes == null || !Number.isFinite(minutes) || minutes < 0) return "—";
  const days = Math.floor(minutes / (24 * 60));
  const hours = Math.floor((minutes % (24 * 60)) / 60);
  const mins = minutes % 60;
  const parts: string[] = [];
  if (days) parts.push(`${days}日`);
  if (hours) parts.push(`${hours}時間`);
  if (mins || parts.length === 0) parts.push(`${mins}分`);
  return parts.join("");
}

export function storedPreTradeContext(trade: Trade): PreTradeContextSnapshot | null {
  if (!isRichSnapshot(trade.analysisSnapshot)) return null;
  return sanitizePreTradeContext(trade.analysisSnapshot.preTradeContext, trade.pair);
}

function contextStateOf(trade: Trade, context: PreTradeContextSnapshot | null): PostTradeContextState {
  if (context) return "ok";
  const snap = isRichSnapshot(trade.analysisSnapshot) ? trade.analysisSnapshot : null;
  return snap?.preTradeContext != null ? "unreadable" : "absent";
}

function resultOf(pnl: number | null): PostTradeResult | null {
  if (pnl == null || !Number.isFinite(pnl)) return null;
  if (pnl > 0) return "profit";
  if (pnl < 0) return "loss";
  return "flat";
}

function triggerGridLabel(context: PreTradeContextSnapshot): string {
  const status = triggerStatusAtEntry(context);
  if (status === "no_trigger") return "Triggerなし";
  if (status === "invalid") return "構造化条件利用不可";
  return formatPreTradeTriggerStatus(context);
}

function riskLabel(context: PreTradeContextSnapshot): string {
  if (!context.risk) return "未取得";
  return `${context.risk.riskPerTrade.toLocaleString("ja-JP", { maximumFractionDigits: 2 })}円 / ${context.risk.riskPercent.toFixed(1)}%`;
}

export function buildContextLabels(context: PreTradeContextSnapshot): string[] {
  const labels: string[] = [];
  labels.push(TRIGGER_LABELS[triggerStatusAtEntry(context)]);
  const action = actionAtEntry(context);
  if (action !== "unavailable") labels.push(`Action ${action}時に登録`);
  labels.push(context.analysisStale ? "期限切れ分析時に登録" : "最新分析時に登録");
  const event = eventRiskAtEntry(context);
  labels.push(event === "unavailable" ? "Event Risk未取得時に登録" : `Event Risk ${event.toUpperCase()}時に登録`);
  labels.push(context.dailyLossLimitReached ? "Daily Loss Limit到達時に登録" : "Daily Loss Limit未到達時に登録");
  return labels.slice(0, POST_TRADE_REVIEW_MAX_LABELS);
}

export function buildPostTradeReview(trade: Trade): PostTradeReviewModel | null {
  if (trade.status !== "closed") return null;
  const context = storedPreTradeContext(trade);
  const minutes = holdingDurationMinutes(trade.openedAt, trade.closedAt);
  const result = resultOf(trade.realizedPnl);
  const realizedR = calculateRealizedR(trade);
  const distance = context?.trigger?.evaluation.status === "not_met"
    ? context.trigger.evaluation.distanceToTriggerPips
    : null;
  return {
    pair: trade.pair,
    tradeSide: trade.side === "short" ? "SELL" : "BUY",
    outcome: {
      realizedPnl: trade.realizedPnl,
      realizedR,
      realizedRLabel: formatRealizedR(realizedR),
      result,
      resultLabel: result ? RESULT_LABEL[result] : "—",
      holdingDurationMinutes: minutes,
      holdingDurationLabel: formatHoldingDuration(minutes),
    },
    context,
    contextState: contextStateOf(trade, context),
    direction: context?.direction ?? "未取得",
    action: context?.action ?? "未取得",
    readinessCount: context?.readiness ? `${context.readiness.confirmedCount} / ${context.readiness.totalCount}` : "—",
    triggerStatus: context ? triggerGridLabel(context) : "—",
    triggerDistance: distance != null && distance >= 0 ? `条件まであと ${formatWatchDistancePips(distance)}` : null,
    triggerCheckedAt: context?.trigger?.evaluation.checkedAt ?? null,
    eventRisk: context ? formatPreTradeEvent(context) : "未取得",
    freshness: context ? (context.analysisStale ? "期限切れ分析" : "最新分析") : "未取得",
    risk: context ? riskLabel(context) : "未取得",
    dailyLossLimit: context ? (context.dailyLossLimitReached ? "到達" : "未到達") : null,
    contextLabels: context ? buildContextLabels(context) : [],
  };
}
