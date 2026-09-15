import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { EntryTriggerEvaluationStatus } from "../lib/ai/entry-trigger";
import { MIN_INSIGHT_SAMPLE_SIZE } from "../lib/trades/analysis-price";
import { filterTradesByPeriod } from "../lib/trades/performance-period";
import {
  ACTION_GROUP_ORDER,
  DLL_GROUP_ORDER,
  EVENT_GROUP_ORDER,
  FRESHNESS_GROUP_ORDER,
  TRIGGER_GROUP_ORDER,
  buildPreTradeContextPerformance,
  formatContextProfitFactor,
} from "../lib/trades/pre-trade-performance";
import type { PreTradeContextSnapshot, Trade, TradeAiAnalysisSnapshot, TradeAnalysisSnapshot } from "../lib/trades/types";

const NOW = "2026-09-15T03:15:00.000Z";
const NOW_MS = Date.parse(NOW);
const SOURCE = readFileSync(join(process.cwd(), "lib/trades/pre-trade-performance.ts"), "utf8");

function triggerEval(status: EntryTriggerEvaluationStatus, extra: Partial<NonNullable<PreTradeContextSnapshot["trigger"]>["evaluation"]> = {}): NonNullable<PreTradeContextSnapshot["trigger"]> {
  return {
    structuredTrigger: {
      version: 1,
      type: "price_below",
      pair: "USD/JPY",
      price: 156.2,
      timeframe: null,
      sourceCondition: "現在価格が156.20を下回った場合",
    },
    evaluation: { status, observedValue: 156.18, checkedAt: NOW, distanceToTriggerPips: 0, ...extra },
  };
}

function context(partial: Partial<PreTradeContextSnapshot> = {}): PreTradeContextSnapshot {
  return {
    version: 1,
    capturedAt: NOW,
    pair: "USD/JPY",
    direction: "SELL",
    action: "WAIT",
    readiness: { confirmedCount: 5, totalCount: 5, state: "waiting" },
    trigger: triggerEval("met"),
    dataQuality: { score: 82 },
    confidence: 76,
    eventRisk: { level: "low", available: true },
    risk: { capital: 50_000, riskPercent: 1, riskPerTrade: 500 },
    dailyLossLimitPercent: 3,
    dailyLossRemaining: 1_000,
    dailyLossLimitReached: false,
    analysisStale: false,
    eventRiskHigh: false,
    ...partial,
  };
}

function snap(preTrade?: PreTradeContextSnapshot | null): TradeAiAnalysisSnapshot {
  return {
    pair: "USD/JPY",
    signal: "wait",
    score: 10,
    confidence: 70,
    summary: "t023",
    dataQualityScore: 80,
    analyzedAt: NOW,
    capturedAt: NOW,
    expiresAt: NOW,
    aiStatus: "available",
    model: "x",
    bullishReasons: [],
    bearishReasons: [],
    version: 1,
    directionSignal: "sell",
    action: preTrade?.action ?? "WAIT",
    marketPrice: 156.5,
    analysisPrice: 156.5,
    factors: [],
    scenario: null,
    dataQuality: {
      score: 80,
      missingData: [],
      categories: {
        technical: { status: "ok", detail: "", fraction: 1 },
        news: { status: "ok", detail: "", fraction: 1 },
        economic: { status: "ok", detail: "", fraction: 1 },
        central_bank: { status: "ok", detail: "", fraction: 1 },
        market_environment: { status: "ok", detail: "", fraction: 1 },
      },
      macroeconomicData: { status: "ok", detail: "", fraction: 1 },
    },
    economicRisk: null,
    chartEvidence: null,
    chartAnalysis: null,
    aiCode: null,
    isFallback: false,
    ...(preTrade !== undefined ? { preTradeContext: preTrade } : {}),
  };
}

