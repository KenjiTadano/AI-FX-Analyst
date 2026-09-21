import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildInput } from "../lib/ai/input";
import { finalizeAnalysis } from "../lib/ai/engine";
import type { StructuredEntryTrigger } from "../lib/ai/entry-trigger";
import type { AIAnalysis, TradeSignal } from "../lib/ai/types";
import { calculateIndicators } from "../lib/market/indicators";
import { analyzeMarketRegime, type MarketRegimeAnalysis } from "../lib/market/market-regime";
import type { Candle, MarketData, Resource, Technical, Symbol } from "../lib/market/types";
import type { RiskSettings } from "../lib/risk/types";
import type { DataResource, EconomicEvent } from "../lib/fundamental/types";
import {
  ENTRY_CONTEXT_DISCLAIMER,
  ENTRY_CONTEXT_EYEBROW,
  ENTRY_CONTEXT_TITLE,
  ENTRY_MTF_ALIGNMENT_LABEL,
  buildLiveEntryContext,
  buildStoredEntryContext,
  entryContextLabels,
  formatDllStatus,
  formatEntryFreshness,
  mtfVsDirection,
} from "../lib/trades/entry-context";
import { captureMarketRegimeSnapshot, REGIME_SNAPSHOT_MISSING, storedMarketRegimeAnalysis } from "../lib/trades/regime-snapshot";
import { buildPreTradeReview } from "../lib/trades/pre-trade-review";
import { captureTradeAiSnapshot, isRichSnapshot, sanitizeTradeAiSnapshot } from "../lib/trades/snapshot";
import { closeTrade, createTrade, editTrade } from "../lib/trades/service";
import type { Trade, TradeDraft } from "../lib/trades/types";
import { buildDailyTradingPlan } from "../lib/trading-plan/daily-plan";
import { buildEntryReadiness } from "../lib/trading-plan/entry-readiness";

const NOW = Date.parse("2026-09-15T08:00:00.000Z");
const capturedAt = new Date(NOW).toISOString();
const ROOT = process.cwd();
const SOURCE = [
  readFileSync(join(ROOT, "lib/trades/entry-context.ts"), "utf8"),
  readFileSync(join(ROOT, "lib/trades/regime-snapshot.ts"), "utf8"),
  readFileSync(join(ROOT, "components/trades/entry-context.tsx"), "utf8"),
  readFileSync(join(ROOT, "components/trades/regime-snapshot.tsx"), "utf8"),
  readFileSync(join(ROOT, "components/trades/pre-trade-review.tsx"), "utf8"),
].join("\n");
const FORBIDDEN = /Entry OK|\bGO\b|Quality Score|良いEntry|悪いEntry|goodEntry|badEntry|ruleFollowed|ruleBroken|disciplineScore|complianceScore|勝ちやすい|負けやすい|おすすめ|条件が良い|条件が悪い/;
const settings: RiskSettings = { balance: 50_000, target: 100_000, riskPercent: 1, tradeUnit: 1000 };
const iso = (at = NOW) => new Date(at).toISOString();
const HOUR = 3_600_000;

function resource<T>(data: T): Resource<T> {
  return { data, fetchedAt: iso(), error: null, stale: false };
}

function candle(time: string, close: number, pad = 0.08): Candle {
  return { time, open: close, high: close + pad, low: close - pad, close };
}

function series(count: number, opts: {
  direction?: 1 | -1 | 0;
  step?: number;
  pad?: number;
  highTail?: number;
  highPad?: number;
  lowHead?: number;
  headPad?: number;
} = {}): Candle[] {
  const direction = opts.direction ?? 1;
  const step = opts.step ?? 0.02;
  const pad = opts.pad ?? 0.08;
  return Array.from({ length: count }, (_, i) => {
    const last = count - 1;
    const close = direction === 0 ? 150 : 150 + (i - last) * step * direction;
    let width = pad;
    if (opts.highTail && i >= count - opts.highTail) width = opts.highPad ?? 12;
    if (opts.lowHead && i < opts.lowHead) width = opts.headPad ?? 8;
    return candle(iso(NOW - (count - i) * HOUR), close, width);
  });
}

function mtfCandles(count: number, direction: 1 | -1 | 0, durationMs: number, base = 150): Candle[] {
  return Array.from({ length: count }, (_, i) => {
    const close = direction === 0 ? base : base + (i - (count - 1)) * 0.01 * direction;
    return { time: iso(NOW - (count - i) * durationMs), open: close, high: close + 0.05, low: close - 0.05, close };
  });
}

