import { AnalysisError, createOpenAICaller } from "./openai";
import { resolveTextProvider, type AiProviderName, type Env } from "./provider";
import type { InterpretCallResult, Interpreter } from "./interpret-types";
import type { AnalysisInput } from "./types";

export type { AiCallMeta, InterpretCallResult, Interpreter } from "./interpret-types";
export { emptyAiMeta } from "./interpret-types";

const FALLBACK_CODES = new Set(["api_error", "rate_limited", "timeout", "invalid_response", "not_configured"]);

function clean(value: string | undefined): string {
  return value?.trim() ?? "";
}

/** OpenAI direct path used only as OpenRouter fallback (or primary when AI_PROVIDER=openai). */
export function resolveOpenAIDirect(env: Env = process.env) {
  const apiKey = clean(env.OPENAI_API_KEY);
  const model = clean(env.OPENAI_ANALYSIS_MODEL) || "gpt-4.1-mini";
  return {
    provider: "openai" as const,
    apiKey,
    model,
    enabled: !!apiKey,
    transport: "responses" as const,
    url: "https://api.openai.com/v1/responses",
  };
}

/**
 * Text interpreter with optional OpenRouter → OpenAI fallback.
 * At most one request per upstream. Never retries the same provider.
 */
export function createTextInterpreter(options: {
  env?: Env;
  fetcher?: typeof fetch;
  timeoutMs?: number;
} = {}): { interpret: Interpreter; enabled: boolean; provider: AiProviderName; model: string } {
  const env = options.env ?? process.env;
  const fetcher = options.fetcher ?? fetch;
  const primary = resolveTextProvider(env);
  const openai = resolveOpenAIDirect(env);
  const openrouterFallbackEnabled = primary.provider === "openrouter" && openai.enabled;

  const primaryCaller = primary.enabled
    ? createOpenAICaller({
      apiKey: primary.apiKey,
      model: primary.model,
      url: primary.url,
      transport: primary.transport,
      provider: primary.provider,
      timeoutMs: options.timeoutMs,
    }, fetcher)
    : null;

  const openaiCaller = (primary.provider === "openai" ? primary.enabled : openrouterFallbackEnabled)
    ? createOpenAICaller({
      apiKey: openai.apiKey,
      model: openai.model,
      url: openai.url,
      transport: openai.transport,
      provider: "openai",
      timeoutMs: options.timeoutMs,
    }, fetcher)
    : null;

  const enabled = !!primaryCaller || (primary.provider === "openrouter" && !!openaiCaller);
  const model = primary.enabled ? primary.model : openai.enabled ? openai.model : "";

  const interpret: Interpreter = async (input: AnalysisInput): Promise<InterpretCallResult> => {
    if (primary.provider === "openai") {
      if (!primaryCaller) throw new AnalysisError("not_configured");
      const result = await primaryCaller(input);
      return {
        interpretation: result.interpretation,
        meta: {
          provider: "openai",
          requestedModel: result.requestedModel,
          actualModel: result.actualModel,
          fallbackUsed: false,
          latencyMs: result.latencyMs,
        },
      };
    }

    // AI_PROVIDER=openrouter
    if (primaryCaller) {
      try {
        const result = await primaryCaller(input);
        return {
          interpretation: result.interpretation,
          meta: {
            provider: "openrouter",
            requestedModel: result.requestedModel,
            actualModel: result.actualModel,
            fallbackUsed: false,
            latencyMs: result.latencyMs,
          },
        };
      } catch (error) {
        const code = error instanceof AnalysisError ? error.code : "api_error";
        if (!openaiCaller || !FALLBACK_CODES.has(code)) throw error;
        // One OpenAI attempt only. Do not re-call OpenRouter.
        const result = await openaiCaller(input);
        return {
          interpretation: result.interpretation,
          meta: {
            provider: "openai",
            requestedModel: primary.model || result.requestedModel,
            actualModel: result.actualModel,
            fallbackUsed: true,
            latencyMs: result.latencyMs,
          },
        };
      }
    }

    if (openaiCaller) {
      const result = await openaiCaller(input);
      return {
        interpretation: result.interpretation,
        meta: {
          provider: "openai",
          requestedModel: primary.model || result.requestedModel,
          actualModel: result.actualModel,
          fallbackUsed: true,
          latencyMs: result.latencyMs,
        },
      };
    }

    throw new AnalysisError("not_configured");
  };

  return { interpret, enabled, provider: primary.provider, model };
}
