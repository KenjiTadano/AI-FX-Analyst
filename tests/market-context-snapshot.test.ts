import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildInput } from "../lib/ai/input";
import { finalizeAnalysis } from "../lib/ai/engine";
import { calculateIndicators } from "../lib/market/indicators";
import type { Candle, MarketData, Resource, Technical, Symbol } from "../lib/market/types";
import {
  captureMarketContextSnapshot,
  marketContextFieldStates,
  marketContextFromTrade,
  sanitizeMarketContextSnapshot,
} from "../lib/trades/market-context-snapshot";
import { storedMultiTimeframeAnalysis } from "../lib/trades/mtf-snapshot";
import { storedMarketRegimeAnalysis } from "../lib/trades/regime-snapshot";
import { buildPerformanceIntelligence } from "../lib/trades/performance-intelligence";
import { closeTrade, createTrade, editTrade } from "../lib/trades/service";
import type { Trade, TradeDraft } from "../lib/trades/types";

const NOW = Date.parse("2026-09-21T09:00:00.000Z");
const capturedAt = new Date(NOW).toISOString();
const SOURCE = [
  readFileSync(join(process.cwd(), "lib/trades/market-context-snapshot.ts"), "utf8"),
  readFileSync(join(process.cwd(), "lib/trades/service.ts"), "utf8"),
  readFileSync(join(process.cwd(), "components/trades/market-context-snapshot.tsx"), "utf8"),
].join("\n");

const iso = (at = NOW) => new Date(at).toISOString();

function resource<T>(data: T): Resource<T> {
  return { data, fetchedAt: iso(), error: null, stale: false };
}

function candles(count: number, direction: 1 | -1 | 0, durationMs: number, base = 150): Candle[] {
  return Array.from({ length: count }, (_, i) => {
    const close = base + direction * i * 0.05;
    const open = close - direction * 0.02;
    return {
      time: iso(NOW - (count - i) * durationMs),
      open, high: Math.max(open, close) + 0.03, low: Math.min(open, close) - 0.03, close, volume: 100,
    };
  });
}

function tech(direction: 1 | -1 | 0, durationMs: number): Resource<Technical> {
  const list = candles(220, direction, durationMs);
  return resource({ candles: list, indicators: calculateIndicators(list), lastClosedAt: list.at(-1)?.time ?? iso() });
}

function marketFrom(pair: Symbol, dirs: { day: 1 | -1 | 0; h4: 1 | -1 | 0; h1: 1 | -1 | 0; m15: 1 | -1 | 0 }, price = 150.25): MarketData {
  return {
    symbol: pair,
    price: resource(price),
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
    openedAt: "2026-09-21T08:00:00.000Z", closedAt: null, stopLoss: 153, takeProfit: 154.5, notes: "TASK104", ...changes,
  };
}

test("1 trade creation captures market context", () => {
  const market = marketFrom("USD/JPY", { day: 1, h4: 1, h1: 1, m15: 1 }, 150.25);
  const trade = createTrade(draft(), ai(), "t1", capturedAt, { market, marketPrice: 150.25 }).data!;
  const ctx = marketContextFromTrade(trade);
  assert.ok(ctx);
  assert.equal(ctx.version, 1);
  assert.equal(ctx.pair, "USD/JPY");
  assert.equal(ctx.capturedAt, capturedAt);
});

test("2 AI未実行でもcapture可能", () => {
  const market = marketFrom("USD/JPY", { day: 1, h4: 1, h1: 1, m15: 1 });
  const trade = createTrade(draft(), null, "t2", capturedAt, { market, marketPrice: 150.1 }).data!;
  assert.equal(trade.analysisSnapshot, null);
  assert.ok(trade.marketContextSnapshot);
  assert.ok(trade.marketContextSnapshot?.multiTimeframe);
  assert.ok(trade.marketContextSnapshot?.marketRegime);
});

test("3 AI failureでもcapture可能", () => {
  const failed = finalizeAnalysis(buildInput("USD/JPY", null, null, NOW), null, "TEST", "rate_limited", NOW);
  const market = marketFrom("USD/JPY", { day: 1, h4: 1, h1: -1, m15: 0 });
  const trade = createTrade(draft(), failed, "t3", capturedAt, { market, marketPrice: 149.9, saveSnapshot: true }).data!;
  assert.ok(trade.marketContextSnapshot?.multiTimeframe);
  assert.notEqual(JSON.stringify(trade.marketContextSnapshot).includes("rate_limited"), true);
});

