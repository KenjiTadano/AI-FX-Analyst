import { compare, directionValue, technicalScoreWeights, timeframeWeights } from "./technical";
import type { DataQuality, Direction, TechnicalAnalysis, TechnicalFrame, TradeSignal } from "./types";
import type { Timeframe } from "../market/types";

export type SafetyReasonCode = "DATA_QUALITY" | "STALE_DATA" | "ECONOMIC_EVENT" | "EXTENDED_MARKET" | "INSUFFICIENT_DATA";
export type ScenarioStatus = "available" | "unavailable" | "not_applicable";
export type EntryTriggerContext = "waiting" | "met" | "unavailable" | "not_evaluated";
export type WaitClassification = "safety" | "scenario" | "directional" | "neutral" | null;

export interface SignalComponent {
  id: string;
  timeframe: Timeframe;
  value: Direction | number | string | null;
  points: number;
}

export interface SafetyReason {
  code: SafetyReasonCode;
  message: string;
}

export interface SafetyEvaluation {
  status: "ALLOW" | "BLOCK";
  reasons: SafetyReason[];
}

export interface SignalEngineV2Result {
  score: number;
  direction: TradeSignal;
  components: SignalComponent[];
  safety: SafetyEvaluation["status"];
  safetyReasons: SafetyReason[];
  scenarioStatus: ScenarioStatus;
  action: "BUY" | "SELL" | "WAIT";
  actionReasons: { code: string; message: string }[];
  waitClassification: WaitClassification;
  entryTriggerContext: EntryTriggerContext;
}

export function signalFromScore(score: number): TradeSignal {
  return score >= 60 ? "strong_buy" : score >= 20 ? "buy" : score <= -60 ? "strong_sell" : score <= -20 ? "sell" : "wait";
}

function component(id: string, frame: TechnicalFrame, value: Direction | number | string | null, weight: number, points: number): SignalComponent {
  return { id, timeframe: frame.timeframe, value, points: points * weight };
}

export function calculateSignalDirection(technical: TechnicalAnalysis): Pick<SignalEngineV2Result, "score" | "direction" | "components"> {
  const components = technical.frames.flatMap(frame => {
    const weight = timeframeWeights[frame.timeframe];
    const slopeDirection = (value: number | null): Direction => compare(value, 0);
    return [
      component("price_vs_sma20", frame, frame.priceVsSma, weight, directionValue(frame.priceVsSma) * technicalScoreWeights.priceVsSma),
      component("sma20_vs_sma75", frame, frame.shortVsMedium, weight, directionValue(frame.shortVsMedium) * technicalScoreWeights.smaAlignment),
      component("sma75_vs_sma200", frame, frame.mediumVsLong, weight, directionValue(frame.mediumVsLong) * technicalScoreWeights.smaAlignment),
      component("sma20_slope", frame, slopeDirection(frame.smaSlopes.short), weight, directionValue(slopeDirection(frame.smaSlopes.short)) * technicalScoreWeights.smaSlope),
      component("sma75_slope", frame, slopeDirection(frame.smaSlopes.medium), weight, directionValue(slopeDirection(frame.smaSlopes.medium)) * technicalScoreWeights.smaSlope),
      component("sma200_slope", frame, slopeDirection(frame.smaSlopes.long), weight, directionValue(slopeDirection(frame.smaSlopes.long)) * technicalScoreWeights.smaSlope),
      component("momentum", frame, compare(frame.momentum, 0), weight, directionValue(compare(frame.momentum, 0)) * technicalScoreWeights.momentum),
      component("rsi_context", frame, frame.rsiState, weight, 0),
    ];
  });
  const score = Math.round(Math.max(-100, Math.min(100, technical.score)));
  return { score, direction: signalFromScore(score), components };
}

