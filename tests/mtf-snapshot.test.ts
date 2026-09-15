import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildInput } from "../lib/ai/input";
import { finalizeAnalysis } from "../lib/ai/engine";
import { calculateIndicators } from "../lib/market/indicators";
import type { Candle, MarketData, Resource, Technical, Symbol } from "../lib/market/types";
import { ALIGNMENT_LABEL, buildMultiTimeframeAnalysis } from "../lib/market/multi-timeframe";
import {
  captureMultiTimeframeSnapshot,
  MTF_SNAPSHOT_DISCLAIMER,
  MTF_SNAPSHOT_MISSING,
  MTF_SNAPSHOT_NOTE,
  MTF_SNAPSHOT_UNREADABLE,
  mtfSnapshotState,
  storedMultiTimeframeAnalysis,
} from "../lib/trades/mtf-snapshot";
import { captureTradeAiSnapshot, isRichSnapshot, sanitizeTradeAiSnapshot } from "../lib/trades/snapshot";
import { closeTrade, createTrade, editTrade } from "../lib/trades/service";
import type { TradeDraft } from "../lib/trades/types";

const NOW = Date.parse("2026-09-15T08:00:00.000Z");
const capturedAt = new Date(NOW).toISOString();
const SOURCE = [
  readFileSync(join(process.cwd(), "lib/trades/mtf-snapshot.ts"), "utf8"),
  readFileSync(join(process.cwd(), "components/trades/mtf-snapshot.tsx"), "utf8"),
  readFileSync(join(process.cwd(), "lib/trades/snapshot.ts"), "utf8"),
].join("\n");
const FORBIDDEN =
  /チャンス|おすすめ|Entry OK|GO\b|goodEntry|badEntry|買い推奨|勝ちパターン|正しいEntry|良いEntry/;

const iso = (at = NOW) => new Date(at).toISOString();

function resource<T>(data: T): Resource<T> {
  return { data, fetchedAt: iso(), error: null, stale: false };
}

function candles(count: number, direction: 1 | -1 | 0, durationMs: number, base = 150): Candle[] {
  return Array.from({ length: count }, (_, i) => {
    const close = direction === 0 ? base : base + (i - (count - 1)) * 0.01 * direction;
    return { time: iso(NOW - (count - i) * durationMs), open: close, high: close + 0.05, low: close - 0.05, close };
  });
}

function tech(direction: 1 | -1 | 0, durationMs: number, count = 240): Resource<Technical> {
  const series = candles(count, direction, durationMs);
  return resource({ candles: series, indicators: calculateIndicators(series), lastClosedAt: series.at(-1)!.time });
}

function marketFrom(pair: Symbol, dirs: { day: 1 | -1 | 0; h4: 1 | -1 | 0; h1: 1 | -1 | 0; m15: 1 | -1 | 0 }): MarketData {
  return {
    symbol: pair,
    price: resource(150),
    timeframes: {
      "15m": tech(dirs.m15, 900_000),
      "1h": tech(dirs.h1, 3_600_000),
      "4h": tech(dirs.h4, 14_400_000),
    },
    daily: tech(dirs.day, 86_400_000),
  };
}

function ai() {
  const base = finalizeAnalysis(buildInput("USD/JPY", null, null, NOW), null, "TEST", "not_configured", NOW);
  return { ...base, signal: "sell" as const, directionSignal: "sell" as const, action: "WAIT" as const, ai: { ...base.ai, status: "available" as const, model: "gpt-test", code: null } };
}

function draft(changes: Partial<TradeDraft> = {}): TradeDraft {
  return {
    pair: "USD/JPY", side: "long", status: "open", quantity: 1000, entryPrice: 153.5, exitPrice: null,
    openedAt: "2026-09-15T07:00:00.000Z", closedAt: null, stopLoss: 153, takeProfit: 154.5, notes: "TASK027", ...changes,
  };
}

