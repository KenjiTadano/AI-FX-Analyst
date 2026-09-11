import type { AIAnalysis, AnalysisFactor, TradeSignal, TradeScenario } from "./types";
import { analysisPlan } from "../risk/risk-reward";
import { positionSize } from "../risk/position-size";
import type { RiskSettings } from "../risk/types";

export const ANALYSIS_STALE_MS = 5 * 60_000;

export const signalLabels: Record<TradeSignal, string> = {
  strong_buy: "すごく買い",
  buy: "買い",
  wait: "待った",
  sell: "売り",
  strong_sell: "すごく売り",
};

export function directionBiasLabel(signal: TradeSignal | null | undefined): string {
  if (!signal || signal === "wait") return "方向感なし / 中立";
  if (signal === "strong_buy") return "強い買い寄り";
  if (signal === "buy") return "買い寄り";
  if (signal === "strong_sell") return "強い売り寄り";
  return "売り寄り";
}

export function actionGuidanceLabel(action: AIAnalysis["action"] | null | undefined, signal: TradeSignal): string {
  const resolved = action ?? (signal === "wait" ? "WAIT" : signal.includes("buy") ? "BUY" : signal.includes("sell") ? "SELL" : "WAIT");
  if (resolved === "WAIT") return "今はエントリーしない";
  if (resolved === "BUY") return "買い条件を満たせば検討";
  return "売り条件を満たせば検討";
}

export type WaitReasonKind = "event" | "volatility" | "conflict" | "entry" | "data" | "confidence" | "other";

export function classifyWaitReasons(analysis: AIAnalysis | null | undefined): { kind: WaitReasonKind; label: string }[] {
  if (!analysis) return [{ kind: "other", label: "条件待ち" }];
  const out: { kind: WaitReasonKind; label: string }[] = [];
  const push = (kind: WaitReasonKind, label: string) => {
    if (!out.some(item => item.label === label)) out.push({ kind, label });
  };
  if (analysis.economicRisk?.active) {
    for (const reason of analysis.economicRisk.reasons.slice(0, 3)) push("event", reason);
    if (!analysis.economicRisk.reasons.length) push("event", "重要指標前");
  }
  for (const reason of analysis.decisionReasons) {
    if (/指標|イベント|リスク時間|発表/.test(reason)) push("event", reason.includes("指標") || reason.includes("イベント") ? "重要指標前" : reason.slice(0, 40));
    else if (/充足|未取得|不足|テクニカル評価のみ|OPENAI|データ/.test(reason)) push("data", "データ不足");
    else if (/確信度/.test(reason)) push("confidence", "確信度不足");
    else if (/矛盾|拮抗/.test(reason)) push("conflict", "BUY/SELL材料が拮抗");
    else if (/急変|乖離|追いかけ|ボラ/.test(reason)) push("volatility", "ボラティリティ / 急変注意");
    else if (/RR|価格関係|エントリー|条件を満たす候補がない/.test(reason)) push("entry", "Entry条件未達");
    else if (/中立/.test(reason)) push("other", "方向感なし");
  }
  if (!out.length) {
    if (analysis.signal === "wait" || analysis.action === "WAIT") push("other", "条件待ち");
  }
  return out.slice(0, 5);
}

/** Prefer existing AI/scenario text; never invent prices. */
export function whatToDoNow(analysis: AIAnalysis | null | undefined): string {
  if (!analysis) return "条件が整うまで待つ";
  if (analysis.economicRisk?.active) {
    const next = analysis.economicRisk.nextHigh?.name;
    return next ? `${next}の発表前後を避け、発表後まで待つ` : "重要指標発表後まで待つ";
  }
  if (analysis.scenario?.condition?.trim()) return analysis.scenario.condition.trim();
  const waits = classifyWaitReasons(analysis);
  if (waits[0]?.label && waits[0].label !== "条件待ち") return waits[0].label.includes("待つ") ? waits[0].label : `${waits[0].label}のため待つ`;
  if (analysis.action === "WAIT" || analysis.signal === "wait") return "条件が整うまで待つ";
  if (analysis.scenario?.direction === "long") return "買いシナリオの条件確認を続ける";
  if (analysis.scenario?.direction === "short") return "売りシナリオの条件確認を続ける";
  return "条件が整うまで待つ";
}

export function scenarioStance(analysis: AIAnalysis | null | undefined): { buy: string; sell: string; wait: string } {
  if (!analysis) return { buy: "未評価", sell: "未評価", wait: "確認中" };
  const actionWait = analysis.action === "WAIT" || analysis.signal === "wait";
  const dir = analysis.directionSignal ?? "wait";
  const buyLean = dir === "buy" || dir === "strong_buy";
  const sellLean = dir === "sell" || dir === "strong_sell";
  return {
    buy: analysis.scenario?.direction === "long" ? "条件付き候補" : buyLean ? "低確率" : "非優勢",
    sell: analysis.scenario?.direction === "short" ? "条件付き候補" : sellLean ? "低確率" : "非優勢",
    wait: actionWait ? "現在推奨" : "非推奨",
  };
}

