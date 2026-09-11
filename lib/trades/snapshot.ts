import { factorCategories, tradeSignals, type AIAnalysis, type AnalysisFactor, type TradeSignal } from "../ai/types";
import { chartTrendDirections, type ChartImageAnalysis, type ChartTrendDirection } from "../chart-analysis/types";
import { pairs, type TradeAnalysisSnapshot, type TradeAiAnalysisSnapshot, type TradeChartAnalysisSnapshot, type TradePair, type AiAlignment } from "./types";

const TEXT = (max: number) => (value: unknown) => typeof value === "string" ? value.trim().slice(0, max) : null;
const NUM = (min: number, max: number) => (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= min && value <= max ? value : null;
const ISO = (value: unknown) => typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && new Date(value).toISOString() === value ? value : null;
const LIST = <T>(items: unknown, max: number, map: (item: unknown) => T | null): T[] => Array.isArray(items) ? items.slice(0, max).map(map).filter((item): item is T => item !== null) : [];
const SECRET_PAYLOAD = /sk-[a-zA-Z0-9]{10,}|api[_-]?key\s*[:=]|data:image\/|BEGIN (RSA )?PRIVATE|systemPrompt|developerPrompt/i;

function scrub(value: string): string {
  return SECRET_PAYLOAD.test(value) ? "[redacted]" : value;
}

function factor(raw: unknown): AnalysisFactor | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const item = raw as Record<string, unknown>;
  const category = factorCategories.includes(item.category as never) ? item.category as AnalysisFactor["category"] : null;
  const direction = ["bullish", "bearish", "neutral", "unknown"].includes(String(item.direction)) ? item.direction as AnalysisFactor["direction"] : null;
  const impact = ["high", "medium", "low"].includes(String(item.impact)) ? item.impact as AnalysisFactor["impact"] : null;
  const title = TEXT(120)(item.title);
  const reason = TEXT(800)(item.reason);
  const source = TEXT(120)(item.source);
  if (!category || !direction || !impact || !title || !reason || !source) return null;
  return {
    category, title: scrub(title), direction, impact, reason: scrub(reason), source: scrub(source),
    evidenceIds: LIST(item.evidenceIds, 8, id => {
      const text = TEXT(120)(id);
      return text && !SECRET_PAYLOAD.test(text) ? text : null;
    }),
  };
}

function sanitizeChart(chart: ChartImageAnalysis | null | undefined, pair: TradePair): TradeChartAnalysisSnapshot | null {
  if (!chart || chart.source !== "chart_image" || chart.pair !== pair) return null;
  const trendDir = chartTrendDirections.includes(chart.trend.direction) ? chart.trend.direction : "unknown";
  return {
    source: "chart_image",
    detectedPairRaw: TEXT(80)(chart.detected.pair),
    detectedPairCanonical: pair,
    timeframe: TEXT(40)(chart.detected.timeframe),
    chartType: TEXT(40)(chart.detected.chartType),
    currentPrice: NUM(0.000001, 1_000_000)(chart.detected.currentPrice),
    trend: {
      direction: trendDir,
      confidence: NUM(0, 100)(chart.trend.confidence) ?? 0,
      reason: scrub(TEXT(400)(chart.trend.reason) ?? "未評価"),
    },
    marketStructure: {
      higherHigh: typeof chart.structure.higherHigh === "boolean" ? chart.structure.higherHigh : null,
      higherLow: typeof chart.structure.higherLow === "boolean" ? chart.structure.higherLow : null,
      lowerHigh: typeof chart.structure.lowerHigh === "boolean" ? chart.structure.lowerHigh : null,
      lowerLow: typeof chart.structure.lowerLow === "boolean" ? chart.structure.lowerLow : null,
    },
    supportLevels: chart.levels.support.filter(n => Number.isFinite(n)).slice(0, 8),
    resistanceLevels: chart.levels.resistance.filter(n => Number.isFinite(n)).slice(0, 8),
    patterns: chart.patterns.slice(0, 6).map(item => ({
      name: scrub(TEXT(80)(item.name) ?? "pattern"),
      confidence: NUM(0, 100)(item.confidence) ?? 0,
      description: scrub(TEXT(240)(item.description) ?? ""),
    })),
    indicators: chart.indicators.slice(0, 8).map(item => ({
      name: scrub(TEXT(80)(item.name) ?? "indicator"),
      value: typeof item.value === "number" && Number.isFinite(item.value) ? item.value : TEXT(40)(item.value),
      interpretation: scrub(TEXT(200)(item.interpretation) ?? ""),
    })),
    dataQuality: {
      score: NUM(0, 100)(chart.dataQuality.score) ?? 0,
      imageReadable: !!chart.dataQuality.imageReadable,
      pairDetected: !!chart.dataQuality.pairDetected,
      timeframeDetected: !!chart.dataQuality.timeframeDetected,
    },
    warnings: LIST(chart.warnings, 8, item => {
      const text = TEXT(200)(item);
      return text ? scrub(text) : null;
    }),
    imageReadable: !!chart.dataQuality.imageReadable,
    analyzedAt: ISO(chart.analyzedAt) ?? new Date(0).toISOString(),
  };
}