function legacy(): TradeAnalysisSnapshot {
  return {
    pair: "USD/JPY", signal: "sell", score: 10, confidence: 70, summary: "legacy",
    dataQualityScore: 80, analyzedAt: NOW, capturedAt: NOW, expiresAt: NOW,
    aiStatus: "available", model: "x", bullishReasons: [], bearishReasons: [],
  };
}

function trade(partial: Partial<Trade> & Pick<Trade, "id">): Trade {
  return {
    pair: "USD/JPY",
    side: "short",
    status: "closed",
    quantity: 1000,
    entryPrice: 156.5,
    exitPrice: 156.0,
    openedAt: NOW,
    closedAt: NOW,
    stopLoss: null,
    takeProfit: null,
    notes: "",
    realizedPnl: 500,
    analysisSnapshot: snap(context()),
    createdAt: NOW,
    updatedAt: NOW,
    ...partial,
  };
}

function many(count: number, prefix: string, ctx: PreTradeContextSnapshot, pnl: number): Trade[] {
  return Array.from({ length: count }, (_, index) => trade({
    id: `${prefix}-${index}`,
    realizedPnl: pnl,
    analysisSnapshot: snap(ctx),
  }));
}

function group(result: ReturnType<typeof buildPreTradeContextPerformance>, axis: "triggerGroups" | "actionGroups" | "freshnessGroups" | "eventRiskGroups" | "dailyLossLimitGroups", key: string) {
  return result[axis].find(item => item.key === key);
}

test("A empty trades", () => {
  const result = buildPreTradeContextPerformance([]);
  assert.equal(result.eligibleClosedTrades, 0);
  assert.equal(result.contextTrades, 0);
  assert.equal(result.coverageRate, null);
  assert.deepEqual(result.triggerGroups, []);
});

test("B only OPEN", () => {
  const result = buildPreTradeContextPerformance([trade({ id: "open", status: "open", realizedPnl: null, closedAt: null, exitPrice: null })]);
  assert.equal(result.eligibleClosedTrades, 0);
  assert.equal(result.contextTrades, 0);
});

test("C closed no context", () => {
  const result = buildPreTradeContextPerformance([trade({ id: "c", analysisSnapshot: null, realizedPnl: 10 })]);
  assert.equal(result.eligibleClosedTrades, 1);
  assert.equal(result.contextTrades, 0);
  assert.equal(result.missingContextTrades, 1);
  assert.equal(result.triggerGroups.length, 0);
});

test("D partial coverage", () => {
  const result = buildPreTradeContextPerformance([
    trade({ id: "with" }),
    trade({ id: "without", analysisSnapshot: null, realizedPnl: -10 }),
  ]);
  assert.equal(result.eligibleClosedTrades, 2);
  assert.equal(result.contextTrades, 1);
  assert.equal(result.missingContextTrades, 1);
  assert.equal(result.coverageRate, 50);
});

test("E coverage denominator closed valid pnl only", () => {
  const result = buildPreTradeContextPerformance([
    trade({ id: "ok" }),
    trade({ id: "open", status: "open", realizedPnl: null, closedAt: null, exitPrice: null }),
    trade({ id: "nan", realizedPnl: Number.NaN }),
  ]);
  assert.equal(result.eligibleClosedTrades, 1);
  assert.equal(result.contextTrades, 1);
});

test("F trigger met", () => {
  assert.equal(group(buildPreTradeContextPerformance([trade({ id: "f" })]), "triggerGroups", "met")?.sampleSize, 1);
});

test("G trigger not_met", () => {
  const result = buildPreTradeContextPerformance([trade({ id: "g", analysisSnapshot: snap(context({ trigger: triggerEval("not_met", { observedValue: 156.2, distanceToTriggerPips: 0 }) })) })]);
  assert.equal(group(result, "triggerGroups", "not_met")?.sampleSize, 1);
});

