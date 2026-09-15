import {
  STATUS_TEXT,
  sanitizeStructuredEntryTrigger,
  type EntryTriggerEvaluationStatus,
} from "../ai/entry-trigger";
import type { EntryReadiness } from "../trading-plan/entry-readiness";
import type { DailyTradingPlan } from "../trading-plan/daily-plan";
import type { AIAnalysis, TradeSignal } from "../ai/types";
import {
  pairs,
  type PreTradeContextSnapshot,
  type PreTradeTriggerEvaluationSnapshot,
  type TradePair,
} from "./types";

export const PRE_TRADE_CONTEXT_VERSION = 1 as const;
export const PRE_TRADE_CONTEXT_MAX_JSON = 8192;
export const PRE_TRADE_TITLE = "エントリー時の判断状況";
export const PRE_TRADE_EYEBROW = "PRE-TRADE CONTEXT";
export const PRE_TRADE_SOURCE_NOTE = "エントリー時点の保存情報";
export const PRE_TRADE_MISSING = "エントリー時の判断状況は保存されていません";
export const PRE_TRADE_CHECKED_AT_LABEL = "判定確認時刻";
export const PRE_TRADE_EVENT_UNAVAILABLE = "未取得";
export const PRE_TRADE_TRIGGER_STATUS_TEXT = STATUS_TEXT;

const DIRECTIONS = ["BUY", "SELL", "NEUTRAL"] as const;
const ACTIONS = ["BUY", "SELL", "WAIT"] as const;
const READINESS_STATES = ["ready_to_review", "waiting", "warning", "unavailable"] as const;
const EVENT_LEVELS = ["high", "medium", "low", "unknown"] as const;
const TRIGGER_STATUSES = ["met", "not_met", "unavailable", "invalid"] as const;

const ISO = (value: unknown): string | null =>
  typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && new Date(value).toISOString() === value
    ? value
    : null;
