import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildInput } from "../lib/ai/input";
import { finalizeAnalysis } from "../lib/ai/engine";
import { calculateIndicators } from "../lib/market/indicators";
import type { Candle, MarketData, Resource, Technical, Symbol } from "../lib/market/types";
import {
  MAX_MARKET_CONTEXT_REVISIONS,
  MARKET_CONTEXT_LIMIT_ERROR,
  MARKET_CONTEXT_REVISION_REASON,
  captureMarketContextRevision,
  isAppendOnlyMarketContextRevisions,
  marketContextFromTrade,
  marketContextRevisionsFromTrade,
  sanitizeMarketContextRevision,
  sanitizeMarketContextRevisions,
} from "../lib/trades/market-context-snapshot";
import { storedMultiTimeframeAnalysis } from "../lib/trades/mtf-snapshot";
import { storedMarketRegimeAnalysis } from "../lib/trades/regime-snapshot";
import {
  buildPerformanceIntelligence,
  savedTechnicalPoint,
} from "../lib/trades/performance-intelligence";
import { appendMarketContextRevision, closeTrade, createTrade, editTrade } from "../lib/trades/service";
import type { Trade, TradeDraft } from "../lib/trades/types";

const NOW = Date.parse("2026-09-21T09:00:00.000Z");
const capturedAt = new Date(NOW).toISOString();
const later = "2026-09-21T12:00:00.000Z";
const SOURCE = [
  readFileSync(join(process.cwd(), "lib/trades/market-context-snapshot.ts"), "utf8"),
  readFileSync(join(process.cwd(), "lib/trades/service.ts"), "utf8"),
  readFileSync(join(process.cwd(), "components/trades/market-context-snapshot.tsx"), "utf8"),
  readFileSync(join(process.cwd(), "components/trades/journal.tsx"), "utf8"),
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
    openedAt: "2026-09-21T08:00:00.000Z", closedAt: null, stopLoss: 153, takeProfit: 154.5, notes: "TASK105", ...changes,
  };
}

function closedTrade(market: MarketData): Trade {
  return createTrade(
    draft({ status: "closed", exitPrice: 154, closedAt: "2026-09-21T11:00:00.000Z" }),
    null,
    "pi-base",
    capturedAt,
    { market, marketPrice: 150.2 },
  ).data!;
}

test("1 original snapshot remains immutable after revision", () => {
  const market = marketFrom("USD/JPY", { day: 1, h4: 1, h1: 1, m15: 1 }, 150.2);
  const trade = createTrade(draft(), null, "r1", capturedAt, { market, marketPrice: 150.2 }).data!;
  const original = structuredClone(trade.marketContextSnapshot);
  const nextMarket = marketFrom("USD/JPY", { day: -1, h4: -1, h1: -1, m15: -1 }, 148.1);
  const revised = appendMarketContextRevision(trade, { pair: "USD/JPY", capturedAt: later, market: nextMarket, marketRate: 148.1 }, later).data!;
  assert.deepEqual(revised.marketContextSnapshot, original);
  assert.equal(revised.marketContextRevisions?.length, 1);
});

test("2 manual refresh creates revision", () => {
  const market = marketFrom("USD/JPY", { day: 1, h4: 1, h1: 1, m15: 1 });
  const trade = createTrade(draft(), null, "r2", capturedAt, { market }).data!;
  const revised = appendMarketContextRevision(trade, {
    pair: "USD/JPY", capturedAt: later, market: marketFrom("USD/JPY", { day: -1, h4: -1, h1: -1, m15: -1 }, 149), marketRate: 149,
  }, later).data!;
  assert.equal(revised.marketContextRevisions?.[0]?.reason, MARKET_CONTEXT_REVISION_REASON);
});

test("3-4 confirmation UX strings present; cancel path creates nothing in domain", () => {
  const ui = readFileSync(join(process.cwd(), "components/trades/market-context-snapshot.tsx"), "utf8");
  const domain = readFileSync(join(process.cwd(), "lib/trades/market-context-snapshot.ts"), "utf8");
  assert.match(ui, /market-context-refresh-confirm/);
  assert.match(ui, /MARKET_CONTEXT_REFRESH_CONFIRM/);
  assert.match(ui, /market-context-refresh-cancel/);
  assert.match(domain, /エントリー時のMarket Contextは変更されません/);
  const market = marketFrom("USD/JPY", { day: 1, h4: 1, h1: 1, m15: 1 });
  const trade = createTrade(draft(), null, "r3", capturedAt, { market }).data!;
  assert.equal(trade.marketContextRevisions ?? null, null);
});