test("H trigger unavailable", () => {
  const result = buildPreTradeContextPerformance([trade({ id: "h", analysisSnapshot: snap(context({ trigger: triggerEval("unavailable", { observedValue: null, distanceToTriggerPips: null }) })) })]);
  assert.equal(group(result, "triggerGroups", "unavailable")?.sampleSize, 1);
});

test("I trigger no_trigger", () => {
  const result = buildPreTradeContextPerformance([trade({ id: "i", analysisSnapshot: snap(context({ trigger: null })) })]);
  assert.equal(group(result, "triggerGroups", "no_trigger")?.sampleSize, 1);
});

test("J invalid handling", () => {
  const result = buildPreTradeContextPerformance([trade({ id: "j", analysisSnapshot: snap(context({ trigger: triggerEval("invalid", { observedValue: null, distanceToTriggerPips: null }) })) })]);
  assert.equal(group(result, "triggerGroups", "invalid")?.sampleSize, 1);
  assert.equal(group(result, "triggerGroups", "no_trigger"), undefined);
});

test("K Action BUY", () => {
  assert.equal(group(buildPreTradeContextPerformance([trade({ id: "k", analysisSnapshot: snap(context({ action: "BUY" })) })]), "actionGroups", "BUY")?.sampleSize, 1);
});

test("L Action SELL", () => {
  assert.equal(group(buildPreTradeContextPerformance([trade({ id: "l", analysisSnapshot: snap(context({ action: "SELL" })) })]), "actionGroups", "SELL")?.sampleSize, 1);
});

test("M Action WAIT", () => {
  assert.equal(group(buildPreTradeContextPerformance([trade({ id: "m" })]), "actionGroups", "WAIT")?.sampleSize, 1);
});

test("N Action unavailable", () => {
  assert.equal(group(buildPreTradeContextPerformance([trade({ id: "n", analysisSnapshot: snap(context({ action: null })) })]), "actionGroups", "unavailable")?.sampleSize, 1);
});

test("O fresh", () => {
  assert.equal(group(buildPreTradeContextPerformance([trade({ id: "o" })]), "freshnessGroups", "fresh")?.sampleSize, 1);
});

test("P stale", () => {
  assert.equal(group(buildPreTradeContextPerformance([trade({ id: "p", analysisSnapshot: snap(context({ analysisStale: true })) })]), "freshnessGroups", "stale")?.sampleSize, 1);
});

test("Q Event low", () => {
  assert.equal(group(buildPreTradeContextPerformance([trade({ id: "q" })]), "eventRiskGroups", "low")?.sampleSize, 1);
});

test("R Event medium", () => {
  assert.equal(group(buildPreTradeContextPerformance([trade({ id: "r", analysisSnapshot: snap(context({ eventRisk: { level: "medium", available: true } })) })]), "eventRiskGroups", "medium")?.sampleSize, 1);
});

test("S Event high", () => {
  assert.equal(group(buildPreTradeContextPerformance([trade({ id: "s", analysisSnapshot: snap(context({ eventRisk: { level: "high", available: true }, eventRiskHigh: true })) })]), "eventRiskGroups", "high")?.sampleSize, 1);
});

test("T Event unavailable", () => {
  const result = buildPreTradeContextPerformance([trade({ id: "t", analysisSnapshot: snap(context({ eventRisk: { level: "unknown", available: false } })) })]);
  assert.equal(group(result, "eventRiskGroups", "unavailable")?.sampleSize, 1);
  assert.equal(group(result, "eventRiskGroups", "low"), undefined);
});

test("U DLL not reached", () => {
  assert.equal(group(buildPreTradeContextPerformance([trade({ id: "u" })]), "dailyLossLimitGroups", "not_reached")?.sampleSize, 1);
});

test("V DLL reached", () => {
  assert.equal(group(buildPreTradeContextPerformance([trade({ id: "v", analysisSnapshot: snap(context({ dailyLossLimitReached: true })) })]), "dailyLossLimitGroups", "reached")?.sampleSize, 1);
});

