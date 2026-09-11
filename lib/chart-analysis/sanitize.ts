import { symbols, type Symbol } from "../market/types";
import { isPairMismatch, normalizeDetectedPair } from "./normalize";
import { chartTrendDirections, type ChartImageAnalysis, type ChartTrendDirection } from "./types";

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

function clampScore(value: unknown, fallback = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function truncate(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, max);
}

function numberList(value: unknown, limit = 6): number[] {
  if (!Array.isArray(value)) return [];
  const out: number[] = [];
  for (const item of value) {
    if (typeof item === "number" && Number.isFinite(item) && out.length < limit) out.push(item);
  }
  return out;
}

function textList(value: unknown, limit = 8, max = 400): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const text = truncate(item, max);
    if (text && out.length < limit) out.push(text);
  }
  return out;
}

/**
 * Re-validate client-supplied ChartImageAnalysis before AI attach.
 * Malformed payloads return null (excluded, never throw into AI prompt crafting).
 */
export function sanitizeClientChartAnalysis(raw: unknown, selectedPair: Symbol): ChartImageAnalysis | null {
  if (!symbols.includes(selectedPair) || !isRecord(raw)) return null;
  if (raw.source !== "chart_image") return null;
  if (raw.pair !== selectedPair || !symbols.includes(raw.pair as Symbol)) return null;
  const detectedRaw = isRecord(raw.detected) ? raw.detected : null;
  const trendRaw = isRecord(raw.trend) ? raw.trend : null;
  const structureRaw = isRecord(raw.structure) ? raw.structure : null;
  const levelsRaw = isRecord(raw.levels) ? raw.levels : null;
  const qualityRaw = isRecord(raw.dataQuality) ? raw.dataQuality : null;
  if (!detectedRaw || !trendRaw || !structureRaw || !levelsRaw || !qualityRaw) return null;
  if (typeof trendRaw.confidence !== "number" || !Number.isFinite(trendRaw.confidence)) return null;
  if (typeof qualityRaw.score !== "number" || !Number.isFinite(qualityRaw.score)) return null;
  if (typeof qualityRaw.imageReadable !== "boolean") return null;
  const direction = chartTrendDirections.includes(trendRaw.direction as ChartTrendDirection)
    ? trendRaw.direction as ChartTrendDirection
    : null;
  if (!direction) return null;
  const analyzedAt = truncate(raw.analyzedAt, 40);
  if (!analyzedAt || Number.isNaN(Date.parse(analyzedAt))) return null;
  const rawPair = truncate(detectedRaw.pair, 80);
  const mismatch = isPairMismatch(selectedPair, rawPair);
  const boolOrNull = (value: unknown): boolean | null => value === null || typeof value === "boolean" ? value : null;
  const patterns = Array.isArray(raw.patterns) ? raw.patterns.flatMap(item => {
    if (!isRecord(item)) return [];
    const name = truncate(item.name, 80);
    const description = truncate(item.description, 400);
    if (!name || !description) return [];
    return [{ name, confidence: clampScore(item.confidence), description }];
  }).slice(0, 6) : [];
  const indicators = Array.isArray(raw.indicators) ? raw.indicators.flatMap(item => {
    if (!isRecord(item)) return [];
    const name = truncate(item.name, 80);
    const interpretation = truncate(item.interpretation, 400);
    if (!name || !interpretation) return [];
    const value = typeof item.value === "string" || typeof item.value === "number" || item.value === null ? item.value : null;
    if (typeof value === "string" && value.length > 80) return [{ name, value: value.slice(0, 80), interpretation }];
    if (typeof value === "number" && !Number.isFinite(value)) return [];
    return [{ name, value, interpretation }];
  }).slice(0, 8) : [];
  const price = detectedRaw.currentPrice;
  return {
    pair: selectedPair,
    detected: {
      pair: rawPair,
      timeframe: truncate(detectedRaw.timeframe, 40),
      chartType: truncate(detectedRaw.chartType, 40),
      currentPrice: typeof price === "number" && Number.isFinite(price) ? price : price === null ? null : null,
    },
    trend: {
      direction,
      confidence: clampScore(trendRaw.confidence),
      reason: truncate(trendRaw.reason, 800) ?? "画像から確認できた範囲の観察です。",
    },
    structure: {
      higherHigh: boolOrNull(structureRaw.higherHigh),
      higherLow: boolOrNull(structureRaw.higherLow),
      lowerHigh: boolOrNull(structureRaw.lowerHigh),
      lowerLow: boolOrNull(structureRaw.lowerLow),
    },
    levels: {
      support: numberList(levelsRaw.support),
      resistance: numberList(levelsRaw.resistance),
    },
    patterns,
    indicators,
    observations: textList(raw.observations),
    warnings: textList(raw.warnings),
    dataQuality: {
      score: clampScore(qualityRaw.score),
      imageReadable: qualityRaw.imageReadable,
      pairDetected: typeof qualityRaw.pairDetected === "boolean" ? qualityRaw.pairDetected : !!rawPair,
      timeframeDetected: typeof qualityRaw.timeframeDetected === "boolean" ? qualityRaw.timeframeDetected : !!truncate(detectedRaw.timeframe, 40),
    },
    // Never trust client pairMismatch; recompute from canonical labels.
    pairMismatch: mismatch,
    source: "chart_image",
    analyzedAt,
    model: truncate(raw.model, 80),
  };
}

export type ChartAttachBlockReason = "mismatch" | "unknown_pair" | "low_quality" | "unreadable" | "unavailable";

export function chartAttachBlockReason(analysis: ChartImageAnalysis | null | undefined, pair: Symbol): ChartAttachBlockReason | null {
  if (!analysis) return "unavailable";
  if (analysis.pair !== pair || analysis.source !== "chart_image") return "unavailable";
  if (analysis.pairMismatch) return "mismatch";
  const canonical = normalizeDetectedPair(analysis.detected.pair);
  if (canonical !== null && canonical !== pair) return "mismatch";
  if (!analysis.dataQuality.imageReadable) return "unreadable";
  if (analysis.dataQuality.score < 40) return "low_quality";
  if (analysis.detected.pair && canonical === null) return "unknown_pair";
  // Mirrors canAttachToPairAnalysis without invoking its type predicate (avoids `never`).
  return null;
}

export const chartAttachBlockMessages: Record<ChartAttachBlockReason, string> = {
  mismatch: "選択通貨ペアと画像の通貨ペアが異なるため、総合分析には使用できません",
  unknown_pair: "画像内の通貨ペアを確認できないため、総合分析には使用できません",
  low_quality: "画像品質が低いため、総合分析には使用できません",
  unreadable: "画像品質が低いため、総合分析には使用できません",
  unavailable: "このチャート結果は総合分析には使用できません",
};
