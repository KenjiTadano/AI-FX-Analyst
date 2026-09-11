import { symbols, type Symbol } from "../market/types";
import { chartTrendDirections, type ChartImageAnalysis, type ChartTrendDirection } from "./types";

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const isText = (value: unknown, max = 500): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= max;
const isBoolOrNull = (value: unknown): value is boolean | null => value === null || typeof value === "boolean";
const isFiniteOrNull = (value: unknown): value is number | null => value === null || typeof value === "number" && Number.isFinite(value);

const aliasToPair: Record<string, Symbol> = {
  // USD/JPY
  "USD/JPY": "USD/JPY",
  "USDJPY": "USD/JPY",
  "USD-JPY": "USD/JPY",
  "米ドル/円": "USD/JPY",
  "米ドル円": "USD/JPY",
  "ドル/円": "USD/JPY",
  "ドル円": "USD/JPY",
  "USDOLLAR/JAPANESEYEN": "USD/JPY",
  "USDOLLAR-JAPANESEYEN": "USD/JPY",
  // EUR/JPY
  "EUR/JPY": "EUR/JPY",
  "EURJPY": "EUR/JPY",
  "EUR-JPY": "EUR/JPY",
  "ユーロ/円": "EUR/JPY",
  "ユーロ円": "EUR/JPY",
  "EURO/JPY": "EUR/JPY",
  "EURO/JAPANESEYEN": "EUR/JPY",
  // GBP/JPY
  "GBP/JPY": "GBP/JPY",
  "GBPJPY": "GBP/JPY",
  "GBP-JPY": "GBP/JPY",
  "英ポンド/円": "GBP/JPY",
  "英ポンド円": "GBP/JPY",
  "ポンド/円": "GBP/JPY",
  "ポンド円": "GBP/JPY",
  "POUND/JPY": "GBP/JPY",
  "POUNDSTERLING/JPY": "GBP/JPY",
  "BRITISHPOUND/JAPANESEYEN": "GBP/JPY",
};

function compactPairKey(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .replace(/[\u3000\s]+/g, " ")
    .replace(/\s*[/／]\s*/g, "/")
    .replace(/\s*[-－–—]\s*/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function englishCurrencyTokens(value: string): string {
  return value
    .toUpperCase()
    .replace(/U\.?S\.?\s*DOLLAR/g, "USD")
    .replace(/JAPANESE\s*YEN/g, "JPY")
    .replace(/EURO(?![A-Z])/g, "EUR")
    .replace(/BRITISH\s*POUND|POUND\s*STERLING|\bPOUND\b/g, "GBP")
    .replace(/\s+/g, "");
}

/** Map Vision/UI pair labels to a supported Symbol. Ambiguous/unsupported → null. */
export function normalizeDetectedPair(raw: unknown): Symbol | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const compact = compactPairKey(raw);
  const upper = compact.toUpperCase();
  const nospace = upper.replace(/\s+/g, "");
  const named = englishCurrencyTokens(compact);
  const candidates = [compact, upper, nospace, named, nospace.replace(/-/g, "/"), named.replace(/-/g, "/")];
  for (const key of candidates) {
    const hit = aliasToPair[key];
    if (hit) return hit;
  }
  // Compact ISO forms: USDJPY / USD/JPY / USD-JPY
  for (const iso of [nospace, named]) {
    if (/^[A-Z]{3}\/[A-Z]{3}$/.test(iso) && symbols.includes(iso as Symbol)) return iso as Symbol;
    if (/^[A-Z]{3}-[A-Z]{3}$/.test(iso)) {
      const slash = iso.replace("-", "/");
      if (symbols.includes(slash as Symbol)) return slash as Symbol;
    }
    if (/^[A-Z]{6}$/.test(iso)) {
      const slash = `${iso.slice(0, 3)}/${iso.slice(3)}`;
      if (symbols.includes(slash as Symbol)) return slash as Symbol;
    }
  }
  return null;
}

/** Clear mismatch only when both sides resolve to different supported pairs. Unknown ≠ mismatch. */
export function isPairMismatch(selectedPair: Symbol, detectedRaw: unknown): boolean {
  const canonical = normalizeDetectedPair(detectedRaw);
  return canonical !== null && canonical !== selectedPair;
}

function clampScore(value: unknown, fallback = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function numberList(value: unknown, limit = 6): number[] {
  if (!Array.isArray(value)) return [];
  const out: number[] = [];
  for (const item of value) {
    if (typeof item === "number" && Number.isFinite(item) && out.length < limit) out.push(item);
  }
  return out;
}

function textList(value: unknown, limit = 12, max = 400): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => isText(item, max)).slice(0, limit);
}

