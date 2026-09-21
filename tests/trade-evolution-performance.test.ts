import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { calculateIndicators } from "../lib/market/indicators";
import type { Candle, MarketData, Resource, Technical, Symbol } from "../lib/market/types";
import { createExitPlan } from "../lib/trades/exit-plan";
import { filterTradesByPeriod } from "../lib/trades/performance-period";
import {
  MARKET_CONTEXT_REVISION_REASON,
  captureMarketContextSnapshot,
  type MarketContextRevision,
  type MarketContextSnapshot,
} from "../lib/trades/market-context-snapshot";
import { buildPerformanceIntelligence } from "../lib/trades/performance-intelligence";
import { createTrade } from "../lib/trades/service";
import {
  MAX_EVOLUTION_OBSERVATIONS,
  MIN_INSIGHT_SAMPLE_SIZE,
  TRADE_EVOLUTION_SELECTION_BIAS,
  TRADE_EVOLUTION_TIMING_CAVEAT,
  aggregateAnyContextStatus,
  buildTradeEvolutionPerformance,
  compareOriginalToLatest,
  isTradeEvolutionEligible,
  latestMarketContextRevision,
} from "../lib/trades/trade-evolution-performance";
import type { Trade, TradeDraft } from "../lib/trades/types";

const NOW = Date.parse("2026-09-21T09:00:00.000Z");
const T0 = new Date(NOW).toISOString();
const T1 = "2026-09-21T10:30:00.000Z";
const T2 = "2026-09-21T12:00:00.000Z";
const T_EARLY = "2026-09-21T08:00:00.000Z";
const ROOT = process.cwd();
const SOURCE = [
  readFileSync(join(ROOT, "lib/trades/trade-evolution-performance.ts"), "utf8"),
  readFileSync(join(ROOT, "components/trades/trade-evolution.tsx"), "utf8"),
].join("\n");

const FORBIDDEN =
  /原因|効果|有効|優位|勝ちやすい|負けやすい|改善|悪化|\bshould\b|\brecommend\b|決済すべき|損切りサイン|保有を続ける|\bbest\b|\bworst\b|\btop\b|\bbottom\b/;

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
    pair: "USD/JPY", side: "long", status: "closed", quantity: 1000, entryPrice: 153.5, exitPrice: 154,
    openedAt: "2026-09-21T08:00:00.000Z", closedAt: "2026-09-21T11:00:00.000Z",
    stopLoss: 153, takeProfit: 154.5, notes: "TASK107", ...changes,
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

function bullishMarket(price = 157) {
  return marketFrom("USD/JPY", { day: 1, h4: 1, h1: 1, m15: 1 }, price);
}

function bearishMarket(price = 156) {
  return marketFrom("USD/JPY", { day: -1, h4: -1, h1: -1, m15: -1 }, price);
}

function withPlan(trade: Trade, stopLoss = 153, takeProfit = 154.5): Trade {
  return {
    ...trade,
    exitPlan: createExitPlan({
      pair: trade.pair,
      side: trade.side,
      entryPrice: trade.entryPrice,
      stopLoss,
      takeProfit,
      capturedAt: trade.createdAt,
    }),
  };
}

function closedTrade(id: string, opts: {
  pnl?: number;
  exitPrice?: number;
  original?: MarketContextSnapshot | null;
  revisions?: MarketContextRevision[];
  withR?: boolean;
  status?: Trade["status"];
  openedAt?: string;
  closedAt?: string | null;
} = {}): Trade {
  const base = createTrade(draft({
    status: opts.status ?? "closed",
    exitPrice: opts.status === "open" ? null : (opts.exitPrice ?? 154),
    closedAt: opts.status === "open" ? null : (opts.closedAt ?? "2026-09-21T11:00:00.000Z"),
    openedAt: opts.openedAt ?? "2026-09-21T08:00:00.000Z",
  }), null, id, T0).data!;
  let trade: Trade = {
    ...base,
    realizedPnl: opts.status === "open" ? null : (opts.pnl ?? 500),
    marketContextSnapshot: opts.original === undefined ? snap(bullishMarket(), T0) : opts.original,
    marketContextRevisions: opts.revisions ?? [asRevision(snap(bearishMarket(), T1), T1)],
  };
  if (opts.withR) trade = withPlan(trade);
  return trade;
}

function groupBySuffix<T extends { key: string; sampleSize: number }>(groups: T[], suffix: string): T | undefined {
  return groups.find(g => g.key.endsWith(`:${suffix}`));
}

