import { classifyWaitReasons, isAnalysisStale, ANALYSIS_STALE_MS } from "../ai/decision-ui";
import type { AIAnalysis, TradeSignal } from "../ai/types";
import { calendarKnown, nextHigh, riskState } from "../economic-calendar/risk-window";
import type { DataResource, EconomicEvent, Importance } from "../fundamental/types";
import { allowedLoss } from "../risk/position-size";
import type { RiskSettings } from "../risk/types";
import { summarize } from "../trades/analytics";
import type { Trade } from "../trades/types";
import { isSameLocalDay, toEpochMs } from "./today";

export const CONFIDENCE_DISCLAIMER = "AI Confidenceは分析判断の確信度であり、勝率を保証する値ではありません。";
export const NO_AUTO_TRADING_COPY = "この画面は分析とリスク管理を整理するための参考情報です。注文は自動送信されません。";
export const CONDITION_SOURCE_LABEL = "現在のAI分析に含まれる条件";
export const ANALYSIS_STALE_MESSAGE = "分析から時間が経過しています";
export const UNAVAILABLE_MESSAGE = "AI分析を実行すると今日の計画を表示できます";
export const RISK_LIMIT_MESSAGE = "設定したDaily Loss Limitに到達しています";
export const WAIT_MESSAGE = "今はエントリーせず待つ";
export const REVIEW_BUY_MESSAGE = "BUY条件を確認";
export const REVIEW_SELL_MESSAGE = "SELL条件を確認";

export type DailyPlanStatus = "wait" | "review_buy" | "review_sell" | "risk_limit" | "stale" | "unavailable";
export type DailyPlanAction = "BUY" | "SELL" | "WAIT";
export type DailyPlanDirection = "BUY" | "SELL" | "NEUTRAL";
export type EventRiskLevel = "high" | "medium" | "low" | "unknown";

export const STATUS_PRIORITY: DailyPlanStatus[] = ["risk_limit", "stale", "unavailable", "wait", "review_buy", "review_sell"];

export interface DailyPlanEventRisk {
  level: EventRiskLevel;
  available: boolean;
  message: string;
  name: string | null;
  scheduledAt: string | null;
  importance: Importance | null;
  source: "economic_calendar" | "analysis" | "none";
}

export interface DailyTradingPlan {
  pair: string;
  currentRate: number | null;
  analyzedAt: string | null;
  direction: DailyPlanDirection;
  directionSignal: TradeSignal | null;
  action: DailyPlanAction | null;
  status: DailyPlanStatus;
  mainMessage: string;
  statusReason: string;
  directionNote: string | null;
  confidence: number | null;
  dataQuality: number | null;
  stale: boolean;
  entryCondition: string | null;
  invalidationCondition: string | null;
  stopLoss: number | null;
  takeProfit: number | null;
  conditionSource: string | null;
  eventRisk: DailyPlanEventRisk;
  capital: number | null;
  riskPercent: number | null;
  riskPerTrade: number | null;
  dailyLossLimitPercent: number | null;
  dailyLossLimit: number | null;
  dailyLossUsed: number;
  dailyLossRemaining: number | null;
  todayTradeCount: number;
  todayClosedCount: number;
  todayRealizedPnl: number;
  todayPairTradeCount: number;
  todayScopeLabel: "全通貨ペア";
  chartEvidenceUsed: boolean;
}

export interface DailyPlanInput {
  pair: string;
  analysis: AIAnalysis | null | undefined;
  trades: Trade[] | null | undefined;
  riskSettings: RiskSettings | null | undefined;
  currentRate?: number | null;
  calendar?: DataResource<EconomicEvent[]> | null;
  dailyLossLimitPercent?: number | null;
  now: Date | number | string;
}

export function parseDailyLossLimitPercent(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  if (!Number.isFinite(n) || n <= 0 || n > 10) return null;
  return n;
}

export function directionToken(signal: TradeSignal | null | undefined): DailyPlanDirection {
  if (!signal || signal === "wait") return "NEUTRAL";
  if (signal.includes("buy")) return "BUY";
  if (signal.includes("sell")) return "SELL";
  return "NEUTRAL";
}

export function resolveAction(analysis: AIAnalysis): DailyPlanAction {
  if (analysis.action === "BUY" || analysis.action === "SELL" || analysis.action === "WAIT") return analysis.action;
  if (analysis.signal === "wait") return "WAIT";
  if (analysis.signal.includes("buy")) return "BUY";
  if (analysis.signal.includes("sell")) return "SELL";
  return "WAIT";
}