test("W win/loss/break-even", () => {
  const result = buildPreTradeContextPerformance([
    trade({ id: "win", realizedPnl: 100 }),
    trade({ id: "loss", realizedPnl: -50 }),
    trade({ id: "be", realizedPnl: 0 }),
  ]);
  const met = group(result, "triggerGroups", "met")!;
  assert.equal(met.wins, 1);
  assert.equal(met.losses, 1);
  assert.equal(met.breakEven, 1);
});

test("X average PnL", () => {
  const result = buildPreTradeContextPerformance([
    trade({ id: "a", realizedPnl: 100 }),
    trade({ id: "b", realizedPnl: -50 }),
  ]);
  assert.equal(group(result, "triggerGroups", "met")?.averagePnl, 25);
});

test("Y total PnL", () => {
  const result = buildPreTradeContextPerformance([
    trade({ id: "a", realizedPnl: 100 }),
    trade({ id: "b", realizedPnl: -40 }),
  ]);
  assert.equal(group(result, "triggerGroups", "met")?.totalPnl, 60);
});

test("Z profit factor", () => {
  const result = buildPreTradeContextPerformance([
    trade({ id: "a", realizedPnl: 100 }),
    trade({ id: "b", realizedPnl: -50 }),
  ]);
  assert.equal(group(result, "triggerGroups", "met")?.profitFactor, 2);
});

test("AA grossLoss zero no Infinity", () => {
  const result = buildPreTradeContextPerformance([trade({ id: "aa", realizedPnl: 80 })]);
  assert.equal(group(result, "triggerGroups", "met")?.profitFactor, null);
  assert.equal(formatContextProfitFactor(group(result, "triggerGroups", "met")?.profitFactor ?? null), "—");
  assert.notEqual(group(result, "triggerGroups", "met")?.profitFactor, Number.POSITIVE_INFINITY);
});

test("AB sample <5 insufficient", () => {
  const result = buildPreTradeContextPerformance(many(4, "ab", context(), 10));
  assert.equal(group(result, "triggerGroups", "met")?.sufficientSample, false);
});

test("AC sample >=5 sufficient", () => {
  const result = buildPreTradeContextPerformance(many(5, "ac", context(), 10));
  assert.equal(group(result, "triggerGroups", "met")?.sufficientSample, true);
  assert.equal(MIN_INSIGHT_SAMPLE_SIZE, 5);
});

test("AD OPEN excluded", () => {
  const result = buildPreTradeContextPerformance([
    trade({ id: "closed" }),
    trade({ id: "open", status: "open", realizedPnl: null, closedAt: null, exitPrice: null, analysisSnapshot: snap(context({ trigger: triggerEval("not_met") })) }),
  ]);
  assert.equal(result.eligibleClosedTrades, 1);
  assert.equal(group(result, "triggerGroups", "not_met"), undefined);
});

test("AE realizedPnl invalid excluded", () => {
  const result = buildPreTradeContextPerformance([
    trade({ id: "ok" }),
    trade({ id: "inf", realizedPnl: Number.POSITIVE_INFINITY }),
    trade({ id: "nan", realizedPnl: Number.NaN }),
  ]);
  assert.equal(result.eligibleClosedTrades, 1);
});

test("AF legacy not classified as no_trigger", () => {
  const result = buildPreTradeContextPerformance([
    trade({ id: "legacy", analysisSnapshot: legacy(), realizedPnl: 20 }),
    trade({ id: "none", analysisSnapshot: null, realizedPnl: 20 }),
  ]);
  assert.equal(result.missingContextTrades, 2);
  assert.equal(group(result, "triggerGroups", "no_trigger"), undefined);
});

test("AG period already filtered / no internal date filtering", () => {
  const oldTrade = trade({ id: "old", openedAt: "2020-01-01T00:00:00.000Z", closedAt: "2020-01-01T00:00:00.000Z" });
  const result = buildPreTradeContextPerformance([oldTrade, trade({ id: "new" })]);
  assert.equal(result.contextTrades, 2);
  assert.doesNotMatch(SOURCE, /filterTradesByPeriod|PERIOD_WINDOW|openedAt >=/);
});

