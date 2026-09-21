import type { Symbol } from "../market/types";
import type { AiProviderName } from "../ai/provider";
import { ChartVisionError, createChartVision } from "./openai-vision";
import { chartAnalysisMessages, chartNotConfiguredMessage, type AllowedChartMime, type ChartAnalysisResponse } from "./types";
import { validateChartUpload } from "./validate";

export function createChartAnalysisService(deps: {
  apiKey: string;
  model: string;
  provider?: AiProviderName;
  analyze?: ReturnType<typeof createChartVision>;
  now?: () => number;
}) {
  const analyze = deps.analyze ?? createChartVision({ apiKey: deps.apiKey, model: deps.model });
  return async (input: { pair: unknown; bytes: Uint8Array; mimeHint?: string | null; filename?: string | null }): Promise<ChartAnalysisResponse> => {
    const validated = validateChartUpload(input);
    if (!validated.ok) return { ok: false, analysis: null, error: { code: validated.code, message: chartAnalysisMessages[validated.code] } };
    if (!deps.apiKey) return { ok: false, analysis: null, error: { code: "not_configured", message: chartNotConfiguredMessage(deps.provider ?? "openai") } };
    try {
      const base64 = Buffer.from(input.bytes).toString("base64");
      const analysis = await analyze({ pair: validated.pair, mime: validated.mime, base64 });
      return { ok: true, analysis, error: null };
    } catch (error) {
      const code = error instanceof ChartVisionError ? error.code : "analysis_failed";
      const detail = error instanceof ChartVisionError ? error.detail ?? null : null;
      return { ok: false, analysis: null, error: { code, message: chartAnalysisMessages[code], detail } };
    }
  };
}

export function toBase64DataUrl(bytes: Uint8Array, mime: AllowedChartMime): string {
  return `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
}

export type ChartServicePair = Symbol;
