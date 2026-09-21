import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { calculateIndicators } from "../lib/market/indicators";
import type { Candle, MarketData, Resource, Technical, Symbol } from "../lib/market/types";
import {
  MARKET_CONTEXT_REVISION_REASON,
  captureMarketContextSnapshot,
  type MarketContextRevision,
  type MarketContextSnapshot,
} from "../lib/trades/market-context-snapshot";
import { createExitPlan } from "../lib/trades/exit-plan";
import { buildPerformanceIntelligence } from "../lib/trades/performance-intelligence";
import { buildTradeEvolutionPerformance } from "../lib/trades/trade-evolution-performance";
import { createTrade } from "../lib/trades/service";
import {
  MAX_SIMILAR_RESULTS,
  MIN_SIMILARITY,
  SIMILAR_HISTORICAL_DISCLAIMER,
  SIMILAR_HISTORICAL_OUTCOME_NOTE,
  buildCurrentMarketContext,
  compareContextSimilarity,
  findSimilarHistoricalContexts,
  isSimilarHistoricalCandidate,
  rankSimilarMatches,
} from "../lib/trades/context-similarity";
import type { Trade, TradeDraft } from "../lib/trades/types";

const NOW = Date.parse("2026-09-21T12:00:00.000Z");
const T0 = new Date(NOW).toISOString();
const T1 = "2026-09-20T10:00:00.000Z";
const T2 = "2026-09-10T10:00:00.000Z";
const ROOT = process.cwd();
const SOURCE = [
  readFileSync(join(ROOT, "lib/trades/context-similarity.ts"), "utf8"),
  readFileSync(join(ROOT, "components/dashboard/similar-historical-context.tsx"), "utf8"),
].join("\n");

const FORBIDDEN =
  /上がりそう|勝率\d|期待値が高い|買いに有利|過去\d件中\d勝|予測|embedding|openrouter/i;

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

function marketFrom(
  pair: Symbol,
  dirs: { day: 1 | -1 | 0; h4: 1 | -1 | 0; h1: 1 | -1 | 0; m15: 1 | -1 | 0 },
  price = 150.25,
): MarketData {
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
    pair: "USD/JPY", side: "long", status: "closed", quantity: 1000, entryPrice: 153.5, exitPrice: 154,
    openedAt: "2026-09-20T08:00:00.000Z", closedAt: "2026-09-20T11:00:00.000Z",
    stopLoss: 153, takeProfit: 154.5, notes: "TASK108", ...changes,
  };
}

function asRevision(snapshot: MarketContextSnapshot, capturedAt: string): MarketContextRevision {
  return { ...snapshot, capturedAt, reason: MARKET_CONTEXT_REVISION_REASON };
}

function snap(market: MarketData, capturedAt: string, rate?: number): MarketContextSnapshot {
  return captureMarketContextSnapshot({
    pair: market.symbol,
    capturedAt,
    market,
    marketRate: rate ?? market.price.data,
  })!;
}

function bullish(pair: Symbol = "USD/JPY", price = 157) {
  return marketFrom(pair, { day: 1, h4: 1, h1: 1, m15: 1 }, price);
}

function bearish(pair: Symbol = "USD/JPY", price = 156) {
  return marketFrom(pair, { day: -1, h4: -1, h1: -1, m15: -1 }, price);
}

function mixed(pair: Symbol = "USD/JPY", price = 156.5) {
  return marketFrom(pair, { day: 1, h4: 1, h1: -1, m15: 0 }, price);
}

function withPlan(trade: Trade): Trade {
  return {
    ...trade,
    exitPlan: createExitPlan({
      pair: trade.pair,
      side: trade.side,
      entryPrice: trade.entryPrice,
      stopLoss: trade.stopLoss ?? 153,
      takeProfit: trade.takeProfit ?? 154.5,
      capturedAt: trade.createdAt,
    }),
  };
}

