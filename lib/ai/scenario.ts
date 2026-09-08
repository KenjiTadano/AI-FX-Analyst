import { positive } from "./technical";
import type { AnalysisInput, TradeScenario, TradeSignal } from "./types";

export function validateScenario(value: TradeScenario | null): TradeScenario | null {
  if (!value || !["long", "short"].includes(value.direction)) return null;
  const { min, max } = value.entryZone;
  const { stopLoss, takeProfit1, takeProfit2 } = value;
  if (![min, max, stopLoss, takeProfit1, takeProfit2].every(positive) || min > max) return null;
  const valid = value.direction === "long" ? stopLoss < min && max < takeProfit1 && takeProfit1 < takeProfit2 : takeProfit2 < takeProfit1 && takeProfit1 < min && max < stopLoss;
  if (!valid) return null;
  // Worst entry within the zone; never trust a model-provided RR or midpoint.
  const riskReward = value.direction === "long" ? (takeProfit1 - max) / (max - stopLoss) : (min - takeProfit1) / (stopLoss - min);
  if (!Number.isFinite(riskReward) || riskReward < 1.5) return null;
  return { ...value, riskReward: Math.floor(riskReward * 100) / 100 };
}
export function generateScenario(input: AnalysisInput, signal: TradeSignal): TradeScenario | null {
  if (signal === "wait" || input.currentRate === null) return null;
  const frame = input.technicalAnalysis.frames.find(frame => frame.timeframe === "1h" && frame.available && frame.completeness === 1);
  if (!frame || !positive(frame.atr) || !positive(frame.recentHigh) || !positive(frame.recentLow)) return null;
  const { atr, recentHigh: high, recentLow: low } = frame;
  const rate = input.currentRate;
  const long = signal === "buy" || signal === "strong_buy";
  const round = (value: number) => Math.round(value * 1000) / 1000;
  const min = round(rate + (long ? -0.25 : 0.1) * atr);
  const max = round(rate + (long ? -0.1 : 0.25) * atr);
  return validateScenario({
    direction: long ? "long" : "short", entryZone: { min, max },
    stopLoss: round(long ? Math.min(low - atr * 0.1, min - atr * 0.5) : Math.max(high + atr * 0.1, max + atr * 0.5)),
    takeProfit1: round(long ? high : low), takeProfit2: round(long ? high + atr * 0.75 : low - atr * 0.75),
    riskReward: 0, sourceTimeframe: "1h",
    condition: long ? "押し目ゾーン到達後、反発と上昇基調の継続を確認した場合のみ。" : "戻りゾーン到達後、反落と下降基調の継続を確認した場合のみ。",
    invalidation: "損切り水準を越える、重要指標で前提が変わる、または分析の有効期限を過ぎた場合は無効。",
  });
}
