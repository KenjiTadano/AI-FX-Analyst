import {
  TIMEFRAME_LABEL,
  TRIGGER_DISCLAIMER,
  TRIGGER_INVALID_LABEL,
  TRIGGER_STALE_NOTE,
  type EntryTriggerEvaluation,
  type EntryTriggerEvaluationStatus,
  type StructuredEntryTrigger,
  type TriggerTimeframe,
} from "../ai/entry-trigger";
import { priceDeltaToPips } from "../trades/analysis-price";
import { RISK_LIMIT_MESSAGE, type DailyPlanAction, type DailyPlanDirection } from "./daily-plan";

export type EntryTriggerWatchStatus = "waiting" | "met" | "unavailable" | "invalid";

export const WATCH_STATUS_TEXT: Record<EntryTriggerWatchStatus, string> = {
  waiting: "条件待ち",
  met: "条件成立",
  unavailable: "判定データ待ち",
  invalid: "利用不可",
};

export const WATCH_DISTANCE_DISCLAIMER =
  "条件までのpipsは価格差を示すだけで、成立確率やエントリー推奨度ではありません。";
export const WATCH_NEWLY_MET_NOTICE = "エントリー条件の成立を確認しました";
export const WATCH_CHECKED_AT_NOTE = "Dashboardで条件成立を確認した時刻";
export const WATCH_INVALID_MESSAGE = TRIGGER_INVALID_LABEL;
export const WATCH_UNAVAILABLE_MESSAGE = "判定データ待ち";
export const WATCH_STALE_WARNING = TRIGGER_STALE_NOTE;
export const WATCH_DLL_WARNING = RISK_LIMIT_MESSAGE;
export const WATCH_TRIGGER_DISCLAIMER = TRIGGER_DISCLAIMER;

export interface EntryTriggerIdentity {
  analyzedAt: string;
  pair: string;
  type: StructuredEntryTrigger["type"];
  price: number;
  timeframe: TriggerTimeframe | null;
}

export interface EntryTriggerWatch {
  status: EntryTriggerWatchStatus;
  statusText: string;
  direction: DailyPlanDirection;
  action: DailyPlanAction | null;
  humanCondition: string;
  expression: string;
  observedValue: number | null;
  observedLabel: string;
  distanceToTriggerPips: number | null;
  showDistance: boolean;
  identity: EntryTriggerIdentity | null;
  identityKey: string | null;
  checkedAt: string;
  unavailableDetail: string | null;
  invalidMessage: string | null;
  staleWarning: string | null;
  dailyLossLimitWarning: string | null;
  eventRiskWarning: string | null;
  distanceDisclaimer: string;
  triggerDisclaimer: string;
  checkedAtNote: string;
}

export interface BuildEntryTriggerWatchInput {
  trigger: StructuredEntryTrigger | null;
  evaluation: EntryTriggerEvaluation | null;
  action: DailyPlanAction | null;
  direction: DailyPlanDirection;
  stale: boolean;
  dailyLossLimitReached: boolean;
  eventRiskHigh?: boolean;
  eventRiskMessage?: string | null;
  analyzedAt?: string | null;
  pair: string;
}

export interface WatchTransitionMemory {
  identityKey: string | null;
  evaluationStatus: EntryTriggerEvaluationStatus | null;
  newlyMet: boolean;
}

function watchStatusFromEvaluation(status: EntryTriggerEvaluationStatus): EntryTriggerWatchStatus {
  if (status === "not_met") return "waiting";
  if (status === "met") return "met";
  if (status === "unavailable") return "unavailable";
  return "invalid";
}

function signedGap(type: StructuredEntryTrigger["type"], triggerPrice: number, observed: number): number {
  if (type === "price_above" || type === "candle_close_above") return triggerPrice - observed;
  return observed - triggerPrice;
}

function distancePips(
  trigger: StructuredEntryTrigger,
  evaluation: EntryTriggerEvaluation,
): number | null {
  if (evaluation.status === "unavailable" || evaluation.status === "invalid") return null;
  if (evaluation.observedValue == null || !Number.isFinite(evaluation.observedValue)) return null;
  if (evaluation.status === "met") return 0;
  const gap = signedGap(trigger.type, trigger.price, evaluation.observedValue);
  return priceDeltaToPips(trigger.pair, Math.max(0, gap));
}

