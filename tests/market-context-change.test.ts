import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { calculateIndicators } from "../lib/market/indicators";
import type { Candle, MarketData, Resource, Technical, Symbol } from "../lib/market/types";
import {
  buildMarketContextChangeAnalysis,
  changeTimeframeSetMatchesMtf,
  compareMarketContexts,
  detectAppendOrderAnomaly,
  elapsedBetween,
  formatElapsed,
  smaRelation,
} from "../lib/trades/market-context-change";
import {
  MARKET_CONTEXT_REVISION_REASON,
  captureMarketContextSnapshot,
  type MarketContextRevision,
  type MarketContextSnapshot,
} from "../lib/trades/market-context-snapshot";
import {
  buildPerformanceIntelligence,
  savedTechnicalPoint,
} from "../lib/trades/performance-intelligence";
import { storedMultiTimeframeAnalysis } from "../lib/trades/mtf-snapshot";
import { appendMarketContextRevision, createTrade } from "../lib/trades/service";
import type { Trade, TradeDraft } from "../lib/trades/types";

const NOW = Date.parse("2026-09-21T09:00:00.000Z");
const t0 = new Date(NOW).toISOString();
const t1 = "2026-09-21T10:30:00.000Z";
const t2 = "2026-09-21T12:00:00.000Z";
const ROOT = process.cwd();
const SOURCE = [
  readFileSync(join(ROOT, "lib/trades/market-context-change.ts"), "utf8"),
  readFileSync(join(ROOT, "components/trades/market-context-change.tsx"), "utf8"),
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

function tech(direction: 1 | -1 | 0, durationMs: number, base = 150): Resource<Technical> {
  const list = candles(220, direction, durationMs, base);
  return resource({ candles: list, indicators: calculateIndicators(list), lastClosedAt: list.at(-1)?.time ?? iso() });
}

function marketFrom(pair: Symbol, dirs: { day: 1 | -1 | 0; h4: 1 | -1 | 0; h1: 1 | -1 | 0; m15: 1 | -1 | 0 }, price = 150.25): MarketData {
  return {
    symbol: pair,
    price: resource(price),
    timeframes: {
      "15m": tech(dirs.m15, 900_000, price),
      "1h": tech(dirs.h1, 3_600_000, price),
      "4h": tech(dirs.h4, 14_400_000, price),
    },
    daily: tech(dirs.day, 86_400_000, price),
  };
}

function draft(changes: Partial<TradeDraft> = {}): TradeDraft {
  return {
    pair: "USD/JPY", side: "long", status: "open", quantity: 1000, entryPrice: 153.5, exitPrice: null,
    openedAt: "2026-09-21T08:00:00.000Z", closedAt: null, stopLoss: 153, takeProfit: 154.5, notes: "TASK106", ...changes,
  };
}

function asRevision(snapshot: MarketContextSnapshot, capturedAt: string): MarketContextRevision {
  return { ...snapshot, capturedAt, reason: MARKET_CONTEXT_REVISION_REASON };
}

function snap(market: MarketData, capturedAt: string, rate?: number): MarketContextSnapshot {
  return captureMarketContextSnapshot({
    pair: "USD/JPY",
    capturedAt,
    market,
    marketRate: rate ?? market.price.data,
  })!;
}

test("timeframe set matches MTF", () => {
  assert.equal(changeTimeframeSetMatchesMtf(), true);
});

test("1 original → latest comparison", () => {
  const original = snap(marketFrom("USD/JPY", { day: 1, h4: 1, h1: 1, m15: 1 }, 157.2), t0, 157.2);
  const latest = asRevision(snap(marketFrom("USD/JPY", { day: 0, h4: 0, h1: 0, m15: -1 }, 157.65), t1, 157.65), t1);
  const trade: Trade = {
    ...createTrade(draft(), null, "c1", t0).data!,
    marketContextSnapshot: original,
    marketContextRevisions: [latest],
  };
  const analysis = buildMarketContextChangeAnalysis(trade, { mode: "original_to_latest" });
  assert.equal(analysis.unavailableReason, null);
  assert.equal(analysis.comparison?.mode, "original_to_latest");
  assert.equal(analysis.comparison?.rate.status, "changed");
  assert.ok((analysis.comparison?.rate.absolute ?? 0) > 0);
});

test("2 previous → latest comparison", () => {
  const original = snap(marketFrom("USD/JPY", { day: 1, h4: 1, h1: 1, m15: 1 }, 150), t0, 150);
  const r1 = asRevision(snap(marketFrom("USD/JPY", { day: 1, h4: 1, h1: 0, m15: 1 }, 151), t1, 151), t1);
  const r2 = asRevision(snap(marketFrom("USD/JPY", { day: -1, h4: -1, h1: -1, m15: -1 }, 149), t2, 149), t2);
  const trade: Trade = {
    ...createTrade(draft(), null, "c2", t0).data!,
    marketContextSnapshot: original,
    marketContextRevisions: [r1, r2],
  };
  const analysis = buildMarketContextChangeAnalysis(trade, { mode: "previous_to_latest" });
  assert.equal(analysis.comparison?.fromCapturedAt, t1);
  assert.equal(analysis.comparison?.toCapturedAt, t2);
  assert.equal(analysis.comparison?.rate.before, 151);
  assert.equal(analysis.comparison?.rate.after, 149);
});

test("3 revision selection original → selected", () => {
  const original = snap(marketFrom("USD/JPY", { day: 1, h4: 1, h1: 1, m15: 1 }, 150), t0, 150);
  const r1 = asRevision(snap(marketFrom("USD/JPY", { day: 0, h4: 0, h1: 0, m15: 0 }, 151), t1, 151), t1);
  const r2 = asRevision(snap(marketFrom("USD/JPY", { day: -1, h4: -1, h1: -1, m15: -1 }, 152), t2, 152), t2);
  const trade: Trade = {
    ...createTrade(draft(), null, "c3", t0).data!,
    marketContextSnapshot: original,
    marketContextRevisions: [r1, r2],
  };
  const analysis = buildMarketContextChangeAnalysis(trade, { mode: "original_to_selected", selectedRevisionIndex: 0 });
  assert.equal(analysis.comparison?.toCapturedAt, t1);
  assert.equal(analysis.comparison?.rate.after, 151);
});

test("4 original missing", () => {
  const trade: Trade = {
    ...createTrade(draft(), null, "c4", t0).data!,
    marketContextSnapshot: null,
    marketContextRevisions: [asRevision(snap(marketFrom("USD/JPY", { day: 1, h4: 1, h1: 1, m15: 1 }), t1), t1)],
  };
  const analysis = buildMarketContextChangeAnalysis(trade);
  assert.equal(analysis.unavailableReason, "no_original");
  assert.equal(analysis.comparison, null);
  assert.equal(analysis.revisions.length, 1);
});

test("5 revisions missing", () => {
  const trade = createTrade(draft(), null, "c5", t0, {
    market: marketFrom("USD/JPY", { day: 1, h4: 1, h1: 1, m15: 1 }),
  }).data!;
  const analysis = buildMarketContextChangeAnalysis(trade);
  assert.equal(analysis.unavailableReason, "no_revisions");
  assert.ok(analysis.original);
});

test("6-8 marketRate deltas / missing", () => {
  const a = snap(marketFrom("USD/JPY", { day: 1, h4: 1, h1: 1, m15: 1 }, 100), t0, 100);
  const b = asRevision(snap(marketFrom("USD/JPY", { day: 1, h4: 1, h1: 1, m15: 1 }, 110), t1, 110), t1);
  const cmp = compareMarketContexts(a, b, { mode: "original_to_latest", fromLabel: "O", toLabel: "R" });
  assert.equal(cmp.rate.absolute, 10);
  assert.ok(Math.abs((cmp.rate.percent ?? 0) - 10) < 1e-9);
  const missing = compareMarketContexts(
    { ...a, marketRate: null },
    { ...b, marketRate: null },
    { mode: "original_to_latest", fromLabel: "O", toLabel: "R" },
  );
  assert.equal(missing.rate.status, "unavailable");
});

test("9-14 timeframe changes / unchanged / insufficient", () => {
  const bull = snap(marketFrom("USD/JPY", { day: 1, h4: 1, h1: 1, m15: 1 }), t0);
  const bear = asRevision(snap(marketFrom("USD/JPY", { day: -1, h4: -1, h1: -1, m15: -1 }), t1), t1);
  const cmp = compareMarketContexts(bull, bear, { mode: "original_to_latest", fromLabel: "O", toLabel: "R" });
  for (const tf of ["15m", "1h", "4h", "1day"] as const) {
    const row = cmp.timeframes.find(item => item.timeframe === tf)!;
    assert.equal(row.status, "changed");
    assert.equal(row.trend.before, "bullish");
    assert.equal(row.trend.after, "bearish");
  }
  const same = compareMarketContexts(bull, asRevision(bull, t1), { mode: "original_to_latest", fromLabel: "O", toLabel: "R" });
  assert.ok(same.timeframes.every(tf => tf.status === "unchanged" || tf.trend.status === "unchanged"));
  const empty = compareMarketContexts(
    { ...bull, multiTimeframe: null },
    { ...bear, multiTimeframe: null },
    { mode: "original_to_latest", fromLabel: "O", toLabel: "R" },
  );
  assert.ok(empty.timeframes.every(tf => tf.status === "unavailable"));
});

test("15-17 regime / trendDirection / volatility", () => {
  const a = snap(marketFrom("USD/JPY", { day: 1, h4: 1, h1: 1, m15: 1 }, 150), t0);
  const b = asRevision(snap(marketFrom("USD/JPY", { day: 0, h4: 0, h1: 0, m15: 0 }, 150), t1), t1);
  const cmp = compareMarketContexts(a, b, { mode: "original_to_latest", fromLabel: "O", toLabel: "R" });
  assert.ok(cmp.regime.regime.before);
  assert.ok(cmp.regime.regime.after);
  assert.ok(["changed", "unchanged"].includes(cmp.regime.status));
});

test("18-24 technical / SMA relation / RSI", () => {
  const high = snap(marketFrom("USD/JPY", { day: 1, h4: 1, h1: 1, m15: 1 }, 160), t0, 160);
  const low = asRevision(snap(marketFrom("USD/JPY", { day: -1, h4: -1, h1: -1, m15: -1 }, 140), t1, 140), t1);
  // Force technical relations for deterministic SMA above/below
  const before: MarketContextSnapshot = {
    ...high,
    technicalContext: {
      timeframe: "1h", lastClose: 160, sma20: 150, sma75: 155, sma200: 148, rsi14: 63.2, source: "mtf_1h",
    },
  };
  const after: MarketContextRevision = {
    ...low,
    technicalContext: {
      timeframe: "1h", lastClose: 140, sma20: 150, sma75: 135, sma200: 148, rsi14: 51.4, source: "mtf_1h",
    },
  };
  const cmp = compareMarketContexts(before, after, { mode: "original_to_latest", fromLabel: "O", toLabel: "R" });
  assert.equal(cmp.technical.lastClose.delta, -20);
  assert.equal(cmp.technical.smaRelations.sma20.before, "above");
  assert.equal(cmp.technical.smaRelations.sma20.after, "below");
  assert.equal(cmp.technical.smaRelations.sma75.before, "above");
  assert.equal(cmp.technical.smaRelations.sma75.after, "above");
  assert.equal(smaRelation(150, 150), "equal");
  assert.ok(Math.abs((cmp.technical.rsi14.delta ?? 0) - (-11.8)) < 1e-9);
  assert.equal(cmp.technical.rsiBucket.before, "rsi_55_70");
  assert.equal(cmp.technical.rsiBucket.after, "rsi_45_55");
  const missingTech = compareMarketContexts(
    { ...before, technicalContext: null },
    { ...after, technicalContext: null },
    { mode: "original_to_latest", fromLabel: "O", toLabel: "R" },
  );
  assert.equal(missingTech.technical.status, "unavailable");
});

test("25-26 elapsed / invalid timestamp", () => {
  assert.equal(formatElapsed(5_400_000), "1h 30m");
  const ok = elapsedBetween(t0, t1);
  assert.equal(ok.invalid, false);
  assert.equal(ok.label, "1h 30m");
  const bad = elapsedBetween("nope", t1);
  assert.equal(bad.invalid, true);
  const reverse = elapsedBetween(t1, t0);
  assert.equal(reverse.invalid, true);
});

test("27-28 append order preserved / no auto reorder", () => {
  const original = snap(marketFrom("USD/JPY", { day: 1, h4: 1, h1: 1, m15: 1 }), t0);
  const laterFirst = asRevision(snap(marketFrom("USD/JPY", { day: 1, h4: 1, h1: 1, m15: 1 }, 151), t2, 151), t2);
  const earlierSecond = asRevision(snap(marketFrom("USD/JPY", { day: -1, h4: -1, h1: -1, m15: -1 }, 149), t1, 149), t1);
  const trade: Trade = {
    ...createTrade(draft(), null, "ord", t0).data!,
    marketContextSnapshot: original,
    marketContextRevisions: [laterFirst, earlierSecond],
  };
  const analysis = buildMarketContextChangeAnalysis(trade, { mode: "original_to_latest" });
  assert.equal(analysis.appendOrderAnomaly, true);
  assert.equal(analysis.comparison?.toCapturedAt, t1);
  assert.equal(detectAppendOrderAnomaly([laterFirst, earlierSecond]), true);
  assert.equal(detectAppendOrderAnomaly([earlierSecond, laterFirst]), false);
});

test("29-30 OPEN / CLOSED", () => {
  const market = marketFrom("USD/JPY", { day: 1, h4: 1, h1: 1, m15: 1 });
  const open = createTrade(draft(), null, "open", t0, { market }).data!;
  const withRev = appendMarketContextRevision(open, {
    pair: "USD/JPY", capturedAt: t1, market: marketFrom("USD/JPY", { day: -1, h4: -1, h1: -1, m15: -1 }, 149),
  }, t1).data!;
  assert.equal(buildMarketContextChangeAnalysis(withRev).unavailableReason, null);
  const closed: Trade = {
    ...withRev,
    status: "closed",
    exitPrice: 154,
    closedAt: t2,
    realizedPnl: 500,
    updatedAt: t2,
  };
  assert.equal(buildMarketContextChangeAnalysis(closed).unavailableReason, null);
});

test("31 PI ignores revisions regression", () => {
  const market = marketFrom("USD/JPY", { day: 1, h4: 1, h1: 1, m15: 1 }, 150.2);
  const base = createTrade(draft({
    status: "closed", exitPrice: 154, closedAt: t2,
  }), null, "pi", t0, { market, marketPrice: 150.2 }).data!;
  const before = buildPerformanceIntelligence([base]);
  const revised = appendMarketContextRevision(base, {
    pair: "USD/JPY",
    capturedAt: t1,
    market: marketFrom("USD/JPY", { day: -1, h4: -1, h1: -1, m15: -1 }, 140),
    marketRate: 140,
  }, t1).data!;
  const after = buildPerformanceIntelligence([revised]);
  assert.deepEqual(savedTechnicalPoint(revised), savedTechnicalPoint(base));
  assert.equal(storedMultiTimeframeAnalysis(revised)?.alignment, storedMultiTimeframeAnalysis(base)?.alignment);
  assert.equal(JSON.stringify(after.technical.sma.groups), JSON.stringify(before.technical.sma.groups));
  assert.equal(JSON.stringify(after.technical.rsi.groups), JSON.stringify(before.technical.rsi.groups));
});

test("32 original snapshot remains unchanged", () => {
  const market = marketFrom("USD/JPY", { day: 1, h4: 1, h1: 1, m15: 1 });
  const trade = createTrade(draft(), null, "im", t0, { market }).data!;
  const original = structuredClone(trade.marketContextSnapshot);
  const revised = appendMarketContextRevision(trade, {
    pair: "USD/JPY", capturedAt: t1, market: marketFrom("USD/JPY", { day: -1, h4: -1, h1: -1, m15: -1 }),
  }, t1).data!;
  buildMarketContextChangeAnalysis(revised);
  assert.deepEqual(revised.marketContextSnapshot, original);
});

test("33-34 no recommendation / BUY SELL WAIT generation", () => {
  assert.doesNotMatch(SOURCE, /改善|悪化|撤退|危険|買いシグナル|売りシグナル|bearish cross|bullish cross|sell signal|buy signal/i);
  assert.doesNotMatch(SOURCE, /\b(BUY|SELL|WAIT)\b/);
  assert.doesNotMatch(SOURCE, /おすすめ|推奨|close recommendation|stop-loss adjustment/i);
});

test("35-36 no API / AI request", () => {
  assert.doesNotMatch(SOURCE, /\bfetch\s*\(/);
  assert.doesNotMatch(SOURCE, /\/api\/market|openrouter|openai|responses\.create/i);
  assert.doesNotMatch(SOURCE, /setInterval|twelvedata|finnhub/i);
  assert.doesNotMatch(SOURCE, /\bpolling\b/);
});

test("37 UI mobile-friendly classes present", () => {
  const css = readFileSync(join(ROOT, "app/globals.css"), "utf8");
  assert.match(css, /market-context-change/);
  assert.match(css, /overflow-wrap/);
  const ui = readFileSync(join(ROOT, "components/trades/market-context-change.tsx"), "utf8");
  assert.match(ui, /market-context-change/);
  assert.match(ui, /data-status/);
});
