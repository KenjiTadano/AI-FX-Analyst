import test from "node:test";
import assert from "node:assert/strict";
import { buildInput } from "../lib/ai/input";
import { finalizeAnalysis } from "../lib/ai/engine";
import { normalizeChartAnalysis } from "../lib/chart-analysis/normalize";
import { createTrade, editTrade, closeTrade, captureAnalysis } from "../lib/trades/service";
import { alignmentPerformance } from "../lib/trades/analytics";
import { captureTradeAiSnapshot, computeAiAlignment, isRichSnapshot, sanitizePersistedSnapshot, sanitizeTradeAiSnapshot } from "../lib/trades/snapshot";
import type { TradeDraft } from "../lib/trades/types";
import { readFileSync } from "node:fs";

const now = "2026-09-11T12:00:00.000Z";
const ms = Date.parse(now);
const draft = (changes: Partial<TradeDraft> = {}): TradeDraft => ({
  pair: "USD/JPY", side: "long", status: "open", quantity: 1000, entryPrice: 153.5, exitPrice: null,
  openedAt: "2026-09-11T11:00:00.000Z", closedAt: null, stopLoss: 153, takeProfit: 154.5, notes: "TASK013", ...changes,
});
function ai(overrides: Record<string, unknown> = {}) {
  const base = finalizeAnalysis(buildInput("USD/JPY", null, null, ms), null, "TEST", "not_configured", ms);
  return { ...base, ...overrides, ai: { ...base.ai, ...(overrides.ai as object | undefined) } };
}
function chart() {
  return normalizeChartAnalysis({
    detected: { pair: "米ドル/円", timeframe: "15分足", chartType: "candlestick", currentPrice: 154.2 },
    trend: { direction: "down", confidence: 80, reason: "高値切り下げ" },
    structure: { higherHigh: false, higherLow: false, lowerHigh: true, lowerLow: true },
    levels: { support: [153.8], resistance: [154.5] },
    patterns: [], indicators: [], observations: ["押し目弱い"], warnings: [],
    dataQuality: { score: 90, imageReadable: true, pairDetected: true, timeframeDetected: true },
  }, "USD/JPY", "TEST", ms);
}

test("A: AI analysis present stores versioned snapshot", () => {
  const trade = createTrade(draft(), ai({ signal: "sell", directionSignal: "sell", action: "WAIT", ai: { status: "available", model: "gpt-test", code: null, message: null } }), "a", now).data!;
  assert.ok(trade.analysisSnapshot);
  assert.ok(isRichSnapshot(trade.analysisSnapshot));
  assert.equal(trade.analysisSnapshot.version, 1);
  assert.equal(trade.analysisSnapshot.signal, "sell");
  assert.equal(trade.analysisSnapshot.action, "WAIT");
});

test("B: AI absent still creates trade with null snapshot", () => {
  const trade = createTrade(draft(), null, "b", now).data!;
  assert.equal(trade.analysisSnapshot, null);
});

test("C: chartEvidence used stores chart snapshot", () => {
  const analysis = ai({
    signal: "sell", directionSignal: "sell", action: "WAIT",
    chartEvidence: { used: true, timeframe: "15分足", trend: "down", qualityScore: 90 },
    ai: { status: "available", model: "gpt-test", code: null, message: null },
  });
  const trade = createTrade(draft(), analysis, "c", now, { chartImageAnalysis: chart() }).data!;
  assert.ok(isRichSnapshot(trade.analysisSnapshot));
  assert.equal(trade.analysisSnapshot.chartEvidence?.used, true);
  assert.equal(trade.analysisSnapshot.chartAnalysis?.timeframe, "15分足");
  assert.equal(trade.analysisSnapshot.chartAnalysis?.source, "chart_image");
});

test("D: without chart leaves chart null", () => {
  const trade = createTrade(draft(), ai({ ai: { status: "available", model: "x", code: null, message: null } }), "d", now).data!;
  assert.ok(isRichSnapshot(trade.analysisSnapshot));
  assert.equal(trade.analysisSnapshot.chartAnalysis, null);
  assert.equal(trade.analysisSnapshot.chartEvidence, null);
});

test("E: pair mismatch refuses snapshot attach", () => {
  assert.equal(captureAnalysis(ai(), "EUR/JPY", now), null);
  const trade = createTrade(draft({ pair: "EUR/JPY" }), ai(), "e", now).data!;
  assert.equal(trade.analysisSnapshot, null);
});

test("F: WAIT action yields wait_override alignment", () => {
  const snap = captureTradeAiSnapshot({ analysis: ai({ signal: "wait", directionSignal: "sell", action: "WAIT", ai: { status: "available", model: "x", code: null, message: null } }), pair: "USD/JPY", now });
  assert.equal(computeAiAlignment("long", snap), "wait_override");
});