function finiteMoney(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function textOrNull(value: string | null | undefined): string | null {
  const text = value?.trim();
  return text ? text : null;
}

function mainMessageFor(status: DailyPlanStatus): string {
  if (status === "risk_limit") return RISK_LIMIT_MESSAGE;
  if (status === "stale") return ANALYSIS_STALE_MESSAGE;
  if (status === "unavailable") return UNAVAILABLE_MESSAGE;
  if (status === "review_buy") return REVIEW_BUY_MESSAGE;
  if (status === "review_sell") return REVIEW_SELL_MESSAGE;
  return WAIT_MESSAGE;
}

function directionNoteFor(direction: DailyPlanDirection, action: DailyPlanAction | null): string | null {
  if (action !== "WAIT") return null;
  if (direction === "SELL") return "AI方向は下方向ですが、現在のActionはWAITです。";
  if (direction === "BUY") return "AI方向は上方向ですが、現在のActionはWAITです。";
  return null;
}

function statusReasonFor(
  status: DailyPlanStatus,
  analysis: AIAnalysis | null,
  dailyLossRemaining: number | null,
): string {
  if (status === "risk_limit") return dailyLossRemaining === 0 ? "Daily Loss Limitに到達" : "Daily Loss Limit";
  if (status === "stale") return `${Math.round(ANALYSIS_STALE_MS / 60_000)}分以上経過`;
  if (status === "unavailable") return "選択中の通貨ペアのAI分析がありません";
  if (!analysis) return "条件待ち";
  const waits = classifyWaitReasons(analysis);
  if (status === "wait") return waits[0]?.label ?? analysis.decisionReasons[0] ?? "条件未成立";
  return analysis.decisionReasons[0] ?? analysis.summary ?? (status === "review_buy" ? "BUY条件の確認" : "SELL条件の確認");
}

function nextUpcoming(events: EconomicEvent[], nowMs: number): EconomicEvent | null {
  return events
    .filter(event => event.scheduledAt && Date.parse(event.scheduledAt) > nowMs && event.actual === null)
    .sort((a, b) => a.scheduledAt!.localeCompare(b.scheduledAt!))[0] ?? null;
}

function eventRiskFrom(
  nowMs: number,
  calendar: DataResource<EconomicEvent[]> | null | undefined,
  analysis: AIAnalysis | null,
): DailyPlanEventRisk {
  const empty: DailyPlanEventRisk = {
    level: "unknown",
    available: false,
    message: "現在利用できる重要イベント情報はありません",
    name: null,
    scheduledAt: null,
    importance: null,
    source: "none",
  };
  if (calendarKnown(calendar ?? undefined, nowMs) && calendar?.data) {
    const events = calendar.data;
    const risk = riskState(events, nowMs);
    const next = nextUpcoming(events, nowMs) ?? nextHigh(events, nowMs);
    const active = events.find(event => risk.activeIds.includes(event.id));
    const shown = active ?? next;
    if (risk.imminent && shown) {
      return {
        level: shown.importance,
        available: true,
        message: risk.reasons[0] ?? `${shown.name}の発表前後です`,
        name: shown.name,
        scheduledAt: shown.scheduledAt,
        importance: shown.importance,
        source: "economic_calendar",
      };
    }
    if (next) {
      return {
        level: next.importance,
        available: true,
        message: `${next.name}（予定あり）`,
        name: next.name,
        scheduledAt: next.scheduledAt,
        importance: next.importance,
        source: "economic_calendar",
      };
    }
    return {
      level: "low",
      available: true,
      message: "取得範囲内に時刻が確定した次のhighイベントはありません",
      name: null,
      scheduledAt: null,
      importance: null,
      source: "economic_calendar",
    };
  }
  const economic = analysis?.economicRisk;
  if (economic) {
    if (!economic.known && !economic.nextHigh && !economic.reasons.length) {
      return { ...empty, level: "unknown", message: "重要イベントの有無は不明です", source: "analysis" };
    }
    if (economic.nextHigh) {
      const importance = economic.nextHigh.importance;
      return {
        level: importance ?? (economic.active ? "high" : "unknown"),
        available: true,
        message: economic.reasons[0] ?? economic.nextHigh.name,
        name: economic.nextHigh.name,
        scheduledAt: economic.nextHigh.scheduledAt,
        importance,
        source: "analysis",
      };
    }
    if (economic.active) {
      return {
        level: "high",
        available: true,
        message: economic.reasons[0] ?? "重要イベント接近中",
        name: null,
        scheduledAt: null,
        importance: "high",
        source: "analysis",
      };
    }
    return {
      level: economic.known ? "low" : "unknown",
      available: economic.known,
      message: economic.known ? "現在利用できる重要イベント情報はありません" : "重要イベントの有無は不明です",
      name: null,
      scheduledAt: null,
      importance: null,
      source: "analysis",
    };
  }
  return empty;
}

export function buildDailyTradingPlan(input: DailyPlanInput): DailyTradingPlan {
  const nowMs = toEpochMs(input.now);
  const pair = input.pair;
  const analysis = input.analysis && input.analysis.pair === pair ? input.analysis : null;
  const mismatch = !!input.analysis && input.analysis.pair !== pair;
  const trades = Array.isArray(input.trades) ? input.trades : [];
  const todayTrades = Number.isFinite(nowMs) ? trades.filter(trade => isSameLocalDay(trade.openedAt, nowMs)) : [];
  const todayClosed = todayTrades.filter(trade => trade.status === "closed" && trade.realizedPnl !== null && Number.isFinite(trade.realizedPnl));
  const todayStats = summarize(todayClosed);
  const todayRealizedPnl = todayStats.totalPnl;
  const dailyLossUsed = Math.max(0, -todayRealizedPnl);

  const settings = input.riskSettings;
  const capital = settings ? finiteMoney(settings.balance) : null;
  const riskPercent = settings && Number.isFinite(settings.riskPercent) && settings.riskPercent > 0 ? settings.riskPercent : null;
  const riskPerTrade = capital != null && riskPercent != null ? allowedLoss(capital, riskPercent) : null;
  const dailyLossLimitPercent = parseDailyLossLimitPercent(input.dailyLossLimitPercent);
  const dailyLossLimit = capital != null && dailyLossLimitPercent != null ? allowedLoss(capital, dailyLossLimitPercent) : null;
  const dailyLossRemaining = dailyLossLimit == null ? null : Math.max(0, dailyLossLimit - dailyLossUsed);
  const riskLimitReached = dailyLossRemaining !== null && dailyLossRemaining <= 0;

  const stale = !!analysis && (
    isAnalysisStale(analysis.analyzedAt, nowMs) ||
    (Number.isFinite(Date.parse(analysis.expiresAt)) && nowMs >= Date.parse(analysis.expiresAt))
  );
  const action = analysis ? resolveAction(analysis) : null;
  const direction = directionToken(analysis?.directionSignal ?? null);

  let status: DailyPlanStatus;
  if (riskLimitReached) status = "risk_limit";
  else if (stale) status = "stale";
  else if (!analysis) status = "unavailable";
  else if (action === "BUY") status = "review_buy";
  else if (action === "SELL") status = "review_sell";
  else status = "wait";

  const scenario = analysis?.scenario ?? null;
  const entryCondition = textOrNull(scenario?.condition);
  const invalidationCondition = textOrNull(scenario?.invalidation);
  const stopLoss = scenario && Number.isFinite(scenario.stopLoss) ? scenario.stopLoss : null;
  const takeProfit = scenario && Number.isFinite(scenario.takeProfit1) ? scenario.takeProfit1 : null;
  const liveRate = finiteMoney(input.currentRate);
  const analysisRate = analysis ? finiteMoney(analysis.currentRate) : null;

  return {
    pair,
    currentRate: liveRate ?? analysisRate,
    analyzedAt: analysis?.analyzedAt ?? null,
    direction,
    directionSignal: analysis?.directionSignal ?? null,
    action,
    status,
    mainMessage: mainMessageFor(status),
    statusReason: statusReasonFor(status, analysis, dailyLossRemaining),
    directionNote: analysis ? directionNoteFor(direction, action) : null,
    confidence: analysis && Number.isFinite(analysis.confidence) ? analysis.confidence : null,
    dataQuality: analysis && Number.isFinite(analysis.dataQuality.score) ? analysis.dataQuality.score : null,
    stale,
    entryCondition,
    invalidationCondition,
    stopLoss,
    takeProfit,
    conditionSource: analysis && (entryCondition || invalidationCondition || stopLoss != null || takeProfit != null) ? CONDITION_SOURCE_LABEL : null,
    eventRisk: eventRiskFrom(nowMs, input.calendar, mismatch ? null : analysis),
    capital,
    riskPercent,
    riskPerTrade,
    dailyLossLimitPercent,
    dailyLossLimit,
    dailyLossUsed,
    dailyLossRemaining,
    todayTradeCount: todayTrades.length,
    todayClosedCount: todayClosed.length,
    todayRealizedPnl,
    todayPairTradeCount: todayTrades.filter(trade => trade.pair === pair).length,
    todayScopeLabel: "全通貨ペア",
    chartEvidenceUsed: !!analysis?.chartEvidence?.used,
  };
}
