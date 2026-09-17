import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildInput } from "../lib/ai/input";
import { finalizeAnalysis } from "../lib/ai/engine";
import type { AIAnalysis } from "../lib/ai/types";
import { fromTradeRow, toTradeRow } from "../lib/supabase/mappers";
import { summarize } from "../lib/trades/analytics";
import {
  EXIT_PLAN_MISSING,
  EXIT_PLAN_PREFILL_NOTE,
  JPY_PIP_SIZE,
  aiScenarioPrefill,
  calculateRealizedMovePips,
  calculateRealizedR,
  createExitPlan,
  exitPlanInputErrors,
  exitPlanState,
  formatMovePips,
  formatPlannedRR,
  formatRCoverage,
  formatRealizedR,
  formatRiskPips,
  sanitizeExitPlan,
  storedExitPlan,
  summarizeRPerformance,
  type TradeExitPlan,
} from "../lib/trades/exit-plan";
import { createTradeRepository, decodeJournal } from "../lib/trades/repository";
import { closeTrade, createTrade, editTrade } from "../lib/trades/service";
import { isRichSnapshot } from "../lib/trades/snapshot";
import type { Trade, TradeDraft } from "../lib/trades/types";
import { validateTrade } from "../lib/trades/validation";
import { READINESS_FIXED_TOTAL } from "../lib/trading-plan/entry-readiness";

const NOW = "2026-09-16T00:00:00.000Z";
const ROOT = process.cwd();
const HELPERS = readFileSync(join(ROOT, "lib/trades/exit-plan.ts"), "utf8");
const SOURCE = [
  HELPERS,
  readFileSync(join(ROOT, "components/trades/exit-plan.tsx"), "utf8"),
  readFileSync(join(ROOT, "components/trades/trade-form.tsx"), "utf8"),
  readFileSync(join(ROOT, "components/trades/performance.tsx"), "utf8"),
  readFileSync(join(ROOT, "lib/trades/post-trade-review.ts"), "utf8"),
  readFileSync(join(ROOT, "components/trades/post-trade-review.tsx"), "utf8"),
].join("\n");
const FORBIDDEN = /良いR|悪いR|成功R|失敗R|理想的|最低ライン|おすすめ|Entry OK|\bGO\b|2R以上を狙うと勝てる|高R:Rほど優秀/;
const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const draft = (changes: Partial<TradeDraft> = {}): TradeDraft => ({
  pair: "USD/JPY",
  side: "long",
  status: "open",
  quantity: 1000,
  entryPrice: 155.2,
  exitPrice: null,
  openedAt: NOW,
  closedAt: null,
  stopLoss: 154.9,
  takeProfit: 155.8,
  notes: "T031",
  ...changes,
});

function ai(overrides: Partial<AIAnalysis> = {}): AIAnalysis {
  const base = finalizeAnalysis(buildInput("USD/JPY", null, null, Date.parse(NOW)), null, "TEST", "not_configured", Date.parse(NOW));
  return {
    ...base,
    signal: "wait",
    directionSignal: "buy",
    action: "WAIT",
    pair: "USD/JPY",
    scenario: {
      direction: "long",
      entryZone: { min: 155.1, max: 155.2 },
      stopLoss: 155,
      takeProfit1: 155.8,
      takeProfit2: 156.2,
      riskReward: 2,
      condition: "TEST",
      invalidation: "TEST",
      sourceTimeframe: "1h",
    },
    ...overrides,
  };
}

function plan(changes: Partial<Parameters<typeof createExitPlan>[0]> = {}) {
  return createExitPlan({
    pair: "USD/JPY",
    side: "long",
    entryPrice: 155.2,
    stopLoss: 154.9,
    takeProfit: 155.8,
    capturedAt: NOW,
    ...changes,
  });
}

function closed(exitPrice: number, extra: Partial<TradeDraft> = {}, capturedAt = NOW): Trade {
  return closeTrade(createTrade(draft(extra), null, "closed", capturedAt).data!, exitPrice, capturedAt, capturedAt).data!;
}

test("A BUY plan", () => {
  const value = plan()!;
  assert.equal(value.side, "buy");
  assert.equal(value.initialStopLoss, 154.9);
  assert.equal(value.initialTakeProfit, 155.8);
  assert.equal(value.initialRiskPrice, 0.3);
});

