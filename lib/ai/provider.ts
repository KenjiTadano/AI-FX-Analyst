/** Server-side AI provider selection. Models are never assumed; OpenRouter requires OPENROUTER_MODEL. */

export type AiProviderName = "openai" | "openrouter";
export type AiTransport = "responses" | "chat";

export type TextProviderConfig = {
  provider: AiProviderName;
  apiKey: string;
  model: string;
  enabled: boolean;
  transport: AiTransport;
  url: string;
};

export type ChartProviderConfig = TextProviderConfig & {
  imageCapable: boolean;
};

export type Env = Record<string, string | undefined>;

function clean(value: string | undefined): string {
  return value?.trim() ?? "";
}

export function resolveTextProvider(env: Env = process.env): TextProviderConfig {
  const provider = clean(env.AI_PROVIDER).toLowerCase() === "openrouter" ? "openrouter" : "openai";
  if (provider === "openrouter") {
    const apiKey = clean(env.OPENROUTER_API_KEY);
    const model = clean(env.OPENROUTER_MODEL);
    const base = (clean(env.OPENROUTER_BASE_URL) || "https://openrouter.ai/api/v1").replace(/\/$/, "");
    return {
      provider,
      apiKey,
      model,
      enabled: !!apiKey && !!model,
      transport: "chat",
      url: `${base}/chat/completions`,
    };
  }
  const apiKey = clean(env.OPENAI_API_KEY);
  const model = clean(env.OPENAI_ANALYSIS_MODEL) || "gpt-4.1-mini";
  return {
    provider,
    apiKey,
    model,
    enabled: !!apiKey,
    transport: "responses",
    url: "https://api.openai.com/v1/responses",
  };
}

export function resolveChartProvider(env: Env = process.env): ChartProviderConfig {
  const text = resolveTextProvider(env);
  if (text.provider === "openrouter") {
    const model = clean(env.OPENROUTER_CHART_MODEL);
    return {
      ...text,
      model,
      enabled: !!text.apiKey && !!model,
      imageCapable: !!model,
    };
  }
  const model = clean(env.OPENAI_CHART_MODEL) || text.model;
  return { ...text, model, enabled: !!text.apiKey && !!model, imageCapable: true };
}

export function classifyProviderHttp(status: number): { code: "rate_limited" | "api_error" | "timeout"; detail: string } {
  if (status === 429) return { code: "rate_limited", detail: "http_429" };
  if (status === 408) return { code: "timeout", detail: "http_408" };
  if (status === 401) return { code: "api_error", detail: "http_401" };
  if (status === 402) return { code: "api_error", detail: "http_402" };
  return { code: "api_error", detail: `http_${status}` };
}

/** Bounded recognition only. Callers must not loop on this value. */
export function retryAfterSeconds(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 86_400) return null;
  return seconds;
}
