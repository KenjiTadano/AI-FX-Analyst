import { categoryLabels } from "./input";
import { directionValue, scoreDirection } from "./technical";
import { generateScenario } from "./scenario";
import { factorCategories, type AIAnalysis, type AIErrorCode, type AnalysisInput, type ModelInterpretation, type TradeSignal } from "./types";

export const aiMessages: Record<AIErrorCode, string> = {
  not_configured: "OPENAI_API_KEYが未設定です。テクニカル評価のみ表示しています。",
  api_error: "AIを取得できません。テクニカル評価のみ表示しています。",
  invalid_response: "AIの返答を検証できませんでした。テクニカル評価のみ表示しています。",
  timeout: "AI分析がタイムアウトしました。テクニカル評価のみ表示しています。",
  rate_limited: "AIの利用上限に達しました。テクニカル評価のみ表示しています。",
  insufficient_data: "市場データ不足のためAI分析を見送りました。",
};
export function signalFromScore(score: number): TradeSignal {
  return score >= 60 ? "strong_buy" : score >= 20 ? "buy" : score <= -60 ? "strong_sell" : score <= -20 ? "sell" : "wait";
}
export function finalizeAnalysis(input: AnalysisInput, interpretation: ModelInterpretation | null, model: string, error: AIErrorCode | null, now = Date.now()): AIAnalysis {
  const technical = input.technicalAnalysis;
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
  const confidence = aiReady ? Math.max(0, Math.round(Math.min(interpretation.confidence, input.dataAvailability.score, 90) - (contradictory ? 20 : 0) - (overextendedRsi ? 8 : 0))) : Math.min(35, input.dataAvailability.score);
  const decisionReasons: string[] = [];
  if (!aiReady) decisionReasons.push(aiMessages[error ?? "api_error"]);
  if (!technical.ready) decisionReasons.push("新鮮なレートと十分な2時間軸以上の確定足が必要です。");
  if (input.dataAvailability.score < 60) decisionReasons.push("データ充足率が60%未満のため待機します。");
  if (confidence < 55) decisionReasons.push("確信度が55%未満のため待機します。");
  if (contradictory) decisionReasons.push("テクニカルと他の材料、または時間軸間に矛盾があります。");
  if (technical.extended) decisionReasons.push("急変・大きな乖離があり、追いかけエントリーを見送ります。");
  if (input.eventRisk.nextRiskAt && now >= Date.parse(input.eventRisk.nextRiskAt)) decisionReasons.push("分析中に重要指標の発表30分前に入ったため待機します。");
  if (input.eventRisk.imminent || input.eventRisk.uncertainTime) decisionReasons.push(...input.eventRisk.reasons);
  if (interpretation?.preferWait) decisionReasons.push("AIの材料統合でも、条件が整うまで待つ判断です。");
  let signal = decisionReasons.length ? "wait" as const : signalFromScore(score);
  if (signal === "wait" && !decisionReasons.length) decisionReasons.push("方向スコアが中立帯です。");
  if (confidence < 75 && (signal === "strong_buy" || signal === "strong_sell")) signal = signal === "strong_buy" ? "buy" : "sell";
  let scenario = generateScenario(input, signal);
  if (signal !== "wait" && !scenario) { signal = "wait"; decisionReasons.push("方向感はありますが、価格関係またはRR 1.5以上の条件を満たす候補がないため待機します。"); }
  if (signal === "wait") scenario = null;
  const technicalBullish = technical.factors.filter(factor => factor.direction === "bullish").map(factor => factor.reason);
  const technicalBearish = technical.factors.filter(factor => factor.direction === "bearish").map(factor => factor.reason);
  const defaultExpiry = now + (aiReady ? 300_000 : 60_000);
  const riskAt = input.eventRisk.nextRiskAt ? Date.parse(input.eventRisk.nextRiskAt) : Number.POSITIVE_INFINITY;
  const expiresAt = Math.min(defaultExpiry, riskAt > now ? riskAt : defaultExpiry);
  return {
    pair: input.pair, signal, score, technicalScore: technical.score, confidence,
    summary: aiReady ? interpretation.summary : `AI統合は未取得です。取得済みテクニカルの方向は${{ bullish: "上昇寄り", bearish: "下落寄り", neutral: "中立", unknown: "未確認" }[scoreDirection(technical.score)]}ですが、総合判定は「待った」です。`,
    factors, bullishReasons: aiReady ? interpretation.bullishReasons : technicalBullish, bearishReasons: aiReady ? interpretation.bearishReasons : technicalBearish,
    riskWarnings: [...new Set([...technical.warnings, ...input.dataAvailability.missingData, ...input.eventRisk.reasons, ...(interpretation?.riskWarnings ?? []), ...(interpretation?.scenarioComment ? [interpretation.scenarioComment] : []), "確信度とスコアは勝率ではありません。条件が整うまでは待機できます。" ])],
    scenario, dataQuality: input.dataAvailability, currentRate: input.currentRate, analyzedAt: new Date(now).toISOString(), expiresAt: new Date(expiresAt).toISOString(), decisionReasons,
    ai: { status: aiReady ? "available" : error === "not_configured" || error === "insufficient_data" ? "unavailable" : "error", model: aiReady ? model : null, code: error, message: error ? aiMessages[error] : null },
  };
}