test("B SELL plan", () => {
  const value = plan({ side: "short", stopLoss: 155.5, takeProfit: 154.6 })!;
  assert.equal(value.side, "sell");
  assert.equal(value.initialRiskPrice, 0.3);
});

test("C BUY invalid SL", () => {
  assert.equal(plan({ stopLoss: 155.5 }), null);
  assert.equal(exitPlanInputErrors({ pair: "USD/JPY", side: "long", entryPrice: 155.2, stopLoss: 155.5, takeProfit: null, capturedAt: NOW }).stopLoss, "買いの初期損切りはエントリー価格より下にしてください。");
});

test("D SELL invalid SL", () => {
  assert.equal(plan({ side: "short", stopLoss: 154.9 }), null);
  assert.equal(exitPlanInputErrors({ pair: "USD/JPY", side: "short", entryPrice: 155.2, stopLoss: 154.9, takeProfit: null, capturedAt: NOW }).stopLoss, "売りの初期損切りはエントリー価格より上にしてください。");
});

test("E zero risk", () => {
  assert.equal(plan({ stopLoss: 155.2 }), null);
  assert.equal(calculateRealizedR(closed(155.8, { stopLoss: 155.2, takeProfit: null })), null);
});

test("F missing SL", () => {
  assert.equal(plan({ stopLoss: null }), null);
  assert.equal(createTrade(draft({ stopLoss: null, takeProfit: null }), null, "f", NOW).data?.exitPlan, null);
});

test("G missing TP", () => {
  const value = plan({ takeProfit: null })!;
  assert.equal(value.initialTakeProfit, null);
  assert.equal(value.plannedRewardRiskRatio, null);
  assert.equal(value.initialRiskPips, 30);
});

test("H invalid TP", () => {
  const value = plan({ takeProfit: 154.5 })!;
  assert.equal(value.initialTakeProfit, null);
  assert.equal(value.plannedRewardRiskRatio, null);
  assert.ok(exitPlanInputErrors({ pair: "USD/JPY", side: "long", entryPrice: 155.2, stopLoss: 154.9, takeProfit: 154.5, capturedAt: NOW }).takeProfit);
});

test("I planned reward BUY", () => {
  const value = plan()!;
  assert.equal(value.plannedRewardPrice, 0.6);
  assert.equal(value.plannedRewardPips, 60);
});

test("J planned reward SELL", () => {
  const value = plan({ side: "short", stopLoss: 155.5, takeProfit: 154.6 })!;
  assert.equal(value.plannedRewardPrice, 0.6);
  assert.equal(value.plannedRewardPips, 60);
});

test("K planned RR", () => {
  assert.equal(plan()!.plannedRewardRiskRatio, 2);
  assert.equal(formatPlannedRR(2), "2.00R");
});

test("L pip conversion", () => {
  assert.equal(JPY_PIP_SIZE, 0.01);
  assert.equal(plan()!.initialRiskPips, 30);
  assert.equal(formatRiskPips(30), "30.0 pips");
});

test("M realized +2R BUY", () => {
  const trade = closed(155.8);
  assert.equal(calculateRealizedR(trade), 2);
  assert.equal(formatRealizedR(2), "+2.00R");
});

test("N realized -1.5R BUY", () => {
  const trade = closed(154.75);
  assert.equal(calculateRealizedR(trade), -1.5);
  assert.equal(formatRealizedR(-1.5), "-1.50R");
});

test("O realized +2R SELL", () => {
  const trade = closed(154.6, { side: "short", stopLoss: 155.5, takeProfit: 154.6 });
  assert.equal(calculateRealizedR(trade), 2);
});

test("P realized negative SELL", () => {
  const trade = closed(155.65, { side: "short", stopLoss: 155.5, takeProfit: 154.6 });
  assert.equal(calculateRealizedR(trade), -1.5);
});

test("Q break-even 0R", () => {
  const trade = closed(155.2);
  assert.equal(calculateRealizedR(trade), 0);
  assert.equal(formatRealizedR(-0), "0.00R");
  assert.equal(formatRealizedR(-0.001), "0.00R");
});

test("R > planned TP", () => {
  const trade = closed(156.4);
  assert.ok(calculateRealizedR(trade)! > plan()!.plannedRewardRiskRatio!);
});