export function evaluateSafetyGate(input: {
  technical: TechnicalAnalysis;
  dataQuality: DataQuality;
  staleDataSources?: readonly string[];
  eventRisk: { imminent: boolean; uncertainTime: boolean; nextRiskAt?: string | null; reasons: string[] };
  now: number;
}): SafetyEvaluation {
  const reasons: SafetyReason[] = [];
  const add = (code: SafetyReasonCode, message: string) => {
    if (!reasons.some(reason => reason.code === code)) reasons.push({ code, message });
  };
  if (input.dataQuality.score < 60) add("DATA_QUALITY", "データ充足率が60%未満のためActionをブロックします。");
  if (input.staleDataSources?.length) add("STALE_DATA", `古いデータを検出しました: ${input.staleDataSources.join(", ")}`);
  const eventStarted = !!input.eventRisk.nextRiskAt && input.now >= Date.parse(input.eventRisk.nextRiskAt);
  if (input.eventRisk.imminent || input.eventRisk.uncertainTime || eventStarted) {
    add("ECONOMIC_EVENT", input.eventRisk.reasons.join(" / ") || "経済イベントのリスク時間帯または発表時刻不明を検出しました。");
  }
  if (input.technical.extended) add("EXTENDED_MARKET", "急変・大きな乖離を検出したため追いかけエントリーをブロックします。");
  if (!input.technical.ready) add("INSUFFICIENT_DATA", "新鮮なレートと2時間軸以上の十分な確定足が必要です。");
  return { status: reasons.length ? "BLOCK" : "ALLOW", reasons };
}

export function resolveSignalAction(input: {
  direction: TradeSignal;
  safety: SafetyEvaluation;
  scenarioStatus: ScenarioStatus;
  aiAvailable: boolean;
  confidence: number | null;
  preferWait: boolean;
  contradictions: boolean;
  entryTriggerContext?: EntryTriggerContext;
}): Pick<SignalEngineV2Result, "action" | "actionReasons" | "waitClassification" | "entryTriggerContext"> {
  const actionReasons: { code: string; message: string }[] = input.safety.reasons.map(reason => ({ code: reason.code, message: reason.message }));
  const directionExists = input.direction !== "wait";
  if (directionExists && input.scenarioStatus === "unavailable") {
    actionReasons.push({ code: "NO_VALID_RISK_SCENARIO", message: "方向感はありますが、有効なRR 1.5以上のシナリオがありません。" });
  }
  if (!directionExists) actionReasons.push({ code: "NEUTRAL_DIRECTION", message: "方向スコアが中立帯です。" });
  if (!input.aiAvailable) actionReasons.push({ code: "AI_CONTEXT_UNAVAILABLE", message: "AI解釈は未取得です。方向はテクニカル評価から独立して算出しています。" });
  if (input.confidence !== null && input.confidence < 55) actionReasons.push({ code: "AI_LOW_CONFIDENCE", message: "AI解釈の確信度が55%未満です。" });
  if (input.contradictions) actionReasons.push({ code: "SIGNAL_CONTRADICTION", message: "テクニカル、時間軸、またはAI材料の間に矛盾があります。" });
  if (input.preferWait) actionReasons.push({ code: "AI_PREFER_WAIT", message: "AI解釈は条件が整うまでの待機を提案しています。" });

  const blocked = input.safety.status === "BLOCK"
    || (directionExists && input.scenarioStatus !== "available")
    || !input.aiAvailable
    || (input.confidence !== null && input.confidence < 55)
    || input.contradictions
    || input.preferWait
    || !directionExists;
  const action = blocked ? "WAIT" : input.direction.includes("buy") ? "BUY" : "SELL";
  const waitClassification: WaitClassification = action !== "WAIT" ? null
    : input.safety.status === "BLOCK" ? "safety"
      : directionExists && input.scenarioStatus !== "available" ? "scenario"
        : !directionExists ? "neutral" : "directional";
  return {
    action,
    actionReasons,
    waitClassification,
    entryTriggerContext: input.entryTriggerContext ?? "not_evaluated",
  };
}

export function evaluateSignalEngineV2(input: {
  technical: TechnicalAnalysis;
  dataQuality: DataQuality;
  staleDataSources?: readonly string[];
  eventRisk: { imminent: boolean; uncertainTime: boolean; nextRiskAt?: string | null; reasons: string[] };
  aiAvailable: boolean;
  confidence: number | null;
  preferWait: boolean;
  contradictions: boolean;
  scenarioAvailable: boolean;
  entryTriggerContext?: EntryTriggerContext;
  now: number;
}): SignalEngineV2Result {
  const direction = calculateSignalDirection(input.technical);
  const safety = evaluateSafetyGate(input);
  const scenarioStatus: ScenarioStatus = direction.direction === "wait" ? "not_applicable" : input.scenarioAvailable ? "available" : "unavailable";
  return {
    ...direction,
    safety: safety.status,
    safetyReasons: safety.reasons,
    scenarioStatus,
    ...resolveSignalAction({
      direction: direction.direction,
      safety,
      scenarioStatus,
      aiAvailable: input.aiAvailable,
      confidence: input.confidence,
      preferWait: input.preferWait,
      contradictions: input.contradictions,
      entryTriggerContext: input.entryTriggerContext,
    }),
  };
}