export function isRichSnapshot(value: TradeAnalysisSnapshot | null | undefined): value is TradeAiAnalysisSnapshot {
  return !!value && "version" in value && value.version === 1;
}

export function computeAiAlignment(side: "long" | "short", snapshot: TradeAnalysisSnapshot | null | undefined, tradePair?: string): AiAlignment {
  if (!snapshot) return "unavailable";
  if (tradePair && snapshot.pair !== tradePair) return "unavailable";
  const action = isRichSnapshot(snapshot)
    ? snapshot.action
    : snapshot.signal === "wait" ? "WAIT" : snapshot.signal.includes("buy") ? "BUY" : snapshot.signal.includes("sell") ? "SELL" : "WAIT";
  if (action === "WAIT") return "wait_override";
  const direction: TradeSignal = isRichSnapshot(snapshot) ? snapshot.directionSignal : snapshot.signal;
  const aiBuy = direction === "buy" || direction === "strong_buy";
  const aiSell = direction === "sell" || direction === "strong_sell";
  if (!aiBuy && !aiSell) return "neutral";
  const tradeBuy = side === "long";
  return tradeBuy === aiBuy ? "aligned" : "contrary";
}

export type CaptureSnapshotInput = {
  analysis: AIAnalysis | null;
  pair: string;
  now: string;
  marketPrice?: number | null;
  chartImageAnalysis?: ChartImageAnalysis | null;
  saveSnapshot?: boolean;
};