test("AH deterministic", () => {
  const trades = [trade({ id: "1" }), trade({ id: "2", realizedPnl: -10 })];
  assert.deepEqual(buildPreTradeContextPerformance(trades, "全期間"), buildPreTradeContextPerformance(trades, "全期間"));
});

test("AI no mutation", () => {
  const trades = [trade({ id: "ai" })];
  const before = JSON.stringify(trades);
  const result = buildPreTradeContextPerformance(trades);
  trades[0]!.realizedPnl = 1;
  assert.equal(JSON.stringify(trades) !== before, true);
  assert.equal(group(result, "triggerGroups", "met")?.totalPnl, 500);
});

test("AJ no fetch", () => {
  assert.doesNotMatch(SOURCE, /fetch\(/);
});

test("AK no OpenAI", () => {
  assert.doesNotMatch(SOURCE, /openai|responses\.create/i);
});

test("AL no Supabase", () => {
  assert.doesNotMatch(SOURCE, /supabase|from\("trades"\)/i);
});

test("AM no causal labels", () => {
  const text = JSON.stringify(buildPreTradeContextPerformance(many(5, "am-met", context(), 100).concat(many(5, "am-not", context({ trigger: triggerEval("not_met") }), -40))));
  assert.doesNotMatch(text, /ルール遵守|ルール違反|正しいEntry|悪いEntry|待つべき|有利です|損失原因/);
});

test("AN no ruleFollowed", () => {
  const result = buildPreTradeContextPerformance([
    ...many(5, "met", context(), 40),
    ...many(5, "not", context({ trigger: triggerEval("not_met") }), -10),
    ...many(5, "wait", context({ action: "WAIT" }), -5),
  ]);
  assert.doesNotMatch(JSON.stringify(result), /ruleFollowed|ruleBroken|disciplineScore|goodEntry|badEntry/);
  assert.equal("ruleFollowed" in result, false);
});

test("AO fixed group ordering", () => {
  assert.deepEqual([...TRIGGER_GROUP_ORDER], ["met", "not_met", "unavailable", "invalid", "no_trigger"]);
  assert.deepEqual([...ACTION_GROUP_ORDER], ["BUY", "SELL", "WAIT", "unavailable"]);
  assert.deepEqual([...FRESHNESS_GROUP_ORDER], ["fresh", "stale"]);
  assert.deepEqual([...EVENT_GROUP_ORDER], ["low", "medium", "high", "unavailable"]);
  assert.deepEqual([...DLL_GROUP_ORDER], ["not_reached", "reached"]);
  const result = buildPreTradeContextPerformance([
    trade({ id: "no", analysisSnapshot: snap(context({ trigger: null })) }),
    trade({ id: "met" }),
    trade({ id: "unavail", analysisSnapshot: snap(context({ trigger: triggerEval("unavailable", { observedValue: null, distanceToTriggerPips: null }) })) }),
  ]);
  assert.deepEqual(result.triggerGroups.map(item => item.key), ["met", "unavailable", "no_trigger"]);
});

test("AP zero group behavior", () => {
  const result = buildPreTradeContextPerformance([trade({ id: "ap" })]);
  assert.equal(group(result, "actionGroups", "BUY"), undefined);
  assert.equal(group(result, "triggerGroups", "not_met"), undefined);
});

test("AQ comparison met/not_met both >=5", () => {
  const result = buildPreTradeContextPerformance([
    ...many(5, "met", context(), 100),
    ...many(5, "not", context({ trigger: triggerEval("not_met") }), -40),
  ]);
  assert.equal(result.comparisons.some(item => item.id === "trigger-met-not-met"), true);
  assert.match(result.comparisons[0]!.text, /条件成立グループの平均損益/);
  assert.doesNotMatch(result.comparisons[0]!.text, /待つべき|有利/);
});

test("AR comparison blocked if one <5", () => {
  const result = buildPreTradeContextPerformance([
    ...many(5, "met", context(), 100),
    ...many(4, "not", context({ trigger: triggerEval("not_met") }), -40),
  ]);
  assert.equal(result.comparisons.some(item => item.id === "trigger-met-not-met"), false);
});

test("AS comparison max cap", () => {
  const result = buildPreTradeContextPerformance([
    ...many(5, "met-fresh", context({ analysisStale: false }), 80),
    ...many(5, "not-stale", context({ trigger: triggerEval("not_met"), analysisStale: true }), -30),
  ]);
  assert.ok(result.comparisons.length <= 3);
});

test("AT Event unavailable != low", () => {
  const result = buildPreTradeContextPerformance([trade({
    id: "at",
    analysisSnapshot: snap(context({ eventRisk: { level: "unknown", available: false } })),
  })]);
  assert.equal(group(result, "eventRiskGroups", "unavailable")?.label, "未取得");
  assert.equal(group(result, "eventRiskGroups", "low"), undefined);
});

test("AU WAIT not called violation", () => {
  const result = buildPreTradeContextPerformance(many(5, "wait", context({ action: "WAIT" }), -20));
  const wait = result.comparisons.find(item => item.id === "action-wait");
  assert.ok(wait);
  assert.doesNotMatch(wait!.text, /違反|無視|悪いEntry/);
});

test("AV Trigger MET not called compliance", () => {
  const result = buildPreTradeContextPerformance([
    ...many(5, "met", context(), 40),
    ...many(5, "not", context({ trigger: triggerEval("not_met") }), -10),
  ]);
  assert.doesNotMatch(JSON.stringify(result.comparisons), /遵守|正しいEntry|有効です/);
});

test("AW coverage percentage", () => {
  const result = buildPreTradeContextPerformance([
    trade({ id: "1" }),
    trade({ id: "2" }),
    trade({ id: "3", analysisSnapshot: null }),
  ]);
  assert.equal(result.coverageRate, (2 / 3) * 100);
});

test("AX period label input/output", () => {
  const result = buildPreTradeContextPerformance([trade({ id: "ax" })], "直近30日");
  assert.equal(result.periodLabel, "直近30日");
});

test("AY null PF display/helper", () => {
  assert.equal(formatContextProfitFactor(null), "—");
  assert.equal(formatContextProfitFactor(Number.POSITIVE_INFINITY), "—");
  assert.equal(formatContextProfitFactor(1.7234), "1.72");
});

test("AZ large/small PnL formatting compatibility", () => {
  const result = buildPreTradeContextPerformance([
    trade({ id: "big", realizedPnl: 12_345.67 }),
    trade({ id: "tiny", realizedPnl: 0.01 }),
  ]);
  assert.equal(group(result, "triggerGroups", "met")?.totalPnl, 12345.68);
});

test("reuses MIN_INSIGHT_SAMPLE_SIZE not a duplicate literal constant", () => {
  assert.match(SOURCE, /MIN_INSIGHT_SAMPLE_SIZE/);
  assert.doesNotMatch(SOURCE, /MIN_.*=\s*5/);
  assert.equal(MIN_INSIGHT_SAMPLE_SIZE, 5);
});

test("filtered period input is used as-is", () => {
  const trades = [
    trade({ id: "in", openedAt: NOW, closedAt: NOW }),
    trade({ id: "out", openedAt: "2020-01-01T00:00:00.000Z", closedAt: "2020-01-01T00:00:00.000Z" }),
  ];
  const filtered = filterTradesByPeriod(trades, "30d", NOW_MS);
  const result = buildPreTradeContextPerformance(filtered, "直近30日");
  assert.equal(result.contextTrades, 1);
  assert.equal(result.periodLabel, "直近30日");
});
