import test from "node:test";
import assert from "node:assert/strict";
import { detectImageMime, normalizePair, validateChartUpload } from "../lib/chart-analysis/validate";
import { canAttachToPairAnalysis, isPairMismatch, normalizeChartAnalysis, normalizeDetectedPair, qualityLabel } from "../lib/chart-analysis/normalize";
import { ChartVisionError, chartVisionPrompt, createChartVision } from "../lib/chart-analysis/openai-vision";
import { createChartAnalysisService } from "../lib/chart-analysis/service";
import { buildInput } from "../lib/ai/input";
import { systemPrompt } from "../lib/ai/openai";
import type { ChartImageAnalysis } from "../lib/chart-analysis/types";

const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
const webp = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
const pdf = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0, 0, 0, 0]);

function sampleRaw(overrides: Record<string, unknown> = {}) {
  return {
    detected: { pair: "USD/JPY", timeframe: "4H", chartType: "candlestick", currentPrice: 153.2 },
    trend: { direction: "down", confidence: 82, reason: "高値切り下げが見える" },
    structure: { higherHigh: false, higherLow: false, lowerHigh: true, lowerLow: true },
    levels: { support: [152.8, 152.2], resistance: [154.1] },
    patterns: [{ name: "Descending Channel", confidence: 70, description: "下降チャネルに見える" }],
    indicators: [{ name: "SMA", value: "20", interpretation: "価格が下側" }],
    observations: ["押し目の戻りが弱い"],
    warnings: [],
    dataQuality: { score: 85, imageReadable: true, pairDetected: true, timeframeDetected: true },
    ...overrides,
  };
}

function analysis(partial: Partial<ChartImageAnalysis> = {}): ChartImageAnalysis {
  return {
    ...normalizeChartAnalysis(sampleRaw(), "USD/JPY", "gpt-4.1-mini", Date.parse("2026-09-11T12:00:00Z")),
    ...partial,
  };
}

test("detects png jpeg webp and rejects pdf empty", () => {
  assert.equal(detectImageMime(png), "image/png");
  assert.equal(detectImageMime(jpeg), "image/jpeg");
  assert.equal(detectImageMime(webp), "image/webp");
  assert.equal(detectImageMime(pdf), null);
  assert.equal(detectImageMime(new Uint8Array()), null);
});

test("pair normalization accepts slash and compact forms", () => {
  assert.equal(normalizePair("USD/JPY"), "USD/JPY");
  assert.equal(normalizePair("usdjpy"), "USD/JPY");
  assert.equal(normalizePair("EURUSD"), null);
});

for (const [label, bytes, mime, code] of [
  ["png", png, "image/png", null],
  ["jpeg", jpeg, "image/jpeg", null],
  ["webp", webp, "image/webp", null],
  ["pdf", pdf, "application/pdf", "unsupported_file"],
  ["svg mime", png, "image/svg+xml", "unsupported_file"],
  ["empty", new Uint8Array(), "image/png", "invalid_file"],
] as const) {
  test(`upload validation ${label}`, () => {
    const result = validateChartUpload({ pair: "USD/JPY", bytes, mimeHint: mime, filename: `chart.${label}` });
    if (code) {
      assert.equal(result.ok, false);
      assert.equal(!result.ok && result.code, code);
    } else {
      assert.equal(result.ok, true);
    }
  });
}

test("rejects oversized files and invalid pairs", () => {
  const big = new Uint8Array(5 * 1024 * 1024 + 1);
  big.set(png.slice(0, 8));
  assert.equal(validateChartUpload({ pair: "USD/JPY", bytes: big, mimeHint: "image/png" }).ok, false);
  assert.equal(validateChartUpload({ pair: "EUR/USD", bytes: png, mimeHint: "image/png" }).ok, false);
});