/** Build a sanitized, versioned snapshot. Pair mismatch / opt-out / missing analysis → null (trade itself still succeeds). */
export function captureTradeAiSnapshot(input: CaptureSnapshotInput): TradeAiAnalysisSnapshot | null {
  const { analysis, pair, now, marketPrice = null, chartImageAnalysis = null, saveSnapshot = true } = input;
  if (!saveSnapshot || !analysis || !pairs.includes(pair as TradePair) || analysis.pair !== pair) return null;
  const capturedAt = ISO(now);
  if (!capturedAt) return null;
  const signal = tradeSignals.includes(analysis.signal) ? analysis.signal : "wait";
  const directionSignal = tradeSignals.includes(analysis.directionSignal as TradeSignal) ? analysis.directionSignal as TradeSignal : signal;
  const action = analysis.action === "BUY" || analysis.action === "SELL" || analysis.action === "WAIT"
    ? analysis.action
    : signal === "wait" ? "WAIT" : signal.includes("buy") ? "BUY" : signal.includes("sell") ? "SELL" : "WAIT";
  const summary = scrub(TEXT(2000)(analysis.summary) ?? "分析要約なし");
  const chartAnalysis = sanitizeChart(chartImageAnalysis, pair as TradePair);
  const chartEvidence = analysis.chartEvidence?.used
    ? {
      used: true as const,
      timeframe: TEXT(40)(analysis.chartEvidence.timeframe),
      trend: (chartTrendDirections.includes(analysis.chartEvidence.trend) ? analysis.chartEvidence.trend : "unknown") as ChartTrendDirection,
      qualityScore: NUM(0, 100)(analysis.chartEvidence.qualityScore) ?? 0,
    }
    : chartAnalysis
      ? { used: false as const, timeframe: chartAnalysis.timeframe, trend: chartAnalysis.trend.direction, qualityScore: chartAnalysis.dataQuality.score }
      : null;
  const scenario = analysis.scenario && (analysis.scenario.direction === "long" || analysis.scenario.direction === "short") ? {
    direction: analysis.scenario.direction,
    entryZone: {
      min: NUM(0.000001, 1_000_000)(analysis.scenario.entryZone.min) ?? analysis.scenario.entryZone.min,
      max: NUM(0.000001, 1_000_000)(analysis.scenario.entryZone.max) ?? analysis.scenario.entryZone.max,
    },
    stopLoss: NUM(0.000001, 1_000_000)(analysis.scenario.stopLoss) ?? analysis.scenario.stopLoss,
    takeProfit1: NUM(0.000001, 1_000_000)(analysis.scenario.takeProfit1) ?? analysis.scenario.takeProfit1,
    takeProfit2: NUM(0.000001, 1_000_000)(analysis.scenario.takeProfit2) ?? analysis.scenario.takeProfit2,
    riskReward: NUM(0, 1000)(analysis.scenario.riskReward) ?? 0,
    condition: scrub(TEXT(400)(analysis.scenario.condition) ?? ""),
    invalidation: scrub(TEXT(400)(analysis.scenario.invalidation) ?? ""),
    sourceTimeframe: TEXT(20)(analysis.scenario.sourceTimeframe) ?? "1h",
  } : null;
  const economic = analysis.economicRisk ? {
    active: !!analysis.economicRisk.active,
    known: !!analysis.economicRisk.known,
    reasons: LIST(analysis.economicRisk.reasons, 5, item => {
      const text = TEXT(200)(item);
      return text ? scrub(text) : null;
    }),
    nextHigh: analysis.economicRisk.nextHigh ? {
      name: scrub(TEXT(120)(analysis.economicRisk.nextHigh.name) ?? "event"),
      scheduledAt: TEXT(40)(analysis.economicRisk.nextHigh.scheduledAt),
      importance: analysis.economicRisk.nextHigh.importance === "high" || analysis.economicRisk.nextHigh.importance === "medium" || analysis.economicRisk.nextHigh.importance === "low"
        ? analysis.economicRisk.nextHigh.importance : null,
    } : null,
  } : null;
  const categories = Object.fromEntries(factorCategories.map(category => {
    const value = analysis.dataQuality.categories[category];
    return [category, {
      status: value?.status === "ok" || value?.status === "partial" || value?.status === "missing" ? value.status : "missing",
      detail: scrub(TEXT(200)(value?.detail) ?? ""),
      fraction: NUM(0, 1)(value?.fraction) ?? 0,
    }];
  })) as TradeAiAnalysisSnapshot["dataQuality"]["categories"];
  const snapshot: TradeAiAnalysisSnapshot = {
    version: 1,
    pair: pair as TradePair,
    signal,
    directionSignal,
    action,
    score: NUM(-100, 100)(analysis.score) ?? 0,
    confidence: NUM(0, 100)(analysis.confidence) ?? 0,
    summary,
    dataQualityScore: NUM(0, 100)(analysis.dataQuality.score) ?? 0,
    analyzedAt: ISO(analysis.analyzedAt) ?? capturedAt,
    capturedAt,
    expiresAt: ISO(analysis.expiresAt) ?? capturedAt,
    aiStatus: analysis.ai.status === "available" || analysis.ai.status === "unavailable" || analysis.ai.status === "error" ? analysis.ai.status : "unavailable",
    model: analysis.ai.model === null ? null : scrub(TEXT(120)(analysis.ai.model) ?? "model"),
    bullishReasons: LIST(analysis.bullishReasons, 12, item => {
      const text = TEXT(400)(item);
      return text ? scrub(text) : null;
    }),
    bearishReasons: LIST(analysis.bearishReasons, 12, item => {
      const text = TEXT(400)(item);
      return text ? scrub(text) : null;
    }),
    marketPrice: NUM(0.000001, 1_000_000)(marketPrice),
    analysisPrice: NUM(0.000001, 1_000_000)(analysis.currentRate),
    factors: LIST(analysis.factors, 8, factor),
    scenario,
    dataQuality: {
      score: NUM(0, 100)(analysis.dataQuality.score) ?? 0,
      missingData: LIST(analysis.dataQuality.missingData, 12, item => {
        const text = TEXT(120)(item);
        return text ? scrub(text) : null;
      }),
      categories,
      macroeconomicData: {
        status: analysis.dataQuality.macroeconomicData?.status === "ok" || analysis.dataQuality.macroeconomicData?.status === "partial" || analysis.dataQuality.macroeconomicData?.status === "missing"
          ? analysis.dataQuality.macroeconomicData.status : "missing",
        detail: scrub(TEXT(200)(analysis.dataQuality.macroeconomicData?.detail) ?? ""),
        fraction: NUM(0, 1)(analysis.dataQuality.macroeconomicData?.fraction) ?? 0,
      },
    },
    economicRisk: economic,
    chartEvidence,
    chartAnalysis,
    aiCode: analysis.ai.code === null ? null : scrub(TEXT(80)(analysis.ai.code) ?? "error"),
    isFallback: analysis.ai.status !== "available",
  };
  return sanitizeTradeAiSnapshot(snapshot);
}

