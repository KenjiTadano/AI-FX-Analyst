import { qualityLabel } from "../chart-analysis/normalize";
import type { AIAnalysis } from "../ai/types";
import type { RiskSettings } from "../risk/types";
import type { Candle, Timeframe } from "../market/types";
import {
  TRIGGER_DISCLAIMER,
  TRIGGER_SOURCE_LABEL,
  TRIGGER_STALE_NOTE,
  evaluateStructuredEntryTrigger,
  sanitizeStructuredEntryTrigger,
  type EntryTriggerEvaluation,
  type StructuredEntryTrigger,
} from "../ai/entry-trigger";
import {
  ANALYSIS_STALE_MESSAGE,
  REVIEW_BUY_MESSAGE,
  REVIEW_SELL_MESSAGE,
  RISK_LIMIT_MESSAGE,
  type DailyPlanAction,
  type DailyPlanDirection,
  type DailyTradingPlan,
  type EventRiskLevel,
} from "./daily-plan";

export const ENTRY_READINESS_DISCLAIMER =
  "エントリー準備度は、判断材料の確認状況を示すもので、勝率やエントリー推奨度を表すものではありません。";
export const READINESS_UNAVAILABLE_MESSAGE = "AI分析を実行すると準備状況を確認できます";
export const EVENT_UNAVAILABLE_MESSAGE = "イベント情報：取得できていません";
export const RISK_INVALID_MESSAGE = "Risk設定を確認してください";
export const CONDITION_NOT_EVALUATED_MESSAGE = "条件成立の自動判定はしていません";
export const CONDITION_PRESENT_LABEL = "確認条件あり";
export const WAIT_ACTION_MESSAGE = "現在のActionはWAITです";
export const WAIT_UNTIL_CONDITION_MESSAGE = "条件成立まで待つ";
export const READY_TO_REVIEW_MESSAGE = "条件を確認できます";
export const WAITING_MATERIALS_MESSAGE = "条件の確認待ち";
export const STALE_REFRESH_MESSAGE = "分析を更新してください";
export const READINESS_FIXED_TOTAL = 5;

export type ReadinessCheckStatus = "confirmed" | "pending" | "warning" | "unavailable";
export type EntryReadinessState = "ready_to_review" | "waiting" | "warning" | "unavailable";
export type ReadinessCheckId = "analysis" | "direction" | "dataQuality" | "risk" | "eventRisk";

export const CHECK_STATUS_LABEL: Record<ReadinessCheckStatus, string> = {
  confirmed: "確認済み",
  pending: "確認待ち",
  warning: "注意",
  unavailable: "未取得",
};

export const STATE_LABEL: Record<EntryReadinessState, string> = {
  ready_to_review: "条件を確認できます",
  waiting: "確認待ち",
  warning: "注意",
  unavailable: "未取得",
};

export interface ReadinessCheck {
  id: ReadinessCheckId;
  title: string;
  status: ReadinessCheckStatus;
  statusLabel: string;
  detail: string;
}

export interface EntryConditionReadiness {
  status: ReadinessCheckStatus;
  statusLabel: string;
  label: string;
  text: string | null;
  evaluated: false;
  note: string;
}

export interface EntryReadinessWarning {
  code: "daily_loss_limit" | "stale" | "analysis_unavailable" | "low_data_quality" | "high_event_risk" | "invalid_risk";
  message: string;
}

export interface EntryReadiness {
  pair: string;
  state: EntryReadinessState;
  confirmedCount: number;
  totalCount: typeof READINESS_FIXED_TOTAL;
  action: DailyPlanAction | null;
  direction: DailyPlanDirection;
  actionMessage: string;
  guidance: string;
  stateMessage: string;
  checks: {
    analysis: ReadinessCheck;
    direction: ReadinessCheck;
    dataQuality: ReadinessCheck;
    risk: ReadinessCheck;
    eventRisk: ReadinessCheck;
  };
  entryCondition: EntryConditionReadiness;
  warnings: EntryReadinessWarning[];
  chartEvidenceUsed: boolean;
  confidence: number | null;
  stale: boolean;
  dailyLossLimitReached: boolean;
  entryTrigger: StructuredEntryTrigger | null;
  triggerEvaluation: EntryTriggerEvaluation | null;
  triggerSourceLabel: string;
  triggerDisclaimer: string;
  triggerStaleNote: string | null;
}

