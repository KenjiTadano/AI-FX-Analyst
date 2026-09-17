import type { AIAnalysis } from "../ai/types";
import { validPrice } from "./calculations";
import { JPY_PIP_SIZE, priceDeltaToPips } from "./analysis-price";
import { pairs, type Trade, type TradePair } from "./types";

export const EXIT_PLAN_VERSION = 1 as const;
export const EXIT_PLAN_TITLE = "Exit Plan";
export const EXIT_PLAN_EYEBROW = "EXIT PLAN";
export const EXIT_PLAN_CLOSED_EYEBROW = "EXIT PLAN / RESULT";
export const EXIT_PLAN_MISSING = "初期Exit Planは保存されていません";
export const EXIT_PLAN_UNREADABLE = "初期Exit Planは確認できません";
export const EXIT_PLAN_OPEN_R = "未決済";
export const EXIT_PLAN_PREFILL_NOTE = "現在のAI分析から初期値を入力しています。必要に応じて変更してください。";
export const EXIT_PLAN_DISCLAIMER =
  "初期リスクと実現Rは登録時の値幅計画の記録であり、取引の良し悪しや推奨を示すものではありません。";
export const EXIT_PLAN_SL_BUY_ERROR = "買いの初期損切りはエントリー価格より下にしてください。";
export const EXIT_PLAN_SL_SELL_ERROR = "売りの初期損切りはエントリー価格より上にしてください。";
export const EXIT_PLAN_SL_ZERO_ERROR = "初期損切りはエントリー価格と異なる値にしてください。";
export const EXIT_PLAN_TP_BUY_ERROR = "買いの初期利確はエントリー価格より上にしてください。";
export const EXIT_PLAN_TP_SELL_ERROR = "売りの初期利確はエントリー価格より下にしてください。";

export type ExitPlanSide = "buy" | "sell";

export interface TradeExitPlan {
  version: typeof EXIT_PLAN_VERSION;
  pair: TradePair;
  side: ExitPlanSide;
  capturedAt: string;
  entryPrice: number;
  initialStopLoss: number;
  initialTakeProfit: number | null;
  initialRiskPrice: number;
  initialRiskPips: number;
  plannedRewardPrice: number | null;
  plannedRewardPips: number | null;
  plannedRewardRiskRatio: number | null;
}

export type ExitPlanInput = {
  pair: string;
  side: "long" | "short" | ExitPlanSide;
  entryPrice: number;
  stopLoss: number | null | undefined;
  takeProfit: number | null | undefined;
  capturedAt: string;
};

export type RPerformanceSummary = {
  eligibleCount: number;
  sampleSize: number;
  coverage: number | null;
  totalR: number | null;
  averageR: number | null;
  positiveR: number;
  negativeR: number;
  zeroR: number;
};

const ISO = (value: unknown): string | null =>
  typeof value === "string"
  && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
  && new Date(value).toISOString() === value
    ? value
    : null;

const SECRET = /sk-[a-zA-Z0-9]{10,}|api[_-]?key\s*[:=]|data:image\/|BEGIN (RSA )?PRIVATE|systemPrompt|developerPrompt/i;

function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function tradeSideToPlanSide(side: string): ExitPlanSide | null {
  if (side === "long" || side === "buy") return "buy";
  if (side === "short" || side === "sell") return "sell";
  return null;
}

export function planSideMatchesTrade(planSide: ExitPlanSide, tradeSide: string): boolean {
  return tradeSideToPlanSide(tradeSide) === planSide;
}

function priceDiff(left: number, right: number): number {
  return Math.round((left - right) * 1e10) / 1e10;
}

function riskPrice(side: ExitPlanSide, entry: number, stop: number): number | null {
  const risk = side === "buy" ? priceDiff(entry, stop) : priceDiff(stop, entry);
  return Number.isFinite(risk) && risk > 0 ? risk : null;
}

function rewardPrice(side: ExitPlanSide, entry: number, takeProfit: number): number | null {
  const reward = side === "buy" ? priceDiff(takeProfit, entry) : priceDiff(entry, takeProfit);
  return Number.isFinite(reward) && reward > 0 ? reward : null;
}

function pipsOf(pair: TradePair, delta: number): number | null {
  return priceDeltaToPips(pair, delta);
}