/** Re-validate / drop unknown client fields before persistence. Malformed → null (caller keeps trade). */
export function sanitizeTradeAiSnapshot(raw: unknown): TradeAiAnalysisSnapshot | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (value.version !== 1) return null;
  if (!pairs.includes(value.pair as TradePair)) return null;
  if (!tradeSignals.includes(value.signal as TradeSignal)) return null;
  if (!tradeSignals.includes(value.directionSignal as TradeSignal)) return null;
  if (!["BUY", "SELL", "WAIT"].includes(String(value.action))) return null;
  if (!["available", "unavailable", "error"].includes(String(value.aiStatus))) return null;
  const score = NUM(-100, 100)(value.score);
  const confidence = NUM(0, 100)(value.confidence);
  const dataQualityScore = NUM(0, 100)(value.dataQualityScore);
  const summary = TEXT(2000)(value.summary);
  const analyzedAt = ISO(value.analyzedAt);
  const capturedAt = ISO(value.capturedAt);
  const expiresAt = ISO(value.expiresAt);
  if (score === null || confidence === null || dataQualityScore === null || !summary || !analyzedAt || !capturedAt || !expiresAt) return null;
  if (typeof value.isFallback !== "boolean") return null;
  if (SECRET_PAYLOAD.test(JSON.stringify(value))) return null;
  // Trust capture-built objects; reject only when required shape is incomplete.
  return value as unknown as TradeAiAnalysisSnapshot;
}

export function sanitizePersistedSnapshot(raw: unknown): TradeAnalysisSnapshot | TradeAiAnalysisSnapshot | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (value.version === 1) return sanitizeTradeAiSnapshot(value);
  // Legacy Task007/008 snapshot (no version).
  if (!pairs.includes(value.pair as TradePair) || !tradeSignals.includes(value.signal as TradeSignal)) return null;
  const score = NUM(-100, 100)(value.score);
  const confidence = NUM(0, 100)(value.confidence);
  const dataQualityScore = NUM(0, 100)(value.dataQualityScore);
  const summary = TEXT(10000)(value.summary);
  const analyzedAt = ISO(value.analyzedAt);
  const capturedAt = ISO(value.capturedAt);
  const expiresAt = ISO(value.expiresAt);
  if (score === null || confidence === null || dataQualityScore === null || !summary || !analyzedAt || !capturedAt || !expiresAt) return null;
  if (!["available", "unavailable", "error"].includes(String(value.aiStatus))) return null;
  if (!(value.model === null || typeof value.model === "string" && value.model.length <= 200)) return null;
  if (![value.bullishReasons, value.bearishReasons].every(a => Array.isArray(a) && a.length <= 30 && a.every(t => typeof t === "string" && t.length <= 4000))) return null;
  return {
    pair: value.pair as TradePair,
    signal: value.signal as TradeSignal,
    score, confidence, summary, dataQualityScore, analyzedAt, capturedAt, expiresAt,
    aiStatus: value.aiStatus as TradeAnalysisSnapshot["aiStatus"],
    model: value.model as string | null,
    bullishReasons: value.bullishReasons as string[],
    bearishReasons: value.bearishReasons as string[],
  };
}

export const alignmentLabels: Record<AiAlignment, string> = {
  aligned: "AI一致",
  contrary: "AI逆行",
  wait_override: "WAIT中エントリー",
  neutral: "AI中立",
  unavailable: "AI分析なし",
};