export interface EntryReadinessInput {
  pair: string;
  analysis: AIAnalysis | null | undefined;
  dailyPlan: DailyTradingPlan;
  riskSettings: RiskSettings | null | undefined;
  currentRate?: number | null;
  candlesByTimeframe?: Partial<Record<Timeframe, { candles: Candle[]; lastClosedAt: string | null } | null>>;
  now?: Date | number | string;
}

function check(
  id: ReadinessCheckId,
  title: string,
  status: ReadinessCheckStatus,
  detail: string,
): ReadinessCheck {
  return { id, title, status, statusLabel: CHECK_STATUS_LABEL[status], detail };
}

function dataQualityStatus(score: number | null): ReadinessCheckStatus {
  if (score == null || !Number.isFinite(score)) return "unavailable";
  const band = qualityLabel(score);
  if (band === "高") return "confirmed";
  if (band === "中") return "pending";
  return "warning";
}

function eventRiskStatus(level: EventRiskLevel, available: boolean): ReadinessCheckStatus {
  if (!available) return "unavailable";
  if (level === "high") return "warning";
  if (level === "medium") return "pending";
  if (level === "low") return "confirmed";
  return "pending";
}

function overallState(input: {
  analysisMissing: boolean;
  dailyLossLimitReached: boolean;
  stale: boolean;
  checks: ReadinessCheck[];
}): EntryReadinessState {
  if (input.dailyLossLimitReached) return "warning";
  if (input.stale) return "warning";
  if (input.analysisMissing) return "unavailable";
  if (input.checks.some(item => item.status === "warning")) return "warning";
  if (input.checks.some(item => item.status === "pending" || item.status === "unavailable")) return "waiting";
  return "ready_to_review";
}