function tech(direction: 1 | -1 | 0, durationMs: number, count = 240): Resource<Technical> {
  const rows = mtfCandles(count, direction, durationMs);
  return resource({ candles: rows, indicators: calculateIndicators(rows), lastClosedAt: rows.at(-1)!.time });
}

function hourFrame(rows: Candle[]): Resource<Technical> {
  return resource({ candles: rows, indicators: calculateIndicators(rows), lastClosedAt: rows.at(-1)?.time ?? null });
}

function marketFrom(
  pair: Symbol,
  dirs: { day: 1 | -1 | 0; h4: 1 | -1 | 0; h1: 1 | -1 | 0; m15: 1 | -1 | 0 },
  hour?: Candle[],
): MarketData {
  return {
    symbol: pair,
    price: resource(150),
    timeframes: {
      "15m": tech(dirs.m15, 900_000),
      "1h": hour ? hourFrame(hour) : tech(dirs.h1, 3_600_000),
      "4h": tech(dirs.h4, 14_400_000),
    },
    daily: tech(dirs.day, 86_400_000),
  };
}

function trigger(partial: Partial<StructuredEntryTrigger> = {}): StructuredEntryTrigger {
  return {
    version: 1,
    type: "price_above",
    pair: "USD/JPY",
    price: 156.1,
    timeframe: null,
    sourceCondition: "現在価格が156.10を上回った場合",
    ...partial,
  };
}

function analysis(signal: TradeSignal = "wait", extra: Partial<AIAnalysis> = {}): AIAnalysis {
  const base = finalizeAnalysis(buildInput("USD/JPY", null, null, NOW), null, "TEST", "not_configured", NOW);
  const action = extra.action ?? (signal === "wait" ? "WAIT" : signal.includes("buy") ? "BUY" : "SELL");
  return {
    ...base,
    ...extra,
    pair: extra.pair ?? "USD/JPY",
    signal,
    directionSignal: extra.directionSignal ?? (signal === "wait" ? "buy" : signal),
    action,
    ai: extra.ai ?? { status: "available", model: "TEST", code: null, message: null },
    scenario: extra.scenario ?? {
      direction: "long",
      entryZone: { min: 156.3, max: 156.5 },
      stopLoss: 155.9,
      takeProfit1: 157.2,
      takeProfit2: 157.6,
      riskReward: 1.7,
      condition: "押し目",
      invalidation: "損切り",
      sourceTimeframe: "1h",
    },
    economicRisk: extra.economicRisk ?? { active: false, known: true, reasons: [], nextHigh: null },
    chartEvidence: extra.chartEvidence !== undefined ? extra.chartEvidence : null,
    confidence: extra.confidence ?? 76,
    dataQuality: extra.dataQuality ?? { ...base.dataQuality, score: 82 },
    currentRate: extra.currentRate ?? 156.18,
    analyzedAt: extra.analyzedAt ?? capturedAt,
    expiresAt: extra.expiresAt ?? new Date(NOW + 300_000).toISOString(),
    entryTrigger: extra.entryTrigger !== undefined ? extra.entryTrigger : trigger(),
  };
}

function calendar(importance: EconomicEvent["importance"] | "empty" | "unavailable"): DataResource<EconomicEvent[]> {
  if (importance === "unavailable") {
    return { data: null, status: "unavailable", error: { code: "network", message: "down" }, warnings: [], fetchedAt: capturedAt, provider: "TEST" };
  }
  if (importance === "empty") {
    return { data: [], status: "empty", error: null, warnings: [], fetchedAt: capturedAt, provider: "TEST" };
  }
  return {
    data: [{
      id: "cpi", name: "米CPI", country: "US", currency: "USD", scheduledAt: new Date(NOW + 3_600_000).toISOString(),
      rawScheduledAt: null, timezone: "UTC", previous: 3, forecast: 3.1, actual: null, unit: "%", status: "upcoming",
      source: "TEST", url: null, isKeyIndicator: true, affectedCurrencies: ["USD"], importance,
      importanceBasis: "provider", impactDirection: null, reason: "TEST",
    }],
    status: "ok", error: null, warnings: [], fetchedAt: capturedAt, provider: "TEST",
  };
}

const lossTrade: Trade = {
  id: "loss", pair: "USD/JPY", side: "short", status: "closed", quantity: 1000,
  entryPrice: 156.5, exitPrice: 157.3, openedAt: capturedAt, closedAt: capturedAt, stopLoss: null, takeProfit: null,
  notes: "", realizedPnl: -800, analysisSnapshot: null, createdAt: capturedAt, updatedAt: capturedAt,
};