export function createExitPlan(input: ExitPlanInput): TradeExitPlan | null {
  const pair = pairs.includes(input.pair as TradePair) ? input.pair as TradePair : null;
  const side = tradeSideToPlanSide(input.side);
  const capturedAt = ISO(input.capturedAt);
  if (!pair || !side || !capturedAt || !validPrice(input.entryPrice) || !validPrice(input.stopLoss)) return null;
  const risk = riskPrice(side, input.entryPrice, input.stopLoss);
  const riskPips = risk != null ? pipsOf(pair, risk) : null;
  if (risk == null || riskPips == null) return null;
  const takeProfit = validPrice(input.takeProfit) ? input.takeProfit : null;
  const reward = takeProfit != null ? rewardPrice(side, input.entryPrice, takeProfit) : null;
  const rewardPips = reward != null ? pipsOf(pair, reward) : null;
  const ratio = reward != null && risk > 0 ? reward / risk : null;
  const plannedRewardPrice = reward != null && rewardPips != null && ratio != null && Number.isFinite(ratio) ? reward : null;
  return copy({
    version: EXIT_PLAN_VERSION,
    pair,
    side,
    capturedAt,
    entryPrice: input.entryPrice,
    initialStopLoss: input.stopLoss,
    initialTakeProfit: plannedRewardPrice != null ? takeProfit : null,
    initialRiskPrice: risk,
    initialRiskPips: riskPips,
    plannedRewardPrice,
    plannedRewardPips: plannedRewardPrice != null ? rewardPips : null,
    plannedRewardRiskRatio: plannedRewardPrice != null ? ratio : null,
  });
}

export function sanitizeExitPlan(raw: unknown): TradeExitPlan | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (SECRET.test(JSON.stringify(raw))) return null;
  const value = raw as Record<string, unknown>;
  if ("candles" in value || "apiKey" in value || "apikey" in value || "prompt" in value) return null;
  const capturedAt = ISO(value.capturedAt);
  const pair = pairs.includes(value.pair as TradePair) ? value.pair as TradePair : null;
  const side = tradeSideToPlanSide(String(value.side ?? ""));
  if (value.version !== 1 || !pair || !side || !capturedAt) return null;
  if (!validPrice(value.entryPrice) || !validPrice(value.initialStopLoss)) return null;
  const takeProfit = value.initialTakeProfit == null ? null : validPrice(value.initialTakeProfit) ? value.initialTakeProfit : null;
  return createExitPlan({
    pair,
    side,
    entryPrice: value.entryPrice,
    stopLoss: value.initialStopLoss,
    takeProfit,
    capturedAt,
  });
}

export function storedExitPlan(trade: Trade): TradeExitPlan | null {
  const plan = sanitizeExitPlan(trade.exitPlan);
  if (!plan) return null;
  if (plan.pair !== trade.pair || !planSideMatchesTrade(plan.side, trade.side)) return null;
  return plan;
}

export function exitPlanState(trade: Trade): "ok" | "absent" | "unreadable" {
  if (trade.exitPlan == null) return "absent";
  return storedExitPlan(trade) ? "ok" : "unreadable";
}

export function calculateRealizedR(trade: Trade): number | null {
  const plan = storedExitPlan(trade);
  if (!plan || trade.status !== "closed" || !validPrice(trade.exitPrice)) return null;
  const move = plan.side === "buy" ? priceDiff(trade.exitPrice, plan.entryPrice) : priceDiff(plan.entryPrice, trade.exitPrice);
  if (!Number.isFinite(move) || plan.initialRiskPrice <= 0) return null;
  const realized = move / plan.initialRiskPrice;
  return Number.isFinite(realized) ? realized : null;
}

export function calculateRealizedMovePips(trade: Trade): number | null {
  const plan = storedExitPlan(trade);
  if (!plan || trade.status !== "closed" || !validPrice(trade.exitPrice)) return null;
  const move = plan.side === "buy" ? priceDiff(trade.exitPrice, plan.entryPrice) : priceDiff(plan.entryPrice, trade.exitPrice);
  if (!Number.isFinite(move)) return null;
  const pips = pipsOf(plan.pair, Math.abs(move));
  if (pips == null) return null;
  if (move === 0) return 0;
  return move > 0 ? pips : -pips;
}

