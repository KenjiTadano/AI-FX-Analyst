import { nextHigh, riskState } from "../economic-calendar/risk-window";
import { categoryLabels } from "./input";
import { directionValue, scoreDirection } from "./technical";
import { generateScenario } from "./scenario";
import type { AiProviderName } from "./provider";
import type { PrimaryFailureMeta } from "./interpret-types";
import { factorCategories, type AIAnalysis, type AIErrorCode, type AnalysisInput, type ModelInterpretation } from "./types";
import { sanitizeStructuredEntryTrigger } from "./entry-trigger";
import { evaluateSignalEngineV2, signalFromScore } from "./signal-engine-v2";

export { signalFromScore };

export const aiMessages: Record<AIErrorCode, string> = {
  not_configured: "OpenAI API設定が不足しています。テクニカル評価のみ表示しています。",
  api_error: "AIを取得できません。テクニカル評価のみ表示しています。",
  invalid_response: "AIの返答を検証できませんでした。テクニカル評価のみ表示しています。",
  timeout: "AI分析がタイムアウトしました。テクニカル評価のみ表示しています。",
  rate_limited: "AIの利用上限に達しました。テクニカル評価のみ表示しています。",
  insufficient_data: "市場データ不足のためAI分析を見送りました。",
};

/** Provider-aware user message. Never include secret values or env variable names. */
export function aiMessage(code: AIErrorCode, provider: AiProviderName = "openai", detail?: string | null): string {
  if (code === "not_configured") {
    return provider === "openrouter"
      ? "OpenRouter API設定が不足しています。テクニカル評価のみ表示しています。"
      : "OpenAI API設定が不足しています。テクニカル評価のみ表示しています。";
  }
  if (code === "rate_limited") {
    const retry = detail?.match(/retry_after_(\d+)/)?.[1];
    return retry
      ? `AIの利用上限に達しました（約${retry}秒後に再試行できます）。テクニカル評価のみ表示しています。自動再試行はしません。`
      : "AIの利用上限に達しました。テクニカル評価のみ表示しています。自動再試行はしません。";
  }
  if (code === "api_error" && detail?.includes("http_402")) {
    return provider === "openrouter"
      ? "OpenRouterの利用枠または課金状態のためAIを取得できません。テクニカル評価のみ表示しています。"
      : "AIプロバイダの利用枠または課金状態のためAIを取得できません。テクニカル評価のみ表示しています。";
  }
  return aiMessages[code];
}

export type FinalizeAiMeta = {
  provider?: AiProviderName;
  requestedModel?: string | null;
  actualModel?: string | null;
  fallbackUsed?: boolean;
  latencyMs?: number | null;
  detail?: string | null;
  primaryFailure?: PrimaryFailureMeta | null;
};

