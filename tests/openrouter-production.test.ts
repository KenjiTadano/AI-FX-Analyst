import test from "node:test";
import assert from "node:assert/strict";
import { AnalysisError, createOpenAI, createOpenAICaller, extractResponseModel } from "../lib/ai/openai";
import { createTextInterpreter, toSafePrimaryFailure } from "../lib/ai/interpret";
import { aiMessage, finalizeAnalysis } from "../lib/ai/engine";
import { resolveChartProvider, resolveTextProvider } from "../lib/ai/provider";
import { buildInput } from "../lib/ai/input";
import { interpretationSchema } from "../lib/ai/openai";

const now = Date.parse("2026-09-21T00:00:00.000Z");
const input = () => buildInput("USD/JPY", null, null, now);

function validJson() {
  return JSON.stringify({
    summary: "テスト要約です。",
    factors: ["technical", "news", "economic", "central_bank", "market_environment"].map(category => ({
      category, title: category, direction: "unknown", impact: "low", reason: "未評価です。", source: "未評価", evidenceIds: [],
    })),
    bullishReasons: ["材料なし"],
    bearishReasons: ["材料なし"],
    riskWarnings: ["テスト"],
    confidence: 40,
    contradictions: false,
    preferWait: true,
    scenarioComment: "条件待ちです。",
    entryTrigger: null,
  });
}

function chatOk(model = "meta-llama/test-actual", text = validJson()) {
  return Response.json({
    id: "gen",
    model,
    choices: [{ message: { role: "assistant", content: text } }],
  });
}

function openAiOk(model = "gpt-4.1-mini") {
  return Response.json({
    status: "completed",
    model,
    output: [{ type: "message", content: [{ type: "output_text", text: validJson() }] }],
  });
}

const fallbackEnv = {
  AI_PROVIDER: "openrouter",
  OPENROUTER_API_KEY: "or-key",
  OPENROUTER_MODEL: "openrouter/free",
  OPENAI_API_KEY: "oa-key",
  OPENAI_ANALYSIS_MODEL: "gpt-4.1-mini",
} as const;

async function interpretWithFallback(openrouterResponse: () => Response | Promise<Response>) {
  const urls: string[] = [];
  const { interpret } = createTextInterpreter({
    env: { ...fallbackEnv },
    fetcher: async (url) => {
      urls.push(String(url));
      if (String(url).includes("openrouter")) return openrouterResponse();
      return openAiOk("gpt-4.1-mini-2025-04-14");
    },
  });
  const result = await interpret(input());
  return { result, urls };
}

test("OpenRouter free requested model is env-driven and never hardcodes Gemini", () => {
  const config = resolveTextProvider({
    AI_PROVIDER: "openrouter",
    OPENROUTER_API_KEY: "sk-or-test",
    OPENROUTER_MODEL: "openrouter/free",
  });
  assert.equal(config.enabled, true);
  assert.equal(config.model, "openrouter/free");
  assert.equal(config.model.includes("gemini"), false);
  assert.equal(JSON.stringify(interpretationSchema).includes("gemini"), false);
});

test("actual model metadata is captured from OpenRouter response.model", async () => {
  const call = createOpenAICaller({
    apiKey: "k",
    model: "openrouter/free",
    url: "https://openrouter.ai/api/v1/chat/completions",
    transport: "chat",
    provider: "openrouter",
  }, async () => chatOk("vendor/actual-routed-model"));
  const result = await call(input());
  assert.equal(result.requestedModel, "openrouter/free");
  assert.equal(result.actualModel, "vendor/actual-routed-model");
  assert.equal(extractResponseModel({ model: "vendor/actual-routed-model" }), "vendor/actual-routed-model");
});

test("OpenRouter success returns validated interpretation", async () => {
  const interpret = createOpenAI({
    apiKey: "k",
    model: "openrouter/free",
    url: "https://openrouter.ai/api/v1/chat/completions",
    transport: "chat",
  }, async () => chatOk());
  const parsed = await interpret(input());
  assert.equal(parsed.preferWait, true);
  assert.equal(parsed.confidence, 40);
});

test("OpenRouter 402 is distinguished without auto retry", async () => {
  let calls = 0;
  const interpret = createOpenAI({
    apiKey: "SECRET",
    model: "openrouter/free",
    url: "https://openrouter.ai/api/v1/chat/completions",
    transport: "chat",
  }, async () => {
    calls += 1;
    return new Response("no", { status: 402, headers: { "retry-after": "20" } });
  });
  await assert.rejects(interpret(input()), (error: unknown) => {
    assert.ok(error instanceof AnalysisError);
    assert.equal(error.code, "api_error");
    assert.match(error.detail ?? "", /http_402:retry_after_20/);
    assert.equal((error.detail ?? "").includes("SECRET"), false);
    return true;
  });
  assert.equal(calls, 1);
  assert.match(aiMessage("api_error", "openrouter", "http_402:retry_after_20"), /利用枠または課金/);
});

