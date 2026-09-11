import "server-only";
import { getMarketData } from "../market/client";
import { getFundamentalData } from "../fundamental/client";
import type { ChartImageAnalysis } from "../chart-analysis/types";
import type { Symbol } from "../market/types";
import { createOpenAI } from "./openai";
import { createAnalysisService } from "./service";
import type { AnalysisResponse } from "./types";

const apiKey = process.env.OPENAI_API_KEY?.trim() ?? "";
const model = process.env.OPENAI_ANALYSIS_MODEL?.trim() || "gpt-4.1-mini";
const limit = (value: string | undefined, fallback: number) => value && /^\d+$/.test(value) ? Math.max(1, Math.min(1000, Number(value))) : fallback;
const service = createAnalysisService({
  market: getMarketData, fundamental: getFundamentalData,
  interpret: createOpenAI({ apiKey, model }), enabled: !!apiKey, model,
  hourlyLimit: limit(process.env.AI_ANALYSIS_HOURLY_LIMIT, 20), dailyLimit: limit(process.env.AI_ANALYSIS_DAILY_LIMIT, 100),
});
export function getAnalysis(pair: Symbol, chartImageAnalysis?: ChartImageAnalysis | null): Promise<AnalysisResponse> {
  return service(pair, chartImageAnalysis);
}