export function normalizeChartAnalysis(raw: unknown, selectedPair: Symbol, model: string | null, now = Date.now()): ChartImageAnalysis {
  if (!isRecord(raw)) throw new Error("invalid_ai_response");
  const detectedRaw = isRecord(raw.detected) ? raw.detected : {};
  const trendRaw = isRecord(raw.trend) ? raw.trend : {};
  const structureRaw = isRecord(raw.structure) ? raw.structure : {};
  const levelsRaw = isRecord(raw.levels) ? raw.levels : {};
  const qualityRaw = isRecord(raw.dataQuality) ? raw.dataQuality : {};
  const direction = chartTrendDirections.includes(trendRaw.direction as ChartTrendDirection) ? trendRaw.direction as ChartTrendDirection : "unknown";
  const rawPair = typeof detectedRaw.pair === "string" && detectedRaw.pair.trim() ? detectedRaw.pair.trim().slice(0, 80) : null;
  const mismatch = isPairMismatch(selectedPair, rawPair);
  const warnings = textList(raw.warnings);
  if (mismatch) warnings.unshift("選択通貨ペアと画像内の通貨ペアが一致しません。この画像結果は選択ペアのAI総合判断へ自動統合しません。");
  const patterns = Array.isArray(raw.patterns) ? raw.patterns.flatMap(item => {
    if (!isRecord(item) || !isText(item.name, 80) || !isText(item.description, 400)) return [];
    return [{ name: item.name.trim(), confidence: clampScore(item.confidence), description: item.description.trim() }];
  }).slice(0, 6) : [];
  const indicators = Array.isArray(raw.indicators) ? raw.indicators.flatMap(item => {
    if (!isRecord(item) || !isText(item.name, 80) || !isText(item.interpretation, 400)) return [];
    const value = typeof item.value === "string" || typeof item.value === "number" || item.value === null ? item.value : null;
    if (typeof value === "number" && !Number.isFinite(value)) return [];
    return [{ name: item.name.trim(), value, interpretation: item.interpretation.trim() }];
  }).slice(0, 8) : [];
  const score = clampScore(qualityRaw.score, rawPair || direction !== "unknown" ? 50 : 20);
  return {
    pair: selectedPair,
    detected: {
      // Keep Vision's raw label for UI; mismatch uses canonical comparison separately.
      pair: rawPair,
      timeframe: isText(detectedRaw.timeframe, 40) ? detectedRaw.timeframe.trim() : null,
      chartType: isText(detectedRaw.chartType, 40) ? detectedRaw.chartType.trim() : null,
      currentPrice: isFiniteOrNull(detectedRaw.currentPrice) ? detectedRaw.currentPrice : null,
    },
    trend: {
      direction,
      confidence: clampScore(trendRaw.confidence, direction === "unknown" ? 0 : 40),
      reason: isText(trendRaw.reason, 800) ? trendRaw.reason.trim() : "画像から確認できた範囲の観察です。",
    },
    structure: {
      higherHigh: isBoolOrNull(structureRaw.higherHigh) ? structureRaw.higherHigh : null,
      higherLow: isBoolOrNull(structureRaw.higherLow) ? structureRaw.higherLow : null,
      lowerHigh: isBoolOrNull(structureRaw.lowerHigh) ? structureRaw.lowerHigh : null,
      lowerLow: isBoolOrNull(structureRaw.lowerLow) ? structureRaw.lowerLow : null,
    },
    levels: {
      support: numberList(levelsRaw.support),
      resistance: numberList(levelsRaw.resistance),
    },
    patterns,
    indicators,
    observations: textList(raw.observations),
    warnings,
    dataQuality: {
      score,
      imageReadable: typeof qualityRaw.imageReadable === "boolean" ? qualityRaw.imageReadable : score >= 40,
      pairDetected: typeof qualityRaw.pairDetected === "boolean" ? qualityRaw.pairDetected : !!rawPair,
      timeframeDetected: typeof qualityRaw.timeframeDetected === "boolean" ? qualityRaw.timeframeDetected : isText(detectedRaw.timeframe, 40),
    },
    pairMismatch: mismatch,
    source: "chart_image",
    analyzedAt: new Date(now).toISOString(),
    model,
  };
}

export function canAttachToPairAnalysis(analysis: ChartImageAnalysis | null | undefined, pair: Symbol): analysis is ChartImageAnalysis {
  if (!analysis || analysis.pair !== pair || analysis.pairMismatch || analysis.source !== "chart_image") return false;
  if (!analysis.dataQuality.imageReadable || analysis.dataQuality.score < 40) return false;
  const canonical = normalizeDetectedPair(analysis.detected.pair);
  // Attach when the label confirms the selected pair, or when no pair label was detected.
  if (canonical === pair) return true;
  if (!analysis.detected.pair) return true;
  // Ambiguous/unsupported label: not a hard mismatch, but do not auto-attach.
  return false;
}

export function qualityLabel(score: number): "高" | "中" | "低" {
  return score >= 80 ? "高" : score >= 50 ? "中" : "低";
}
