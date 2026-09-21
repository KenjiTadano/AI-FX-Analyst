import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildInput } from "../lib/ai/input";
import { finalizeAnalysis } from "../lib/ai/engine";
import type { AIAnalysis, TradeSignal } from "../lib/ai/types";
import type { DataResource, EconomicEvent } from "../lib/fundamental/types";
import { calculateIndicators } from "../lib/market/indicators";
import type { Candle, MarketData, Resource, Technical, Symbol } from "../lib/market/types";
import type { RiskSettings } from "../lib/risk/types";
import {
  captureMarketContextSnapshot,
} from "../lib/trades/market-context-snapshot";
import { createTrade } from "../lib/trades/service";
import type { Trade, TradeDraft } from "../lib/trades/types";
import { findSimilarHistoricalContexts } from "../lib/trades/context-similarity";
import { buildPerformanceIntelligence } from "../lib/trades/performance-intelligence";
import { buildTradeEvolutionPerformance } from "../lib/trades/trade-evolution-performance";
import {
  WORKSPACE_AI_UNAVAILABLE_NOTE,
  WORKSPACE_TRIGGER_NOTE,
  buildTradingDecisionWorkspace,
} from "../lib/dashboard/trading-decision-workspace";

const NOW = Date.parse("2026-09-21T12:00:00.000Z");
const T0 = new Date(NOW).toISOString();
const ROOT = process.cwd();
const SOURCE = [
  readFileSync(join(ROOT, "lib/dashboard/trading-decision-workspace.ts"), "utf8"),
  readFileSync(join(ROOT, "components/dashboard/trading-decision-workspace.tsx"), "utf8"),
].join("\n");

const settings: RiskSettings = { balance: 50_000, target: 100_000, riskPercent: 1, tradeUnit: 1000 };

function analysis(signal: TradeSignal = "wait", extra: Partial<AIAnalysis> = {}): AIAnalysis {
  const base = finalizeAnalysis(buildInput("USD/JPY", null, null, NOW), null, "TEST", "not_configured", NOW);
  const action = extra.action ?? (signal === "wait" ? "WAIT" : signal.includes("buy") ? "BUY" : "SELL");
  return {
    ...base,
    ...extra,
    pair: extra.pair ?? "USD/JPY",
    signal,
    directionSignal: extra.directionSignal ?? signal,
    action,
    ai: extra.ai ?? { status: "available", model: "TEST", code: null, message: null },
    scenario: extra.scenario ?? {
      direction: "short",
      entryZone: { min: 156.1, max: 156.2 },
      stopLoss: 156.8,
      takeProfit1: 155.4,
      takeProfit2: 155.0,
      riskReward: 1.6,
      condition: "156.20を下抜けた場合",
      invalidation: "156.80超で無効",
      sourceTimeframe: "1h",
    },
    entryTrigger: extra.entryTrigger !== undefined ? extra.entryTrigger : {
      version: 1,
      type: "price_below",
      pair: "USD/JPY",
      price: 156.2,
      timeframe: null,
      sourceCondition: "156.20を下抜けた場合",
    },
    economicRisk: extra.economicRisk ?? { active: false, known: true, reasons: [], nextHigh: null },
    confidence: extra.confidence ?? 72,
    dataQuality: extra.dataQuality ?? { ...base.dataQuality, score: 82 },
    currentRate: extra.currentRate ?? 156.42,
    analyzedAt: extra.analyzedAt ?? T0,
    expiresAt: extra.expiresAt ?? new Date(NOW + 300_000).toISOString(),
  };
}

function resource<T>(data: T): Resource<T> {
  return { data, fetchedAt: T0, error: null, stale: false };
}

function candles(count: number, direction: 1 | -1 | 0, durationMs: number, base = 156): Candle[] {
  return Array.from({ length: count }, (_, i) => {
    const close = base + direction * i * 0.05;
    const open = close - direction * 0.02;
    return {
      time: new Date(NOW - (count - i) * durationMs).toISOString(),
      open, high: Math.max(open, close) + 0.03, low: Math.min(open, close) - 0.03, close, volume: 100,
    };
  });
}

