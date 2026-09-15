import { TRIGGER_DISCLAIMER, TRIGGER_INVALID_LABEL } from "../ai/entry-trigger";
import type { AIAnalysis } from "../ai/types";
import { RISK_LIMIT_MESSAGE, type DailyTradingPlan } from "../trading-plan/daily-plan";
import {
  STATE_LABEL,
  WAIT_ACTION_MESSAGE,
  type EntryReadiness,
} from "../trading-plan/entry-readiness";
import {
  WATCH_DISTANCE_DISCLAIMER,
  buildEntryTriggerWatch,
  formatWatchCheckedAt,
  formatWatchDistancePips,
} from "../trading-plan/entry-trigger-watch";
import {
  capturePreTradeContext,
  eventRiskAtEntry,
  formatPreTradeEvent,
  formatPreTradeTriggerStatus,
  triggerStatusAtEntry,
} from "./pre-trade-context";
import type { PreTradeContextSnapshot } from "./types";

export const PRE_TRADE_REVIEW_TITLE = "エントリー前の最終確認";
export const PRE_TRADE_REVIEW_EYEBROW = "PRE-TRADE REVIEW";
export const PRE_TRADE_REVIEW_DISCLAIMER =
  "この表示はエントリー前の判断状況を確認するためのもので、売買を推奨・禁止するものではありません。";
export const PRE_TRADE_REVIEW_TRIGGER_DISCLAIMER = TRIGGER_DISCLAIMER;
export const PRE_TRADE_REVIEW_DISTANCE_DISCLAIMER = WATCH_DISTANCE_DISCLAIMER;
export const PRE_TRADE_REVIEW_SAVE_ON = "この判断状況は取引登録時点の情報として保存されます";
export const PRE_TRADE_REVIEW_SAVE_OFF =
  "AI分析の保存がOFFのため、この判断状況は取引履歴には保存されません";
export const PRE_TRADE_REVIEW_UNAVAILABLE = "現在のAI判断状況を確認できません";
export const PRE_TRADE_REVIEW_NO_TRIGGER = "自動判定できる構造化条件はありません";
export const PRE_TRADE_REVIEW_MAX_WARNINGS = 5;

export type PreTradeReviewWarningCode =
  | "daily_loss_limit_reached"
  | "analysis_stale"
  | "event_high"
  | "event_unavailable"
  | "action_wait"
  | "direction_conflict"
  | "trigger_unavailable"
  | "trigger_invalid"
  | "trigger_not_met"
  | "context_not_saved"
  | "context_unavailable";

export type PreTradeReviewWarning = {
  code: PreTradeReviewWarningCode;
  message: string;
  severity: "warning" | "info";
};

export type PreTradeReviewModel = {
  pair: string;
  tradeSide: "BUY" | "SELL";
  saveAnalysis: boolean;
  context: PreTradeContextSnapshot | null;
  direction: PreTradeContextSnapshot["direction"];
  action: PreTradeContextSnapshot["action"];
  readinessCount: string;
  readinessState: string | null;
  triggerStatus: string;
  triggerDistance: string | null;
  triggerCheckedAt: string | null;
  eventRisk: string;
  freshness: string;
  risk: string;
  warnings: PreTradeReviewWarning[];
  blocking: false;
  saveMessage: string;
};

const WARNING_ORDER: PreTradeReviewWarningCode[] = [
  "daily_loss_limit_reached",
  "analysis_stale",
  "event_high",
  "event_unavailable",
  "action_wait",
  "direction_conflict",
  "trigger_unavailable",
  "trigger_invalid",
  "trigger_not_met",
  "context_unavailable",
  "context_not_saved",
];

const MESSAGES: Record<PreTradeReviewWarningCode, string> = {
  daily_loss_limit_reached: RISK_LIMIT_MESSAGE,
  analysis_stale: "AI分析が古いため、現在の市場状況とずれている可能性があります。",
  event_high: "重要イベントリスクが高い状態です。",
  event_unavailable: "イベントリスク情報を取得できていません。",
  action_wait: `${WAIT_ACTION_MESSAGE}。`,
  direction_conflict: "登録予定の方向とAI方向が異なります。",
  trigger_unavailable: "エントリー条件を現在のデータでは判定できません。",
  trigger_invalid: TRIGGER_INVALID_LABEL,
  trigger_not_met: "構造化されたエントリー条件はまだ成立していません。",
  context_not_saved: PRE_TRADE_REVIEW_SAVE_OFF,
  context_unavailable: PRE_TRADE_REVIEW_UNAVAILABLE,
};

function tradeSideOf(side: "BUY" | "SELL" | "long" | "short"): "BUY" | "SELL" {
  return side === "SELL" || side === "short" ? "SELL" : "BUY";
}

export function distanceFromReadiness(pair: string, readiness: EntryReadiness | null | undefined): number | null {
  if (!readiness?.triggerEvaluation) return null;
  const distance = buildEntryTriggerWatch({
    trigger: readiness.entryTrigger,
    evaluation: readiness.triggerEvaluation,
    action: readiness.action,
    direction: readiness.direction,
    stale: readiness.stale,
    dailyLossLimitReached: readiness.dailyLossLimitReached,
    pair,
  })?.distanceToTriggerPips ?? null;
  return distance != null && Number.isFinite(distance) && distance >= 0 ? distance : null;
}