export function summarizeRPerformance(trades: Trade[]): RPerformanceSummary {
  const eligible = trades.filter(trade => trade.status === "closed");
  const values = eligible.map(calculateRealizedR).filter((value): value is number => value != null && Number.isFinite(value));
  const sampleSize = values.length;
  const totalR = sampleSize ? values.reduce((sum, value) => sum + value, 0) : null;
  return {
    eligibleCount: eligible.length,
    sampleSize,
    coverage: eligible.length ? sampleSize / eligible.length * 100 : null,
    totalR,
    averageR: sampleSize && totalR != null ? totalR / sampleSize : null,
    positiveR: values.filter(value => value > 0).length,
    negativeR: values.filter(value => value < 0).length,
    zeroR: values.filter(value => value === 0).length,
  };
}

export function exitPlanInputErrors(input: ExitPlanInput): { stopLoss: string | null; takeProfit: string | null } {
  const side = tradeSideToPlanSide(input.side);
  const errors = { stopLoss: null as string | null, takeProfit: null as string | null };
  if (!side || !validPrice(input.entryPrice)) return errors;
  if (input.stopLoss != null && input.stopLoss !== undefined && Number.isFinite(input.stopLoss)) {
    if (input.stopLoss === input.entryPrice) errors.stopLoss = EXIT_PLAN_SL_ZERO_ERROR;
    else if (!validPrice(input.stopLoss)) errors.stopLoss = EXIT_PLAN_SL_ZERO_ERROR;
    else if (riskPrice(side, input.entryPrice, input.stopLoss) == null) {
      errors.stopLoss = side === "buy" ? EXIT_PLAN_SL_BUY_ERROR : EXIT_PLAN_SL_SELL_ERROR;
    }
  }
  if (input.takeProfit != null && input.takeProfit !== undefined && Number.isFinite(input.takeProfit)) {
    if (!validPrice(input.takeProfit) || rewardPrice(side, input.entryPrice, input.takeProfit) == null) {
      errors.takeProfit = side === "buy" ? EXIT_PLAN_TP_BUY_ERROR : EXIT_PLAN_TP_SELL_ERROR;
    }
  }
  return errors;
}

export function aiScenarioPrefill(
  analysis: AIAnalysis | null | undefined,
  pair: string,
  side: "long" | "short",
  entryPrice?: number | null,
): { stopLoss: number; takeProfit: number | null } | null {
  if (!analysis || analysis.pair !== pair || !analysis.scenario) return null;
  const want = side === "short" ? "short" : "long";
  if (analysis.scenario.direction !== want) return null;
  const planSide = tradeSideToPlanSide(side);
  const stopLoss = analysis.scenario.stopLoss;
  const takeProfit = analysis.scenario.takeProfit1;
  if (!planSide || !validPrice(stopLoss)) return null;
  if (validPrice(entryPrice) && riskPrice(planSide, entryPrice, stopLoss) == null) return null;
  const tp = validPrice(takeProfit) ? takeProfit : null;
  const usableTp = tp != null && validPrice(entryPrice) ? (rewardPrice(planSide, entryPrice, tp) != null ? tp : null) : tp;
  return { stopLoss, takeProfit: usableTp };
}

function rounded(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function formatMovePips(pips: number | null | undefined): string {
  if (pips == null || !Number.isFinite(pips)) return "—";
  const value = rounded(pips, 1);
  if (value === 0) return "0.0 pips";
  return `${value > 0 ? "+" : ""}${value.toFixed(1)} pips`;
}

export function formatRiskPips(pips: number | null | undefined): string {
  if (pips == null || !Number.isFinite(pips)) return "—";
  return `${rounded(Math.abs(pips), 1).toFixed(1)} pips`;
}

export function formatPlannedRR(ratio: number | null | undefined): string {
  if (ratio == null || !Number.isFinite(ratio)) return "—";
  return `${rounded(ratio, 2).toFixed(2)}R`;
}

export function formatRealizedR(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const roundedValue = rounded(value, 2);
  if (roundedValue === 0) return "0.00R";
  return `${roundedValue > 0 ? "+" : ""}${roundedValue.toFixed(2)}R`;
}

export function formatRCoverage(summary: RPerformanceSummary): string {
  if (!summary.eligibleCount) return "—";
  const pct = summary.coverage == null || !Number.isFinite(summary.coverage) ? "—" : `${rounded(summary.coverage, 1).toFixed(1)}%`;
  return `${summary.sampleSize} / ${summary.eligibleCount}（${pct}）`;
}

export { JPY_PIP_SIZE };
