import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildInput } from "../lib/ai/input";
import { finalizeAnalysis } from "../lib/ai/engine";
import { evaluateStructuredEntryTrigger, type StructuredEntryTrigger } from "../lib/ai/entry-trigger";
import type { AIAnalysis, TradeSignal } from "../lib/ai/types";
import type { DataResource, EconomicEvent } from "../lib/fundamental/types";
import type { RiskSettings } from "../lib/risk/types";
import { createTrade } from "../lib/trades/service";
import type { TradeDraft } from "../lib/trades/types";
import { validateDraft } from "../lib/trades/validation";
import {
  PRE_TRADE_REVIEW_DISCLAIMER,
  PRE_TRADE_REVIEW_SAVE_OFF,
  PRE_TRADE_REVIEW_SAVE_ON,
  PRE_TRADE_REVIEW_UNAVAILABLE,
  buildPreTradeReview,
  reviewContextFields,
} from "../lib/trades/pre-trade-review";
import { isRichSnapshot } from "../lib/trades/snapshot";
import { buildDailyTradingPlan } from "../lib/trading-plan/daily-plan";
import { buildEntryReadiness } from "../lib/trading-plan/entry-readiness";

const NOW = Date.parse("2026-09-15T03:15:00.000Z");
const capturedAt = new Date(NOW).toISOString();
const settings: RiskSettings = { balance: 50_000, target: 100_000, riskPercent: 1, tradeUnit: 1000 };