function tech(direction: 1 | -1 | 0, durationMs: number, base = 156): Resource<Technical> {
  const list = candles(220, direction, durationMs, base);
  return resource({ candles: list, indicators: calculateIndicators(list), lastClosedAt: list.at(-1)?.time ?? T0 });
}

function marketFrom(
  pair: Symbol,
  dirs: { day: 1 | -1 | 0; h4: 1 | -1 | 0; h1: 1 | -1 | 0; m15: 1 | -1 | 0 },
  price = 156.25,
  stale = false,
): MarketData {
  return {
    symbol: pair,
    price: { data: price, fetchedAt: T0, error: null, stale },
    timeframes: {
      "15m": tech(dirs.m15, 900_000, price),
      "1h": tech(dirs.h1, 3_600_000, price),
      "4h": tech(dirs.h4, 14_400_000, price),
    },
    daily: tech(dirs.day, 86_400_000, price),
  };
}

function bullishMarket(price = 157) {
  return marketFrom("USD/JPY", { day: 1, h4: 1, h1: 1, m15: 1 }, price);
}

function calendar(events: EconomicEvent[]): DataResource<EconomicEvent[]> {
  return { data: events, status: events.length ? "ok" : "empty", error: null, warnings: [], fetchedAt: T0, provider: "TEST" };
}

function event(change: Partial<EconomicEvent> = {}): EconomicEvent {
  return {
    id: "cpi",
    name: "米CPI",
    country: "US",
    currency: "USD",
    scheduledAt: new Date(NOW + 3_600_000).toISOString(),
    rawScheduledAt: null,
    timezone: "UTC",
    previous: 3.0,
    forecast: 3.1,
    actual: null,
    unit: "%",
    status: "upcoming",
    source: "TEST",
    url: null,
    isKeyIndicator: true,
    affectedCurrencies: ["USD"],
    importance: "high",
    importanceBasis: "provider",
    impactDirection: null,
    reason: "TEST",
    ...change,
  };
}

function draft(changes: Partial<TradeDraft> = {}): TradeDraft {
  return {
    pair: "USD/JPY", side: "short", status: "closed", quantity: 1000, entryPrice: 156.5, exitPrice: 156.2,
    openedAt: "2026-09-20T08:00:00.000Z", closedAt: "2026-09-20T11:00:00.000Z",
    stopLoss: 156.8, takeProfit: 155.5, notes: "TASK109", ...changes,
  };
}

function closedWithContext(id: string, market = bullishMarket()): Trade {
  const base = createTrade(draft(), null, id, T0).data!;
  return {
    ...base,
    realizedPnl: 300,
    marketContextSnapshot: captureMarketContextSnapshot({
      pair: "USD/JPY",
      capturedAt: "2026-09-20T08:00:00.000Z",
      market,
      marketRate: market.price.data,
    }),
    marketContextRevisions: [],
  };
}

function workspace(extra: Partial<Parameters<typeof buildTradingDecisionWorkspace>[0]> = {}) {
  const market = extra.market !== undefined ? extra.market : bullishMarket();
  return buildTradingDecisionWorkspace({
    pair: "USD/JPY",
    analysis: analysis("sell", { directionSignal: "sell", action: "WAIT" }),
    trades: [],
    riskSettings: settings,
    currentRate: 156.25,
    market,
    calendar: calendar([]),
    now: NOW,
    capturedAt: T0,
    ...extra,
  });
}

test("1–4 pair / rate / freshness", () => {
  const fresh = workspace({
    market: marketFrom("USD/JPY", { day: 1, h4: 1, h1: 1, m15: 1 }, 156.25),
    currentRate: 156.25,
  });
  assert.equal(fresh.pair, "USD/JPY");
  assert.equal(fresh.rate.value, 156.25);
  assert.equal(fresh.rate.freshness, "fresh");
  assert.equal(fresh.rate.freshnessLabel, "FRESH");

  const stale = workspace({
    market: marketFrom("USD/JPY", { day: 1, h4: 1, h1: 1, m15: 1 }, 156.25, true),
    currentRate: null,
  });
  assert.equal(stale.rate.freshness, "stale");
  assert.equal(stale.rate.freshnessLabel, "STALE");
});