test("G: BUY trade + AI BUY aligns", () => {
  const snap = captureTradeAiSnapshot({ analysis: ai({ signal: "buy", directionSignal: "buy", action: "BUY", ai: { status: "available", model: "x", code: null, message: null } }), pair: "USD/JPY", now });
  assert.equal(computeAiAlignment("long", snap), "aligned");
});

test("H: BUY trade + AI SELL is contrary", () => {
  const snap = captureTradeAiSnapshot({ analysis: ai({ signal: "sell", directionSignal: "sell", action: "SELL", ai: { status: "available", model: "x", code: null, message: null } }), pair: "USD/JPY", now });
  assert.equal(computeAiAlignment("long", snap), "contrary");
});

test("I: trade edit keeps snapshot immutable", () => {
  const trade = createTrade(draft(), ai({ ai: { status: "available", model: "x", code: null, message: null } }), "i", now).data!;
  const edited = editTrade(trade, { ...trade, notes: "changed", entryPrice: 153.6 }, now).data!;
  assert.deepEqual(edited.analysisSnapshot, trade.analysisSnapshot);
});

test("J: trade close keeps snapshot immutable", () => {
  const trade = createTrade(draft(), ai({ ai: { status: "available", model: "x", code: null, message: null } }), "j", now).data!;
  const closed = closeTrade(trade, 154, now, now).data!;
  assert.deepEqual(closed.analysisSnapshot, trade.analysisSnapshot);
});

test("K: legacy snapshot without version still validates", () => {
  const legacy = {
    pair: "USD/JPY", signal: "wait", score: 0, confidence: 40, summary: "legacy", dataQualityScore: 50,
    analyzedAt: now, capturedAt: now, expiresAt: now, aiStatus: "unavailable", model: null, bullishReasons: [], bearishReasons: [],
  };
  assert.ok(sanitizePersistedSnapshot(legacy));
  assert.equal(computeAiAlignment("long", legacy as never), "wait_override");
});

test("L: malformed client snapshot is rejected by sanitizer", () => {
  assert.equal(sanitizeTradeAiSnapshot({ version: 1 }), null);
  assert.equal(sanitizePersistedSnapshot({ signal: "invalid" }), null);
});

test("M: secret-like payloads are not accepted", () => {
  const poisoned = captureTradeAiSnapshot({
    analysis: ai({
      summary: "normal",
      ai: { status: "available", model: "sk-abcdefghijklmnopqrstuvwxyz123456", code: null, message: null },
    }),
    pair: "USD/JPY",
    now,
  });
  // model is scrubbed rather than rejecting the whole trade snapshot when built through capture
  assert.ok(poisoned);
  assert.equal(poisoned!.model, "[redacted]");
  assert.equal(sanitizeTradeAiSnapshot({ ...poisoned, summary: "leak data:image/png;base64,AAAA" }), null);
});

test("N: fallback snapshot marks isFallback", () => {
  const snap = captureTradeAiSnapshot({ analysis: ai(), pair: "USD/JPY", now });
  assert.ok(snap);
  assert.equal(snap!.isFallback, true);
  assert.equal(snap!.aiStatus, "unavailable");
});

test("O: performance aggregation covers alignment buckets", () => {
  const wait = closeTrade(createTrade(draft(), ai({ signal: "wait", directionSignal: "sell", action: "WAIT", ai: { status: "available", model: "x", code: null, message: null } }), "o1", now).data!, 154, now, now).data!;
  const aligned = closeTrade(createTrade(draft(), ai({ signal: "buy", directionSignal: "buy", action: "BUY", ai: { status: "available", model: "x", code: null, message: null } }), "o2", now).data!, 154, now, now).data!;
  const contrary = closeTrade(createTrade(draft({ side: "long" }), ai({ signal: "sell", directionSignal: "sell", action: "SELL", ai: { status: "available", model: "x", code: null, message: null } }), "o3", now).data!, 153, now, now).data!;
  const none = closeTrade(createTrade(draft(), null, "o4", now).data!, 154, now, now).data!;
  const groups = Object.fromEntries(alignmentPerformance([wait, aligned, contrary, none]).map(g => [g.alignment, g.count]));
  assert.equal(groups.wait_override, 1);
  assert.equal(groups.aligned, 1);
  assert.equal(groups.contrary, 1);
  assert.equal(groups.unavailable, 1);
});

test("saveSnapshot false stores no snapshot", () => {
  const trade = createTrade(draft(), ai({ ai: { status: "available", model: "x", code: null, message: null } }), "opt", now, { saveSnapshot: false }).data!;
  assert.equal(trade.analysisSnapshot, null);
});

test("migration extends check_trade without dropping trades", () => {
  const sql = readFileSync("supabase/migrations/20260911220000_extend_trade_ai_analysis_snapshot.sql", "utf8");
  assert.match(sql, /create or replace function public\.check_trade/i);
  assert.match(sql, /version/i);
  assert.doesNotMatch(sql, /drop table/i);
  assert.match(sql, /analysis_snapshot is distinct from old\.analysis_snapshot/i);
});