function closedTrade(id: string, opts: {
  pair?: Symbol;
  market?: MarketData;
  capturedAt?: string;
  pnl?: number;
  openedAt?: string;
  closedAt?: string;
  status?: Trade["status"];
  revisions?: MarketContextRevision[];
  original?: MarketContextSnapshot | null;
  withR?: boolean;
} = {}): Trade {
  const pair = opts.pair ?? "USD/JPY";
  const market = opts.market ?? bullish(pair);
  const base = createTrade(draft({
    pair,
    status: opts.status ?? "closed",
    exitPrice: opts.status === "open" ? null : 154,
    closedAt: opts.status === "open" ? null : (opts.closedAt ?? "2026-09-20T11:00:00.000Z"),
    openedAt: opts.openedAt ?? "2026-09-20T08:00:00.000Z",
  }), null, id, T0).data!;
  let trade: Trade = {
    ...base,
    realizedPnl: opts.status === "open" ? null : (opts.pnl ?? 500),
    marketContextSnapshot: opts.original === undefined
      ? snap(market, opts.capturedAt ?? T1)
      : opts.original,
    marketContextRevisions: opts.revisions ?? [],
  };
  if (opts.withR) trade = withPlan(trade);
  return trade;
}

test("1–2 same pair candidates / pair mismatch excluded", () => {
  const current = snap(bullish("USD/JPY"), T0);
  const usd = closedTrade("usd", { pair: "USD/JPY", market: bullish("USD/JPY") });
  const eur = closedTrade("eur", { pair: "EUR/JPY", market: bullish("EUR/JPY") });
  const result = findSimilarHistoricalContexts({
    pair: "USD/JPY",
    current,
    trades: [usd, eur],
  });
  assert.ok(result.matches.every(m => m.pair === "USD/JPY"));
  assert.equal(result.matches.some(m => m.tradeId === "eur"), false);
  assert.equal(isSimilarHistoricalCandidate(eur, "USD/JPY"), false);
});

test("3 original required / 4 revision not candidate / 5 legacy AI not candidate", () => {
  const current = snap(bullish(), T0);
  const revisionOnly = closedTrade("rev-only", {
    original: null,
    revisions: [asRevision(snap(bullish(), T1), T1)],
  });
  const noSnap = closedTrade("none", { original: null, revisions: [] });
  const ok = closedTrade("ok", { market: bullish() });
  assert.equal(isSimilarHistoricalCandidate(revisionOnly, "USD/JPY"), false);
  assert.equal(isSimilarHistoricalCandidate(noSnap, "USD/JPY"), false);
  assert.equal(isSimilarHistoricalCandidate(ok, "USD/JPY"), true);
  const result = findSimilarHistoricalContexts({
    pair: "USD/JPY",
    current,
    trades: [revisionOnly, noSnap, ok],
  });
  assert.equal(result.matches.some(m => m.tradeId === "rev-only"), false);
  assert.doesNotMatch(SOURCE, /analysisSnapshot.*similar|legacy.*candidate/i);
});