test("5-9 automatic paths do not append revisions", () => {
  assert.doesNotMatch(SOURCE, /setInterval\([^)]*appendMarketContextRevision/);
  assert.doesNotMatch(SOURCE, /useEffect\([^)]*appendMarketContextRevision/);
  const market = marketFrom("USD/JPY", { day: 1, h4: 1, h1: 1, m15: 1 });
  const trade = createTrade(draft(), null, "r5", capturedAt, { market }).data!;
  const closed = closeTrade(trade, 154, later, later).data!;
  assert.equal(closed.marketContextRevisions ?? null, null);
  const noted = editTrade(closed, { ...closed, notes: "n" }, later).data!;
  assert.equal(noted.marketContextRevisions ?? null, null);
  const ai = finalizeAnalysis(buildInput("USD/JPY", null, null, NOW), null, "TEST", "not_configured", NOW);
  const withAi = createTrade(draft(), { ...ai, ai: { ...ai.ai, status: "available", model: "gpt-test", code: null } }, "r5b", capturedAt, { market }).data!;
  assert.equal(withAi.marketContextRevisions ?? null, null);
});

test("10-15 revision fields capture", () => {
  const market = marketFrom("USD/JPY", { day: 1, h4: 1, h1: 1, m15: 1 }, 151.5);
  const trade = createTrade(draft(), null, "r10", capturedAt, { market, marketPrice: 150 }).data!;
  const next = marketFrom("USD/JPY", { day: -1, h4: -1, h1: -1, m15: -1 }, 149.25);
  const revised = appendMarketContextRevision(trade, { pair: "USD/JPY", capturedAt: later, market: next, marketRate: 149.25 }, later).data!;
  const rev = revised.marketContextRevisions![0]!;
  assert.equal(rev.capturedAt, later);
  assert.equal(rev.pair, "USD/JPY");
  assert.ok(rev.multiTimeframe);
  assert.ok(rev.marketRegime);
  assert.ok(rev.technicalContext);
  assert.equal(rev.marketRate, 149.25);
  assert.notEqual(rev.marketRate, revised.entryPrice);
});

test("12 pair mismatch rejected", () => {
  const market = marketFrom("USD/JPY", { day: 1, h4: 1, h1: 1, m15: 1 });
  const trade = createTrade(draft(), null, "r12", capturedAt, { market }).data!;
  const original = structuredClone(trade.marketContextSnapshot);
  const eur = marketFrom("EUR/JPY", { day: 1, h4: 1, h1: 1, m15: 1 });
  const failed = appendMarketContextRevision(trade, { pair: "EUR/JPY", capturedAt: later, market: eur }, later);
  assert.equal(failed.data, null);
  assert.deepEqual(trade.marketContextSnapshot, original);
  assert.equal(trade.marketContextRevisions ?? null, null);
});

test("16 AI provider/model absent from revision", () => {
  const rev = captureMarketContextRevision({
    pair: "USD/JPY",
    capturedAt: later,
    market: marketFrom("USD/JPY", { day: 1, h4: 1, h1: 1, m15: 1 }),
  })!;
  const json = JSON.stringify(rev);
  assert.equal(json.includes("gpt"), false);
  assert.equal(json.includes("provider"), false);
  assert.equal(json.includes("aiStatus"), false);
  assert.equal(sanitizeMarketContextRevision({ ...rev, model: "x" }), null);
});

test("17 OpenRouter/OpenAI request 0 in revision capture path", () => {
  assert.doesNotMatch(SOURCE, /openrouter|openai|responses\.create/i);
});

test("18-21 append-only / no mutate / no delete / order preserved", () => {
  const market = marketFrom("USD/JPY", { day: 1, h4: 1, h1: 1, m15: 1 });
  let trade = createTrade(draft(), null, "r18", capturedAt, { market }).data!;
  trade = appendMarketContextRevision(trade, { pair: "USD/JPY", capturedAt: later, market }, later).data!;
  const first = structuredClone(trade.marketContextRevisions![0]);
  const t2 = "2026-09-21T13:00:00.000Z";
  trade = appendMarketContextRevision(trade, {
    pair: "USD/JPY", capturedAt: t2, market: marketFrom("USD/JPY", { day: -1, h4: -1, h1: -1, m15: -1 }, 147),
  }, t2).data!;
  assert.equal(trade.marketContextRevisions!.length, 2);
  assert.deepEqual(trade.marketContextRevisions![0], first);
  assert.equal(trade.marketContextRevisions![1]!.capturedAt, t2);
  assert.equal(isAppendOnlyMarketContextRevisions([first], trade.marketContextRevisions), true);
  assert.equal(isAppendOnlyMarketContextRevisions(trade.marketContextRevisions, [first]), false);
  assert.equal(sanitizeMarketContextRevisions([{ ...first, reason: "auto" }]), null);
});

test("22-23 max revision limit rejects without deleting", () => {
  const market = marketFrom("USD/JPY", { day: 1, h4: 1, h1: 1, m15: 1 });
  let trade = createTrade(draft(), null, "r22", capturedAt, { market }).data!;
  for (let i = 0; i < MAX_MARKET_CONTEXT_REVISIONS; i += 1) {
    const at = new Date(NOW + (i + 1) * 60_000).toISOString();
    trade = appendMarketContextRevision(trade, { pair: "USD/JPY", capturedAt: at, market }, at).data!;
  }
  assert.equal(trade.marketContextRevisions!.length, MAX_MARKET_CONTEXT_REVISIONS);
  const before = structuredClone(trade.marketContextRevisions);
  const overflow = appendMarketContextRevision(trade, {
    pair: "USD/JPY", capturedAt: "2026-09-22T00:00:00.000Z", market,
  }, "2026-09-22T00:00:00.000Z");
  assert.equal(overflow.data, null);
  assert.match(overflow.error ?? "", /最大20件/);
  assert.deepEqual(trade.marketContextRevisions, before);
  assert.equal(MARKET_CONTEXT_LIMIT_ERROR.includes("削除"), true);
});