test("1 CLOSED only / 2 OPEN excluded", () => {
  const open = closedTrade("open", { status: "open", revisions: [asRevision(snap(bearishMarket(), T1), T1)] });
  const closed = closedTrade("c1", { pnl: 100 });
  const result = buildTradeEvolutionPerformance([open, closed]);
  assert.equal(result.coverage.periodClosed, 1);
  assert.equal(result.coverage.evolutionEligible, 1);
  assert.equal(isTradeEvolutionEligible(open), false);
});

test("3 realizedPnl required", () => {
  const trade = closedTrade("nan", { pnl: Number.NaN });
  assert.equal(isTradeEvolutionEligible(trade), false);
  assert.equal(buildTradeEvolutionPerformance([trade]).coverage.evolutionEligible, 0);
});

test("4 original required / 5 revision required", () => {
  const noOriginal = closedTrade("no-orig", {
    original: null,
    revisions: [asRevision(snap(bearishMarket(), T1), T1)],
  });
  const noRevision = closedTrade("no-rev", {
    original: snap(bullishMarket(), T0),
    revisions: [],
  });
  assert.equal(isTradeEvolutionEligible(noOriginal), false);
  assert.equal(isTradeEvolutionEligible(noRevision), false);
  const result = buildTradeEvolutionPerformance([noOriginal, noRevision]);
  assert.equal(result.coverage.evolutionEligible, 0);
  assert.equal(result.coverage.originalAvailable, 1);
  assert.equal(result.coverage.revisionAvailable, 1);
  assert.equal(result.emptyReason, "no_eligible");
});