export function captureLivePreTradeContext(input: {
  pair: string;
  analysis?: AIAnalysis | null;
  dailyPlan?: DailyTradingPlan | null;
  readiness?: EntryReadiness | null;
}): PreTradeContextSnapshot | null {
  const analysis = input.analysis && input.analysis.pair === input.pair ? input.analysis : null;
  if (!analysis) return null;
  return capturePreTradeContext({
    pair: input.pair,
    capturedAt: analysis.analyzedAt,
    analysis,
    dailyPlan: input.dailyPlan ?? null,
    readiness: input.readiness ?? null,
    distanceToTriggerPips: distanceFromReadiness(input.pair, input.readiness),
  });
}

function warn(code: PreTradeReviewWarningCode, severity: PreTradeReviewWarning["severity"] = "warning"): PreTradeReviewWarning {
  return { code, message: MESSAGES[code], severity };
}

function collectWarnings(input: {
  context: PreTradeContextSnapshot | null;
  tradeSide: "BUY" | "SELL";
  saveAnalysis: boolean;
  readiness: EntryReadiness | null;
}): PreTradeReviewWarning[] {
  const { context, tradeSide, saveAnalysis, readiness } = input;
  const items: PreTradeReviewWarning[] = [];
  if (!context) items.push(warn("context_unavailable", "info"));
  if (context?.dailyLossLimitReached) items.push(warn("daily_loss_limit_reached"));
  if (context?.analysisStale) items.push(warn("analysis_stale"));
  const event = eventRiskAtEntry(context);
  if (event === "high") items.push(warn("event_high"));
  if (context && event === "unavailable") items.push(warn("event_unavailable", "info"));
  if (context?.action === "WAIT") items.push(warn("action_wait"));
  if (context && context.action !== "WAIT" && (context.direction === "BUY" || context.direction === "SELL") && context.direction !== tradeSide) {
    items.push(warn("direction_conflict"));
  }
  if (readiness?.triggerEvaluation?.status === "invalid") {
    items.push(warn("trigger_invalid"));
  } else if (context) {
    const trigger = triggerStatusAtEntry(context);
    if (trigger === "unavailable") items.push(warn("trigger_unavailable"));
    if (trigger === "not_met") items.push(warn("trigger_not_met"));
  }
  if (!saveAnalysis) items.push(warn("context_not_saved", "info"));
  return WARNING_ORDER
    .map(code => items.find(item => item.code === code))
    .filter((item): item is PreTradeReviewWarning => !!item)
    .slice(0, PRE_TRADE_REVIEW_MAX_WARNINGS);
}

function triggerLabel(context: PreTradeContextSnapshot | null, readiness: EntryReadiness | null): string {
  if (readiness?.triggerEvaluation?.status === "invalid") return "構造化条件利用不可";
  if (!context) return "未取得";
  if (!context.trigger) return PRE_TRADE_REVIEW_NO_TRIGGER;
  return formatPreTradeTriggerStatus(context);
}

export function buildPreTradeReview(input: {
  pair: string;
  tradeSide: "BUY" | "SELL" | "long" | "short";
  analysis?: AIAnalysis | null;
  dailyPlan?: DailyTradingPlan | null;
  readiness?: EntryReadiness | null;
  saveAnalysis: boolean;
}): PreTradeReviewModel {
  const pair = input.pair;
  const tradeSide = tradeSideOf(input.tradeSide);
  const analysis = input.analysis && input.analysis.pair === pair ? input.analysis : null;
  const plan = input.dailyPlan && input.dailyPlan.pair === pair ? input.dailyPlan : null;
  const readiness = input.readiness && input.readiness.pair === pair ? input.readiness : null;
  const context = captureLivePreTradeContext({ pair, analysis, dailyPlan: plan, readiness });
  const status = triggerStatusAtEntry(context);
  const distance = status === "not_met" ? context?.trigger?.evaluation.distanceToTriggerPips ?? null : null;
  const checkedAt = context?.trigger?.evaluation.checkedAt ?? null;
  const warnings = collectWarnings({ context, tradeSide, saveAnalysis: input.saveAnalysis, readiness });

  return {
    pair,
    tradeSide,
    saveAnalysis: input.saveAnalysis,
    context,
    direction: context?.direction ?? null,
    action: context?.action ?? null,
    readinessCount: context?.readiness ? `${context.readiness.confirmedCount} / ${context.readiness.totalCount}` : "—",
    readinessState: context?.readiness ? STATE_LABEL[context.readiness.state] : null,
    triggerStatus: triggerLabel(context, readiness),
    triggerDistance: distance != null && distance >= 0 ? `条件まであと ${formatWatchDistancePips(distance)}` : null,
    triggerCheckedAt: checkedAt ? formatWatchCheckedAt(checkedAt) : null,
    eventRisk: context ? formatPreTradeEvent(context) : "未取得",
    freshness: context ? (context.analysisStale ? "期限切れ分析" : "最新分析") : "未取得",
    risk: context?.risk
      ? `${context.risk.riskPerTrade.toLocaleString("ja-JP", { maximumFractionDigits: 2 })}円 / ${context.risk.riskPercent.toFixed(1)}%`
      : "未取得",
    warnings,
    blocking: false,
    saveMessage: input.saveAnalysis ? PRE_TRADE_REVIEW_SAVE_ON : PRE_TRADE_REVIEW_SAVE_OFF,
  };
}

export function reviewContextFields(context: PreTradeContextSnapshot | null) {
  return {
    pair: context?.pair ?? null,
    direction: context?.direction ?? null,
    action: context?.action ?? null,
    readiness: context?.readiness ?? null,
    triggerStatus: triggerStatusAtEntry(context),
    eventRisk: eventRiskAtEntry(context),
    analysisStale: context?.analysisStale ?? null,
    risk: context?.risk ?? null,
  };
}