test("4 pair一致", () => {
  const market = marketFrom("USD/JPY", { day: 1, h4: 1, h1: 1, m15: 1 });
  const trade = createTrade(draft(), null, "t4", capturedAt, { market }).data!;
  assert.equal(trade.marketContextSnapshot?.pair, trade.pair);
});

test("5 pair mismatch rejection", () => {
  const market = marketFrom("EUR/JPY", { day: 1, h4: 1, h1: 1, m15: 1 });
  const trade = createTrade(draft({ pair: "USD/JPY" }), null, "t5", capturedAt, { market }).data!;
  assert.equal(trade.marketContextSnapshot, null);
  assert.equal(captureMarketContextSnapshot({ pair: "USD/JPY", capturedAt, market }), null);
});

test("6 capturedAt保存", () => {
  const market = marketFrom("USD/JPY", { day: 1, h4: 1, h1: 1, m15: 1 });
  const trade = createTrade(draft({ openedAt: "2026-09-20T00:00:00.000Z" }), null, "t6", capturedAt, { market }).data!;
  assert.equal(trade.marketContextSnapshot?.capturedAt, capturedAt);
  assert.notEqual(trade.marketContextSnapshot?.capturedAt, trade.openedAt);
});

test("7 marketRate != entryPrice", () => {
  const market = marketFrom("USD/JPY", { day: 1, h4: 1, h1: 1, m15: 1 }, 150.25);
  const trade = createTrade(draft({ entryPrice: 153.5 }), null, "t7", capturedAt, { market, marketPrice: 150.25 }).data!;
  assert.equal(trade.marketContextSnapshot?.marketRate, 150.25);
  assert.notEqual(trade.marketContextSnapshot?.marketRate, trade.entryPrice);
});

test("8 MTF保存", () => {
  const market = marketFrom("USD/JPY", { day: 1, h4: 1, h1: 1, m15: 1 });
  const trade = createTrade(draft(), null, "t8", capturedAt, { market }).data!;
  assert.equal(trade.marketContextSnapshot?.multiTimeframe?.alignment, "aligned_bullish");
  assert.equal(storedMultiTimeframeAnalysis(trade)?.alignment, "aligned_bullish");
});

test("9 Regime保存", () => {
  const market = marketFrom("USD/JPY", { day: 1, h4: 1, h1: 1, m15: 1 });
  const trade = createTrade(draft(), null, "t9", capturedAt, { market }).data!;
  assert.ok(trade.marketContextSnapshot?.marketRegime);
  assert.ok(storedMarketRegimeAnalysis(trade));
});

test("10 technical values保存/参照", () => {
  const market = marketFrom("USD/JPY", { day: 1, h4: 1, h1: 1, m15: 1 });
  const trade = createTrade(draft(), null, "t10", capturedAt, { market }).data!;
  const tech = trade.marketContextSnapshot?.technicalContext;
  assert.ok(tech);
  assert.equal(tech.timeframe, "1h");
  assert.ok(tech.lastClose != null);
  assert.ok(tech.sma20 != null || tech.sma75 != null || tech.sma200 != null || tech.rsi14 != null);
});

test("11 missing contextでもtrade保存可能", () => {
  const trade = createTrade(draft(), null, "t11", capturedAt).data!;
  assert.ok(trade);
  assert.equal(trade.analysisSnapshot, null);
  // No market → still capture empty-ish independent snapshot (pair + capturedAt) or null?
  // capture with market=null still returns snapshot with null children.
  assert.ok(trade.marketContextSnapshot);
  assert.equal(trade.marketContextSnapshot?.multiTimeframe, null);
  assert.equal(trade.marketContextSnapshot?.marketRegime, null);
});

test("12-15 close / PnL / notes / exit plan updates keep snapshot immutable", () => {
  const market = marketFrom("USD/JPY", { day: 1, h4: 1, h1: 1, m15: 1 }, 150.2);
  const created = createTrade(draft(), null, "t12", capturedAt, { market, marketPrice: 150.2 }).data!;
  const original = structuredClone(created.marketContextSnapshot);
  const closed = closeTrade(created, 154, "2026-09-21T10:00:00.000Z", "2026-09-21T10:00:00.000Z").data!;
  assert.deepEqual(closed.marketContextSnapshot, original);
  const noted = editTrade(closed, { ...closed, notes: "updated notes" }, "2026-09-21T10:01:00.000Z").data!;
  assert.deepEqual(noted.marketContextSnapshot, original);
  assert.equal(noted.notes, "updated notes");
  const planTouched = editTrade(noted, { ...noted, stopLoss: 152.5 }, "2026-09-21T10:02:00.000Z").data!;
  assert.deepEqual(planTouched.marketContextSnapshot, original);
  assert.deepEqual(planTouched.exitPlan, created.exitPlan);
});

