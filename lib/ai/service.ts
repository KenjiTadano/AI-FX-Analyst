import type { MarketData, Symbol } from "../market/types";
import type { FundamentalData } from "../fundamental/types";
import { buildInput } from "./input";
import { finalizeAnalysis } from "./engine";
import { AnalysisError, validateInterpretation } from "./openai";
import type { AIAnalysis, AnalysisInput, AnalysisResponse, ModelInterpretation } from "./types";

export interface AnalysisDependencies {
  market(pair: Symbol): Promise<MarketData>;
  fundamental(pair: Symbol): Promise<FundamentalData>;
  interpret(input: AnalysisInput): Promise<ModelInterpretation>;
  model: string;
  enabled: boolean;
  now?: () => number;
  hourlyLimit?: number;
  dailyLimit?: number;
  // Future reanalysis policy can supply a market revision without changing cache internals.
  revision?: () => string;
}
export function createAnalysisService(deps: AnalysisDependencies) {
  const now = deps.now ?? Date.now;
  const cache = new Map<Symbol, { data: AIAnalysis; revision: string }>();
  const pending = new Map<Symbol, Promise<AnalysisResponse>>();
  let calls: number[] = [];
  return async (pair: Symbol): Promise<AnalysisResponse> => {
    const cached = cache.get(pair);
    const revision = deps.revision?.() ?? "v1";
    if (cached && cached.revision === revision && Date.parse(cached.data.expiresAt) > now()) return { success: true, data: cached.data, error: null, cached: true };
    const underway = pending.get(pair);
    if (underway) return underway;
    const task = (async (): Promise<AnalysisResponse> => {
      const results = await Promise.allSettled([Promise.resolve().then(() => deps.market(pair)), Promise.resolve().then(() => deps.fundamental(pair))]);
      const input = buildInput(pair, results[0].status === "fulfilled" ? results[0].value : null, results[1].status === "fulfilled" ? results[1].value : null, now());
      let interpretation: ModelInterpretation | null = null;
      let error: AnalysisError["code"] | null = null;
      try {
        if (!deps.enabled) throw new AnalysisError("not_configured");
        if (!input.technicalAnalysis.ready) throw new AnalysisError("insufficient_data");
        const time = now();
        calls = calls.filter(at => time - at < 86_400_000);
        if (calls.length >= (deps.dailyLimit ?? 100) || calls.filter(at => time - at < 3_600_000).length >= (deps.hourlyLimit ?? 20)) throw new AnalysisError("rate_limited");
        calls.push(time);
        interpretation = validateInterpretation(await deps.interpret(input), input);
      } catch (caught) { error = caught instanceof AnalysisError ? caught.code : "api_error"; }
      const data = finalizeAnalysis(input, interpretation, deps.model, error, now());
      cache.set(pair, { data, revision });
      return { success: true, data, error: null, cached: false };
    })();
    pending.set(pair, task);
    try { return await task; } finally { pending.delete(pair); }
  };
}
