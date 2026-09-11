import type { Symbol } from "../market/types";
import { normalizeChartAnalysis } from "./normalize";
import type { AllowedChartMime, ChartAnalysisErrorCode, ChartImageAnalysis } from "./types";

export class ChartVisionError extends Error {
  constructor(public code: ChartAnalysisErrorCode) { super(code); }
}

export const chartVisionPrompt = `あなたはFXチャート画像の観察アシスタントです。売買指示は出さず、画像に見える範囲だけを構造化JSONで報告します。
厳守事項:
- 画像に見えない情報を作らない
- 表示されていないindicatorを推測しない
- 読めない価格を推測しない
- 通貨ペア・時間足を推測しない。読めなければnull
- patternを無理に検出しない。該当なしなら空配列
- support/resistanceは明確な主要帯のみ。自信がない場合は空配列にしてwarningsへ理由を書く
- 撮影時刻を推測しない。チャート内に明示時刻がある場合のみobservationsへ
- ユーザー選択ペアと画像ペアが異なっても、画像上の値をユーザー選択へ上書きしない
- confidenceとdataQuality.scoreは0〜100の整数
- trend.directionは strong_up / up / sideways / down / strong_down / unknown のいずれか`;

const string = { type: "string" };
const nullableString = { type: ["string", "null"] };
const nullableNumber = { type: ["number", "null"] };
const nullableBoolean = { type: ["boolean", "null"] };
const stringList = { type: "array", items: string };
const numberList = { type: "array", items: { type: "number" } };

export const chartAnalysisSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    detected: {
      type: "object", additionalProperties: false,
      properties: {
        pair: nullableString,
        timeframe: nullableString,
        chartType: nullableString,
        currentPrice: nullableNumber,
      },
      required: ["pair", "timeframe", "chartType", "currentPrice"],
    },
    trend: {
      type: "object", additionalProperties: false,
      properties: {
        direction: { type: "string", enum: ["strong_up", "up", "sideways", "down", "strong_down", "unknown"] },
        confidence: { type: "number" },
        reason: string,
      },
      required: ["direction", "confidence", "reason"],
    },
    structure: {
      type: "object", additionalProperties: false,
      properties: {
        higherHigh: nullableBoolean,
        higherLow: nullableBoolean,
        lowerHigh: nullableBoolean,
        lowerLow: nullableBoolean,
      },
      required: ["higherHigh", "higherLow", "lowerHigh", "lowerLow"],
    },
    levels: {
      type: "object", additionalProperties: false,
      properties: { support: numberList, resistance: numberList },
      required: ["support", "resistance"],
    },
    patterns: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        properties: { name: string, confidence: { type: "number" }, description: string },
        required: ["name", "confidence", "description"],
      },
    },
    indicators: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        properties: {
          name: string,
          value: { type: ["string", "number", "null"] },
          interpretation: string,
        },
        required: ["name", "value", "interpretation"],
      },
    },
    observations: stringList,
    warnings: stringList,
    dataQuality: {
      type: "object", additionalProperties: false,
      properties: {
        score: { type: "number" },
        imageReadable: { type: "boolean" },
        pairDetected: { type: "boolean" },
        timeframeDetected: { type: "boolean" },
      },
      required: ["score", "imageReadable", "pairDetected", "timeframeDetected"],
    },
  },
  required: ["detected", "trend", "structure", "levels", "patterns", "indicators", "observations", "warnings", "dataQuality"],
};

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

export function createChartVision(config: { apiKey: string; model: string; timeoutMs?: number }, fetcher: typeof fetch = fetch) {
  return async (input: { pair: Symbol; mime: AllowedChartMime; base64: string }): Promise<ChartImageAnalysis> => {
    if (!config.apiKey) throw new ChartVisionError("not_configured");
    let response: Response;
    try {
      response = await fetcher("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(config.timeoutMs ?? 45_000),
        body: JSON.stringify({
          model: config.model,
          store: false,
          max_output_tokens: 2500,
          input: [{
            role: "user",
            content: [
              { type: "input_text", text: `${chartVisionPrompt}\nユーザー選択通貨ペア: ${input.pair}\n画像に見える範囲だけをJSONで返してください。` },
              { type: "input_image", image_url: `data:${input.mime};base64,${input.base64}` },
            ],
          }],
          text: { format: { type: "json_schema", name: "chart_image_analysis", strict: true, schema: chartAnalysisSchema } },
        }),
      });
    } catch (error) {
      throw new ChartVisionError(error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name) ? "openai_timeout" : "openai_unavailable");
    }
    if (!response.ok) throw new ChartVisionError(response.status === 429 ? "rate_limited" : "openai_unavailable");
    try {
      const body: unknown = await response.json();
      if (!isRecord(body) || body.status !== "completed" || !Array.isArray(body.output)) throw new ChartVisionError("invalid_ai_response");
      const texts: string[] = [];
      for (const item of body.output) {
        if (!isRecord(item) || item.type !== "message" || !Array.isArray(item.content)) continue;
        for (const part of item.content) {
          if (isRecord(part) && part.type === "refusal") throw new ChartVisionError("invalid_ai_response");
          if (isRecord(part) && part.type === "output_text" && typeof part.text === "string") texts.push(part.text);
        }
      }
      if (texts.length !== 1 || texts[0]!.length > 25_000) throw new ChartVisionError("invalid_ai_response");
      return normalizeChartAnalysis(JSON.parse(texts[0]!), input.pair, config.model);
    } catch (error) {
      if (error instanceof ChartVisionError) throw error;
      throw new ChartVisionError("invalid_ai_response");
    }
  };
}