test("S < -1R", () => {
  assert.ok(calculateRealizedR(closed(154.75))! < -1);
});

test("T no clamp", () => {
  assert.equal(calculateRealizedR(closed(154.75)), -1.5);
  assert.equal(calculateRealizedR(closed(156.4)), 4);
});

test("U no exitPrice", () => {
  const open = createTrade(draft(), null, "u", NOW).data!;
  assert.equal(calculateRealizedR(open), null);
  assert.equal(calculateRealizedMovePips(open), null);
});

test("V malformed plan", () => {
  const trade = closed(155.8);
  trade.exitPlan = { version: 1 } as Trade["exitPlan"];
  assert.equal(sanitizeExitPlan(trade.exitPlan), null);
  assert.equal(storedExitPlan(trade), null);
  assert.equal(validateTrade({ ...trade, exitPlan: { candles: [] } }).data?.id, trade.id);
  assert.equal(validateTrade({ ...trade, exitPlan: { candles: [] } }).data?.exitPlan, null);
});

test("W pair mismatch", () => {
  const trade = closed(155.8, { pair: "EUR/JPY" });
  trade.exitPlan = plan()!;
  assert.equal(storedExitPlan(trade), null);
  assert.equal(calculateRealizedR(trade), null);
  assert.equal(exitPlanState(trade), "unreadable");
});

test("X side mismatch", () => {
  const trade = closed(154.6, { side: "short", stopLoss: 155.5, takeProfit: 154.6 });
  trade.exitPlan = plan()!;
  assert.equal(storedExitPlan(trade), null);
  assert.equal(calculateRealizedR(trade), null);
});

test("Y sanitizer", () => {
  assert.equal(sanitizeExitPlan(null), null);
  assert.equal(sanitizeExitPlan("plan"), null);
  assert.equal(sanitizeExitPlan({ version: 2, pair: "USD/JPY", side: "buy", capturedAt: NOW, entryPrice: 155.2, initialStopLoss: 154.9 }), null);
  assert.equal(sanitizeExitPlan({ ...plan()!, apiKey: "x" }), null);
  assert.ok(sanitizeExitPlan(plan()));
});

test("Z canonical derived fields", () => {
  const raw = { ...plan()!, initialRiskPrice: 9, initialRiskPips: 1, plannedRewardPrice: 1, plannedRewardPips: 1, plannedRewardRiskRatio: 99 };
  const clean = sanitizeExitPlan(raw)!;
  assert.equal(clean.initialRiskPrice, 0.3);
  assert.equal(clean.initialRiskPips, 30);
  assert.equal(clean.plannedRewardRiskRatio, 2);
});

test("AA no mutation", () => {
  const input = { pair: "USD/JPY", side: "long" as const, entryPrice: 155.2, stopLoss: 154.9, takeProfit: 155.8, capturedAt: NOW };
  const before = JSON.stringify(input);
  const created = createExitPlan(input)!;
  created.initialRiskPrice = 99;
  assert.equal(JSON.stringify(input), before);
  assert.equal(createExitPlan(input)!.initialRiskPrice, 0.3);
});

test("AB deterministic", () => {
  assert.deepEqual(plan(), plan());
  const trade = closed(155.8);
  assert.equal(calculateRealizedR(trade), calculateRealizedR(trade));
});

test("AC capturedAt caller supplied", () => {
  assert.doesNotMatch(HELPERS, /Date\.now/);
  const value = createExitPlan({ pair: "USD/JPY", side: "long", entryPrice: 155.2, stopLoss: 154.9, takeProfit: null, capturedAt: "2026-01-02T03:04:05.006Z" })!;
  assert.equal(value.capturedAt, "2026-01-02T03:04:05.006Z");
  assert.equal(createExitPlan({ pair: "USD/JPY", side: "long", entryPrice: 155.2, stopLoss: 154.9, takeProfit: null, capturedAt: "not-iso" }), null);
});

test("AD legacy no plan", () => {
  const trade = { ...closed(155.8), exitPlan: null };
  assert.equal(storedExitPlan(trade), null);
  assert.equal(exitPlanState(trade), "absent");
  assert.equal(EXIT_PLAN_MISSING, "初期Exit Planは保存されていません");
  assert.equal(calculateRealizedR(trade), null);
});