test("normalizes chart analysis and preserves unknowns", () => {
  const result = normalizeChartAnalysis(sampleRaw({
    detected: { pair: "USDJPY", timeframe: null, chartType: null, currentPrice: null },
    patterns: [],
    indicators: [],
    structure: { higherHigh: null, higherLow: null, lowerHigh: null, lowerLow: null },
  }), "USD/JPY", "TEST");
  assert.equal(result.detected.pair, "USDJPY");
  assert.equal(result.pairMismatch, false);
  assert.equal(result.detected.timeframe, null);
  assert.equal(result.structure.higherHigh, null);
  assert.deepEqual(result.patterns, []);
  assert.equal(result.source, "chart_image");
  assert.equal(qualityLabel(85), "高");
  assert.equal(qualityLabel(55), "中");
  assert.equal(qualityLabel(20), "低");
});

test("pair aliases match and clear mismatches use canonical pairs", () => {
  for (const [selected, detected] of [
    ["USD/JPY", "USD/JPY"],
    ["USD/JPY", "USDJPY"],
    ["USD/JPY", "USD-JPY"],
    ["USD/JPY", "米ドル/円"],
    ["USD/JPY", "ドル円"],
    ["USD/JPY", "US Dollar / Japanese Yen"],
    ["EUR/JPY", "ユーロ/円"],
    ["GBP/JPY", "ポンド/円"],
  ] as const) {
    const result = normalizeChartAnalysis(sampleRaw({ detected: { pair: detected, timeframe: "1H", chartType: "candle", currentPrice: 150 } }), selected, "TEST");
    assert.equal(result.pairMismatch, false, `${selected} vs ${detected}`);
    assert.equal(normalizeDetectedPair(detected), selected);
    assert.equal(canAttachToPairAnalysis(result, selected), true, `attach ${selected} vs ${detected}`);
  }
  for (const [selected, detected] of [
    ["USD/JPY", "EUR/JPY"],
    ["USD/JPY", "ユーロ/円"],
    ["EUR/JPY", "ドル円"],
  ] as const) {
    const result = normalizeChartAnalysis(sampleRaw({ detected: { pair: detected, timeframe: "1H", chartType: "candle", currentPrice: 1 } }), selected, "TEST");
    assert.equal(result.pairMismatch, true, `${selected} vs ${detected}`);
    assert.equal(canAttachToPairAnalysis(result, selected), false);
  }
});

test("unknown detected pair is not a hard mismatch and does not auto-attach", () => {
  assert.equal(normalizeDetectedPair("EUR/USD"), null);
  assert.equal(normalizeDetectedPair("不明ペア"), null);
  assert.equal(isPairMismatch("USD/JPY", "EUR/USD"), false);
  assert.equal(isPairMismatch("USD/JPY", null), false);
  const result = normalizeChartAnalysis(sampleRaw({ detected: { pair: "EUR/USD", timeframe: "1H", chartType: "candle", currentPrice: 1.1 } }), "USD/JPY", "TEST");
  assert.equal(result.pairMismatch, false);
  assert.equal(result.detected.pair, "EUR/USD");
  assert.equal(canAttachToPairAnalysis(result, "USD/JPY"), false);
  assert.ok(!result.warnings.some(item => item.includes("一致しません")));
});

test("pair mismatch warns and blocks AI auto attach", () => {
  const result = normalizeChartAnalysis(sampleRaw({ detected: { pair: "EUR/JPY", timeframe: "1H", chartType: "candle", currentPrice: 160 } }), "USD/JPY", "TEST");
  assert.equal(result.pairMismatch, true);
  assert.match(result.warnings[0]!, /一致しません/);
  assert.equal(canAttachToPairAnalysis(result, "USD/JPY"), false);
});

test("japanese usd/jpy label attaches to Task005 technical evidence", () => {
  const chart = normalizeChartAnalysis(sampleRaw({ detected: { pair: "米ドル/円", timeframe: "15分", chartType: "candle", currentPrice: 154.2 } }), "USD/JPY", "TEST");
  assert.equal(chart.pairMismatch, false);
  assert.equal(canAttachToPairAnalysis(chart, "USD/JPY"), true);
  const input = buildInput("USD/JPY", null, null, Date.parse("2026-09-11T12:00:00Z"), chart);
  assert.ok(input.chartImageAnalysis);
  assert.ok(input.fundamentalData.some(item => item.id === "technical:chart_image"));
});