test("24 capture failure changes nothing", () => {
  const market = marketFrom("USD/JPY", { day: 1, h4: 1, h1: 1, m15: 1 });
  const trade = createTrade(draft(), null, "r24", capturedAt, { market }).data!;
  const snap = structuredClone(trade.marketContextSnapshot);
  const failed = appendMarketContextRevision(trade, {
    pair: "USD/JPY",
    capturedAt: "not-iso",
    market,
  }, "not-iso");
  assert.equal(failed.data, null);
  assert.deepEqual(trade.marketContextSnapshot, snap);
  assert.equal(trade.marketContextRevisions ?? null, null);
});

test("25-26 legacy trade can append revision without becoming original", () => {
  const market = marketFrom("USD/JPY", { day: 1, h4: 1, h1: 1, m15: 1 });
  const legacy: Trade = { ...createTrade(draft(), null, "leg", capturedAt).data!, marketContextSnapshot: null };
  assert.equal(marketContextFromTrade(legacy), null);
  const revised = appendMarketContextRevision(legacy, { pair: "USD/JPY", capturedAt: later, market }, later).data!;
  assert.equal(revised.marketContextSnapshot, null);
  assert.equal(marketContextFromTrade(revised), null);
  assert.equal(marketContextRevisionsFromTrade(revised).length, 1);
  assert.equal(storedMultiTimeframeAnalysis(revised), null);
});

test("27-29 Performance Intelligence ignores revisions", () => {
  const market = marketFrom("USD/JPY", { day: 1, h4: 1, h1: 1, m15: 1 }, 150.2);
  const base = closedTrade(market);
  const beforePi = buildPerformanceIntelligence([base]);
  const beforeTech = savedTechnicalPoint(base);
  const beforeMtf = storedMultiTimeframeAnalysis(base)?.alignment;
  const beforeRegime = storedMarketRegimeAnalysis(base)?.regime;
  const next = marketFrom("USD/JPY", { day: -1, h4: -1, h1: -1, m15: -1 }, 140);
  const revised = appendMarketContextRevision(base, { pair: "USD/JPY", capturedAt: later, market: next, marketRate: 140 }, later).data!;
  const afterPi = buildPerformanceIntelligence([revised]);
  assert.deepEqual(savedTechnicalPoint(revised), beforeTech);
  assert.equal(storedMultiTimeframeAnalysis(revised)?.alignment, beforeMtf);
  assert.equal(storedMarketRegimeAnalysis(revised)?.regime, beforeRegime);
  assert.equal(afterPi.coverage.mtf.present, beforePi.coverage.mtf.present);
  assert.equal(afterPi.overview.closedTrades, beforePi.overview.closedTrades);
  assert.equal(JSON.stringify(afterPi.technical.sma.groups), JSON.stringify(beforePi.technical.sma.groups));
  assert.equal(JSON.stringify(afterPi.technical.rsi.groups), JSON.stringify(beforePi.technical.rsi.groups));
});

test("30 original → legacy adapter regression", () => {
  const market = marketFrom("USD/JPY", { day: -1, h4: -1, h1: -1, m15: -1 });
  const trade = createTrade(draft(), null, "ad", capturedAt, { market }).data!;
  const revised = appendMarketContextRevision(trade, {
    pair: "USD/JPY", capturedAt: later, market: marketFrom("USD/JPY", { day: 1, h4: 1, h1: 1, m15: 1 }),
  }, later).data!;
  assert.equal(storedMultiTimeframeAnalysis(revised)?.alignment, "aligned_bearish");
});

test("31 concurrency helper isAppendOnly", () => {
  const a = [{ version: 1 as const, capturedAt: later, pair: "USD/JPY" as const, marketRate: 1, multiTimeframe: null, marketRegime: null, technicalContext: null, reason: MARKET_CONTEXT_REVISION_REASON }];
  const b = [...a, { ...a[0]!, capturedAt: "2026-09-21T14:00:00.000Z" }];
  assert.equal(isAppendOnlyMarketContextRevisions(a, b), true);
  assert.equal(isAppendOnlyMarketContextRevisions(b, a), false);
});

test("32 UI has history accordion / no automatic replacement helpers", () => {
  const ui = readFileSync(join(process.cwd(), "components/trades/market-context-snapshot.tsx"), "utf8");
  assert.match(ui, /market-context-history/);
  assert.match(ui, /<details/);
  assert.doesNotMatch(ui, /replaceMarketContext|refreshMarketContext\(|setInterval\(/);
  assert.doesNotMatch(
    readFileSync(join(process.cwd(), "lib/trades/market-context-snapshot.ts"), "utf8"),
    /replaceMarketContext|setInterval\(|\bpolling\b/,
  );
});
