import "server-only";
import { createChartAnalysisService } from "./service";
import { createChartVision } from "./openai-vision";

const apiKey = process.env.OPENAI_API_KEY?.trim() ?? "";
const model = process.env.OPENAI_CHART_MODEL?.trim() || process.env.OPENAI_ANALYSIS_MODEL?.trim() || "gpt-4.1-mini";

export const analyzeChartImage = createChartAnalysisService({
  apiKey,
  model,
  analyze: createChartVision({ apiKey, model }),
});

export const chartAnalysisModel = model;