function scene(opts: {
  rate?: number | null;
  calendar?: Parameters<typeof calendar>[0];
  dailyLossLimitPercent?: number;
  trades?: Trade[];
  extra?: Partial<AIAnalysis>;
  market?: MarketData | null;
  pair?: string;
  stale?: boolean;
} = {}) {
  const pair = opts.pair ?? "USD/JPY";
  const extra = opts.stale
    ? { analyzedAt: new Date(NOW - 10 * 60_000).toISOString(), expiresAt: new Date(NOW - 60_000).toISOString(), ...opts.extra }
    : opts.extra ?? {};
  const ai = analysis("wait", { directionSignal: "buy", action: "WAIT", ...extra, pair: extra.pair ?? "USD/JPY" });
  const plan = buildDailyTradingPlan({
    pair: ai.pair,
    analysis: ai,
    trades: opts.trades ?? [],
    riskSettings: settings,
    currentRate: opts.rate === undefined ? 156.18 : opts.rate,
    calendar: calendar(opts.calendar ?? "empty"),
    now: NOW,
    dailyLossLimitPercent: opts.dailyLossLimitPercent,
  });
  const readiness = buildEntryReadiness({
    pair: ai.pair,
    analysis: ai,
    dailyPlan: plan,
    riskSettings: settings,
    currentRate: opts.rate === undefined ? 156.18 : opts.rate,
    now: NOW,
  });
  const market = opts.market === undefined
    ? marketFrom("USD/JPY", { day: 1, h4: 1, h1: 1, m15: 1 }, series(220, { direction: 1, highTail: 6, highPad: 12 }))
    : opts.market;
  const live = buildLiveEntryContext({
    pair,
    capturedAt,
    analysis: ai,
    dailyPlan: plan,
    readiness,
    market,
  });
  const review = buildPreTradeReview({
    pair,
    tradeSide: "BUY",
    analysis: ai,
    dailyPlan: plan,
    readiness,
    saveAnalysis: true,
    market,
  });
  return { ai, plan, readiness, market, live, review };
}

function draft(changes: Partial<TradeDraft> = {}): TradeDraft {
  return {
    pair: "USD/JPY", side: "long", status: "open", quantity: 1000, entryPrice: 156.18, exitPrice: null,
    openedAt: capturedAt, closedAt: null, stopLoss: 155.9, takeProfit: 157.2, notes: "T030", ...changes,
  };
}

function storedRegime(partial: Partial<MarketRegimeAnalysis> = {}): MarketRegimeAnalysis {
  const base = analyzeMarketRegime({ pair: "USD/JPY", candles: series(220), analyzedAt: capturedAt });
  return { ...base, ...partial };
}

test("A live context build", () => {
  const { live } = scene();
  assert.equal(live?.source, "live");
  assert.equal(live?.pair, "USD/JPY");
  assert.equal(live?.version, 1);
});

test("B stored context build", () => {
  const { ai, plan, readiness, market } = scene();
  const trade = createTrade(draft(), ai, "b", capturedAt, { dailyPlan: plan, readiness, market }).data!;
  const stored = buildStoredEntryContext(trade);
  assert.equal(stored?.source, "stored");
  assert.equal(stored?.ai.action, "WAIT");
});

test("C AI Direction BUY", () => {
  assert.equal(scene().live?.ai.direction, "BUY");
});

test("D Action WAIT", () => {
  assert.equal(scene().live?.ai.action, "WAIT");
});

test("E WAIT preserved", () => {
  const { live, review } = scene();
  assert.equal(live?.ai.direction, "BUY");
  assert.equal(live?.ai.action, "WAIT");
  assert.equal(review.action, "WAIT");
  assert.notEqual(review.action, "BUY");
});

test("F MTF aligned bullish", () => {
  const { live } = scene({ market: marketFrom("USD/JPY", { day: 1, h4: 1, h1: 1, m15: 1 }, series(220)) });
  assert.equal(live?.mtf?.alignment, "aligned_bullish");
  assert.equal(ENTRY_MTF_ALIGNMENT_LABEL.aligned_bullish, "全時間軸で上向き");
});

test("G MTF aligned bearish", () => {
  const { live } = scene({ market: marketFrom("USD/JPY", { day: -1, h4: -1, h1: -1, m15: -1 }, series(220, { direction: -1 })) });
  assert.equal(live?.mtf?.alignment, "aligned_bearish");
});

test("H mixed", () => {
  const { live } = scene({ market: marketFrom("USD/JPY", { day: 1, h4: 1, h1: -1, m15: -1 }) });
  assert.equal(live?.mtf?.alignment, "mixed");
  assert.equal(live?.mtf?.vsDirection, "時間軸混在");
});