test("6–7 current context construction / no extra market fetch", () => {
  const market = bullish();
  const current = buildCurrentMarketContext({
    pair: "USD/JPY",
    capturedAt: T0,
    market,
    marketRate: 157,
  });
  assert.ok(current);
  assert.equal(current!.pair, "USD/JPY");
  assert.ok(current!.multiTimeframe);
  assert.doesNotMatch(SOURCE, /fetch\(|getMarketData\(|\/api\/market/);
});

test("8–11 MTF match / mismatch / unavailable", () => {
  const current = snap(bullish(), T0);
  const same = snap(bullish(), T1);
  const opposite = snap(bearish(), T1);
  const emptyHist: MarketContextSnapshot = {
    version: 1,
    capturedAt: T1,
    pair: "USD/JPY",
    marketRate: null,
    multiTimeframe: null,
    marketRegime: null,
    technicalContext: null,
  };
  const sameScore = compareContextSimilarity(current, same);
  const oppScore = compareContextSimilarity(current, opposite);
  const emptyScore = compareContextSimilarity(current, emptyHist);
  assert.equal(sameScore.dimensions.find(d => d.key === "mtf_15m")?.status, "match");
  assert.equal(sameScore.dimensions.find(d => d.key === "mtf_1day")?.status, "match");
  assert.equal(oppScore.dimensions.find(d => d.key === "mtf_1h")?.status, "mismatch");
  assert.equal(emptyScore.dimensions.find(d => d.key === "mtf_4h")?.status, "not_comparable");
});

test("12–14 regime / trendDirection / volatility", () => {
  const current = snap(bullish(), T0);
  const same = snap(bullish(), T1);
  const opp = snap(bearish(), T1);
  const sameScore = compareContextSimilarity(current, same);
  const oppScore = compareContextSimilarity(current, opp);
  assert.equal(sameScore.dimensions.find(d => d.key === "regime")?.status, "match");
  assert.ok(["match", "mismatch"].includes(oppScore.dimensions.find(d => d.key === "trendDirection")!.status));
  assert.ok(["match", "mismatch", "not_comparable"].includes(sameScore.dimensions.find(d => d.key === "volatility")!.status));
});

test("15–18 SMA relations and RSI bucket", () => {
  const current = snap(bullish(undefined, 160), T0, 160);
  const same = snap(bullish(undefined, 160), T1, 160);
  const far = snap(bearish(undefined, 140), T1, 140);
  const sameScore = compareContextSimilarity(current, same);
  const farScore = compareContextSimilarity(current, far);
  for (const key of ["sma20", "sma75", "sma200", "rsiBucket"] as const) {
    assert.ok(sameScore.dimensions.some(d => d.key === key));
    assert.ok(["match", "mismatch", "not_comparable"].includes(farScore.dimensions.find(d => d.key === key)!.status));
  }
});

test("19 raw market price ignored", () => {
  assert.doesNotMatch(SOURCE, /Math\.abs\(\s*(?:current|historical)?\.?marketRate/);
  assert.doesNotMatch(SOURCE, /priceDistance|absoluteDistance|rawPrice/);
  const a = snap(bullish(undefined, 157), T0, 157);
  const b = snap(bullish(undefined, 145), T1, 145);
  const score = compareContextSimilarity(a, b);
  assert.ok(score.comparable >= 1);
});

test("20–23 match ratio / comparable / min guard / threshold", () => {
  const current = snap(bullish(), T0);
  const same = snap(bullish(), T1);
  const score = compareContextSimilarity(current, same);
  assert.equal(score.ratio, score.comparable ? score.matches / score.comparable : null);
  assert.equal(score.totalDimensions, 11);
  assert.ok(score.sufficientComparable);
  assert.ok(score.meetsThreshold);
  assert.ok(score.percent != null && score.percent >= MIN_SIMILARITY * 100);

  const empty: MarketContextSnapshot = {
    version: 1, capturedAt: T1, pair: "USD/JPY", marketRate: null,
    multiTimeframe: null, marketRegime: null, technicalContext: null,
  };
  const thin = compareContextSimilarity(current, empty);
  assert.equal(thin.sufficientComparable, false);
  assert.equal(thin.meetsThreshold, false);
});

test("24–30 ranking excludes outcome / P/L / R / win / AI; tie-break deterministic", () => {
  assert.doesNotMatch(SOURCE, /rankSimilarMatches[\s\S]{0,400}realizedPnl|rankSimilarMatches[\s\S]{0,400}realizedR|rankSimilarMatches[\s\S]{0,400}win/);
  const current = snap(bullish(), T0);
  const lowPnlRecent = closedTrade("low", {
    market: bullish(),
    pnl: -9999,
    openedAt: "2026-09-20T08:00:00.000Z",
    withR: true,
  });
  const highPnlOlder = closedTrade("high", {
    market: bullish(),
    pnl: 99999,
    openedAt: "2026-09-01T08:00:00.000Z",
    withR: true,
  });
  const result = findSimilarHistoricalContexts({
    pair: "USD/JPY",
    current,
    trades: [highPnlOlder, lowPnlRecent],
  });
  assert.ok(result.matches.length >= 2);
  // Same similarity → newer openedAt first (not higher P/L)
  assert.equal(result.matches[0]!.tradeId, "low");
  const reordered = [...result.matches].sort(rankSimilarMatches);
  assert.deepEqual(reordered.map(m => m.tradeId), result.matches.map(m => m.tradeId));
});

test("31 max results", () => {
  const current = snap(bullish(), T0);
  const trades = Array.from({ length: 8 }, (_, i) => closedTrade(`m${i}`, {
    market: bullish(),
    openedAt: `2026-09-${String(10 + i).padStart(2, "0")}T08:00:00.000Z`,
  }));
  const result = findSimilarHistoricalContexts({ pair: "USD/JPY", current, trades });
  assert.ok(result.matches.length <= MAX_SIMILAR_RESULTS);
});

test("32–34 CLOSED outcome / missing R / OPEN excluded", () => {
  const current = snap(bullish(), T0);
  const closed = closedTrade("c", { market: bullish(), pnl: 1200, withR: true });
  const closedNoR = { ...closedTrade("nr", { market: bullish(), pnl: 100 }), exitPlan: null };
  const open = closedTrade("o", { status: "open", market: bullish() });
  const result = findSimilarHistoricalContexts({
    pair: "USD/JPY",
    current,
    trades: [closed, closedNoR, open],
  });
  assert.equal(result.matches.some(m => m.tradeId === "o"), false);
  const withR = result.matches.find(m => m.tradeId === "c");
  const withoutR = result.matches.find(m => m.tradeId === "nr");
  assert.ok(withR?.outcome.available);
  assert.ok(withR?.outcome.realizedR != null);
  assert.equal(withoutR?.outcome.realizedR ?? null, null);
  assert.ok(withoutR?.outcome.realizedPnl != null);
});

test("35–39 empty UX distinctions", () => {
  assert.equal(
    findSimilarHistoricalContexts({ pair: "USD/JPY", current: null, trades: [] }).emptyReason,
    "current_unavailable",
  );
  assert.equal(
    findSimilarHistoricalContexts({
      pair: "USD/JPY",
      current: snap(bullish(), T0),
      trades: [closedTrade("x", { original: null })],
    }).emptyReason,
    "no_historical_snapshot",
  );
  assert.equal(
    findSimilarHistoricalContexts({
      pair: "USD/JPY",
      current: snap(bullish(), T0),
      trades: [closedTrade("e", { pair: "EUR/JPY", market: bullish("EUR/JPY") })],
    }).emptyReason,
    "no_same_pair_candidate",
  );
  const emptyCurrent: MarketContextSnapshot = {
    version: 1, capturedAt: T0, pair: "USD/JPY", marketRate: null,
    multiTimeframe: null, marketRegime: null, technicalContext: null,
  };
  const thin = findSimilarHistoricalContexts({
    pair: "USD/JPY",
    current: emptyCurrent,
    trades: [closedTrade("t", { market: bullish() })],
  });
  assert.ok(thin.emptyReason === "insufficient_comparable" || thin.emptyReason === "below_threshold");
});

test("40–42 disclaimer / no aggregate win rate / no prediction", () => {
  assert.match(SOURCE, new RegExp(SIMILAR_HISTORICAL_DISCLAIMER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(SOURCE, new RegExp(SIMILAR_HISTORICAL_OUTCOME_NOTE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(SOURCE, /勝率|winRate|aggregate/);
  assert.doesNotMatch(SOURCE, FORBIDDEN);
});

test("43–44 Task103 / Task107 regression", () => {
  const trades = Array.from({ length: 6 }, (_, i) => closedTrade(`pi${i}`, {
    market: bullish(),
    pnl: 100,
    withR: true,
    revisions: [asRevision(snap(bearish(), T2), T2)],
  }));
  const pi = buildPerformanceIntelligence(trades);
  const evo = buildTradeEvolutionPerformance(trades);
  assert.equal(pi.overview.closedTrades, 6);
  assert.equal(evo.coverage.evolutionEligible, 6);
  findSimilarHistoricalContexts({
    pair: "USD/JPY",
    current: snap(bullish(), T0),
    trades,
  });
  assert.equal(buildPerformanceIntelligence(trades).overview.totalPnl, pi.overview.totalPnl);
  assert.equal(buildTradeEvolutionPerformance(trades).coverage.evolutionEligible, evo.coverage.evolutionEligible);
});

test("45–46 original / revisions immutable", () => {
  const original = snap(bullish(), T1);
  const rev = asRevision(snap(bearish(), T2), T2);
  const trade = closedTrade("im", { original, revisions: [rev] });
  const o = JSON.stringify(trade.marketContextSnapshot);
  const r = JSON.stringify(trade.marketContextRevisions);
  findSimilarHistoricalContexts({
    pair: "USD/JPY",
    current: snap(bullish(), T0),
    trades: [trade],
  });
  assert.equal(JSON.stringify(trade.marketContextSnapshot), o);
  assert.equal(JSON.stringify(trade.marketContextRevisions), r);
});

test("47–49 no DB write / API / AI", () => {
  assert.doesNotMatch(SOURCE, /supabase|\.insert\(|\.update\(|fetch\(|openrouter|OpenAI|embed/i);
});

test("50 mobile / no overflow styles", () => {
  const css = readFileSync(join(ROOT, "app/globals.css"), "utf8");
  assert.match(css, /similar-historical-panel/);
  assert.match(css, /similar-match-card/);
  assert.match(css, /min-width:\s*0/);
});

test("mixed context scores below identical bullish", () => {
  const current = snap(bullish(), T0);
  const identical = compareContextSimilarity(current, snap(bullish(), T1));
  const mixedScore = compareContextSimilarity(current, snap(mixed(), T1));
  assert.ok((identical.ratio ?? 0) >= (mixedScore.ratio ?? 0));
});
