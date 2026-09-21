import type { AiProviderName } from "./provider";
import type { AnalysisInput, ModelInterpretation } from "./types";

/** Allowed primary-failure categories only. Never include raw upstream bodies/headers. */
export type PrimaryFailureReason = "api_error" | "rate_limited" | "timeout" | "invalid_response" | "not_configured";

/** Client-safe OpenRouter primary failure summary (shown only when fallbackUsed). */
export type PrimaryFailureMeta = {
  reason: PrimaryFailureReason;
  httpStatus: number | null;
  retryAfterSeconds: number | null;
};

/** Safe server/client metadata. Never include secrets, prompts, or images. */
export type AiCallMeta = {
  provider: AiProviderName;
  requestedModel: string;
  actualModel: string | null;
  fallbackUsed: boolean;
  latencyMs: number;
  /** Present only for OpenRouter → OpenAI fallback. Null on primary success. */
  primaryFailure?: PrimaryFailureMeta | null;
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
  return { provider, requestedModel, actualModel: null, fallbackUsed: false, latencyMs: 0, primaryFailure: null };
}