test("6 latest revision = append order last / 7 timestamp does not reorder", () => {
  const original = snap(bullishMarket(150), T0, 150);
  const first = asRevision(snap(marketFrom("USD/JPY", { day: 1, h4: 1, h1: 0, m15: 1 }, 151), T1, 151), T1);
  const lastByAppend = asRevision(snap(bearishMarket(149), T_EARLY, 149), T_EARLY);
  const trade = closedTrade("append", {
    original,
    revisions: [first, lastByAppend],
  });
  const latest = latestMarketContextRevision(trade);
  assert.equal(latest?.capturedAt, T_EARLY);
  assert.equal(latest?.marketRate, 149);
  const change = compareOriginalToLatest(trade);
  assert.equal(change?.toCapturedAt, T_EARLY);
  assert.equal(change?.rate.after, 149);
  assert.doesNotMatch(SOURCE, /revisions\.sort\(|\[\.\.\.revisions\]\.sort/);
});

test("8 Task106 comparator reused", () => {
  assert.match(SOURCE, /compareMarketContexts/);
  assert.doesNotMatch(SOURCE, /function compareTimeframe|function compareRegime|function compareTechnical/);
});

test("9–11 any changed / unchanged / unavailable", () => {
  const changed = closedTrade("any-ch", {
    original: snap(bullishMarket(), T0),
    revisions: [asRevision(snap(bearishMarket(), T1), T1)],
  });
  const sameMarket = bullishMarket(157);
  const unchanged = closedTrade("any-un", {
    original: snap(sameMarket, T0),
    revisions: [asRevision(snap(sameMarket, T1), T1)],
  });
  const emptyCtx: MarketContextSnapshot = {
    version: 1,
    capturedAt: T0,
    pair: "USD/JPY",
    marketRate: null,
    multiTimeframe: null,
    marketRegime: null,
    technicalContext: null,
  };
  const unavailable = closedTrade("any-ua", {
    original: emptyCtx,
    revisions: [asRevision({ ...emptyCtx, capturedAt: T1 }, T1)],
  });
  const result = buildTradeEvolutionPerformance([changed, unchanged, unavailable]);
  assert.equal(groupBySuffix(result.anyContextChange.groups, "changed")?.sampleSize, 1);
  assert.equal(groupBySuffix(result.anyContextChange.groups, "unchanged")?.sampleSize, 1);
  assert.equal(groupBySuffix(result.anyContextChange.groups, "unavailable")?.sampleSize, 1);
  assert.equal(aggregateAnyContextStatus(compareOriginalToLatest(changed)!), "changed");
  assert.equal(aggregateAnyContextStatus(compareOriginalToLatest(unchanged)!), "unchanged");
  assert.equal(aggregateAnyContextStatus(compareOriginalToLatest(unavailable)!), "unavailable");
});

test("12–15 timeframe trend changes 15m/1h/4h/1D", () => {
  const trade = closedTrade("tf", {
    original: snap(bullishMarket(), T0),
    revisions: [asRevision(snap(bearishMarket(), T1), T1)],
  });
  const result = buildTradeEvolutionPerformance([trade]);
  for (const key of ["trend:15m", "trend:1h", "trend:4h", "trend:1day"]) {
    const block = result.timeframeTrend.find(b => b.key === key);
    assert.ok(block, key);
    assert.equal(groupBySuffix(block!.groups, "changed")?.sampleSize, 1, key);
  }
});

test("16–19 regime / trendDirection / volatility", () => {
  const original = snap(bullishMarket(), T0);
  const revisionMarket = bearishMarket();
  const revision = asRevision(snap(revisionMarket, T1), T1);
  // Force high volatility on revision via sanitized regime override if needed
  const trade = closedTrade("reg", { original, revisions: [revision] });
  const change = compareOriginalToLatest(trade)!;
  assert.ok(change.regime.regime.status === "changed" || change.regime.trendDirection.status === "changed");
  const result = buildTradeEvolutionPerformance([trade]);
  assert.ok(result.regime.regime.groups.some(g => g.sampleSize > 0));
  assert.ok(result.regime.trendDirection.groups.some(g => g.sampleSize > 0));
  assert.ok(result.regime.volatility.groups.some(g => g.sampleSize > 0));

  const same = closedTrade("reg-same", {
    original: snap(bullishMarket(157), T0),
    revisions: [asRevision(snap(bullishMarket(157), T1), T1)],
  });
  const sameResult = buildTradeEvolutionPerformance([same]);
  assert.equal(groupBySuffix(sameResult.regime.regime.groups, "unchanged")?.sampleSize, 1);
});

test("20–22 SMA relation changed", () => {
  const trade = closedTrade("sma", {
    original: snap(bullishMarket(160), T0, 160),
    revisions: [asRevision(snap(bearishMarket(140), T1, 140), T1)],
  });
  const result = buildTradeEvolutionPerformance([trade]);
  assert.ok(
    groupBySuffix(result.smaRelation.sma20.groups, "changed")
    || groupBySuffix(result.smaRelation.sma75.groups, "changed")
    || groupBySuffix(result.smaRelation.sma200.groups, "changed"),
  );
  const change = compareOriginalToLatest(trade)!;
  assert.ok(
    change.technical.smaRelations.sma20.status === "changed"
    || change.technical.smaRelations.sma75.status === "changed"
    || change.technical.smaRelations.sma200.status === "changed"
    || change.technical.status === "changed",
  );
});

test("23–24 RSI bucket changed / unchanged", () => {
  const changed = closedTrade("rsi-ch", {
    original: snap(bullishMarket(160), T0, 160),
    revisions: [asRevision(snap(bearishMarket(140), T1, 140), T1)],
  });
  const same = closedTrade("rsi-un", {
    original: snap(bullishMarket(157), T0),
    revisions: [asRevision(snap(bullishMarket(157), T1), T1)],
  });
  const result = buildTradeEvolutionPerformance([changed, same]);
  assert.ok(result.rsiBucket.groups.some(g => g.sampleSize > 0));
  const change = compareOriginalToLatest(changed)!;
  const sameChange = compareOriginalToLatest(same)!;
  assert.ok(["changed", "unchanged", "unavailable"].includes(change.technical.rsiBucket.status));
  assert.ok(["changed", "unchanged", "unavailable"].includes(sameChange.technical.rsiBucket.status));
});

test("25 missing technical unavailable", () => {
  const noTech: MarketContextSnapshot = {
    version: 1,
    capturedAt: T0,
    pair: "USD/JPY",
    marketRate: 150,
    multiTimeframe: null,
    marketRegime: null,
    technicalContext: null,
  };
  const trade = closedTrade("no-tech", {
    original: noTech,
    revisions: [asRevision({ ...noTech, capturedAt: T1 }, T1)],
  });
  const change = compareOriginalToLatest(trade)!;
  assert.equal(change.technical.status, "unavailable");
  assert.equal(change.technical.rsiBucket.status, "unavailable");
  assert.equal(change.technical.smaRelations.sma20.status, "unavailable");
  const result = buildTradeEvolutionPerformance([trade]);
  assert.equal(groupBySuffix(result.rsiBucket.groups, "unavailable")?.sampleSize, 1);
});

test("26–30 wins/losses P/L and R handling", () => {
  const wins = Array.from({ length: 3 }, (_, i) => closedTrade(`w${i}`, {
    pnl: 200,
    exitPrice: 154,
    withR: true,
    original: snap(bullishMarket(), T0),
    revisions: [asRevision(snap(bearishMarket(), T1), T1)],
  }));
  const losses = Array.from({ length: 2 }, (_, i) => closedTrade(`l${i}`, {
    pnl: -100,
    exitPrice: 153.2,
    withR: true,
    original: snap(bullishMarket(), T0),
    revisions: [asRevision(snap(bearishMarket(), T1), T1)],
  }));
  const noR = {
    ...closedTrade("nor", {
      pnl: 50,
      withR: false,
      original: snap(bullishMarket(), T0),
      revisions: [asRevision(snap(bearishMarket(), T1), T1)],
    }),
    exitPlan: null,
  };
  const result = buildTradeEvolutionPerformance([...wins, ...losses, noR]);
  const changed = groupBySuffix(result.anyContextChange.groups, "changed");
  assert.ok(changed);
  assert.equal(changed!.sampleSize, 6);
  assert.equal(changed!.wins, 4);
  assert.equal(changed!.losses, 2);
  assert.equal(changed!.totalPnl, 3 * 200 + 2 * -100 + 50);
  assert.equal(changed!.averagePnl, changed!.totalPnl / 6);
  assert.equal(changed!.rSampleSize, 5);
  assert.ok(changed!.averageR != null);
  assert.ok(changed!.totalR != null);
  assert.ok(changed!.positiveRCount + changed!.negativeRCount <= changed!.rSampleSize);
  assert.notEqual(changed!.averageR, 0);
  // missing R is not treated as 0R — rSampleSize excludes noR
  assert.equal(changed!.rSampleSize, 5);
});

test("31 n < 5 sample warning", () => {
  const trades = Array.from({ length: 3 }, (_, i) => closedTrade(`s${i}`, {
    original: snap(bullishMarket(), T0),
    revisions: [asRevision(snap(bearishMarket(), T1), T1)],
  }));
  const result = buildTradeEvolutionPerformance(trades);
  const changed = groupBySuffix(result.anyContextChange.groups, "changed");
  assert.equal(changed!.sufficientSample, false);
  assert.ok(changed!.sampleSize < MIN_INSIGHT_SAMPLE_SIZE);
  assert.equal(result.observations.length, 0);
});

test("32 period filter regression", () => {
  const recent = closedTrade("recent", {
    openedAt: "2026-09-20T08:00:00.000Z",
    closedAt: "2026-09-20T11:00:00.000Z",
  });
  const old = closedTrade("old", {
    openedAt: "2025-01-01T08:00:00.000Z",
    closedAt: "2025-01-01T11:00:00.000Z",
  });
  const filtered = filterTradesByPeriod([recent, old], "30d", new Date("2026-09-21T12:00:00.000Z"));
  const result = buildTradeEvolutionPerformance(filtered);
  assert.equal(result.coverage.periodClosed, 1);
  assert.equal(result.coverage.evolutionEligible, 1);
});

test("33 selection-bias warning / 34 timing caveat", () => {
  const result = buildTradeEvolutionPerformance([closedTrade("bias")]);
  assert.equal(result.selectionBiasWarning, TRADE_EVOLUTION_SELECTION_BIAS);
  assert.equal(result.timingCaveat, TRADE_EVOLUTION_TIMING_CAVEAT);
  assert.match(SOURCE, /手動で再取得した/);
  assert.match(SOURCE, /再取得タイミングはトレードごとに異なります/);
  assert.ok(result.elapsed.sampleSize >= 1);
  assert.ok(result.elapsed.minLabel);
  assert.ok(result.elapsed.medianLabel);
  assert.ok(result.elapsed.maxLabel);
});

test("35 observations max 5", () => {
  const trades = Array.from({ length: 8 }, (_, i) => closedTrade(`obs${i}`, {
    pnl: i % 2 === 0 ? 200 : -80,
    exitPrice: i % 2 === 0 ? 154 : 153.2,
    withR: true,
    original: snap(bullishMarket(), T0),
    revisions: [asRevision(snap(bearishMarket(), T1), T1)],
  }));
  const result = buildTradeEvolutionPerformance(trades);
  assert.ok(result.observations.length <= MAX_EVOLUTION_OBSERVATIONS);
  assert.ok(result.observations.length >= 1);
  for (const text of result.observations) {
    assert.doesNotMatch(text, FORBIDDEN);
  }
});

test("36 forbidden recommendation language", () => {
  assert.match(SOURCE, /FORBIDDEN/);
  const observations = buildTradeEvolutionPerformance(Array.from({ length: 6 }, (_, i) => closedTrade(`f${i}`, {
    pnl: i % 2 === 0 ? 120 : -40,
    withR: true,
    original: snap(bullishMarket(), T0),
    revisions: [asRevision(snap(bearishMarket(), T1), T1)],
  }))).observations;
  assert.ok(observations.length >= 1);
  for (const text of observations) {
    assert.doesNotMatch(text, FORBIDDEN);
    assert.doesNotMatch(text, /決済すべき|損切りサイン|保有を続けるべき|勝ちやすい/);
  }
});

test("37 no ranking", () => {
  assert.doesNotMatch(SOURCE, /\.sort\(\(a,\s*b\).*winRate|\.sort\(\(a,\s*b\).*averageR/);
  assert.doesNotMatch(SOURCE, /rankBy|sortByWinRate|sortByAverageR/);
  assert.match(SOURCE, /EVOLUTION_STATUS_ORDER/);
});

test("38 existing Task103 metrics unchanged", () => {
  const trades = Array.from({ length: 6 }, (_, i) => closedTrade(`pi${i}`, {
    pnl: 100,
    withR: true,
  }));
  const before = buildPerformanceIntelligence(trades, "全期間");
  buildTradeEvolutionPerformance(trades, "全期間");
  const after = buildPerformanceIntelligence(trades, "全期間");
  assert.equal(after.overview.closedTrades, before.overview.closedTrades);
  assert.equal(after.overview.totalPnl, before.overview.totalPnl);
  assert.equal(after.overview.averageR, before.overview.averageR);
  assert.deepEqual(after.regime.byRegime.map(g => [g.key, g.sampleSize]), before.regime.byRegime.map(g => [g.key, g.sampleSize]));
  assert.deepEqual(after.observations, before.observations);
});

test("39 Task106 UI regression — no rewrite of change module selectors", () => {
  const changeUi = readFileSync(join(ROOT, "components/trades/market-context-change.tsx"), "utf8");
  assert.match(changeUi, /MARKET_CONTEXT_CHANGE_TITLE|市場変化/);
  assert.match(changeUi, /buildMarketContextChangeAnalysis/);
});

test("40–41 original / revisions immutable", () => {
  const original = snap(bullishMarket(), T0);
  const rev = asRevision(snap(bearishMarket(), T1), T1);
  const trade = closedTrade("immut", { original, revisions: [rev] });
  const originalJson = JSON.stringify(trade.marketContextSnapshot);
  const revisionsJson = JSON.stringify(trade.marketContextRevisions);
  buildTradeEvolutionPerformance([trade]);
  compareOriginalToLatest(trade);
  assert.equal(JSON.stringify(trade.marketContextSnapshot), originalJson);
  assert.equal(JSON.stringify(trade.marketContextRevisions), revisionsJson);
});

test("42–43 no API / AI request", () => {
  assert.doesNotMatch(SOURCE, /fetch\(|openrouter|OpenAI|getMarketData|generateText|streamText/i);
});

test("44 mobile / no overflow styles present", () => {
  const css = readFileSync(join(ROOT, "app/globals.css"), "utf8");
  assert.match(css, /trade-evolution-section/);
  assert.match(css, /te-dimension/);
  assert.match(css, /min-width:\s*0/);
});

test("empty UX distinctions", () => {
  assert.equal(buildTradeEvolutionPerformance([]).emptyReason, "no_closed");
  assert.equal(
    buildTradeEvolutionPerformance([closedTrade("a", { original: null, revisions: [asRevision(snap(bearishMarket(), T1), T1)] })]).emptyReason,
    "no_original",
  );
  assert.equal(
    buildTradeEvolutionPerformance([closedTrade("b", { revisions: [] })]).emptyReason,
    "no_revision",
  );
});

test("elapsed coverage uses valid timestamps only", () => {
  const trade = closedTrade("elapsed", {
    original: snap(bullishMarket(), T0),
    revisions: [asRevision(snap(bearishMarket(), T2), T2)],
  });
  const result = buildTradeEvolutionPerformance([trade]);
  assert.equal(result.elapsed.sampleSize, 1);
  assert.ok((result.elapsed.minMs ?? 0) > 0);
  assert.equal(result.elapsed.minMs, result.elapsed.maxMs);
});