test("OpenRouter 429 keeps Retry-After without auto retry", async () => {
  let calls = 0;
  const interpret = createOpenAI({
    apiKey: "SECRET",
    model: "openrouter/free",
    url: "https://openrouter.ai/api/v1/chat/completions",
    transport: "chat",
  }, async () => {
    calls += 1;
    return new Response("no", { status: 429, headers: { "retry-after": "15" } });
  });
  await assert.rejects(interpret(input()), (error: unknown) => {
    assert.ok(error instanceof AnalysisError);
    assert.equal(error.code, "rate_limited");
    assert.match(error.detail ?? "", /http_429:retry_after_15/);
    return true;
  });
  assert.equal(calls, 1);
  assert.match(aiMessage("rate_limited", "openrouter", "http_429:retry_after_15"), /約15秒後/);
  assert.match(aiMessage("rate_limited", "openrouter", "http_429:retry_after_15"), /自動再試行はしません/);
});

test("OpenRouter timeout fails closed once", async () => {
  const interpret = createOpenAI({
    apiKey: "k",
    model: "openrouter/free",
    url: "https://openrouter.ai/api/v1/chat/completions",
    transport: "chat",
    timeoutMs: 5,
  }, async (_url, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("timeout", "TimeoutError")), { once: true });
    setTimeout(() => reject(new Error("failed to abort")), 50);
  }));
  await assert.rejects(interpret(input()), (error: unknown) => error instanceof AnalysisError && error.code === "timeout");
});

test("invalid structured response is not repaired into BUY/SELL", async () => {
  const interpret = createOpenAI({
    apiKey: "k",
    model: "openrouter/free",
    url: "https://openrouter.ai/api/v1/chat/completions",
    transport: "chat",
  }, async () => chatOk("m", JSON.stringify({ summary: "x", action: "BUY" })));
  await assert.rejects(interpret(input()), (error: unknown) => {
    assert.ok(error instanceof AnalysisError);
    assert.equal(error.code, "invalid_response");
    return true;
  });
});

test("OpenRouter failure falls back to OpenAI at most once", async () => {
  const { result, urls } = await interpretWithFallback(() => new Response("SECRET-BODY", { status: 402, headers: { "retry-after": "20", "x-request-id": "abc" } }));
  assert.equal(urls.length, 2);
  assert.ok(urls[0]!.includes("openrouter"));
  assert.ok(urls[1]!.includes("api.openai.com"));
  assert.equal(result.meta.fallbackUsed, true);
  assert.equal(result.meta.provider, "openai");
  assert.equal(result.meta.requestedModel, "openrouter/free");
  assert.equal(result.meta.actualModel, "gpt-4.1-mini-2025-04-14");
  assert.deepEqual(result.meta.primaryFailure, { reason: "api_error", httpStatus: 402, retryAfterSeconds: 20 });
  assert.equal(JSON.stringify(result.meta).includes("SECRET-BODY"), false);
  assert.equal(JSON.stringify(result.meta).includes("x-request-id"), false);
  assert.equal(result.interpretation.preferWait, true);
});

test("402 fallback reason is visible in finalize details meta", async () => {
  const { result } = await interpretWithFallback(() => new Response("no", { status: 402, headers: { "retry-after": "30" } }));
  const analysis = finalizeAnalysis(input(), result.interpretation, "openrouter/free", null, now, "openrouter", result.meta);
  assert.equal(analysis.ai.fallbackUsed, true);
  assert.deepEqual(analysis.ai.primaryFailure, { reason: "api_error", httpStatus: 402, retryAfterSeconds: 30 });
});

test("429 fallback reason includes Retry-After", async () => {
  const { result, urls } = await interpretWithFallback(() => new Response("no", { status: 429, headers: { "retry-after": "120" } }));
  assert.equal(urls.length, 2);
  assert.deepEqual(result.meta.primaryFailure, { reason: "rate_limited", httpStatus: 429, retryAfterSeconds: 120 });
});

test("timeout fallback reason", async () => {
  const { result, urls } = await interpretWithFallback(async () => {
    throw new DOMException("timeout", "TimeoutError");
  });
  assert.equal(urls.length, 2);
  assert.deepEqual(result.meta.primaryFailure, { reason: "timeout", httpStatus: null, retryAfterSeconds: null });
});

test("invalid_response fallback reason", async () => {
  const { result, urls } = await interpretWithFallback(() => chatOk("m", JSON.stringify({ summary: "x", action: "BUY" })));
  assert.equal(urls.length, 2);
  assert.equal(result.meta.primaryFailure?.reason, "invalid_response");
  assert.equal(result.meta.primaryFailure?.httpStatus, null);
  assert.equal(JSON.stringify(result.meta.primaryFailure).includes("BUY"), false);
});