const NUM = (min: number, max: number) => (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= min && value <= max ? value : null;
const BOOL = (value: unknown): boolean | null => typeof value === "boolean" ? value : null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export type TriggerStatusAtEntry = EntryTriggerEvaluationStatus | "no_trigger";
export type ActionAtEntry = "BUY" | "SELL" | "WAIT" | "unavailable";
export type EventRiskAtEntry = "high" | "medium" | "low" | "unavailable";

export function triggerStatusAtEntry(context: PreTradeContextSnapshot | null | undefined): TriggerStatusAtEntry {
  if (!context?.trigger) return "no_trigger";
  return context.trigger.evaluation.status;
}

export function actionAtEntry(context: PreTradeContextSnapshot | null | undefined): ActionAtEntry {
  return context?.action ?? "unavailable";
}

export function eventRiskAtEntry(context: PreTradeContextSnapshot | null | undefined): EventRiskAtEntry {
  if (!context?.eventRisk || !context.eventRisk.available) return "unavailable";
  return context.eventRisk.level === "unknown" ? "unavailable" : context.eventRisk.level;
}

function planDirection(signal: TradeSignal | null | undefined): PreTradeContextSnapshot["direction"] {
  if (!signal || signal === "wait") return "NEUTRAL";
  if (signal === "buy" || signal === "strong_buy") return "BUY";
  if (signal === "sell" || signal === "strong_sell") return "SELL";
  return "NEUTRAL";
}

export interface CapturePreTradeContextInput {
  pair: string;
  capturedAt: string;
  analysis?: AIAnalysis | null;
  dailyPlan?: DailyTradingPlan | null;
  readiness?: EntryReadiness | null;
  distanceToTriggerPips?: number | null;
}

export function capturePreTradeContext(input: CapturePreTradeContextInput): PreTradeContextSnapshot | null {
  if (!pairs.includes(input.pair as TradePair)) return null;
  const pair = input.pair as TradePair;
  const capturedAt = ISO(input.capturedAt);
  if (!capturedAt) return null;
  if (input.analysis && input.analysis.pair !== pair) return null;
  if (input.dailyPlan && input.dailyPlan.pair !== pair) return null;
  if (input.readiness && input.readiness.pair !== pair) return null;

  const plan = input.dailyPlan && input.dailyPlan.pair === pair ? input.dailyPlan : null;
  const readiness = input.readiness && input.readiness.pair === pair ? input.readiness : null;
  const analysis = input.analysis && input.analysis.pair === pair ? input.analysis : null;

  const direction = readiness?.direction
    ?? plan?.direction
    ?? (analysis ? planDirection(analysis.directionSignal ?? analysis.signal) : null);
  const action = readiness?.action ?? plan?.action ?? (analysis ? (
    analysis.action === "BUY" || analysis.action === "SELL" || analysis.action === "WAIT" ? analysis.action : null
  ) : null);

  const readinessSnap = readiness && readiness.totalCount === 5
    && Number.isInteger(readiness.confirmedCount)
    && readiness.confirmedCount >= 0
    && readiness.confirmedCount <= 5
    ? {
      confirmedCount: readiness.confirmedCount,
      totalCount: 5 as const,
      state: readiness.state,
    }
    : null;

  const structured = readiness?.entryTrigger && readiness.entryTrigger.pair === pair
    ? sanitizeStructuredEntryTrigger(readiness.entryTrigger, pair)
    : null;
  const evaluation = readiness?.triggerEvaluation ?? null;
  let trigger: PreTradeContextSnapshot["trigger"] = null;
  if (structured && evaluation && evaluation.status !== "invalid") {
    trigger = {
      structuredTrigger: copy(structured),
      evaluation: {
        status: evaluation.status,
        observedValue: typeof evaluation.observedValue === "number" && Number.isFinite(evaluation.observedValue) ? evaluation.observedValue : null,
        checkedAt: ISO(evaluation.checkedAt),
        distanceToTriggerPips: input.distanceToTriggerPips ?? null,
      },
    };
  }

  const eventAvailable = plan ? plan.eventRisk.available : false;
  const eventLevel = eventAvailable ? plan!.eventRisk.level : "unknown";
  const eventRiskHigh = readiness?.checks.eventRisk.status === "warning" || (eventAvailable && eventLevel === "high");

  const risk = plan
    && plan.capital != null && Number.isFinite(plan.capital) && plan.capital >= 0
    && plan.riskPercent != null && Number.isFinite(plan.riskPercent) && plan.riskPercent > 0
    && plan.riskPerTrade != null && Number.isFinite(plan.riskPerTrade) && plan.riskPerTrade >= 0
    ? { capital: plan.capital, riskPercent: plan.riskPercent, riskPerTrade: plan.riskPerTrade }
    : null;

  const dqScore = analysis ? analysis.dataQuality.score : plan?.dataQuality ?? null;
  const confidence = analysis?.confidence ?? plan?.confidence ?? readiness?.confidence ?? null;

  const captured: PreTradeContextSnapshot = {
    version: PRE_TRADE_CONTEXT_VERSION,
    capturedAt,
    pair,
    direction,
    action,
    readiness: readinessSnap,
    trigger,
    dataQuality: dqScore == null ? null : { score: dqScore },
    confidence,
    eventRisk: plan ? { level: eventLevel, available: eventAvailable } : null,
    risk,
    dailyLossLimitPercent: plan?.dailyLossLimitPercent ?? null,
    dailyLossRemaining: plan?.dailyLossRemaining ?? null,
    dailyLossLimitReached: !!readiness?.dailyLossLimitReached,
    analysisStale: !!(readiness?.stale || plan?.stale),
    eventRiskHigh: !!eventRiskHigh,
  };
  return sanitizePreTradeContext(captured, pair);
}

export function sanitizePreTradeContext(raw: unknown, pair: string): PreTradeContextSnapshot | null {
  if (raw == null) return null;
  if (!isRecord(raw)) return null;
  if (raw.version !== PRE_TRADE_CONTEXT_VERSION) return null;
  if (raw.pair !== pair || !pairs.includes(raw.pair as TradePair)) return null;
  const capturedAt = ISO(raw.capturedAt);
  if (!capturedAt) return null;
  if (raw.direction !== null && !DIRECTIONS.includes(raw.direction as typeof DIRECTIONS[number])) return null;
  if (raw.action !== null && !ACTIONS.includes(raw.action as typeof ACTIONS[number])) return null;
  if (/sk-[a-zA-Z0-9]{10,}|api[_-]?key\s*[:=]|data:image\/|BEGIN (RSA )?PRIVATE|systemPrompt|developerPrompt/i.test(JSON.stringify(raw))) return null;

  let readiness: PreTradeContextSnapshot["readiness"] = null;
  if (raw.readiness != null) {
    if (!isRecord(raw.readiness)) return null;
    const confirmed = NUM(0, 5)(raw.readiness.confirmedCount);
    if (confirmed === null || !Number.isInteger(confirmed)) return null;
    if (raw.readiness.totalCount !== 5) return null;
    if (!READINESS_STATES.includes(raw.readiness.state as typeof READINESS_STATES[number])) return null;
    readiness = { confirmedCount: confirmed, totalCount: 5, state: raw.readiness.state as typeof READINESS_STATES[number] };
  }

  let trigger: PreTradeContextSnapshot["trigger"] = null;
  if (raw.trigger != null) {
    if (!isRecord(raw.trigger)) return null;
    const structured = sanitizeStructuredEntryTrigger(raw.trigger.structuredTrigger, pair);
    if (!structured) return null;
    if (!isRecord(raw.trigger.evaluation)) return null;
    const status = raw.trigger.evaluation.status;
    if (!TRIGGER_STATUSES.includes(status as EntryTriggerEvaluationStatus)) return null;
    const observed = raw.trigger.evaluation.observedValue;
    if (observed !== null && (typeof observed !== "number" || !Number.isFinite(observed))) return null;
    const checkedAt = raw.trigger.evaluation.checkedAt === null ? null : ISO(raw.trigger.evaluation.checkedAt);
    if (raw.trigger.evaluation.checkedAt !== null && checkedAt === null) return null;
    const distance = raw.trigger.evaluation.distanceToTriggerPips;
    if (distance !== null && (typeof distance !== "number" || !Number.isFinite(distance) || distance < 0)) return null;
    const evaluation: PreTradeTriggerEvaluationSnapshot = {
      status: status as EntryTriggerEvaluationStatus,
      observedValue: observed === null ? null : observed,
      checkedAt,
      distanceToTriggerPips: distance === null ? null : distance,
    };
    trigger = { structuredTrigger: copy(structured), evaluation };
  }

  let dataQuality: PreTradeContextSnapshot["dataQuality"] = null;
  if (raw.dataQuality != null) {
    if (!isRecord(raw.dataQuality)) return null;
    const score = raw.dataQuality.score === null ? null : NUM(0, 100)(raw.dataQuality.score);
    if (raw.dataQuality.score !== null && score === null) return null;
    dataQuality = { score };
  }

  const confidence = raw.confidence === null ? null : NUM(0, 100)(raw.confidence);
  if (raw.confidence !== null && confidence === null) return null;

  let eventRisk: PreTradeContextSnapshot["eventRisk"] = null;
  if (raw.eventRisk != null) {
    if (!isRecord(raw.eventRisk)) return null;
    const available = BOOL(raw.eventRisk.available);
    if (available === null) return null;
    if (!EVENT_LEVELS.includes(raw.eventRisk.level as typeof EVENT_LEVELS[number])) return null;
    const level = available ? raw.eventRisk.level as typeof EVENT_LEVELS[number] : "unknown";
    eventRisk = { level, available };
  }

  let risk: PreTradeContextSnapshot["risk"] = null;
  if (raw.risk != null) {
    if (!isRecord(raw.risk)) return null;
    const capital = NUM(0, 1e12)(raw.risk.capital);
    const riskPercent = NUM(0.000001, 10)(raw.risk.riskPercent);
    const riskPerTrade = NUM(0, 1e12)(raw.risk.riskPerTrade);
    if (capital === null || riskPercent === null || riskPerTrade === null) return null;
    risk = { capital, riskPercent, riskPerTrade };
  }

  const dailyLossLimitPercent = raw.dailyLossLimitPercent === null || raw.dailyLossLimitPercent === undefined
    ? null
    : NUM(0.1, 10)(raw.dailyLossLimitPercent);
  if (raw.dailyLossLimitPercent != null && dailyLossLimitPercent === null) return null;
  const dailyLossRemaining = raw.dailyLossRemaining === null || raw.dailyLossRemaining === undefined
    ? null
    : NUM(0, 1e12)(raw.dailyLossRemaining);
  if (raw.dailyLossRemaining != null && dailyLossRemaining === null) return null;
  const dailyLossLimitReached = BOOL(raw.dailyLossLimitReached);
  const analysisStale = BOOL(raw.analysisStale);
  const eventRiskHigh = BOOL(raw.eventRiskHigh);
  if (dailyLossLimitReached === null || analysisStale === null || eventRiskHigh === null) return null;

  const result: PreTradeContextSnapshot = {
    version: 1,
    capturedAt,
    pair: pair as TradePair,
    direction: raw.direction as PreTradeContextSnapshot["direction"],
    action: raw.action as PreTradeContextSnapshot["action"],
    readiness,
    trigger,
    dataQuality,
    confidence,
    eventRisk,
    risk,
    dailyLossLimitPercent,
    dailyLossRemaining,
    dailyLossLimitReached,
    analysisStale,
    eventRiskHigh,
  };
  if (JSON.stringify(result).length > PRE_TRADE_CONTEXT_MAX_JSON) return null;
  return copy(result);
}

export function formatPreTradeEvent(context: PreTradeContextSnapshot): string {
  if (!context.eventRisk || !context.eventRisk.available) return PRE_TRADE_EVENT_UNAVAILABLE;
  if (context.eventRisk.level === "unknown") return PRE_TRADE_EVENT_UNAVAILABLE;
  return context.eventRisk.level.toUpperCase();
}

export function formatPreTradeTriggerStatus(context: PreTradeContextSnapshot): string {
  if (!context.trigger) return "条件なし";
  return PRE_TRADE_TRIGGER_STATUS_TEXT[context.trigger.evaluation.status];
}