test("I insufficient", () => {
  const market = marketFrom("USD/JPY", { day: 1, h4: 1, h1: 1, m15: 1 });
  market.timeframes["15m"] = { data: null, fetchedAt: iso(), error: "unavailable", stale: false };
  const { live } = scene({ market });
  assert.equal(live?.mtf?.alignment, "insufficient");
  assert.equal(live?.mtf?.vsDirection, "データ不足");
});

test("J MTF null", () => {
  const { live } = scene({ market: null });
  assert.equal(live?.mtf, null);
});

test("K HTF bullish", () => {
  assert.equal(scene({ market: marketFrom("USD/JPY", { day: 1, h4: 1, h1: 1, m15: 1 }) }).live?.mtf?.higherTimeframeBias, "bullish");
});

test("L HTF bearish", () => {
  assert.equal(scene({ market: marketFrom("USD/JPY", { day: -1, h4: -1, h1: -1, m15: -1 }) }).live?.mtf?.higherTimeframeBias, "bearish");
});

test("M HTF neutral", () => {
  const market = marketFrom("USD/JPY", { day: 1, h4: -1, h1: 1, m15: 1 });
  assert.equal(scene({ market }).live?.mtf?.higherTimeframeBias, "neutral");
});

test("N HTF unavailable", () => {
  const market = marketFrom("USD/JPY", { day: 1, h4: 1, h1: 1, m15: 1 });
  market.daily = { data: null, fetchedAt: iso(), error: "unavailable", stale: false };
  market.timeframes["4h"] = { data: null, fetchedAt: iso(), error: "unavailable", stale: false };
  assert.equal(scene({ market }).live?.mtf?.higherTimeframeBias, "unavailable");
});

test("O Regime trending", () => {
  assert.equal(scene({ market: marketFrom("USD/JPY", { day: 1, h4: 1, h1: 1, m15: 1 }, series(220)) }).live?.marketRegime?.regime, "trending");
});

test("P range", () => {
  assert.equal(scene({ market: marketFrom("USD/JPY", { day: 1, h4: 1, h1: 1, m15: 1 }, series(220, { direction: 0, pad: 0.12 })) }).live?.marketRegime?.regime, "range");
});

test("Q transition", () => {
  assert.equal(scene({ market: marketFrom("USD/JPY", { day: 1, h4: 1, h1: 1, m15: 1 }, series(220, { direction: 1, step: 0.00002 })) }).live?.marketRegime?.regime, "transition");
});

test("R unavailable", () => {
  assert.equal(scene({ market: marketFrom("USD/JPY", { day: 1, h4: 1, h1: 1, m15: 1 }, series(10)) }).live?.marketRegime?.regime, "unavailable");
});

test("S Regime null", () => {
  assert.equal(scene({ market: null }).live?.marketRegime, null);
  assert.equal(scene({ market: null }).live?.regimeState, "absent");
});

test("T volatility high", () => {
  assert.equal(scene({ market: marketFrom("USD/JPY", { day: 1, h4: 1, h1: 1, m15: 1 }, series(220, { highTail: 6, highPad: 12 })) }).live?.marketRegime?.volatility, "high");
});

test("U normal", () => {
  assert.equal(scene({ market: marketFrom("USD/JPY", { day: 1, h4: 1, h1: 1, m15: 1 }, series(220)) }).live?.marketRegime?.volatility, "normal");
});

test("V low", () => {
  assert.equal(scene({
    market: marketFrom("USD/JPY", { day: 1, h4: 1, h1: 1, m15: 1 }, series(220, { direction: -1, lowHead: 170, headPad: 8, pad: 0.04 })),
  }).live?.marketRegime?.volatility, "low");
});

test("W unavailable volatility", () => {
  assert.equal(scene({ market: marketFrom("USD/JPY", { day: 1, h4: 1, h1: 1, m15: 1 }, []) }).live?.marketRegime?.volatility, "unavailable");
});

test("X readiness 5 fixed", () => {
  const { live } = scene();
  assert.equal(live?.readiness?.total, 5);
  assert.equal(live?.readiness?.confirmed, 5);
  assert.doesNotMatch(JSON.stringify(live), /Entry OK/);
});

test("Y trigger met", () => {
  const { live } = scene({ rate: 156.18 });
  assert.equal(live?.trigger.status, "met");
  assert.equal(live?.trigger.label, "条件成立");
});

test("Z trigger not_met", () => {
  const { live } = scene({
    extra: { entryTrigger: trigger({ type: "price_below", price: 156.2 }) },
    rate: 156.28,
  });
  assert.equal(live?.trigger.status, "not_met");
  assert.equal(live?.trigger.label, "条件未成立");
});

test("AA trigger unavailable", () => {
  const { live } = scene({ rate: null });
  assert.equal(live?.trigger.status, "unavailable");
});