test("16-17 legacy trade compatible and no live backfill", () => {
  const legacy: Trade = {
    ...createTrade(draft(), null, "legacy", capturedAt).data!,
    marketContextSnapshot: null,
  };
  assert.equal(marketContextFromTrade(legacy), null);
  assert.equal(marketContextFieldStates(legacy).snapshot, "legacy");
  assert.equal(storedMultiTimeframeAnalysis(legacy), null);
  assert.doesNotMatch(SOURCE, /getMarketData\(|multiTimeframeForPair\(trade|backfill/);
});

test("18 Task103 metrics regression with legacy AI-embedded MTF", () => {
  const market = marketFrom("USD/JPY", { day: 1, h4: 1, h1: 1, m15: 1 });
  const withAi = createTrade(draft({ status: "closed", exitPrice: 154, closedAt: "2026-09-21T11:00:00.000Z" }), ai(), "pi1", capturedAt, {
    market,
    marketPrice: 150.2,
  }).data!;
  // Strip independent snapshot to force legacy path while keeping AI-embedded MTF
  const legacyPath: Trade = { ...withAi, marketContextSnapshot: null };
  assert.ok(storedMultiTimeframeAnalysis(legacyPath));
  const a = buildPerformanceIntelligence([withAi]);
  const b = buildPerformanceIntelligence([legacyPath]);
  assert.equal(a.overview.closedTrades, b.overview.closedTrades);
  assert.equal(a.coverage.mtf.present, b.coverage.mtf.present);
});

test("19 new snapshot → legacy fallback adapter", () => {
  const market = marketFrom("USD/JPY", { day: -1, h4: -1, h1: -1, m15: -1 });
  const independentOnly = createTrade(draft(), null, "ad1", capturedAt, { market }).data!;
  assert.equal(independentOnly.analysisSnapshot, null);
  assert.equal(storedMultiTimeframeAnalysis(independentOnly)?.alignment, "aligned_bearish");
  assert.ok(storedMarketRegimeAnalysis(independentOnly));

  const aiOnly = createTrade(draft(), ai(), "ad2", capturedAt, { market }).data!;
  const stripped: Trade = { ...aiOnly, marketContextSnapshot: null };
  assert.equal(storedMultiTimeframeAnalysis(stripped)?.alignment, "aligned_bearish");
});

test("20 AI provider/modelをmarket snapshotへ保存しない", () => {
  const market = marketFrom("USD/JPY", { day: 1, h4: 1, h1: 1, m15: 1 });
  const trade = createTrade(draft(), ai(), "sec", capturedAt, { market }).data!;
  const json = JSON.stringify(trade.marketContextSnapshot);
  assert.equal(json.includes("gpt-test"), false);
  assert.equal(json.includes("aiStatus"), false);
  assert.equal(json.includes("provider"), false);
  assert.equal(json.includes("openrouter"), false);
  assert.equal(sanitizeMarketContextSnapshot({
    version: 1, capturedAt, pair: "USD/JPY", marketRate: 1, multiTimeframe: null, marketRegime: null, technicalContext: null, model: "x",
  }), null);
});

test("21 no automatic replacement helpers", () => {
  const files = [
    readFileSync(join(process.cwd(), "lib/trades/market-context-snapshot.ts"), "utf8"),
    readFileSync(join(process.cwd(), "components/trades/market-context-snapshot.tsx"), "utf8"),
  ].join("\n");
  assert.doesNotMatch(files, /replaceMarketContext|refreshMarketContext|setInterval\(|\bpolling\b/);
});

test("22 field states distinguish legacy / unavailable / saved", () => {
  const market = marketFrom("USD/JPY", { day: 1, h4: 1, h1: 1, m15: 1 });
  const saved = createTrade(draft(), null, "st", capturedAt, { market }).data!;
  assert.equal(marketContextFieldStates(saved).mtf, "saved");
  const empty = createTrade(draft(), null, "em", capturedAt).data!;
  assert.equal(marketContextFieldStates(empty).mtf, "unavailable");
  assert.equal(marketContextFieldStates(empty).snapshot, "saved");
  const legacy = { ...empty, marketContextSnapshot: null };
  assert.equal(marketContextFieldStates(legacy).snapshot, "legacy");
});