test("not_configured fallback reason", async () => {
  let openaiCalls = 0;
  const { interpret } = createTextInterpreter({
    env: {
      AI_PROVIDER: "openrouter",
      OPENROUTER_API_KEY: "",
      OPENROUTER_MODEL: "",
      OPENAI_API_KEY: "oa-key",
      OPENAI_ANALYSIS_MODEL: "gpt-4.1-mini",
    },
    fetcher: async () => {
      openaiCalls += 1;
      return openAiOk();
    },
  });
  const result = await interpret(input());
  assert.equal(openaiCalls, 1);
  assert.equal(result.meta.fallbackUsed, true);
  assert.deepEqual(result.meta.primaryFailure, { reason: "not_configured", httpStatus: null, retryAfterSeconds: null });
});

test("OpenRouter success does not call OpenAI", async () => {
  const urls: string[] = [];
  const { interpret } = createTextInterpreter({
    env: { ...fallbackEnv },
    fetcher: async (url) => {
      urls.push(String(url));
      return chatOk("routed/model-a");
    },
  });
  const result = await interpret(input());
  assert.equal(urls.length, 1);
  assert.ok(urls[0]!.includes("openrouter"));
  assert.equal(result.meta.fallbackUsed, false);
  assert.equal(result.meta.provider, "openrouter");
  assert.equal(result.meta.actualModel, "routed/model-a");
  assert.equal(result.meta.primaryFailure, null);
  const analysis = finalizeAnalysis(input(), result.interpretation, "openrouter/free", null, now, "openrouter", result.meta);
  assert.equal(analysis.ai.primaryFailure, null);
});

test("missing OpenRouter config stays unavailable unless OpenAI fallback is configured", async () => {
  const none = createTextInterpreter({
    env: { AI_PROVIDER: "openrouter", OPENROUTER_API_KEY: "", OPENROUTER_MODEL: "" },
    fetcher: async () => { throw new Error("network"); },
  });
  assert.equal(none.enabled, false);
  await assert.rejects(none.interpret(input()), (error: unknown) => error instanceof AnalysisError && error.code === "not_configured");

  let openaiCalls = 0;
  const withOpenAI = createTextInterpreter({
    env: {
      AI_PROVIDER: "openrouter",
      OPENROUTER_API_KEY: "",
      OPENROUTER_MODEL: "",
      OPENAI_API_KEY: "oa-key",
      OPENAI_ANALYSIS_MODEL: "gpt-4.1-mini",
    },
    fetcher: async () => {
      openaiCalls += 1;
      return openAiOk();
    },
  });
  assert.equal(withOpenAI.enabled, true);
  const result = await withOpenAI.interpret(input());
  assert.equal(openaiCalls, 1);
  assert.equal(result.meta.fallbackUsed, true);
  assert.equal(result.meta.provider, "openai");
  assert.equal(result.meta.primaryFailure?.reason, "not_configured");
});

test("toSafePrimaryFailure never exposes secrets or raw bodies", () => {
  const failure = toSafePrimaryFailure(new AnalysisError("api_error", "http_402:retry_after_20:sk-secret-leak"));
  assert.deepEqual(failure, { reason: "api_error", httpStatus: null, retryAfterSeconds: null });
  const ok = toSafePrimaryFailure(new AnalysisError("rate_limited", "http_429:retry_after_15"));
  assert.deepEqual(ok, { reason: "rate_limited", httpStatus: 429, retryAfterSeconds: 15 });
});

test("chart model missing keeps imageCapable false", () => {
  const config = resolveChartProvider({
    AI_PROVIDER: "openrouter",
    OPENROUTER_API_KEY: "k",
    OPENROUTER_MODEL: "openrouter/free",
  });
  assert.equal(config.imageCapable, false);
  assert.equal(config.enabled, false);
  assert.equal(config.model, "");
});

test("secrets are not exposed in errors or finalize messages", async () => {
  const interpret = createOpenAI({
    apiKey: "SECRET-KEY-VALUE",
    model: "openrouter/free",
    url: "https://openrouter.ai/api/v1/chat/completions",
    transport: "chat",
  }, async () => new Response("SECRET-KEY-VALUE", { status: 500 }));
  await assert.rejects(interpret(input()), (error: unknown) => {
    assert.ok(error instanceof AnalysisError);
    assert.equal(JSON.stringify(error).includes("SECRET-KEY-VALUE"), false);
    return true;
  });
  const message = aiMessage("not_configured", "openrouter");
  assert.equal(message.includes("OPENROUTER_API_KEY"), false);
  assert.equal(message.includes("SECRET"), false);
});

test("AI unavailable remains separate from market WAIT", () => {
  const analysis = finalizeAnalysis(input(), null, "openrouter/free", "api_error", now, "openrouter", {
    provider: "openrouter",
    requestedModel: "openrouter/free",
    detail: "http_402",
  });
  assert.equal(analysis.action, "WAIT");
  assert.equal(analysis.ai.status, "error");
  assert.equal(analysis.ai.code, "api_error");
  assert.match(analysis.ai.message ?? "", /利用枠または課金/);
  assert.equal(analysis.summary.includes("AIがWAITと判断"), false);
  assert.equal(analysis.ai.provider, "openrouter");
  assert.equal(analysis.ai.requestedModel, "openrouter/free");
});