test("A: live all-bullish MTF is stored on create", () => {
  const market = marketFrom("USD/JPY", { day: 1, h4: 1, h1: 1, m15: 1 });
  const trade = createTrade(draft(), ai(), "a", capturedAt, { market }).data!;
  assert.ok(isRichSnapshot(trade.analysisSnapshot));
  assert.equal(trade.analysisSnapshot.version, 1);
  assert.equal(trade.analysisSnapshot.multiTimeframeAnalysis?.alignment, "aligned_bullish");
  assert.equal(trade.analysisSnapshot.multiTimeframeAnalysis?.higherTimeframeBias, "bullish");
  assert.equal(trade.analysisSnapshot.multiTimeframeAnalysis?.availableTimeframes, 4);
});

test("B: live all-bearish MTF is stored", () => {
  const market = marketFrom("USD/JPY", { day: -1, h4: -1, h1: -1, m15: -1 });
  const trade = createTrade(draft(), ai(), "b", capturedAt, { market }).data!;
  assert.equal(isRichSnapshot(trade.analysisSnapshot) ? trade.analysisSnapshot.multiTimeframeAnalysis?.alignment : null, "aligned_bearish");
});

test("C: mixed MTF is stored without Action", () => {
  const market = marketFrom("USD/JPY", { day: 1, h4: 1, h1: -1, m15: -1 });
  const trade = createTrade(draft(), ai(), "c", capturedAt, { market }).data!;
  const mtf = isRichSnapshot(trade.analysisSnapshot) ? trade.analysisSnapshot.multiTimeframeAnalysis : null;
  assert.equal(mtf?.alignment, "mixed");
  assert.equal(mtf && "action" in mtf, false);
  assert.ok((mtf?.conflicts.length ?? 0) >= 1);
});

test("D: no market leaves MTF null and keeps AI snapshot", () => {
  const trade = createTrade(draft(), ai(), "d", capturedAt).data!;
  assert.ok(isRichSnapshot(trade.analysisSnapshot));
  assert.equal(trade.analysisSnapshot.multiTimeframeAnalysis, null);
  assert.equal(trade.analysisSnapshot.action, "WAIT");
});

test("E: pair mismatch market does not copy foreign MTF", () => {
  const market = marketFrom("EUR/JPY", { day: 1, h4: 1, h1: 1, m15: 1 });
  const trade = createTrade(draft(), ai(), "e", capturedAt, { market }).data!;
  assert.ok(isRichSnapshot(trade.analysisSnapshot));
  assert.equal(trade.analysisSnapshot.multiTimeframeAnalysis, null);
});

test("F: saveSnapshot false stores neither AI nor MTF", () => {
  const market = marketFrom("USD/JPY", { day: 1, h4: 1, h1: 1, m15: 1 });
  const trade = createTrade(draft(), ai(), "f", capturedAt, { market, saveSnapshot: false }).data!;
  assert.equal(trade.analysisSnapshot, null);
});

test("G: AI absent still creates trade without MTF", () => {
  const market = marketFrom("USD/JPY", { day: 1, h4: 1, h1: 1, m15: 1 });
  const trade = createTrade(draft(), null, "g", capturedAt, { market }).data!;
  assert.equal(trade.analysisSnapshot, null);
});

test("H: raw candles are not persisted", () => {
  const market = marketFrom("USD/JPY", { day: 1, h4: 1, h1: 1, m15: 1 });
  const trade = createTrade(draft(), ai(), "h", capturedAt, { market }).data!;
  const json = JSON.stringify(trade.analysisSnapshot);
  assert.equal(json.includes('"candles"'), false);
  assert.equal(json.includes('"values"'), false);
  assert.ok(json.includes("aligned_bullish"));
});

test("I: edit keeps MTF immutable", () => {
  const market = marketFrom("USD/JPY", { day: 1, h4: 1, h1: 1, m15: 1 });
  const trade = createTrade(draft(), ai(), "i", capturedAt, { market }).data!;
  const edited = editTrade(trade, { ...trade, notes: "changed", entryPrice: 153.6 }, capturedAt).data!;
  assert.deepEqual(edited.analysisSnapshot, trade.analysisSnapshot);
});