test("AE AI snapshot OFF + plan", () => {
  const trade = createTrade(draft(), ai(), "ae", NOW, { saveSnapshot: false }).data!;
  assert.equal(trade.analysisSnapshot, null);
  assert.ok(trade.exitPlan);
  assert.equal(trade.exitPlan?.initialStopLoss, 154.9);
});

test("AF AI unavailable + plan", () => {
  const trade = createTrade(draft(), null, "af", NOW).data!;
  assert.equal(trade.analysisSnapshot, null);
  assert.equal(trade.exitPlan?.initialStopLoss, 154.9);
});

test("AG WAIT + plan", () => {
  const trade = createTrade(draft(), ai({ action: "WAIT", signal: "wait" }), "ag", NOW).data!;
  assert.ok(isRichSnapshot(trade.analysisSnapshot));
  assert.equal(trade.analysisSnapshot.action, "WAIT");
  assert.ok(trade.exitPlan);
});

test("AH edit preserves", () => {
  const trade = createTrade(draft(), null, "ah", NOW).data!;
  const edited = editTrade(trade, { ...trade, entryPrice: 155.5, notes: "edited", stopLoss: 154.5 }, NOW).data!;
  assert.deepEqual(edited.exitPlan, trade.exitPlan);
  assert.equal(edited.entryPrice, 155.5);
  assert.equal(calculateRealizedR(closeTrade(edited, 155.8, NOW, NOW).data!), 2);
});

test("AI close preserves", () => {
  const trade = createTrade(draft(), null, "ai", NOW).data!;
  const closedTrade = closeTrade(trade, 155.8, NOW, NOW).data!;
  assert.deepEqual(closedTrade.exitPlan, trade.exitPlan);
});

test("AJ current AI does not rewrite", () => {
  const source = ai({ scenario: { ...ai().scenario!, stopLoss: 155 } });
  const trade = createTrade(draft(), source, "aj", NOW).data!;
  assert.equal(trade.exitPlan?.initialStopLoss, 154.9);
  source.scenario!.stopLoss = 155.05;
  assert.equal(trade.exitPlan?.initialStopLoss, 154.9);
});

test("AK outcome does not rewrite", () => {
  const profit = closed(155.8);
  const loss = closed(154.75);
  assert.deepEqual(profit.exitPlan, loss.exitPlan);
});

test("AL R coverage", () => {
  const summary = summarizeRPerformance([closed(155.8), { ...closed(155.8), id: "legacy", exitPlan: null }, createTrade(draft(), null, "open", NOW).data!]);
  assert.equal(summary.eligibleCount, 2);
  assert.equal(summary.sampleSize, 1);
  assert.equal(summary.coverage, 50);
});

test("AM total R", () => {
  const summary = summarizeRPerformance([closed(155.8), closed(154.75)]);
  assert.equal(summary.totalR, 0.5);
});

test("AN average R", () => {
  const summary = summarizeRPerformance([closed(155.8), closed(154.75)]);
  assert.equal(summary.averageR, 0.25);
});

test("AO positive/negative/zero counts", () => {
  const summary = summarizeRPerformance([closed(155.8), closed(154.75), closed(155.2)]);
  assert.equal(summary.positiveR, 1);
  assert.equal(summary.negativeR, 1);
  assert.equal(summary.zeroR, 1);
});

test("AP eligible denominator", () => {
  const summary = summarizeRPerformance([closed(155.8), createTrade(draft(), null, "open", NOW).data!]);
  assert.equal(summary.eligibleCount, 1);
});

test("AQ legacy denominator only", () => {
  const legacy = { ...closed(155.8), exitPlan: null };
  const summary = summarizeRPerformance([legacy, legacy]);
  assert.equal(summary.eligibleCount, 2);
  assert.equal(summary.sampleSize, 0);
  assert.equal(formatRCoverage(summary), "0 / 2（0.0%）");
});

test("AR invalid plan excluded numerator", () => {
  const bad = closed(155.8);
  bad.exitPlan = plan({ pair: "EUR/JPY" });
  const summary = summarizeRPerformance([bad]);
  assert.equal(summary.eligibleCount, 1);
  assert.equal(summary.sampleSize, 0);
});

test("AS PF existing unaffected", () => {
  const trades = [closed(155.8), closed(154.75)];
  const stats = summarize(trades);
  assert.ok(Number.isFinite(stats.profitFactor));
  assert.equal(stats.count, 2);
  assert.equal("averageR" in stats, false);
});

