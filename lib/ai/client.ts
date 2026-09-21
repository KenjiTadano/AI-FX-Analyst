import "server-only";
import { getMarketData } from "../market/client";
import { getFundamentalData } from "../fundamental/client";
import type { ChartImageAnalysis } from "../chart-analysis/types";
import type { Symbol } from "../market/types";
import { createOpenAI } from "./openai";
import { resolveTextProvider } from "./provider";
import { createAnalysisService } from "./service";
import type { AnalysisResponse } from "./types";

const provider = resolveTextProvider();
const limit = (value: string | undefined, fallback: number) => value && /^\d+$/.test(value) ? Math.max(1, Math.min(1000, Number(value))) : fallback;
const service = createAnalysisService({
  market: getMarketData, fundamental: getFundamentalData,
  interpret: createOpenAI({ apiKey: provider.apiKey, model: provider.model, url: provider.url, transport: provider.transport }),
  enabled: provider.enabled,
  model: provider.model,
  provider: provider.provider,
  hourlyLimit: limit(process.env.AI_ANALYSIS_HOURLY_LIMIT, 20), dailyLimit: limit(process.env.AI_ANALYSIS_DAILY_LIMIT, 100),
});
export function getAnalysis(pair: Symbol, chartImageAnalysis?: ChartImageAnalysis | null): Promise<AnalysisResponse> {
  return service(pair, chartImageAnalysis);
}