test("AB trigger invalid", () => {
  const { review, live } = scene({ extra: { entryTrigger: { version: 1, type: "macd_cross" } as never } });
  assert.equal(review.triggerStatus, "構造化条件利用不可");
  assert.notEqual(live?.trigger.label, "条件成立");
  assert.doesNotMatch(JSON.stringify(live), /\bGO\b|Entry OK/);
});

test("AC event high", () => {
  assert.equal(scene({ calendar: "high" }).live?.eventRisk.level, "high");
  assert.equal(scene({ calendar: "high" }).live?.eventRisk.label, "HIGH");
});

test("AD medium", () => {
  assert.equal(scene({ calendar: "medium" }).live?.eventRisk.label, "MEDIUM");
});

test("AE low", () => {
  assert.equal(scene({ calendar: "empty" }).live?.eventRisk.label, "LOW");
});

test("AF unavailable is not LOW", () => {
  const { live } = scene({
    calendar: "unavailable",
    extra: { economicRisk: { active: false, known: false, reasons: [], nextHigh: null } },
  });
  assert.equal(live?.eventRisk.level, "unavailable");
  assert.notEqual(live?.eventRisk.label, "LOW");
});

test("AG risk", () => {
  const { live } = scene();
  assert.equal(live?.risk.riskPerTrade, 500);
  assert.equal(live?.risk.riskPercent, 1);
});

test("AH risk unavailable", () => {
  const live = buildLiveEntryContext({ pair: "USD/JPY", capturedAt, analysis: null, market: null });
  assert.equal(live?.risk.riskPerTrade, null);
});

test("AI DLL reached", () => {
  const { live } = scene({ dailyLossLimitPercent: 1, trades: [lossTrade] });
  assert.equal(live?.dailyLossLimit.reached, true);
  assert.equal(live?.dailyLossLimit.label, "到達");
});

test("AJ DLL not reached", () => {
  const { live } = scene({ dailyLossLimitPercent: 3 });
  assert.equal(live?.dailyLossLimit.reached, false);
  assert.equal(live?.dailyLossLimit.label, "未到達");
});

test("AK freshness stale", () => {
  const { live } = scene({ stale: true });
  assert.equal(live?.freshness.stale, true);
  assert.equal(live?.freshness.label, "更新から時間経過");
});

test("AL fresh", () => {
  const { live } = scene();
  assert.equal(live?.freshness.stale, false);
  assert.equal(live?.freshness.label, "最新");
});

test("AM Regime snapshot capture", () => {
  const { ai, plan, readiness, market } = scene();
  const trade = createTrade(draft(), ai, "am", capturedAt, { dailyPlan: plan, readiness, market }).data!;
  assert.ok(isRichSnapshot(trade.analysisSnapshot));
  assert.equal(trade.analysisSnapshot.marketRegimeAnalysis?.regime, "trending");
  assert.equal(trade.analysisSnapshot.version, 1);
});

test("AN Regime pair mismatch", () => {
  const foreign = marketFrom("EUR/JPY", { day: 1, h4: 1, h1: 1, m15: 1 }, series(220));
  const { ai, plan, readiness } = scene({ market: foreign });
  const trade = createTrade(draft(), ai, "an", capturedAt, { dailyPlan: plan, readiness, market: foreign }).data!;
  assert.ok(isRichSnapshot(trade.analysisSnapshot));
  assert.equal(trade.analysisSnapshot.marketRegimeAnalysis, null);
  assert.ok(trade.analysisSnapshot.preTradeContext);
});

test("AO malformed Regime isolated", () => {
  const { ai, plan, readiness, market } = scene();
  const snap = captureTradeAiSnapshot({ analysis: ai, pair: "USD/JPY", now: capturedAt, dailyPlan: plan, readiness, market })!;
  const poisoned = sanitizeTradeAiSnapshot({ ...snap, marketRegimeAnalysis: { pair: "USD/JPY", candles: [] } });
  assert.ok(poisoned);
  assert.equal(poisoned!.marketRegimeAnalysis, null);
  assert.ok(poisoned!.preTradeContext);
  assert.ok(poisoned!.multiTimeframeAnalysis);
  assert.equal(poisoned!.action, "WAIT");
});

test("AP raw candle rejected", () => {
  const raw = { ...storedRegime(), candles: series(3) };
  assert.equal(captureMarketRegimeSnapshot({ ...marketFrom("USD/JPY", { day: 1, h4: 1, h1: 1, m15: 1 }), marketRegimeAnalysis: raw as never }, "USD/JPY", capturedAt)?.regime, "trending");
  const snap = captureTradeAiSnapshot({ analysis: analysis(), pair: "USD/JPY", now: capturedAt, market: marketFrom("USD/JPY", { day: 1, h4: 1, h1: 1, m15: 1 }, series(220)) })!;
  const rejected = sanitizeTradeAiSnapshot({ ...snap, marketRegimeAnalysis: raw });
  assert.equal(rejected!.marketRegimeAnalysis, null);
  assert.doesNotMatch(JSON.stringify(snap.marketRegimeAnalysis), /"candles"/);
});

