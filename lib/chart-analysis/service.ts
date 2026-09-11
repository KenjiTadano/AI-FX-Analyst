import type { Symbol } from "../market/types";
import { ChartVisionError, createChartVision } from "./openai-vision";
import { chartAnalysisMessages, type AllowedChartMime, type ChartAnalysisResponse } from "./types";
import { validateChartUpload } from "./validate";

export function createChartAnalysisService(deps: {
  apiKey: string;
  model: string;
  analyze?: ReturnType<typeof createChartVision>;
  now?: () => number;
}) {
  const analyze = deps.analyze ?? createChartVision({ apiKey: deps.apiKey, model: deps.model });
  return async (input: { pair: unknown; bytes: Uint8Array; mimeHint?: string | null; filename?: string | null }): Promise<ChartAnalysisResponse> => {
    const validated = validateChartUpload(input);
    if (!validated.ok) return { ok: false, analysis: null, error: { code: validated.code, message: chartAnalysisMessages[validated.code] } };
    if (!deps.apiKey) return { ok: false, analysis: null, error: { code: "not_configured", message: chartAnalysisMessages.not_configured } };
    try {
      const base64 = Buffer.from(input.bytes).toString("base64");
      const analysis = await analyze({ pair: validated.pair, mime: validated.mime, base64 });
      return { ok: true, analysis, error: null };
    } catch (error) {
      const code = error instanceof ChartVisionError ? error.code : "analysis_failed";
      return { ok: false, analysis: null, error: { code, message: chartAnalysisMessages[code] } };
    }
  };
}

export function toBase64DataUrl(bytes: Uint8Array, mime: AllowedChartMime): string {
  return `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
}

export type ChartServicePair = Symbol;
