import test from "node:test";
import assert from "node:assert/strict";
import { AnalysisError, createOpenAI } from "../lib/ai/openai";
import { aiMessage, finalizeAnalysis } from "../lib/ai/engine";
import { classifyProviderHttp, resolveChartProvider, resolveTextProvider, retryAfterSeconds } from "../lib/ai/provider";
import { ChartVisionError, createChartVision } from "../lib/chart-analysis/openai-vision";
import { chartNotConfiguredMessage } from "../lib/chart-analysis/types";
import { buildInput } from "../lib/ai/input";

const input = () => buildInput("USD/JPY", null, null, Date.parse("2026-09-21T00:00:00.000Z"));

test("openrouter requires model and does not call the network without it", () => {
  const config = resolveTextProvider({ AI_PROVIDER: "openrouter", OPENROUTER_API_KEY: "secret-key" });
  assert.equal(config.enabled, false);
  assert.equal(config.model, "");
  assert.equal(config.url, "https://openrouter.ai/api/v1/chat/completions");
});

test("openrouter chart without image model is not image capable", () => {
  const config = resolveChartProvider({ AI_PROVIDER: "openrouter", OPENROUTER_API_KEY: "k", OPENROUTER_MODEL: "vendor/model" });
  assert.equal(config.imageCapable, false);
  assert.equal(config.enabled, false);
});

test("401 402 429 are classified without reading a body", () => {
  assert.equal(classifyProviderHttp(401).detail, "http_401");
  assert.equal(classifyProviderHttp(402).detail, "http_402");
  assert.equal(classifyProviderHttp(429).code, "rate_limited");
  assert.equal(classifyProviderHttp(503).detail, "http_503");
  assert.equal(retryAfterSeconds("12"), 12);
  assert.equal(retryAfterSeconds("soon"), null);
});

test("provider errors do not retry and do not invent a signal", async () => {
  let calls = 0;
  const interpret = createOpenAI({
    apiKey: "SECRET",
    model: "vendor/model",
    url: "https://openrouter.ai/api/v1/chat/completions",
    transport: "chat",
  }, async () => {
    calls += 1;
    return new Response("no", { status: 402, headers: { "retry-after": "30" } });
  });
  await assert.rejects(interpret(input()), (error: unknown) => {
    assert.ok(error instanceof AnalysisError);
    assert.equal(error.code, "api_error");
    assert.match(error.detail ?? "", /http_402:retry_after_30/);
    assert.equal((error.detail ?? "").includes("SECRET"), false);
    return true;
  });
  assert.equal(calls, 1);
});

test("image-incapable chart model does not fetch", async () => {
  let calls = 0;
  const analyze = createChartVision({ apiKey: "k", model: "text-only", imageCapable: false }, async () => {
    calls += 1;
    return new Response("{}", { status: 200 });
  });
  await assert.rejects(analyze({ pair: "USD/JPY", mime: "image/png", base64: "aa" }));
  assert.equal(calls, 0);
});

test("OpenAI missing config uses OpenAI-facing message without env names", () => {
  const message = aiMessage("not_configured", "openai");
  assert.match(message, /OpenAI API設定が不足/);
  assert.equal(message.includes("OPENAI_API_KEY"), false);
  assert.equal(message.includes("OPENROUTER"), false);
  assert.match(chartNotConfiguredMessage("openai"), /OpenAI API設定が不足/);
  assert.equal(chartNotConfiguredMessage("openai").includes("OPENAI_API_KEY"), false);
});

test("OpenRouter missing config uses OpenRouter-facing message without env names", () => {
  const message = aiMessage("not_configured", "openrouter");
  assert.match(message, /OpenRouter API設定が不足/);
  assert.equal(message.includes("OPENROUTER_API_KEY"), false);
  assert.equal(message.includes("OPENAI_API_KEY"), false);
  assert.match(chartNotConfiguredMessage("openrouter"), /OpenRouter API設定が不足/);
  const analysis = finalizeAnalysis(input(), null, "", "not_configured", Date.parse("2026-09-21T00:00:00.000Z"), "openrouter");
  assert.match(analysis.ai.message ?? "", /OpenRouter API設定が不足/);
});

test("chart 402 and 429 keep Retry-After in detail without auto retry", async () => {
  for (const [status, code, detail] of [
    [402, "openai_unavailable", /http_402:retry_after_45/],
    [429, "rate_limited", /http_429:retry_after_12/],
  ] as const) {
    let calls = 0;
    const analyze = createChartVision({ apiKey: "SECRET", model: "vision-model" }, async () => {
      calls += 1;
      return new Response("no", {
        status,
        headers: { "retry-after": status === 402 ? "45" : "12" },
      });
    });
    await assert.rejects(analyze({ pair: "USD/JPY", mime: "image/png", base64: "aa" }), (error: unknown) => {
      assert.ok(error instanceof ChartVisionError);
      assert.equal(error.code, code);
      assert.match(error.detail ?? "", detail);
      assert.equal((error.detail ?? "").includes("SECRET"), false);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test("AI unavailable keeps Action WAIT as a separate state", () => {
  const analysis = finalizeAnalysis(input(), null, "TEST", "not_configured", Date.parse("2026-09-21T00:00:00.000Z"), "openai");
  assert.equal(analysis.action, "WAIT");
  assert.equal(analysis.ai.status, "unavailable");
  assert.equal(analysis.ai.code, "not_configured");
  assert.match(analysis.summary, /AI統合は未取得/);
  assert.equal(analysis.summary.includes("AIがWAITと判断"), false);
  assert.match(analysis.ai.message ?? "", /OpenAI API設定が不足/);
});