test("AQ secret rejected", () => {
  const { ai, market } = scene();
  const snap = captureTradeAiSnapshot({ analysis: ai, pair: "USD/JPY", now: capturedAt, market })!;
  const poisoned = sanitizeTradeAiSnapshot({
    ...snap,
    marketRegimeAnalysis: { ...snap.marketRegimeAnalysis, reasons: ["sk-abcdefghijklmnop"] },
  });
  assert.ok(poisoned);
  assert.equal(poisoned!.marketRegimeAnalysis, null);
  assert.equal(poisoned!.action, "WAIT");
});

test("AR edit preserves", () => {
  const { ai, plan, readiness, market } = scene();
  const trade = createTrade(draft(), ai, "ar", capturedAt, { dailyPlan: plan, readiness, market }).data!;
  const edited = editTrade(trade, { ...trade, notes: "changed" }, capturedAt).data!;
  assert.deepEqual(edited.analysisSnapshot, trade.analysisSnapshot);
  assert.deepEqual(buildStoredEntryContext(edited), buildStoredEntryContext(trade));
});

test("AS close preserves", () => {
  const { ai, plan, readiness, market } = scene();
  const trade = createTrade(draft(), ai, "as", capturedAt, { dailyPlan: plan, readiness, market }).data!;
  const opened = buildStoredEntryContext(trade);
  const closed = closeTrade(trade, 157.2, capturedAt, capturedAt).data!;
  assert.deepEqual(closed.analysisSnapshot, trade.analysisSnapshot);
  assert.deepEqual(buildStoredEntryContext(closed), opened);
});

test("AT result does not rewrite", () => {
  const { ai, plan, readiness, market } = scene();
  const a = closeTrade(createTrade(draft(), ai, "ata", capturedAt, { dailyPlan: plan, readiness, market }).data!, 157.5, capturedAt, capturedAt).data!;
  const b = closeTrade(createTrade(draft(), ai, "atb", capturedAt, { dailyPlan: plan, readiness, market }).data!, 155.5, capturedAt, capturedAt).data!;
  assert.ok((a.realizedPnl ?? 0) > 0);
  assert.ok((b.realizedPnl ?? 0) < 0);
  assert.deepEqual(buildStoredEntryContext(a), buildStoredEntryContext(b));
});

test("AU Live Regime change ignored historically", () => {
  const trending = marketFrom("USD/JPY", { day: 1, h4: 1, h1: 1, m15: 1 }, series(220));
  const { ai, plan, readiness } = scene({ market: trending });
  const trade = createTrade(draft(), ai, "au", capturedAt, { dailyPlan: plan, readiness, market: trending }).data!;
  assert.equal(storedMarketRegimeAnalysis(trade)?.regime, "trending");
  const liveRange = captureMarketRegimeSnapshot(marketFrom("USD/JPY", { day: 1, h4: 1, h1: 1, m15: 1 }, series(220, { direction: 0, pad: 0.12 })), "USD/JPY", iso(NOW + 3_600_000));
  assert.equal(liveRange?.regime, "range");
  assert.equal(storedMarketRegimeAnalysis(trade)?.regime, "trending");
});

test("AV legacy Regime missing", () => {
  const { ai, plan, readiness } = scene({ market: null });
  const trade = createTrade(draft(), ai, "av", capturedAt, { dailyPlan: plan, readiness }).data!;
  const stored = buildStoredEntryContext(trade)!;
  assert.ok(stored.ai.action);
  assert.equal(stored.marketRegime, null);
  assert.equal(stored.regimeState, "absent");
  assert.equal(entryContextLabels(stored).regime, REGIME_SNAPSHOT_MISSING);
});

test("AW partial context", () => {
  const mtfMarket = marketFrom("USD/JPY", { day: 1, h4: 1, h1: 1, m15: 1 });
  const { ai, plan, readiness } = scene({ market: mtfMarket });
  const trade = createTrade(draft(), ai, "aw", capturedAt, { dailyPlan: plan, readiness, market: mtfMarket }).data!;
  if (!isRichSnapshot(trade.analysisSnapshot)) throw new Error("snap");
  trade.analysisSnapshot.marketRegimeAnalysis = undefined;
  if (trade.marketContextSnapshot) {
    trade.marketContextSnapshot = {
      ...trade.marketContextSnapshot,
      marketRegime: null,
      technicalContext: trade.marketContextSnapshot.technicalContext?.source === "mtf_1h"
        ? trade.marketContextSnapshot.technicalContext
        : null,
    };
  }
  const stored = buildStoredEntryContext(trade)!;
  assert.ok(stored.mtf);
  assert.ok(stored.readiness);
  assert.equal(stored.marketRegime, null);
});