test("matching readable chart can attach as technical evidence", () => {
  const chart = analysis();
  assert.equal(canAttachToPairAnalysis(chart, "USD/JPY"), true);
  const input = buildInput("USD/JPY", null, null, Date.parse("2026-09-11T12:00:00Z"), chart);
  assert.ok(input.chartImageAnalysis);
  assert.ok(input.fundamentalData.some(item => item.id === "technical:chart_image"));
  assert.match(systemPrompt, /chartImageAnalysisまたはtechnical:chart_image/);
});

test("mismatched or poor quality chart does not alter default Task005 input", () => {
  const mismatched = analysis({ pairMismatch: true, detected: { pair: "EUR/USD", timeframe: "1H", chartType: null, currentPrice: null } });
  const poor = analysis({ dataQuality: { score: 20, imageReadable: false, pairDetected: false, timeframeDetected: false } });
  assert.equal(buildInput("USD/JPY", null, null, Date.now(), mismatched).chartImageAnalysis, undefined);
  assert.equal(buildInput("USD/JPY", null, null, Date.now(), poor).fundamentalData.some(item => item.id === "technical:chart_image"), false);
  assert.equal(buildInput("USD/JPY", null, null, Date.now()).chartImageAnalysis, undefined);
});

test("service validates before calling OpenAI", async () => {
  let calls = 0;
  const service = createChartAnalysisService({
    apiKey: "test",
    model: "TEST",
    analyze: async () => { calls++; return analysis(); },
  });
  const missing = await service({ pair: "USD/JPY", bytes: new Uint8Array(), mimeHint: "image/png" });
  assert.equal(missing.ok, false);
  assert.equal(calls, 0);
  const ok = await service({ pair: "USD/JPY", bytes: png, mimeHint: "image/png", filename: "chart.png" });
  assert.equal(ok.ok, true);
  assert.equal(calls, 1);
});

test("vision client maps HTTP and timeout failures without leaking secrets", async () => {
  const secret = "sk-test-secret";
  for (const [status, code] of [[401, "openai_unavailable"], [429, "rate_limited"], [500, "openai_unavailable"]] as const) {
    const analyze = createChartVision({ apiKey: secret, model: "TEST" }, async () => new Response(secret, { status }));
    await assert.rejects(() => analyze({ pair: "USD/JPY", mime: "image/png", base64: "aa" }), (error: unknown) => error instanceof ChartVisionError && error.code === code);
  }
  const timeout = createChartVision({ apiKey: secret, model: "TEST" }, async () => { const error = new Error("timeout"); error.name = "TimeoutError"; throw error; });
  await assert.rejects(() => timeout({ pair: "USD/JPY", mime: "image/png", base64: "aa" }), (error: unknown) => error instanceof ChartVisionError && error.code === "openai_timeout");
});

test("vision client validates structured JSON output", async () => {
  const analyze = createChartVision({ apiKey: "test", model: "TEST" }, async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, "TEST");
    assert.match(JSON.stringify(body.input), /input_image/);
    assert.match(chartVisionPrompt, /画像に見えない情報を作らない/);
    return Response.json({
      status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(sampleRaw()) }] }],
    });
  });
  const result = await analyze({ pair: "USD/JPY", mime: "image/png", base64: "abc" });
  assert.equal(result.trend.direction, "down");
  assert.equal(result.levels.support[0], 152.8);
});

test("invalid vision JSON fails closed", async () => {
  const analyze = createChartVision({ apiKey: "test", model: "TEST" }, async () => Response.json({
    status: "completed",
    output: [{ type: "message", content: [{ type: "output_text", text: "{broken" }] }],
  }));
  await assert.rejects(() => analyze({ pair: "USD/JPY", mime: "image/png", base64: "abc" }), (error: unknown) => error instanceof ChartVisionError && error.code === "invalid_ai_response");
});
