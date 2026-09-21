import type { AiProviderName } from "./provider";
import type { AnalysisInput, ModelInterpretation } from "./types";

/** Safe server/client metadata. Never include secrets, prompts, or images. */
export type AiCallMeta = {
  provider: AiProviderName;
  requestedModel: string;
  actualModel: string | null;
  fallbackUsed: boolean;
  latencyMs: number;
};

export type InterpretCallResult = {
  interpretation: ModelInterpretation;
  meta: AiCallMeta;
};

export type Interpreter = (input: AnalysisInput) => Promise<InterpretCallResult>;

export function isInterpretCallResult(value: unknown): value is InterpretCallResult {
  return !!value && typeof value === "object" && "interpretation" in value && "meta" in value;
}

export function emptyAiMeta(provider: AiProviderName = "openai", requestedModel = ""): AiCallMeta {
  return { provider, requestedModel, actualModel: null, fallbackUsed: false, latencyMs: 0 };
}