test("AT local persistence", () => {
  const entries = new Map<string, string>();
  const repo = createTradeRepository(() => ({ getItem: key => entries.get(key) ?? null, setItem: (key, value) => { entries.set(key, value); } }));
  const trade = createTrade(draft(), null, "persist", NOW).data!;
  assert.equal(repo.save([trade], 0).data?.revision, 1);
  assert.deepEqual(createTradeRepository(() => ({ getItem: key => entries.get(key) ?? null, setItem: () => undefined })).load().data?.trades[0].exitPlan, trade.exitPlan);
  const legacy = JSON.stringify({ schemaVersion: 1, revision: 1, trades: [{ ...trade, exitPlan: undefined }] });
  assert.equal(decodeJournal(legacy).data?.trades[0].exitPlan, null);
});

test("AU cloud serialization", () => {
  const trade = createTrade(draft(), null, "cccccccc-cccc-4ccc-8ccc-cccccccccccc", NOW).data!;
  const row = toTradeRow(trade, OWNER);
  assert.ok(row.exit_plan);
  assert.equal((row.exit_plan as unknown as TradeExitPlan).initialStopLoss, 154.9);
});

test("AV cloud deserialization", () => {
  const trade = createTrade(draft(), null, "cccccccc-cccc-4ccc-8ccc-cccccccccccc", NOW).data!;
  assert.deepEqual(fromTradeRow({ ...toTradeRow(trade, OWNER), version: 1, local_trade_id: null }, OWNER).exitPlan, trade.exitPlan);
});

test("AW malformed cloud plan fail-soft", () => {
  const trade = createTrade(draft(), null, "cccccccc-cccc-4ccc-8ccc-cccccccccccc", NOW).data!;
  const mapped = fromTradeRow({ ...toTradeRow(trade, OWNER), exit_plan: { version: 1 }, version: 1, local_trade_id: null }, OWNER);
  assert.equal(mapped.id, trade.id);
  assert.equal(mapped.exitPlan, null);
  assert.ok(mapped.analysisSnapshot === trade.analysisSnapshot || mapped.analysisSnapshot == null);
});

test("AX RLS/migration compatibility", () => {
  const sql = readFileSync(join(ROOT, "supabase/migrations/20260916210000_add_trade_exit_plan.sql"), "utf8");
  assert.match(sql, /add column if not exists exit_plan jsonb/i);
  assert.match(sql, /exit_plan is null or jsonb_typeof\(exit_plan\) = 'object'/i);
  assert.match(sql, /exit_plan is distinct from old\.exit_plan/i);
  assert.doesNotMatch(sql, /drop policy|disable row level security/i);
  assert.match(sql, /import_local_trades/i);
  assert.match(sql, /security invoker/i);
});

