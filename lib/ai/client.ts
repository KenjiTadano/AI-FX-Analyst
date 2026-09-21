import "server-only";
import { getMarketData } from "../market/client";
import { getFundamentalData } from "../fundamental/client";
import type { ChartImageAnalysis } from "../chart-analysis/types";
import type { Symbol } from "../market/types";
import { createTextInterpreter } from "./interpret";
import { createAnalysisService } from "./service";
import type { AnalysisResponse } from "./types";

const limit = (value: string | undefined, fallback: number) => value && /^\d+$/.test(value) ? Math.max(1, Math.min(1000, Number(value))) : fallback;
const text = createTextInterpreter();
const service = createAnalysisService({
  market: getMarketData, fundamental: getFundamentalData,
  interpret: text.interpret,
  enabled: text.enabled,
  model: text.model,
  provider: text.provider,
  hourlyLimit: limit(process.env.AI_ANALYSIS_HOURLY_LIMIT, 20), dailyLimit: limit(process.env.AI_ANALYSIS_DAILY_LIMIT, 100),
});
export function getAnalysis(pair: Symbol, chartImageAnalysis?: ChartImageAnalysis | null): Promise<AnalysisResponse> {
  return service(pair, chartImageAnalysis);
}