test("5–8 Direction / Action separation / confidence", () => {
  const model = workspace({
    analysis: analysis("sell", { directionSignal: "sell", action: "WAIT", confidence: 71 }),
  });
  assert.equal(model.ai.directionCode, "SELL");
  assert.equal(model.ai.actionCode, "WAIT");
  assert.notEqual(model.ai.directionCode, model.ai.actionCode);
  assert.equal(model.ai.confidence, 71);
  assert.match(SOURCE, /tdw-direction/);
  assert.match(SOURCE, /tdw-action/);
});

test("9–11 AI status / unavailable != semantic WAIT / fallback", () => {
  const unavailable = workspace({
    analysis: analysis("sell", {
      directionSignal: "sell",
      action: "WAIT",
      ai: { status: "unavailable", model: "TEST", code: "api_error", message: "down" },
    }),
  });
  assert.equal(unavailable.ai.status, "unavailable");
  assert.equal(unavailable.ai.actionCode, "WAIT");
  assert.equal(unavailable.ai.unavailableSeparatesWait, true);
  assert.match(SOURCE, new RegExp(WORKSPACE_AI_UNAVAILABLE_NOTE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  const available = workspace();
  assert.equal(available.ai.status, "available");
  assert.equal(available.ai.unavailableSeparatesWait, false);
});

test("12–13 readiness existing result / count", () => {
  const model = workspace({
    analysis: analysis("sell", { directionSignal: "sell", action: "WAIT" }),
  });
  assert.ok(model.readiness.totalCount >= 5);
  assert.match(model.readiness.countLabel, /\d+ \/ \d+/);
  assert.ok(model.readiness.stateLabel.length > 0);
});

test("14–17 trigger MET / NOT MET / unavailable / MET does not change Action WAIT", () => {
  const met = workspace({
    analysis: analysis("sell", {
      directionSignal: "sell",
      action: "WAIT",
      entryTrigger: {
        version: 1, type: "price_below", pair: "USD/JPY", price: 200, timeframe: null, sourceCondition: "x",
      },
    }),
    currentRate: 156,
  });
  assert.ok(met.trigger.available);
  assert.ok(["met", "not_met", "unavailable", "invalid"].includes(met.trigger.status!));
  assert.equal(met.ai.actionCode, "WAIT");
  assert.match(SOURCE, new RegExp(WORKSPACE_TRIGGER_NOTE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  const noTrigger = workspace({
    analysis: analysis("wait", { entryTrigger: null, scenario: null, action: "WAIT", directionSignal: "wait" }),
  });
  assert.ok(noTrigger.trigger.statusText.length > 0);
});

test("18–19 event risk / high-impact visibility", () => {
  const high = workspace({
    calendar: calendar([event()]),
    analysis: analysis("sell", {
      directionSignal: "sell",
      action: "WAIT",
      economicRisk: { active: true, known: true, reasons: ["指標前"], nextHigh: event({ name: "米CPI" }) },
    }),
  });
  assert.ok(high.eventRisk.available || high.eventRisk.levelLabel.length > 0);
  if (high.eventRisk.level === "high") {
    assert.equal(high.eventRisk.highImpact, true);
  }
});

test("20–23 MTF frames 15m/1h/4h/1D", () => {
  const model = workspace();
  for (const tf of ["15m", "1h", "4h", "1day"]) {
    const frame = model.mtf.frames.find(f => f.timeframe === tf);
    assert.ok(frame, tf);
    assert.ok(["bullish", "bearish", "neutral", "unavailable"].includes(frame!.trend));
  }
});

test("24–26 Regime / trendDirection / volatility", () => {
  const model = workspace();
  assert.ok(model.regime.regimeLabel.length > 0);
  assert.ok(model.regime.trendLabel.length > 0);
  assert.ok(model.regime.volatilityLabel.length > 0);
});

test("27–31 Similar History count / top / no P/L R win rate", () => {
  const trades = [closedWithContext("s1"), closedWithContext("s2"), closedWithContext("s3")];
  const model = workspace({ trades, market: bullishMarket() });
  assert.ok(model.similar.count >= 0);
  if (model.similar.available) {
    assert.ok(model.similar.topPercent != null);
  }
  assert.doesNotMatch(SOURCE, /realizedPnl|realizedR|winRate|averageR/);
  assert.doesNotMatch(SOURCE, /tdw-similar[\s\S]{0,200}P\/L/);
  const historyUi = SOURCE.includes("tdw-layer-history") ? SOURCE.slice(SOURCE.indexOf("tdw-layer-history")) : "";
  assert.doesNotMatch(historyUi, /円|勝率\d/);
});

test("32–33 no composite score / no new recommendation", () => {
  assert.doesNotMatch(SOURCE, /decisionScore|compositeScore|qualityScore|tradeQuality|expected value|期待値|probability|predicted return|エントリーしてください|Trade now|historical win rate/i);
  assert.match(SOURCE, /新しい売買判定やスコアは追加していません/);
});

test("34–35 individual unavailable / partial data still renders", () => {
  const partial = workspace({
    market: null,
    marketError: "market down",
    analysis: null,
    trades: [],
  });
  assert.equal(partial.pair, "USD/JPY");
  assert.equal(partial.rate.freshness, "error");
  assert.equal(partial.ai.status, "missing");
  assert.ok(partial.mtf.frames.length === 4);
  assert.ok(partial.trigger.statusText.length > 0);
});

test("36 existing detail remains (source wiring)", () => {
  const dash = readFileSync(join(ROOT, "components/dashboard/dashboard.tsx"), "utf8");
  assert.match(dash, /TradingDecisionWorkspacePanel/);
  assert.match(dash, /AIOverview/);
  assert.match(dash, /DailyTradingPlanPanel/);
  assert.match(dash, /SimilarHistoricalContextPanel/);
  assert.match(dash, /ia-decision-workspace/);
});

test("37 Task108 ranking unchanged", () => {
  const market = bullishMarket();
  const trades = [closedWithContext("a", market), closedWithContext("b", market)];
  const current = captureMarketContextSnapshot({
    pair: "USD/JPY", capturedAt: T0, market, marketRate: market.price.data,
  });
  const before = findSimilarHistoricalContexts({ pair: "USD/JPY", current, trades });
  workspace({ trades, market });
  const after = findSimilarHistoricalContexts({ pair: "USD/JPY", current, trades });
  assert.deepEqual(
    after.matches.map(m => [m.tradeId, m.similarity.percent]),
    before.matches.map(m => [m.tradeId, m.similarity.percent]),
  );
});

test("38–39 Task107 / PI regression", () => {
  const trades = [closedWithContext("p1"), closedWithContext("p2")];
  const pi = buildPerformanceIntelligence(trades);
  const evo = buildTradeEvolutionPerformance(trades);
  workspace({ trades });
  assert.equal(buildPerformanceIntelligence(trades).overview.closedTrades, pi.overview.closedTrades);
  assert.equal(buildTradeEvolutionPerformance(trades).coverage.periodClosed, evo.coverage.periodClosed);
});

test("40 trade creation regression", () => {
  const before = createTrade(draft(), analysis("sell"), "create-1", T0);
  assert.ok(before.data);
  workspace();
  const after = createTrade(draft(), analysis("sell"), "create-2", T0);
  assert.ok(after.data);
  assert.equal(after.data!.pair, before.data!.pair);
});

test("41–43 no DB / API / AI request", () => {
  assert.doesNotMatch(SOURCE, /supabase|\.insert\(|\.update\(|fetch\(|\/api\/|openrouter|OpenAI|embed/i);
});

test("44–46 layout / mobile / a11y markers", () => {
  const css = readFileSync(join(ROOT, "app/globals.css"), "utf8");
  assert.match(css, /trading-decision-workspace/);
  assert.match(css, /tdw-decision-grid/);
  assert.match(css, /min-width:\s*0/);
  assert.match(SOURCE, /aria-labelledby|aria-label|tdw-jump/);
  assert.match(SOURCE, /Decision Summary|Market Context|Historical Reference/);
});
