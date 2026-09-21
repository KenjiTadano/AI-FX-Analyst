import "server-only";
import { resolveChartProvider } from "../ai/provider";
import { createChartAnalysisService } from "./service";
import { createChartVision } from "./openai-vision";

const provider = resolveChartProvider();

export const analyzeChartImage = createChartAnalysisService({
  apiKey: provider.apiKey,
  model: provider.model,
  provider: provider.provider,
  analyze: createChartVision({
    apiKey: provider.apiKey,
    model: provider.model,
    url: provider.url,
    transport: provider.transport,
    imageCapable: provider.imageCapable,
  }),
});

export const chartAnalysisModel = provider.model;