test("AX toggle ON saves", () => {
  const { ai, plan, readiness, market } = scene();
  const trade = createTrade(draft(), ai, "ax", capturedAt, { dailyPlan: plan, readiness, market, saveSnapshot: true }).data!;
  assert.ok(isRichSnapshot(trade.analysisSnapshot));
  assert.ok(trade.analysisSnapshot.preTradeContext);
  assert.ok(trade.analysisSnapshot.multiTimeframeAnalysis);
  assert.ok(trade.analysisSnapshot.marketRegimeAnalysis);
});

test("AY toggle OFF saves none", () => {
  const { ai, plan, readiness, market } = scene();
  const trade = createTrade(draft(), ai, "ay", capturedAt, { dailyPlan: plan, readiness, market, saveSnapshot: false }).data!;
  assert.equal(trade.analysisSnapshot, null);
  assert.equal(buildStoredEntryContext(trade), null);
});

test("AZ no additional fetch", () => {
  assert.doesNotMatch(SOURCE, /\bfetch\s*\(/);
  assert.doesNotMatch(SOURCE, /twelvedata|finnhub|stlouisfed|eodhd/i);
});

test("BA no OpenAI call", () => {
  assert.doesNotMatch(SOURCE, /openai|responses\.create|vision/i);
});

test("BB no Supabase extra query", () => {
  assert.doesNotMatch(SOURCE, /supabase|from\("trades"\)/);
});

test("BC no polling", () => {
  assert.doesNotMatch(SOURCE, /setInterval|setTimeout/);
});

test("BD no migration", () => {
  assert.doesNotMatch(SOURCE, /alter table|create table|add column/i);
});

test("BE no quality score", () => {
  assert.doesNotMatch(SOURCE, FORBIDDEN);
  assert.doesNotMatch(JSON.stringify(scene().live), FORBIDDEN);
});

test("BF no Entry OK", () => {
  assert.doesNotMatch(JSON.stringify(scene().review), /Entry OK/);
});

test("BG no good\/bad", () => {
  assert.doesNotMatch(SOURCE, /良いEntry|悪いEntry|Good Context|Bad Context/);
});

test("BH no compliance label", () => {
  assert.doesNotMatch(SOURCE, /ruleFollowed|disciplineScore|complianceScore|ルール遵守/);
});

test("BI no causal wording", () => {
  assert.doesNotMatch(SOURCE, /だから利益|だから成功|だから失敗|一致だから/);
});

test("BJ deterministic", () => {
  const input = scene();
  const again = buildLiveEntryContext({
    pair: "USD/JPY",
    capturedAt,
    analysis: input.ai,
    dailyPlan: input.plan,
    readiness: input.readiness,
    market: input.market,
  });
  assert.deepEqual(again, input.live);
});

test("BK no mutation", () => {
  const { ai, plan, readiness, market } = scene();
  const before = JSON.stringify({ ai, plan, readiness, market });
  buildLiveEntryContext({ pair: "USD/JPY", capturedAt, analysis: ai, dailyPlan: plan, readiness, market });
  assert.equal(JSON.stringify({ ai, plan, readiness, market }), before);
});

test("critical 1 BUY WAIT full live context", () => {
  const { live, review } = scene();
  assert.equal(live?.ai.direction, "BUY");
  assert.equal(live?.ai.action, "WAIT");
  assert.equal(live?.mtf?.alignment, "aligned_bullish");
  assert.equal(live?.mtf?.higherTimeframeBias, "bullish");
  assert.equal(live?.marketRegime?.regime, "trending");
  assert.equal(live?.marketRegime?.trendDirection, "bullish");
  assert.equal(live?.marketRegime?.volatility, "high");
  assert.equal(live?.readiness?.confirmed, 5);
  assert.equal(live?.trigger.status, "met");
  assert.equal(live?.eventRisk.label, "LOW");
  assert.equal(review.action, "WAIT");
  assert.equal(review.mtf, "方向一致");
  assert.doesNotMatch(JSON.stringify({ live, review }), /Entry OK|\bGO\b/);
});

test("critical 2 stored trending survives live range", () => {
  const trending = marketFrom("USD/JPY", { day: 1, h4: 1, h1: 1, m15: 1 }, series(220));
  const { ai, plan, readiness } = scene({ market: trending });
  const trade = createTrade(draft(), ai, "c2", capturedAt, { dailyPlan: plan, readiness, market: trending }).data!;
  assert.equal(buildStoredEntryContext(trade)?.marketRegime?.regime, "trending");
  assert.equal(buildLiveEntryContext({
    pair: "USD/JPY",
    capturedAt: iso(NOW + 7200_000),
    analysis: ai,
    dailyPlan: plan,
    readiness,
    market: marketFrom("USD/JPY", { day: 1, h4: 1, h1: 1, m15: 1 }, series(220, { direction: 0, pad: 0.12 })),
  })?.marketRegime?.regime, "range");
  assert.equal(buildStoredEntryContext(trade)?.marketRegime?.regime, "trending");
});

test("critical 3 profit and loss share context", () => {
  const { ai, plan, readiness, market } = scene();
  const profit = closeTrade(createTrade(draft(), ai, "c3a", capturedAt, { dailyPlan: plan, readiness, market }).data!, 157.8, capturedAt, capturedAt).data!;
  const loss = closeTrade(createTrade(draft(), ai, "c3b", capturedAt, { dailyPlan: plan, readiness, market }).data!, 155.1, capturedAt, capturedAt).data!;
  assert.deepEqual(buildStoredEntryContext(profit), buildStoredEntryContext(loss));
});

test("critical 4 malformed regime isolated from siblings", () => {
  const { ai, plan, readiness, market } = scene();
  const snap = captureTradeAiSnapshot({ analysis: ai, pair: "USD/JPY", now: capturedAt, dailyPlan: plan, readiness, market })!;
  const isolated = sanitizeTradeAiSnapshot({ ...snap, marketRegimeAnalysis: { version: 1, pair: "USD/JPY", atr14Series: [1, 2] } });
  const trade = { ...draft(), id: "c4", createdAt: capturedAt, updatedAt: capturedAt, realizedPnl: null, analysisSnapshot: isolated };
  const stored = buildStoredEntryContext(trade)!;
  assert.equal(stored.marketRegime, null);
  assert.equal(stored.ai.action, "WAIT");
  assert.ok(stored.mtf);
  assert.ok(stored.readiness);
});

test("critical 5 legacy does not backfill live regime", () => {
  const { ai, plan, readiness } = scene({ market: null });
  const trade = createTrade(draft(), ai, "c5", capturedAt, { dailyPlan: plan, readiness }).data!;
  const stored = buildStoredEntryContext(trade)!;
  assert.equal(stored.marketRegime, null);
  assert.equal(entryContextLabels(stored).regime, "相場環境は保存されていません");
  assert.equal(scene().live?.marketRegime?.regime, "trending");
});

test("titles and vsDirection wording", () => {
  assert.equal(ENTRY_CONTEXT_TITLE, "エントリー判断コンテキスト");
  assert.equal(ENTRY_CONTEXT_EYEBROW, "ENTRY CONTEXT");
  assert.match(ENTRY_CONTEXT_DISCLAIMER, /売買を推奨・禁止するものではありません/);
  assert.equal(mtfVsDirection("aligned_bullish", "BUY"), "方向一致");
  assert.equal(mtfVsDirection("aligned_bullish", "SELL"), "逆方向");
  assert.equal(mtfVsDirection("aligned_bearish", "SELL"), "方向一致");
  assert.equal(mtfVsDirection("mixed", "BUY"), "時間軸混在");
  assert.equal(formatDllStatus(null), "未設定/未取得");
  assert.equal(formatEntryFreshness(null), "未取得");
});

test("no Date.now inside composition helpers", () => {
  const helpers = readFileSync(join(ROOT, "lib/trades/entry-context.ts"), "utf8")
    + readFileSync(join(ROOT, "lib/trades/regime-snapshot.ts"), "utf8");
  assert.doesNotMatch(helpers, /Date\.now/);
});

test("newlyMet is not persisted", () => {
  const { ai, plan, readiness, market } = scene();
  const trade = createTrade(draft(), ai, "watch", capturedAt, { dailyPlan: plan, readiness, market }).data!;
  assert.doesNotMatch(JSON.stringify(trade.analysisSnapshot), /newlyMet/);
});

test("live pair mismatch does not copy foreign regime", () => {
  const live = buildLiveEntryContext({
    pair: "USD/JPY",
    capturedAt,
    analysis: analysis(),
    market: marketFrom("EUR/JPY", { day: 1, h4: 1, h1: 1, m15: 1 }, series(220)),
  });
  assert.equal(live?.marketRegime, null);
  assert.equal(live?.mtf, null);
});