test("J: close keeps MTF immutable", () => {
  const market = marketFrom("USD/JPY", { day: 1, h4: 1, h1: 1, m15: 1 });
  const trade = createTrade(draft(), ai(), "j", capturedAt, { market }).data!;
  const closed = closeTrade(trade, 154, capturedAt, capturedAt).data!;
  assert.equal(closed.status, "closed");
  assert.ok((closed.realizedPnl ?? 0) > 0);
  assert.deepEqual(closed.analysisSnapshot, trade.analysisSnapshot);
  assert.equal(isRichSnapshot(closed.analysisSnapshot) ? closed.analysisSnapshot.multiTimeframeAnalysis?.alignment : null, "aligned_bullish");
});

test("K: profit does not rewrite mixed alignment", () => {
  const market = marketFrom("USD/JPY", { day: 1, h4: 1, h1: -1, m15: -1 });
  const trade = createTrade(draft({ side: "short" }), ai(), "k", capturedAt, { market }).data!;
  const closed = closeTrade(trade, 152.5, capturedAt, capturedAt).data!;
  assert.ok((closed.realizedPnl ?? 0) > 0);
  assert.equal(isRichSnapshot(closed.analysisSnapshot) ? closed.analysisSnapshot.multiTimeframeAnalysis?.alignment : null, "mixed");
});

test("L: invalid MTF drops the field only", () => {
  const snap = captureTradeAiSnapshot({ analysis: ai(), pair: "USD/JPY", now: capturedAt, market: marketFrom("USD/JPY", { day: 1, h4: 1, h1: 1, m15: 1 }) })!;
  const poisoned = sanitizeTradeAiSnapshot({ ...snap, multiTimeframeAnalysis: { pair: "USD/JPY", candles: [] } });
  assert.ok(poisoned);
  assert.equal(poisoned!.multiTimeframeAnalysis, null);
  assert.equal(poisoned!.action, "WAIT");
});

test("M: secret-like MTF conflict does not kill snapshot", () => {
  const snap = captureTradeAiSnapshot({ analysis: ai(), pair: "USD/JPY", now: capturedAt })!;
  const poisoned = sanitizeTradeAiSnapshot({
    ...snap,
    multiTimeframeAnalysis: {
      pair: "USD/JPY",
      analyzedAt: capturedAt,
      higherTimeframeBias: "bullish",
      alignment: "mixed",
      availableTimeframes: 4,
      totalTimeframes: 4,
      timeframes: [],
      conflicts: [{ id: "x", message: "sk-abcdefghijklmnopqrstuvwxyz123456" }],
    },
  });
  assert.ok(poisoned);
  assert.equal(poisoned!.multiTimeframeAnalysis, null);
  assert.equal(poisoned!.action, "WAIT");
});

test("N: stored helper sanitizes pair mismatch", () => {
  const market = marketFrom("USD/JPY", { day: 1, h4: 1, h1: 1, m15: 1 });
  const trade = createTrade(draft(), ai(), "n", capturedAt, { market }).data!;
  if (!isRichSnapshot(trade.analysisSnapshot) || !trade.analysisSnapshot.multiTimeframeAnalysis) throw new Error("mtf");
  trade.analysisSnapshot.multiTimeframeAnalysis = { ...trade.analysisSnapshot.multiTimeframeAnalysis, pair: "EUR/JPY" };
  assert.equal(storedMultiTimeframeAnalysis(trade), null);
  assert.equal(mtfSnapshotState(trade), "unreadable");
});

test("O: legacy snapshot has no MTF", () => {
  const legacy = {
    pair: "USD/JPY", signal: "wait", score: 0, confidence: 40, summary: "legacy", dataQualityScore: 50,
    analyzedAt: capturedAt, capturedAt, expiresAt: capturedAt, aiStatus: "unavailable", model: null, bullishReasons: [], bearishReasons: [],
  };
  assert.equal("multiTimeframeAnalysis" in legacy, false);
  const trade = { ...draft(), id: "o", createdAt: capturedAt, updatedAt: capturedAt, realizedPnl: null, analysisSnapshot: legacy as never };
  assert.equal(storedMultiTimeframeAnalysis(trade), null);
  assert.equal(mtfSnapshotState(trade), "absent");
});