function observedLabelFor(evaluation: EntryTriggerEvaluation): string {
  if (evaluation.observedLabel === "確定足終値") return "最新確定値";
  if (evaluation.observedLabel === "現在価格") return "最新確定値";
  return evaluation.observedLabel;
}

function unavailableDetail(
  trigger: StructuredEntryTrigger | null,
  evaluation: EntryTriggerEvaluation,
): string | null {
  if (evaluation.status !== "unavailable") return null;
  if (trigger?.timeframe) {
    return `${TIMEFRAME_LABEL[trigger.timeframe]}の確定データを待っています`;
  }
  if (trigger && (trigger.type === "price_above" || trigger.type === "price_below")) {
    return "現在価格の判定データを待っています";
  }
  return WATCH_UNAVAILABLE_MESSAGE;
}

export function entryTriggerIdentityKey(identity: EntryTriggerIdentity): string {
  return [identity.analyzedAt, identity.pair, identity.type, String(identity.price), identity.timeframe ?? ""].join("|");
}

export function buildEntryTriggerIdentity(input: {
  analyzedAt?: string | null;
  pair: string;
  type: StructuredEntryTrigger["type"];
  price: number;
  timeframe: TriggerTimeframe | null;
}): EntryTriggerIdentity {
  return {
    analyzedAt: input.analyzedAt ?? "",
    pair: input.pair,
    type: input.type,
    price: input.price,
    timeframe: input.timeframe,
  };
}

export function formatWatchDistancePips(pips: number): string {
  const rounded = Math.round(pips * 10) / 10;
  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  return `${text} pips`;
}

export function formatWatchCheckedAt(iso: string): string {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}

export function nextWatchTransitionState(
  previous: WatchTransitionMemory | null,
  current: { identityKey: string | null; evaluationStatus: EntryTriggerEvaluationStatus | null },
): WatchTransitionMemory {
  const identityChanged = previous?.identityKey !== current.identityKey;
  const newlyMet = !identityChanged
    && previous?.evaluationStatus === "not_met"
    && current.evaluationStatus === "met"
    && current.identityKey != null;
  const keepNotice = !identityChanged
    && !!previous?.newlyMet
    && current.evaluationStatus === "met"
    && current.identityKey != null;
  return {
    identityKey: current.identityKey,
    evaluationStatus: current.evaluationStatus,
    newlyMet: newlyMet || keepNotice,
  };
}

export function buildEntryTriggerWatch(input: BuildEntryTriggerWatchInput): EntryTriggerWatch | null {
  const evaluation = input.evaluation;
  if (!evaluation) return null;

  const pairMismatch = !!input.trigger && input.trigger.pair !== input.pair;
  const status = pairMismatch ? "invalid" : watchStatusFromEvaluation(evaluation.status);
  const trigger = pairMismatch ? null : input.trigger;
  const identity = trigger
    ? buildEntryTriggerIdentity({
      analyzedAt: input.analyzedAt,
      pair: trigger.pair,
      type: trigger.type,
      price: trigger.price,
      timeframe: trigger.timeframe,
    })
    : null;
  const pips = trigger && status !== "invalid" ? distancePips(trigger, evaluation) : null;

  return {
    status,
    statusText: WATCH_STATUS_TEXT[status],
    direction: input.direction,
    action: input.action,
    humanCondition: evaluation.humanLabel,
    expression: evaluation.expression,
    observedValue: status === "invalid" ? null : evaluation.observedValue,
    observedLabel: observedLabelFor(evaluation),
    distanceToTriggerPips: pips,
    showDistance: status === "waiting" && pips != null,
    identity,
    identityKey: identity ? entryTriggerIdentityKey(identity) : null,
    checkedAt: evaluation.checkedAt,
    unavailableDetail: status === "unavailable" ? unavailableDetail(trigger, evaluation) : null,
    invalidMessage: status === "invalid" ? WATCH_INVALID_MESSAGE : null,
    staleWarning: input.stale ? WATCH_STALE_WARNING : null,
    dailyLossLimitWarning: input.dailyLossLimitReached ? WATCH_DLL_WARNING : null,
    eventRiskWarning: input.eventRiskHigh ? (input.eventRiskMessage ?? null) : null,
    distanceDisclaimer: WATCH_DISTANCE_DISCLAIMER,
    triggerDisclaimer: WATCH_TRIGGER_DISCLAIMER,
    checkedAtNote: WATCH_CHECKED_AT_NOTE,
  };
}
