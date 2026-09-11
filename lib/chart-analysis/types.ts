import type { Symbol } from "../market/types";

export const chartTrendDirections = ["strong_up", "up", "sideways", "down", "strong_down", "unknown"] as const;
export type ChartTrendDirection = (typeof chartTrendDirections)[number];

export type ChartAnalysisErrorCode =
  | "invalid_file"
  | "unsupported_file"
  | "file_too_large"
  | "invalid_pair"
  | "not_configured"
  | "openai_unavailable"
  | "openai_timeout"
  | "invalid_ai_response"
  | "analysis_failed"
  | "rate_limited";

export interface ChartImageAnalysis {
  pair: Symbol;
  detected: {
    pair: string | null;
    timeframe: string | null;
    chartType: string | null;
    currentPrice: number | null;
  };
  trend: {
    direction: ChartTrendDirection;
    confidence: number;
    reason: string;
  };
  structure: {
    higherHigh: boolean | null;
    higherLow: boolean | null;
    lowerHigh: boolean | null;
    lowerLow: boolean | null;
  };
  levels: {
    support: number[];
    resistance: number[];
  };
  patterns: {
    name: string;
    confidence: number;
    description: string;
  }[];
  indicators: {
    name: string;
    value: string | number | null;
    interpretation: string;
  }[];
  observations: string[];
  warnings: string[];
  dataQuality: {
    score: number;
    imageReadable: boolean;
    pairDetected: boolean;
    timeframeDetected: boolean;
  };
  pairMismatch: boolean;
  source: "chart_image";
  analyzedAt: string;
  model: string | null;
}

export type ChartAnalysisResponse =
  | { ok: true; analysis: ChartImageAnalysis; error: null }
  | { ok: false; analysis: null; error: { code: ChartAnalysisErrorCode; message: string } };

export const chartAnalysisMessages: Record<ChartAnalysisErrorCode, string> = {
  invalid_file: "画像ファイルが無効です。別の画像を選択してください。",
  unsupported_file: "対応形式は PNG / JPEG / WebP のみです。",
  file_too_large: "画像サイズは5MB以下にしてください。",
  invalid_pair: "対応していない通貨ペアです。",
  not_configured: "OPENAI_API_KEYが未設定です。設定後にサーバーを再起動してください。",
  openai_unavailable: "チャート解析AIを取得できません。時間をおいて再試行してください。",
  openai_timeout: "チャート解析がタイムアウトしました。時間をおいて再試行してください。",
  invalid_ai_response: "チャート解析の結果を検証できませんでした。",
  analysis_failed: "チャート解析に失敗しました。",
  rate_limited: "チャート解析の利用上限に達しました。時間をおいて再試行してください。",
};

export const MAX_CHART_IMAGE_BYTES = 5 * 1024 * 1024;
export const ALLOWED_CHART_MIME = ["image/png", "image/jpeg", "image/webp"] as const;
export type AllowedChartMime = (typeof ALLOWED_CHART_MIME)[number];