test("P: capture helper fail-closed on missing market", () => {
  assert.equal(captureMultiTimeframeSnapshot(null, "USD/JPY", capturedAt), null);
  assert.equal(captureMultiTimeframeSnapshot(marketFrom("USD/JPY", { day: 1, h4: 1, h1: 1, m15: 1 }), "EUR/JPY", capturedAt), null);
});

test("Q: unavailable frames are stored as unavailable not guessed", () => {
  const market = marketFrom("USD/JPY", { day: 1, h4: 1, h1: 1, m15: 1 });
  market.timeframes["15m"] = { data: null, fetchedAt: iso(), error: "unavailable", stale: false };
  const mtf = captureMultiTimeframeSnapshot(market, "USD/JPY", capturedAt)!;
  assert.equal(mtf.alignment, "insufficient");
  assert.equal(mtf.timeframes.find(frame => frame.timeframe === "15m")?.trend, "unavailable");
  assert.equal(mtf.timeframes.find(frame => frame.timeframe === "1day")?.trend, "bullish");
});

test("R: snapshot does not generate BUY/SELL/WAIT from alignment", () => {
  const analysis = buildMultiTimeframeAnalysis({
    pair: "USD/JPY",
    analyzedAt: capturedAt,
    daily: marketFrom("USD/JPY", { day: 1, h4: 1, h1: 1, m15: 1 }).daily,
    timeframes: marketFrom("USD/JPY", { day: 1, h4: 1, h1: 1, m15: 1 }).timeframes,
  });
  assert.doesNotMatch(ALIGNMENT_LABEL[analysis.alignment], /BUY|SELL|WAIT|買い|売り/);
  const trade = createTrade(draft(), ai(), "r", capturedAt, { market: marketFrom("USD/JPY", { day: 1, h4: 1, h1: 1, m15: 1 }) }).data!;
  const stored = isRichSnapshot(trade.analysisSnapshot) ? trade.analysisSnapshot.multiTimeframeAnalysis : null;
  assert.doesNotMatch(JSON.stringify(stored), /"action"|Entry OK|GO/);
});

test("S: copy forbids recommendation wording", () => {
  assert.doesNotMatch(SOURCE, FORBIDDEN);
  assert.match(SOURCE, /MTF_SNAPSHOT_MISSING/);
  assert.equal(MTF_SNAPSHOT_MISSING.includes("保存されていません"), true);
  assert.equal(MTF_SNAPSHOT_UNREADABLE.includes("確認できません"), true);
  assert.match(MTF_SNAPSHOT_NOTE, /再評価していません/);
  assert.match(MTF_SNAPSHOT_DISCLAIMER, /売買の推奨ではありません/);
});

test("T: capture does not fetch or call OpenAI", () => {
  assert.doesNotMatch(SOURCE, /fetch\(|openai|twelvedata|setInterval/);
  assert.doesNotMatch(readFileSync(join(process.cwd(), "lib/trades/service.ts"), "utf8"), /\/api\/market/);
});

test("U: version stays 1", () => {
  const trade = createTrade(draft(), ai(), "u", capturedAt, { market: marketFrom("USD/JPY", { day: 1, h4: 1, h1: 1, m15: 1 }) }).data!;
  assert.equal(isRichSnapshot(trade.analysisSnapshot) ? trade.analysisSnapshot.version : null, 1);
});

test("V: live market change after create does not mutate stored MTF", () => {
  const trade = createTrade(draft(), ai(), "v", capturedAt, { market: marketFrom("USD/JPY", { day: 1, h4: 1, h1: 1, m15: 1 }) }).data!;
  const stored = isRichSnapshot(trade.analysisSnapshot) ? trade.analysisSnapshot.multiTimeframeAnalysis?.alignment : null;
  const later = captureMultiTimeframeSnapshot(marketFrom("USD/JPY", { day: -1, h4: -1, h1: -1, m15: -1 }), "USD/JPY", capturedAt);
  assert.equal(stored, "aligned_bullish");
  assert.equal(later?.alignment, "aligned_bearish");
  assert.equal(isRichSnapshot(trade.analysisSnapshot) ? trade.analysisSnapshot.multiTimeframeAnalysis?.alignment : null, stored);
});