export function finalizeAnalysis(
  input: AnalysisInput,
  interpretation: ModelInterpretation | null,
  model: string,
  error: AIErrorCode | null,
  now = Date.now(),
  provider: AiProviderName = "openai",
  meta: FinalizeAiMeta = {},
): AIAnalysis {
  const technical = input.technicalAnalysis;
  const calendarRisk = input.eventRisk.events ? riskState(input.eventRisk.events, now) : input.eventRisk;
  const economicBlocked = calendarRisk.imminent || calendarRisk.uncertainTime || input.eventRisk.imminent || input.eventRisk.uncertainTime;
  const aiReady = interpretation !== null && error === null;
  const factors = [...technical.factors];
  for (const category of factorCategories.filter(category => category !== "technical")) {
    const factor = aiReady ? interpretation.factors.find(factor => factor.category === category) : null;
    factors.push(factor ?? { category, title: categoryLabels[category], direction: "unknown", impact: "low", reason: "AIによる材料の意味解釈は未取得です。未取得を強気・弱気に数えません。", source: "未評価", evidenceIds: [] });
  }
  const weights = { news: 10, economic: 10, central_bank: 7, market_environment: 3 };
  const fundamentalScore = factors.reduce((sum, factor) => factor.category === "technical" ? sum : sum + directionValue(factor.direction) * weights[factor.category] * ({ high: 1, medium: 0.6, low: 0.3 }[factor.impact]), 0);
  const score = Math.round(Math.max(-100, Math.min(100, technical.score * 0.7 + fundamentalScore)));
  const contradictory = !!interpretation?.contradictions || (Math.abs(technical.score) >= 20 && Math.abs(fundamentalScore) >= 6 && Math.sign(technical.score) !== Math.sign(fundamentalScore)) || technical.frames.some(frame => frame.available && Math.abs(frame.score) >= 20 && Math.sign(frame.score) !== Math.sign(technical.score));
  const overextendedRsi = technical.frames.some(frame => ["oversold", "overbought"].includes(frame.rsiState));
  const confidence = aiReady ? Math.max(0, Math.round(Math.min(interpretation.confidence, input.dataAvailability.score, 90) - (contradictory ? 20 : 0) - (overextendedRsi ? 8 : 0) - (economicBlocked ? 15 : 0))) : Math.min(35, input.dataAvailability.score);
  const messageProvider = meta.provider ?? provider;
  const directionSignal = signalFromScore(technical.score);
  const scenario = generateScenario(input, directionSignal);
  const signalEngineV2 = evaluateSignalEngineV2({
    technical,
    dataQuality: input.dataAvailability,
    staleDataSources: input.staleDataSources,
    eventRisk: {
      ...calendarRisk,
      imminent: calendarRisk.imminent || input.eventRisk.imminent,
      uncertainTime: calendarRisk.uncertainTime || input.eventRisk.uncertainTime,
      nextRiskAt: calendarRisk.nextRiskAt ?? input.eventRisk.nextRiskAt,
      reasons: [...new Set([...calendarRisk.reasons, ...input.eventRisk.reasons])],
    },
    aiAvailable: aiReady,
    confidence: aiReady ? confidence : null,
    preferWait: !!interpretation?.preferWait,
    contradictions: contradictory,
    scenarioAvailable: scenario !== null,
    now,
  });
  const signal = signalEngineV2.action === "WAIT" ? "wait" : signalEngineV2.direction;
  const decisionReasons = signalEngineV2.actionReasons.map(reason => reason.message);
  const technicalBullish = technical.factors.filter(factor => factor.direction === "bullish").map(factor => factor.reason);
  const technicalBearish = technical.factors.filter(factor => factor.direction === "bearish").map(factor => factor.reason);
  const defaultExpiry = now + (aiReady ? 300_000 : 60_000);
  const riskAt = input.eventRisk.nextRiskAt ? Date.parse(input.eventRisk.nextRiskAt) : Number.POSITIVE_INFINITY;
  const boundary = "nextBoundaryAt" in calendarRisk && calendarRisk.nextBoundaryAt ? Date.parse(calendarRisk.nextBoundaryAt) : Infinity;
  const expiresAt = Math.min(defaultExpiry, riskAt > now ? riskAt : defaultExpiry, boundary > now ? boundary : defaultExpiry);
  const displayModel = aiReady ? (meta.actualModel ?? meta.requestedModel ?? (model || null)) : null;
  return {
    pair: input.pair, signal, directionSignal: signalEngineV2.direction, action: signalEngineV2.action, signalEngineV2, economicRisk: { active: calendarRisk.imminent, known: input.eventRisk.known ?? false, reasons: calendarRisk.reasons, nextHigh: nextHigh(input.eventRisk.events ?? [], now) }, score, technicalScore: technical.score, confidence,
    summary: aiReady ? interpretation.summary : `AI統合は未取得です。取得済みテクニカルの方向は${{ bullish: "上昇寄り", bearish: "下落寄り", neutral: "中立", unknown: "未確認" }[scoreDirection(technical.score)]}ですが、総合判定は「待った」です。`,
    factors, bullishReasons: aiReady ? interpretation.bullishReasons : technicalBullish, bearishReasons: aiReady ? interpretation.bearishReasons : technicalBearish,
    riskWarnings: [...new Set([...technical.warnings, ...input.dataAvailability.missingData, ...input.eventRisk.reasons, ...(interpretation?.riskWarnings ?? []), ...(interpretation?.scenarioComment ? [interpretation.scenarioComment] : []), "確信度とスコアは勝率ではありません。条件が整うまでは待機できます。" ])],
    scenario, dataQuality: input.dataAvailability, currentRate: input.currentRate, analyzedAt: new Date(now).toISOString(), expiresAt: new Date(expiresAt).toISOString(), decisionReasons,
    ai: {
      status: aiReady ? "available" : error === "not_configured" || error === "insufficient_data" ? "unavailable" : "error",
      model: displayModel,
      code: error,
      message: error ? aiMessage(error, messageProvider, meta.detail) : null,
      provider: messageProvider,
      requestedModel: meta.requestedModel ?? (model || null),
      actualModel: meta.actualModel ?? null,
      fallbackUsed: !!meta.fallbackUsed,
      latencyMs: meta.latencyMs ?? null,
      primaryFailure: meta.fallbackUsed ? (meta.primaryFailure ?? null) : null,
    },
    chartEvidence: input.chartImageAnalysis ? {
      used: true,
      timeframe: input.chartImageAnalysis.detected.timeframe,
      trend: input.chartImageAnalysis.trend.direction,
      qualityScore: input.chartImageAnalysis.dataQuality.score,
    } : null,
    entryTrigger: sanitizeStructuredEntryTrigger(interpretation?.entryTrigger, input.pair),
  };
}