export function evidenceConflictNote(analysis: AIAnalysis | null | undefined): string | null {
  if (!analysis) return null;
  const technical = analysis.factors.filter(factor => factor.category === "technical");
  const bullishTech = technical.some(f => f.direction === "bullish");
  const bearishTech = technical.some(f => f.direction === "bearish");
  const bullish = analysis.bullishReasons.length > 0 || analysis.factors.some(f => f.direction === "bullish");
  const bearish = analysis.bearishReasons.length > 0 || analysis.factors.some(f => f.direction === "bearish");
  const chartUsed = !!analysis.chartEvidence?.used;
  const chartDown = chartUsed && (analysis.chartEvidence!.trend === "down" || analysis.chartEvidence!.trend === "strong_down");
  const chartUp = chartUsed && (analysis.chartEvidence!.trend === "up" || analysis.chartEvidence!.trend === "strong_up");
  if (chartDown && (bullishTech || analysis.directionSignal === "buy" || analysis.directionSignal === "strong_buy")) {
    return "チャート画像とリアルタイム指標が一致していません";
  }
  if (chartUp && (bearishTech || analysis.directionSignal === "sell" || analysis.directionSignal === "strong_sell")) {
    return "チャート画像とリアルタイム指標が一致していません";
  }
  if (bullish && bearish) return "材料が割れています";
  if (analysis.decisionReasons.some(reason => /矛盾/.test(reason))) return "材料が割れています";
  return null;
}

export function splitEvidenceMaterials(analysis: AIAnalysis | null | undefined): {
  buy: { title: string; reason: string }[];
  sell: { title: string; reason: string }[];
  wait: { title: string; reason: string }[];
} {
  if (!analysis) return { buy: [], sell: [], wait: [] };
  const buy: { title: string; reason: string }[] = [];
  const sell: { title: string; reason: string }[] = [];
  const wait: { title: string; reason: string }[] = [];
  for (const factor of analysis.factors.slice(0, 8)) {
    const item = { title: factor.title, reason: factor.reason };
    if (factor.direction === "bullish") buy.push(item);
    else if (factor.direction === "bearish") sell.push(item);
    else if (factor.direction === "unknown" || factor.direction === "neutral") wait.push(item);
  }
  for (const reason of analysis.bullishReasons.slice(0, 3)) {
    if (!buy.some(item => item.reason === reason)) buy.push({ title: "強気材料", reason });
  }
  for (const reason of analysis.bearishReasons.slice(0, 3)) {
    if (!sell.some(item => item.reason === reason)) sell.push({ title: "弱気材料", reason });
  }
  for (const item of classifyWaitReasons(analysis)) {
    wait.push({ title: "WAIT理由", reason: item.label });
  }
  return { buy: buy.slice(0, 5), sell: sell.slice(0, 5), wait: wait.slice(0, 5) };
}

export function whyFactors(analysis: AIAnalysis | null | undefined): AnalysisFactor[] {
  if (!analysis) return [];
  return analysis.factors.filter(factor => factor.direction !== "unknown" || factor.reason).slice(0, 5);
}

export function isAnalysisStale(analyzedAt: string | null | undefined, now: number, thresholdMs = ANALYSIS_STALE_MS): boolean {
  if (!analyzedAt) return false;
  const at = Date.parse(analyzedAt);
  return Number.isFinite(at) && now - at >= thresholdMs;
}

export function formatScenarioPrices(scenario: TradeScenario | null | undefined, decimals = 3): {
  entry: string;
  stop: string;
  takeProfit1: string;
  takeProfit2: string;
} | null {
  if (!scenario) return null;
  const fmt = (value: number) => value.toFixed(decimals);
  return {
    entry: `${fmt(scenario.entryZone.min)} ～ ${fmt(scenario.entryZone.max)}`,
    stop: fmt(scenario.stopLoss),
    takeProfit1: fmt(scenario.takeProfit1),
    takeProfit2: fmt(scenario.takeProfit2),
  };
}

/** Reuse Task006 sizing; WAIT / missing scenario → null (no invented size). */
export function recommendedPositionHint(analysis: AIAnalysis | null | undefined, pair: string, settings: RiskSettings, now: number): {
  wait: boolean;
  label: string;
  maxUnits: number | null;
} {
  if (!analysis || analysis.action === "WAIT" || analysis.signal === "wait") {
    return { wait: true, label: "新規エントリーなし", maxUnits: 0 };
  }
  const plan = analysisPlan(analysis, pair, now);
  if (!plan.data) return { wait: true, label: plan.error ?? "条件未設定", maxUnits: null };
  const size = positionSize(settings.balance, settings.riskPercent, plan.data.entry, plan.data.scenario.stopLoss, settings.tradeUnit);
  if (!size.data) return { wait: false, label: size.error ?? "未算出", maxUnits: null };
  return { wait: false, label: `この条件なら最大 ${size.data.maxUnits.toLocaleString("ja-JP")} 通貨`, maxUnits: size.data.maxUnits };
}