function trigger(partial: Partial<StructuredEntryTrigger> = {}): StructuredEntryTrigger {
  return {
    version: 1,
    type: "price_below",
    pair: "USD/JPY",
    price: 156.2,
    timeframe: null,
    sourceCondition: "現在価格が156.20を下回った場合",
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
    directionSignal: extra.directionSignal ?? signal,
    action,
    ai: extra.ai ?? { status: "available", model: "TEST", code: null, message: null },
    scenario: extra.scenario ?? {
      direction: signal.includes("buy") ? "long" : "short",
      entryZone: { min: 156.1, max: 156.2 },
      stopLoss: 156.8,
      takeProfit1: 155.4,
      takeProfit2: 155.0,
      riskReward: 1.6,
      condition: "156.20を下抜けた場合",
      invalidation: "156.80を超えた場合は無効",
      sourceTimeframe: "1h",
    },
    economicRisk: extra.economicRisk ?? { active: false, known: true, reasons: [], nextHigh: null },
    chartEvidence: extra.chartEvidence !== undefined ? extra.chartEvidence : null,
    confidence: extra.confidence ?? 76,
    dataQuality: extra.dataQuality ?? { ...base.dataQuality, score: 82 },
    currentRate: extra.currentRate ?? 156.42,
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

const lossTrade = {
  id: "loss", pair: "USD/JPY" as const, side: "short" as const, status: "closed" as const, quantity: 1000,
  entryPrice: 156.5, exitPrice: 157.3, openedAt: capturedAt, closedAt: capturedAt, stopLoss: null, takeProfit: null,
  notes: "", realizedPnl: -800, analysisSnapshot: null, createdAt: capturedAt, updatedAt: capturedAt,
};

function scene(opts: {
  signal?: TradeSignal;
  extra?: Partial<AIAnalysis>;
  rate?: number | null;
  calendar?: Parameters<typeof calendar>[0];
  dailyLossLimitPercent?: number;
  trades?: typeof lossTrade[];
  tradeSide?: "BUY" | "SELL";
  saveAnalysis?: boolean;
  pair?: string;
  plan?: boolean;
} = {}) {
  const pair = opts.pair ?? "USD/JPY";
  const ai = analysis(opts.signal ?? "wait", {
    directionSignal: opts.extra?.directionSignal ?? (opts.signal === "buy" ? "buy" : "sell"),
    action: opts.extra?.action ?? (opts.signal === "buy" ? "BUY" : opts.signal === "sell" ? "SELL" : "WAIT"),
    ...opts.extra,
    pair: opts.extra?.pair ?? "USD/JPY",
  });
  const plan = opts.plan === false ? null : buildDailyTradingPlan({
    pair: ai.pair,
    analysis: ai,
    trades: opts.trades ?? [],
    riskSettings: settings,
    currentRate: opts.rate === undefined ? 156.18 : opts.rate,
    calendar: calendar(opts.calendar ?? "empty"),
    now: NOW,
    dailyLossLimitPercent: opts.dailyLossLimitPercent,
  });
  const readiness = plan ? buildEntryReadiness({
    pair: ai.pair,
    analysis: ai,
    dailyPlan: plan,
    riskSettings: settings,
    currentRate: opts.rate === undefined ? 156.18 : opts.rate,
    now: NOW,
  }) : null;
  const review = buildPreTradeReview({
    pair,
    tradeSide: opts.tradeSide ?? "SELL",
    analysis: ai,
    dailyPlan: plan,
    readiness,
    saveAnalysis: opts.saveAnalysis ?? true,
  });
  return { ai, plan, readiness, review };
}

function codes(review: ReturnType<typeof buildPreTradeReview>) {
  return review.warnings.map(item => item.code);
}

function draft(changes: Partial<TradeDraft> = {}): TradeDraft {
  return {
    pair: "USD/JPY", side: "short", status: "open", quantity: 1000, entryPrice: 156.18, exitPrice: null,
    openedAt: capturedAt, closedAt: null, stopLoss: 156.8, takeProfit: 155.4, notes: "T024", ...changes,
  };
}

const FORBIDDEN = /Entry OK|今すぐ買う|今すぐ売る|\bGO\b|勝率|成立確率|discipline score|ruleFollowed|ruleBroken|goodEntry|badEntry|正しいEntry|ルール遵守|売買推奨|取引禁止/;

test("A: SELL + WAIT + MET", () => {
  const { review } = scene({ tradeSide: "SELL" });
  assert.equal(review.tradeSide, "SELL");
  assert.equal(review.direction, "SELL");
  assert.equal(review.action, "WAIT");
  assert.equal(review.triggerStatus, "条件成立");
  assert.ok(codes(review).includes("action_wait"));
  assert.equal(review.blocking, false);
});

test("B: BUY + WAIT + MET", () => {
  const { review } = scene({
    extra: { directionSignal: "buy", action: "WAIT", entryTrigger: trigger({ type: "price_above", price: 156.1 }) },
    tradeSide: "BUY",
  });
  assert.equal(review.direction, "BUY");
  assert.equal(review.action, "WAIT");
  assert.equal(review.triggerStatus, "条件成立");
  assert.ok(codes(review).includes("action_wait"));
  assert.equal(review.blocking, false);
});

test("C: Action BUY", () => {
  const { review } = scene({ signal: "buy", extra: { entryTrigger: null }, tradeSide: "BUY" });
  assert.equal(review.action, "BUY");
  assert.ok(!codes(review).includes("action_wait"));
});

test("D: Action SELL", () => {
  const { review } = scene({ signal: "sell", extra: { entryTrigger: null }, tradeSide: "SELL" });
  assert.equal(review.action, "SELL");
  assert.ok(!codes(review).includes("action_wait"));
});

test("E: Action WAIT warning", () => {
  const { review } = scene();
  assert.equal(review.warnings.find(item => item.code === "action_wait")?.message, "現在のActionはWAITです。");
});

test("F: trade side vs direction conflict", () => {
  const { review } = scene({ signal: "sell", extra: { entryTrigger: null }, tradeSide: "BUY" });
  assert.ok(codes(review).includes("direction_conflict"));
  assert.match(review.warnings.find(item => item.code === "direction_conflict")!.message, /登録予定の方向とAI方向が異なります/);
  assert.doesNotMatch(review.warnings.find(item => item.code === "direction_conflict")!.message, /間違った方向|SELLに変更/);
});

test("G: aligned direction no conflict", () => {
  const { review } = scene({ signal: "sell", extra: { entryTrigger: null }, tradeSide: "SELL" });
  assert.ok(!codes(review).includes("direction_conflict"));
});

test("H: readiness 5/5", () => {
  const { review } = scene();
  assert.equal(review.readinessCount, "5 / 5");
  assert.equal(review.context?.readiness?.totalCount, 5);
});

test("I: readiness 4/5", () => {
  const { review } = scene({
    calendar: "unavailable",
    extra: { economicRisk: { active: false, known: false, reasons: [], nextHigh: null } },
  });
  assert.equal(review.readinessCount, "4 / 5");
});

test("J: 5/5 does not say Entry OK", () => {
  const { review } = scene();
  assert.equal(review.readinessCount, "5 / 5");
  assert.doesNotMatch(JSON.stringify(review), /Entry OK|準備完了だから取引推奨/);
});

test("K: trigger met", () => {
  assert.equal(scene().review.triggerStatus, "条件成立");
  assert.ok(!codes(scene().review).includes("trigger_not_met"));
});

test("L: trigger not_met warning", () => {
  const { review } = scene({ rate: 156.28 });
  assert.equal(review.triggerStatus, "条件未成立");
  assert.ok(codes(review).includes("trigger_not_met"));
});

test("M: equality not_met + 0 pips", () => {
  const { review } = scene({ rate: 156.2 });
  assert.equal(review.triggerStatus, "条件未成立");
  assert.equal(review.context?.trigger?.evaluation.status, "not_met");
  assert.equal(review.context?.trigger?.evaluation.distanceToTriggerPips, 0);
  assert.equal(review.triggerDistance, "条件まであと 0 pips");
});

test("N: trigger unavailable", () => {
  const { review } = scene({ rate: null });
  assert.equal(review.triggerStatus, "判定データ不足");
  assert.ok(codes(review).includes("trigger_unavailable"));
});

test("O: trigger invalid", () => {
  const { review } = scene({ extra: { entryTrigger: { version: 1, type: "macd_cross" } as never } });
  assert.equal(review.triggerStatus, "構造化条件利用不可");
  assert.ok(codes(review).includes("trigger_invalid"));
  assert.equal(review.context?.trigger, null);
});

test("P: trigger null", () => {
  const { review } = scene({ extra: { entryTrigger: null } });
  assert.equal(review.triggerStatus, "自動判定できる構造化条件はありません");
  assert.ok(!codes(review).includes("trigger_not_met"));
  assert.ok(!codes(review).includes("trigger_unavailable"));
});

test("Q: Event LOW", () => {
  const { review } = scene({ calendar: "empty" });
  assert.equal(review.eventRisk, "LOW");
  assert.ok(!codes(review).includes("event_high"));
});

test("R: Event MEDIUM", () => {
  const { review } = scene({ calendar: "medium" });
  assert.equal(review.eventRisk, "MEDIUM");
  assert.ok(!codes(review).includes("event_high"));
});

test("S: Event HIGH warning", () => {
  const { review } = scene({ calendar: "high" });
  assert.equal(review.eventRisk, "HIGH");
  assert.ok(codes(review).includes("event_high"));
  assert.equal(review.blocking, false);
});

test("T: Event unavailable warning", () => {
  const { review } = scene({
    calendar: "unavailable",
    extra: { economicRisk: { active: false, known: false, reasons: [], nextHigh: null } },
  });
  assert.equal(review.eventRisk, "未取得");
  assert.notEqual(review.eventRisk, "LOW");
  assert.ok(codes(review).includes("event_unavailable"));
});

test("U: stale warning", () => {
  const { review } = scene({
    extra: {
      analyzedAt: new Date(NOW - 10 * 60_000).toISOString(),
      expiresAt: new Date(NOW - 60_000).toISOString(),
    },
  });
  assert.equal(review.freshness, "期限切れ分析");
  assert.ok(codes(review).includes("analysis_stale"));
});

test("V: fresh no stale warning", () => {
  const { review } = scene();
  assert.equal(review.freshness, "最新分析");
  assert.ok(!codes(review).includes("analysis_stale"));
});

test("W: DLL reached warning", () => {
  const { review } = scene({ dailyLossLimitPercent: 1, trades: [lossTrade] });
  assert.ok(codes(review).includes("daily_loss_limit_reached"));
  assert.equal(review.blocking, false);
});

test("X: DLL not reached", () => {
  const { review } = scene();
  assert.equal(review.context?.dailyLossLimitReached, false);
  assert.ok(!codes(review).includes("daily_loss_limit_reached"));
});

test("Y: risk shown", () => {
  const { review } = scene();
  assert.match(review.risk, /500円 \/ 1\.0%/);
});

test("Z: risk unavailable", () => {
  const { review } = scene({ plan: false });
  assert.equal(review.risk, "未取得");
  assert.doesNotMatch(review.risk, /^0円/);
});

test("AA: save toggle ON", () => {
  const { review } = scene({ saveAnalysis: true });
  assert.equal(review.saveMessage, PRE_TRADE_REVIEW_SAVE_ON);
  assert.ok(!codes(review).includes("context_not_saved"));
});

test("AB: save toggle OFF", () => {
  const { review } = scene({ saveAnalysis: false });
  assert.equal(review.saveMessage, PRE_TRADE_REVIEW_SAVE_OFF);
});

test("AC: OFF warning context not saved", () => {
  const { review } = scene({ saveAnalysis: false });
  assert.ok(codes(review).includes("context_not_saved"));
});

test("AD: no blocking state", () => {
  const { review } = scene({
    calendar: "high",
    dailyLossLimitPercent: 1,
    trades: [lossTrade],
    rate: 156.28,
    extra: {
      analyzedAt: new Date(NOW - 10 * 60_000).toISOString(),
      expiresAt: new Date(NOW - 60_000).toISOString(),
    },
  });
  assert.equal(review.blocking, false);
});

test("AE-AI: no recommendation classification", () => {
  const { review } = scene({ calendar: "high", rate: 156.28 });
  assert.doesNotMatch(JSON.stringify(review), FORBIDDEN);
  assert.match(PRE_TRADE_REVIEW_DISCLAIMER, /売買を推奨・禁止するものではありません/);
});

test("AJ: warning deterministic order", () => {
  const { review } = scene({
    calendar: "high",
    dailyLossLimitPercent: 1,
    trades: [lossTrade],
    rate: 156.28,
    extra: {
      analyzedAt: new Date(NOW - 10 * 60_000).toISOString(),
      expiresAt: new Date(NOW - 60_000).toISOString(),
    },
  });
  assert.deepEqual(codes(review), [
    "daily_loss_limit_reached",
    "analysis_stale",
    "event_high",
    "action_wait",
    "trigger_not_met",
  ]);
});

test("AK: warning cap behavior", () => {
  const { review } = scene({
    calendar: "high",
    dailyLossLimitPercent: 1,
    trades: [lossTrade],
    rate: 156.28,
    saveAnalysis: false,
    extra: {
      analyzedAt: new Date(NOW - 10 * 60_000).toISOString(),
      expiresAt: new Date(NOW - 60_000).toISOString(),
    },
  });
  assert.equal(review.warnings.length, 5);
  assert.ok(!codes(review).includes("context_not_saved"));
  assert.equal(codes(review)[0], "daily_loss_limit_reached");
});

test("AL: pair mismatch fail closed", () => {
  const { review } = scene({ pair: "EUR/JPY" });
  assert.equal(review.context, null);
  assert.equal(review.direction, null);
  assert.ok(codes(review).includes("context_unavailable"));
  assert.equal(review.warnings.find(item => item.code === "context_unavailable")?.message, PRE_TRADE_REVIEW_UNAVAILABLE);
});

test("AM: analysis unavailable", () => {
  const review = buildPreTradeReview({
    pair: "USD/JPY",
    tradeSide: "SELL",
    analysis: null,
    dailyPlan: null,
    readiness: null,
    saveAnalysis: true,
  });
  assert.equal(review.context, null);
  assert.ok(codes(review).includes("context_unavailable"));
  assert.equal(review.blocking, false);
});

test("AN: no mutation", () => {
  const { ai, plan, readiness } = scene();
  const before = JSON.stringify({ ai, plan, readiness });
  buildPreTradeReview({ pair: "USD/JPY", tradeSide: "SELL", analysis: ai, dailyPlan: plan, readiness, saveAnalysis: true });
  assert.equal(JSON.stringify({ ai, plan, readiness }), before);
});

test("AO-AR: no fetch OpenAI Supabase timer", () => {
  const source = [
    readFileSync(join(process.cwd(), "lib/trades/pre-trade-review.ts"), "utf8"),
    readFileSync(join(process.cwd(), "components/trades/pre-trade-review.tsx"), "utf8"),
  ].join("\n");
  assert.doesNotMatch(source, /\bfetch\s*\(/);
  assert.doesNotMatch(source, /openai|responses\.create/i);
  assert.doesNotMatch(source, /supabase|from\("trades"\)/i);
  assert.doesNotMatch(source, /setInterval|setTimeout/);
});

test("AS: checkedAt preserved", () => {
  const evaluation = evaluateStructuredEntryTrigger({ trigger: trigger(), pair: "USD/JPY", currentRate: 156.18, now: NOW });
  const { review } = scene();
  assert.equal(review.context?.trigger?.evaluation.checkedAt, evaluation.checkedAt);
  assert.ok(review.triggerCheckedAt);
});

test("AT: checkedAt not candle close", () => {
  const source = readFileSync(join(process.cwd(), "lib/trades/pre-trade-review.ts"), "utf8")
    + readFileSync(join(process.cwd(), "components/trades/pre-trade-review.tsx"), "utf8");
  assert.match(source, /判定確認/);
  assert.doesNotMatch(source, /ローソク足確定/);
});

test("AU: Trigger distance from Task021 semantics", () => {
  const { review } = scene({ rate: 156.28 });
  assert.equal(review.context?.trigger?.evaluation.distanceToTriggerPips, 8);
  assert.equal(review.triggerDistance, "条件まであと 8 pips");
});

test("AV: negative distance never invented", () => {
  const { review } = scene({ rate: 156.18 });
  assert.ok(review.triggerDistance == null || !review.triggerDistance.includes("-"));
  assert.ok((review.context?.trigger?.evaluation.distanceToTriggerPips ?? 0) >= 0);
});

test("AW: current context update changes review", () => {
  const met = scene({ rate: 156.18 }).review;
  const waiting = scene({ rate: 156.28 }).review;
  assert.equal(met.triggerStatus, "条件成立");
  assert.equal(waiting.triggerStatus, "条件未成立");
});

test("AX: snapshot capture remains independent", () => {
  const { ai, plan, readiness, review } = scene();
  const later = new Date(NOW + 60_000).toISOString();
  const trade = createTrade(draft(), ai, "ax", later, { dailyPlan: plan, readiness }).data!;
  const saved = isRichSnapshot(trade.analysisSnapshot) ? trade.analysisSnapshot.preTradeContext : null;
  assert.equal(review.context?.capturedAt, capturedAt);
  assert.equal(saved?.capturedAt, later);
  assert.notEqual(review.context?.capturedAt, saved?.capturedAt);
});

test("AY: review/snapshot consistency", () => {
  const { ai, plan, readiness, review } = scene();
  const trade = createTrade(draft(), ai, "ay", new Date(NOW + 1).toISOString(), { dailyPlan: plan, readiness }).data!;
  const saved = isRichSnapshot(trade.analysisSnapshot) ? trade.analysisSnapshot.preTradeContext ?? null : null;
  assert.deepEqual(reviewContextFields(review.context), reviewContextFields(saved));
});

test("AZ: existing form validation unchanged", () => {
  const invalid = validateDraft({ ...draft(), quantity: 0 });
  assert.equal(invalid.data, null);
  assert.match(invalid.error ?? "", /数量/);
  assert.equal(scene().review.blocking, false);
});

test("WAIT + MET critical remains WAIT", () => {
  const { review } = scene({ tradeSide: "SELL" });
  assert.equal(review.action, "WAIT");
  assert.equal(review.triggerStatus, "条件成立");
  assert.notEqual(review.action, "SELL");
});

test("toggle OFF createTrade snapshot null", () => {
  const { ai, plan, readiness } = scene({ saveAnalysis: false });
  const trade = createTrade(draft(), ai, "off", capturedAt, { dailyPlan: plan, readiness, saveSnapshot: false }).data!;
  assert.equal(trade.analysisSnapshot, null);
});
