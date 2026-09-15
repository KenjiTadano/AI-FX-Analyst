import type { AIAnalysis, DataQuality, TradeScenario } from "../../lib/ai/types";
import type { StructuredEntryTrigger } from "../../lib/ai/entry-trigger";
import type { Symbol } from "../../lib/market/types";

const quality = (score = 82): DataQuality => ({
  score,
  missingData: [],
  categories: {
    technical: { status: "ok", detail: "ok", fraction: 1 },
    news: { status: "ok", detail: "ok", fraction: 1 },
    economic: { status: "ok", detail: "ok", fraction: 1 },
    central_bank: { status: "ok", detail: "ok", fraction: 1 },
    market_environment: { status: "ok", detail: "ok", fraction: 1 },
  },
  macroeconomicData: { status: "ok", detail: "released actuals", fraction: 1 },
});

export const SHORT_SCENARIO: TradeScenario = {
  direction: "short",
  entryZone: { min: 156.1, max: 156.2 },
  stopLoss: 156.8,
  takeProfit1: 155.4,
  takeProfit2: 155.0,
  riskReward: 1.6,
  condition: "156.20を下抜けた場合",
  invalidation: "156.80を超えた場合は無効",
  sourceTimeframe: "1h",
};

export const LONG_SCENARIO: TradeScenario = {
  direction: "long",
  entryZone: { min: 156.3, max: 156.5 },
  stopLoss: 155.9,
  takeProfit1: 157.2,
  takeProfit2: 157.6,
  riskReward: 1.7,
  condition: "押し目ゾーン到達後、反発を確認した場合のみ。",
  invalidation: "損切り水準を越えた場合は無効",
  sourceTimeframe: "1h",
};

export const LONG_TEXT_SCENARIO: TradeScenario = {
  ...SHORT_SCENARIO,
  condition: "156.20を下抜けたあと、1時間足の戻り安値が切り下がっていることと、直近の高値を更新しないことを確認してから売り検討する。価格は分析に含まれる値以外を使わない。",
};

export function priceBelowTrigger(pair: Symbol = "USD/JPY"): StructuredEntryTrigger {
  return {
    version: 1,
    type: "price_below",
    pair,
    price: 156.2,
    timeframe: null,
    sourceCondition: "現在価格が156.20を下回った場合",
  };
}

export function priceAboveTrigger(pair: Symbol = "USD/JPY"): StructuredEntryTrigger {
  return {
    version: 1,
    type: "price_above",
    pair,
    price: 156.1,
    timeframe: null,
    sourceCondition: "現在価格が156.10を上回った場合",
  };
}

export function candleBelowTrigger(pair: Symbol = "USD/JPY"): StructuredEntryTrigger {
  return {
    version: 1,
    type: "candle_close_below",
    pair,
    price: 156.2,
    timeframe: "15min",
    sourceCondition: "15分足が156.20より下で確定した場合",
  };
}

export type AnalysisFixtureName =
  | "sell-wait"
  | "buy-wait"
  | "review-buy"
  | "review-sell"
  | "stale"
  | "chart-evidence"
  | "long-condition"
  | "no-sl-tp"
  | "event-unavailable"
  | "trigger-price-below"
  | "trigger-price-above"
  | "trigger-candle-below"
  | "trigger-stale"
  | "trigger-event-unavailable";

export function analysisFixture(
  name: AnalysisFixtureName,
  now = Date.now(),
  pair: Symbol = "USD/JPY",
): AIAnalysis {
  const analyzedAt = new Date(name === "stale" || name === "trigger-stale" ? now - 10 * 60_000 : now - 30_000).toISOString();
  const expiresAt = new Date(now + 5 * 60_000).toISOString();
  const base: AIAnalysis = {
    pair,
    signal: "wait",
    directionSignal: "wait",
    action: "WAIT",
    economicRisk: { active: false, known: true, reasons: [], nextHigh: null },
    score: 12,
    technicalScore: 10,
    confidence: 68,
    summary: "E2E fixture analysis",
    factors: [],
    bullishReasons: [],
    bearishReasons: [],
    riskWarnings: ["確信度は勝率ではありません。"],
    scenario: null,
    dataQuality: quality(),
    currentRate: 156.42,
    analyzedAt,
    expiresAt,
    decisionReasons: ["条件待ち"],
    ai: { status: "available", model: "e2e-fixture", code: null, message: null },
    chartEvidence: null,
    entryTrigger: null,
  };
  if (name === "sell-wait") {
    return { ...base, directionSignal: "sell", action: "WAIT", signal: "wait", scenario: SHORT_SCENARIO };
  }
  if (name === "buy-wait") {
    return { ...base, directionSignal: "buy", action: "WAIT", signal: "wait", scenario: LONG_SCENARIO };
  }
  if (name === "review-buy") {
    return { ...base, directionSignal: "buy", action: "BUY", signal: "buy", scenario: LONG_SCENARIO };
  }
  if (name === "review-sell") {
    return { ...base, directionSignal: "sell", action: "SELL", signal: "sell", scenario: SHORT_SCENARIO };
  }
  if (name === "stale") {
    return { ...base, directionSignal: "buy", action: "BUY", signal: "buy", scenario: LONG_SCENARIO };
  }
  if (name === "chart-evidence") {
    return {
      ...base,
      directionSignal: "sell",
      action: "WAIT",
      signal: "wait",
      scenario: SHORT_SCENARIO,
      chartEvidence: { used: true, timeframe: "1h", trend: "down", qualityScore: 74 },
    };
  }
  if (name === "long-condition") {
    return { ...base, directionSignal: "sell", action: "WAIT", signal: "wait", scenario: LONG_TEXT_SCENARIO };
  }
  if (name === "event-unavailable") {
    return {
      ...base,
      directionSignal: "sell",
      action: "WAIT",
      signal: "wait",
      scenario: SHORT_SCENARIO,
      economicRisk: { active: false, known: false, reasons: [], nextHigh: null },
    };
  }
  if (name === "trigger-price-below") {
    return { ...base, directionSignal: "sell", action: "WAIT", signal: "wait", scenario: SHORT_SCENARIO, entryTrigger: priceBelowTrigger(pair) };
  }
  if (name === "trigger-price-above") {
    return { ...base, directionSignal: "buy", action: "WAIT", signal: "wait", scenario: LONG_SCENARIO, entryTrigger: priceAboveTrigger(pair) };
  }
  if (name === "trigger-candle-below") {
    return { ...base, directionSignal: "sell", action: "WAIT", signal: "wait", scenario: SHORT_SCENARIO, entryTrigger: candleBelowTrigger(pair) };
  }
  if (name === "trigger-stale") {
    return { ...base, directionSignal: "sell", action: "WAIT", signal: "wait", scenario: SHORT_SCENARIO, entryTrigger: priceBelowTrigger(pair) };
  }
  if (name === "trigger-event-unavailable") {
    return {
      ...base,
      directionSignal: "sell",
      action: "WAIT",
      signal: "wait",
      scenario: SHORT_SCENARIO,
      entryTrigger: priceBelowTrigger(pair),
      economicRisk: { active: false, known: false, reasons: [], nextHigh: null },
    };
  }
  return { ...base, directionSignal: "wait", action: "WAIT", signal: "wait", scenario: null };
}