export function buildEntryReadiness(input: EntryReadinessInput): EntryReadiness {
  const pair = input.pair;
  const analysis = input.analysis && input.analysis.pair === pair ? input.analysis : null;
  const analysisMissing = !analysis;
  const plan = input.dailyPlan.pair === pair ? input.dailyPlan : {
    ...input.dailyPlan,
    pair,
    direction: "NEUTRAL" as const,
    action: null,
    dataQuality: null,
    entryCondition: null,
    eventRisk: { ...input.dailyPlan.eventRisk, available: false, level: "unknown" as const, message: EVENT_UNAVAILABLE_MESSAGE, source: "none" as const },
    stale: false,
    chartEvidenceUsed: false,
    confidence: null,
  };
  const stale = !!analysis && plan.stale;
  const dailyLossLimitReached = plan.dailyLossRemaining !== null && plan.dailyLossRemaining <= 0;

  const analysisCheck = analysisMissing
    ? check("analysis", "AI分析", "unavailable", READINESS_UNAVAILABLE_MESSAGE)
    : stale
      ? check("analysis", "AI分析", "warning", STALE_REFRESH_MESSAGE)
      : check("analysis", "AI分析", "confirmed", "最新");

  const directionCheck = analysisMissing
    ? check("direction", "AI方向", "unavailable", "未取得")
    : plan.direction === "BUY" || plan.direction === "SELL"
      ? check("direction", "AI方向", "confirmed", plan.direction)
      : check("direction", "AI方向", "pending", "NEUTRAL");

  const qualityScore = analysis ? plan.dataQuality : null;
  const qualityStatus = dataQualityStatus(qualityScore);
  const dataQualityCheck = qualityStatus === "unavailable"
    ? check("dataQuality", "Data Quality", "unavailable", "未取得")
    : check(
      "dataQuality",
      "Data Quality",
      qualityStatus,
      `${qualityScore}（${qualityLabel(qualityScore as number)}）`,
    );

  let riskCheck: ReadinessCheck;
  if (!input.riskSettings) {
    riskCheck = check("risk", "Risk", "unavailable", "未取得");
  } else if (plan.capital == null || plan.riskPercent == null || plan.riskPerTrade == null) {
    riskCheck = check("risk", "Risk", "warning", RISK_INVALID_MESSAGE);
  } else {
    riskCheck = check("risk", "Risk", "confirmed", `1回あたり ¥${plan.riskPerTrade.toLocaleString("ja-JP")}`);
  }

  const eventAvailable = plan.eventRisk.available;
  const eventStatus = eventRiskStatus(plan.eventRisk.level, eventAvailable);
  const eventDetail = eventStatus === "unavailable"
    ? EVENT_UNAVAILABLE_MESSAGE
    : plan.eventRisk.message;
  const eventRiskCheck = check("eventRisk", "Event Risk", eventStatus, eventDetail);

  const checks = {
    analysis: analysisCheck,
    direction: directionCheck,
    dataQuality: dataQualityCheck,
    risk: riskCheck,
    eventRisk: eventRiskCheck,
  };
  const checkList = [analysisCheck, directionCheck, dataQualityCheck, riskCheck, eventRiskCheck];
  const confirmedCount = checkList.filter(item => item.status === "confirmed").length;
  const state = overallState({ analysisMissing, dailyLossLimitReached, stale, checks: checkList });

  const entryText = analysis ? plan.entryCondition : null;
  const entryCondition: EntryConditionReadiness = entryText
    ? {
      status: "pending",
      statusLabel: CHECK_STATUS_LABEL.pending,
      label: CONDITION_PRESENT_LABEL,
      text: entryText,
      evaluated: false,
      note: CONDITION_NOT_EVALUATED_MESSAGE,
    }
    : {
      status: "unavailable",
      statusLabel: CHECK_STATUS_LABEL.unavailable,
      label: "Entry条件なし",
      text: null,
      evaluated: false,
      note: CONDITION_NOT_EVALUATED_MESSAGE,
    };

  const warnings: EntryReadinessWarning[] = [];
  if (dailyLossLimitReached) warnings.push({ code: "daily_loss_limit", message: RISK_LIMIT_MESSAGE });
  if (stale) warnings.push({ code: "stale", message: ANALYSIS_STALE_MESSAGE });
  if (analysisMissing) warnings.push({ code: "analysis_unavailable", message: READINESS_UNAVAILABLE_MESSAGE });
  if (riskCheck.status === "warning") warnings.push({ code: "invalid_risk", message: RISK_INVALID_MESSAGE });
  if (dataQualityCheck.status === "warning") warnings.push({ code: "low_data_quality", message: "Data Qualityが低いため、判断材料の確認に注意が必要です。" });
  if (eventRiskCheck.status === "warning") warnings.push({ code: "high_event_risk", message: plan.eventRisk.message });

  const action = analysis ? plan.action : null;
  const direction = analysis ? plan.direction : "NEUTRAL";
  const rawTrigger = analysis?.entryTrigger;
  const hasStructuredTrigger = rawTrigger != null;
  const entryTrigger = hasStructuredTrigger ? sanitizeStructuredEntryTrigger(rawTrigger, pair) : null;
  const triggerEvaluation = hasStructuredTrigger
    ? evaluateStructuredEntryTrigger({
      trigger: rawTrigger,
      pair,
      currentRate: input.currentRate !== undefined ? input.currentRate : plan.currentRate,
      candlesByTimeframe: input.candlesByTimeframe,
      now: input.now ?? Date.now(),
    })
    : null;
  const actionMessage = action === "WAIT"
    ? WAIT_ACTION_MESSAGE
    : action === "BUY"
      ? REVIEW_BUY_MESSAGE
      : action === "SELL"
        ? REVIEW_SELL_MESSAGE
        : READINESS_UNAVAILABLE_MESSAGE;
  const guidance = action === "WAIT"
    ? WAIT_UNTIL_CONDITION_MESSAGE
    : action === "BUY"
      ? REVIEW_BUY_MESSAGE
      : action === "SELL"
        ? REVIEW_SELL_MESSAGE
        : READINESS_UNAVAILABLE_MESSAGE;
  const stateMessage = dailyLossLimitReached
    ? RISK_LIMIT_MESSAGE
    : stale
      ? ANALYSIS_STALE_MESSAGE
      : state === "unavailable"
        ? READINESS_UNAVAILABLE_MESSAGE
        : state === "ready_to_review"
          ? READY_TO_REVIEW_MESSAGE
          : state === "waiting"
            ? WAITING_MATERIALS_MESSAGE
            : warnings[0]?.message ?? "注意";

  return {
    pair,
    state,
    confirmedCount,
    totalCount: READINESS_FIXED_TOTAL,
    action,
    direction,
    actionMessage,
    guidance,
    stateMessage,
    checks,
    entryCondition,
    warnings,
    chartEvidenceUsed: !!analysis && plan.chartEvidenceUsed,
    confidence: analysis ? plan.confidence : null,
    stale,
    dailyLossLimitReached,
    entryTrigger,
    triggerEvaluation,
    triggerSourceLabel: TRIGGER_SOURCE_LABEL,
    triggerDisclaimer: TRIGGER_DISCLAIMER,
    triggerStaleNote: stale && triggerEvaluation ? TRIGGER_STALE_NOTE : null,
  };
}