test("AY no extra API", () => {
  assert.doesNotMatch(HELPERS, /\bfetch\s*\(/);
  assert.doesNotMatch(HELPERS, /twelvedata|api\.openai|openai\.com|finnhub\.io|stlouisfed|eodhd\.com/i);
});

test("AZ no extra query", () => {
  assert.doesNotMatch(readFileSync(join(ROOT, "lib/supabase/cloud-repository.ts"), "utf8"), /from\("exit_plan"\)/);
});

test("BA no polling", () => {
  assert.doesNotMatch(HELPERS, /setInterval|setTimeout/);
});

test("BB Readiness remains 5", () => {
  assert.equal(READINESS_FIXED_TOTAL, 5);
  assert.doesNotMatch(SOURCE, /totalCount:\s*6/);
});

test("BC Trigger unchanged", () => {
  assert.doesNotMatch(HELPERS, /triggerStatus|entryTrigger/);
});

test("BD Daily Plan unchanged", () => {
  assert.doesNotMatch(HELPERS, /buildDailyTradingPlan|daily-plan/);
});

test("BE Action unchanged", () => {
  assert.doesNotMatch(HELPERS, /actionGuidanceLabel|Action WAIT/);
});

test("BF Entry Context unchanged", () => {
  const entry = readFileSync(join(ROOT, "lib/trades/entry-context.ts"), "utf8");
  assert.doesNotMatch(entry, /exitPlan|realizedR|Exit Plan/);
});

test("BG no good/bad wording", () => {
  assert.doesNotMatch(SOURCE, FORBIDDEN);
});

test("BH no Entry OK", () => {
  assert.doesNotMatch(SOURCE, /Entry OK/);
});

test("BI no recommendation", () => {
  assert.doesNotMatch(SOURCE, /おすすめ|推奨R|最低2R/);
});

test("BJ no causal claim", () => {
  assert.doesNotMatch(SOURCE, /だから勝てる|高R:Rほど優秀|2R以上を狙うと勝てる/);
});

test("BK negative zero normalization", () => {
  assert.equal(formatRealizedR(-0.004), "0.00R");
  assert.doesNotMatch(formatRealizedR(-0.004), /-0\.00R/);
  assert.equal(formatMovePips(0), "0.0 pips");
});

test("critical 1 BUY +2R", () => {
  const value = plan()!;
  const trade = closed(155.8);
  assert.equal(value.initialRiskPips, 30);
  assert.equal(value.plannedRewardRiskRatio, 2);
  assert.equal(calculateRealizedR(trade), 2);
  assert.equal(formatRealizedR(calculateRealizedR(trade)), "+2.00R");
});

test("critical 2 SELL +2R", () => {
  const value = plan({ side: "short", stopLoss: 155.5, takeProfit: 154.6 })!;
  const trade = closed(154.6, { side: "short", stopLoss: 155.5, takeProfit: 154.6 });
  assert.equal(value.initialRiskPips, 30);
  assert.equal(value.plannedRewardRiskRatio, 2);
  assert.equal(calculateRealizedR(trade), 2);
});

test("critical 3 BUY -1.5R no clamp", () => {
  assert.equal(calculateRealizedR(closed(154.75)), -1.5);
});

test("critical 4 toggle OFF still saves plan", () => {
  const trade = createTrade(draft(), ai(), "c4", NOW, { saveSnapshot: false }).data!;
  assert.equal(trade.analysisSnapshot, null);
  assert.equal(trade.exitPlan?.version, 1);
});

test("critical 5 current AI SL ignored", () => {
  const trade = createTrade(draft(), ai({ scenario: { ...ai().scenario!, stopLoss: 155 } }), "c5", NOW).data!;
  assert.equal(trade.exitPlan?.initialStopLoss, 154.9);
  assert.equal(calculateRealizedR(closeTrade(trade, 155.8, NOW, NOW).data!), 2);
});

test("prefill uses matching scenario only", () => {
  assert.deepEqual(aiScenarioPrefill(ai(), "USD/JPY", "long"), { stopLoss: 155, takeProfit: 155.8 });
  assert.deepEqual(aiScenarioPrefill(ai(), "USD/JPY", "long", 155.2), { stopLoss: 155, takeProfit: 155.8 });
  assert.equal(aiScenarioPrefill(ai(), "USD/JPY", "long", 154.5), null);
  assert.equal(aiScenarioPrefill(ai(), "USD/JPY", "short"), null);
  assert.equal(aiScenarioPrefill(ai(), "EUR/JPY", "long"), null);
  assert.match(EXIT_PLAN_PREFILL_NOTE, /現在のAI分析から初期値を入力しています/);
});

test("finite safety rejects NaN Infinity and non-positive entry", () => {
  assert.equal(createExitPlan({ pair: "USD/JPY", side: "long", entryPrice: NaN, stopLoss: 154.9, takeProfit: 155.8, capturedAt: NOW }), null);
  assert.equal(createExitPlan({ pair: "USD/JPY", side: "long", entryPrice: Infinity, stopLoss: 154.9, takeProfit: 155.8, capturedAt: NOW }), null);
  assert.equal(createExitPlan({ pair: "USD/JPY", side: "long", entryPrice: 0, stopLoss: -1, takeProfit: 155.8, capturedAt: NOW }), null);
});

test("legacy journal with malformed plan still loads", () => {
  const trade = createTrade(draft(), null, "malformed", NOW).data!;
  const raw = JSON.stringify({ schemaVersion: 1, revision: 1, trades: [{ ...trade, exitPlan: { prompt: "secret", version: 1 } }] });
  const loaded = decodeJournal(raw).data!;
  assert.equal(loaded.trades[0].id, trade.id);
  assert.equal(loaded.trades[0].exitPlan, null);
});
