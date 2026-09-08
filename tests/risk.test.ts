import test from "node:test";
import assert from "node:assert/strict";
import { allowedLoss, positionRisk, positionSize } from "../lib/risk/position-size";
import { analysisPlan, riskReward } from "../lib/risk/risk-reward";
import { drawdown, goalProgress } from "../lib/risk/drawdown";
import { buildInput } from "../lib/ai/input";
import { finalizeAnalysis } from "../lib/ai/engine";
import type { AIAnalysis, TradeSignal } from "../lib/ai/types";
import type { Symbol } from "../lib/market/types";
const now = Date.parse("2026-09-08T00:00:00Z");
function analysis(pair: Symbol = "USD/JPY", signal: TradeSignal = "buy"): AIAnalysis {
  const a = finalizeAnalysis(buildInput(pair, null, null, now), null, "TEST", "not_configured", now);
  return { ...a, signal, ai: { status: "available", model: "TEST", code: null, message: null }, scenario: { direction: "long", entryZone: { min: 153.4, max: 153.5 }, stopLoss: 153, takeProfit1: 154.5, takeProfit2: 155, riskReward: 999, condition: "TEST", invalidation: "TEST", sourceTimeframe: "1h" } };
}
test("budget uses percentage and floors fractions of one sen", () => {
  assert.equal(allowedLoss(50000, 1), 500); assert.equal(allowedLoss(12345.67, 1), 123.45); assert.equal(allowedLoss(0, 1), 0);
});
test("invalid budget inputs are not coerced", () => {
  for (const b of [-1, NaN, Infinity, 1e13]) assert.equal(allowedLoss(b, 1), null);
  for (const r of [-1, 0, NaN, Infinity, 100.01]) assert.equal(allowedLoss(50000, r), null);
  assert.equal(allowedLoss(50000, 100), 50000);
});
test("example 500 yen and 0.5 yen stop produces 1000 units", () => {
  assert.deepEqual(positionSize(50000, 1, 153.5, 153, 1).data, { allowedLoss: 500, maxUnits: 1000, estimatedLoss: 500, lossPerUnit: .5 });
});
test("trade unit floors and insufficient budget gives zero", () => {
  assert.equal(positionSize(50000, 1, 153.3, 153, 1).data?.maxUnits, 1666);
  assert.equal(positionSize(50000, 1, 153.3, 153, 100).data?.maxUnits, 1600);
  assert.equal(positionSize(50000, 1, 153.3, 153, 1000).data?.maxUnits, 1000);
  assert.equal(positionSize(50000, 1, 154, 153, 1000).data?.maxUnits, 0);
  assert.equal(positionSize(0, 1, 154, 153, 1).data?.maxUnits, 0);
});
test("decimal boundary never rounds a position above budget", () => {
  const size = positionSize(50000, 1, 153.1, 153, 1).data!;
  assert.equal(size.maxUnits, 5000); assert.equal(size.estimatedLoss, 500);
  for (const width of [.001, .003, .07, .101, .333, .5, 1.7, 50]) for (const unit of [1, 100, 1000]) {
    const result = positionSize(50000, 1, width + 100, 100, unit).data!;
    assert.ok(result.estimatedLoss <= result.allowedLoss); assert.equal(result.maxUnits % unit, 0);
  }
});
test("equal stop, negative prices and invalid units return errors", () => {
  for (const price of [0, -1, NaN, Infinity, Number.MAX_VALUE]) assert.equal(positionSize(50000, 1, price, 153, 1).data, null);
  assert.equal(positionSize(50000, 1, 153, 153, 1).data, null);
  for (const unit of [0, -1, 1.5, NaN, Infinity]) assert.equal(positionSize(50000, 1, 154, 153, unit).data, null);
});
test("extremely small and large stops remain bounded", () => {
  assert.equal(positionSize(50000, 1, 1.000000001, 1, 1).data?.maxUnits, 500000000000);
  assert.equal(positionSize(50000, 1, 1.000000000001, 1, 1).data, null);
  assert.equal(positionSize(50000, 1, 1e12, 1, 1).data?.maxUnits, 0);
  assert.equal(positionSize(1e12, 100, 1.000000001, 1, 1).data, null);
});
test("long and short risk reward calculated without trusting AI ratio", () => {
  assert.deepEqual(riskReward(153.5, 153, 154.5, "long"), { stopWidth: .5, profitWidth: 1, riskReward: 2 });
  assert.deepEqual(riskReward(153.5, 154, 152.5, "short"), { stopWidth: .5, profitWidth: 1, riskReward: 2 });
  assert.equal(riskReward(153, 153, 154, "long"), null);
  assert.equal(riskReward(153, 152, 151, "long"), null);
});
for (const pair of ["USD/JPY", "EUR/JPY", "GBP/JPY"] as const) test(`${pair} chooses the worst edge of the conditional zone`, () => {
  const a = analysis(pair); const p = analysisPlan(a, pair, now).data!;
  assert.equal(p.entry, 153.5); assert.equal(p.riskReward, 2); assert.equal(positionSize(50000, 1, p.entry, p.scenario.stopLoss, 1).data?.maxUnits, 1000);
  a.signal = "sell"; a.scenario = { ...a.scenario!, direction: "short", entryZone: { min: 153.5, max: 153.6 }, stopLoss: 154, takeProfit1: 152.5, takeProfit2: 152 };
  assert.equal(analysisPlan(a, pair, now).data?.entry, 153.5);
});
test("WAIT suppresses a scenario even when prices are present", () => { assert.equal(analysisPlan(analysis("USD/JPY", "wait"), "USD/JPY", now).data, null); });
test("missing, expired, wrong-pair and unavailable AI data never produce positions", () => {
  assert.equal(analysisPlan(null, "USD/JPY", now).data, null);
  assert.equal(analysisPlan(analysis(), "EUR/JPY", now).data, null);
  assert.equal(analysisPlan(analysis(), "USD/JPY", now + 60000).data, null);
  assert.equal(analysisPlan({ ...analysis(), expiresAt: "invalid" }, "USD/JPY", now).data, null);
  assert.equal(analysisPlan({ ...analysis(), scenario: null }, "USD/JPY", now).data, null);
  const a = analysis(); a.ai.status = "error"; assert.equal(analysisPlan(a, "USD/JPY", now).data, null);
});
test("wrong direction, inverted zone and low RR are rejected", () => {
  const a = analysis(); a.scenario!.takeProfit1 = 153.6; assert.equal(analysisPlan(a, "USD/JPY", now).data, null);
  const b = analysis(); b.scenario!.direction = "short"; assert.equal(analysisPlan(b, "USD/JPY", now).data, null);
  const c = analysis(); c.scenario!.entryZone.min = 154; assert.equal(analysisPlan(c, "USD/JPY", now).data, null);
});
test("input position warning reports actual loss and percent", () => {
  const size = positionSize(50000, 1, 153.5, 153, 100).data!;
  const r = positionRisk(2000, size, 50000, 153.5, 153, 100)!;
  assert.equal(r.estimatedLoss, 1000); assert.equal(r.actualRiskPercent, 2); assert.equal(r.exceedsRisk, true);
  assert.equal(positionRisk(1000, size, 50000, 153.5, 153, 100)?.exceedsRisk, false);
  assert.equal(positionRisk(101, size, 50000, 153.5, 153, 100)?.validUnit, false);
  for (const units of [-1, 1.5, NaN, Infinity]) assert.equal(positionRisk(units, size, 50000, 153.5, 153, 100), null);
});
test("goals cannot influence the position budget", () => {
  assert.deepEqual(goalProgress(50000, 100000), { remaining: 50000, percent: 50, barPercent: 50 });
  assert.deepEqual(goalProgress(50000, 25000), { remaining: 0, percent: 200, barPercent: 100 });
  assert.equal(goalProgress(50000, 0), null); assert.equal(goalProgress(50000, Number.MIN_VALUE), null); assert.equal(goalProgress(-1, 100), null);
  assert.equal(goalProgress(50000, 1e6)?.remaining, 950000);
  assert.equal(positionSize(50000, 1, 153.5, 153, 1).data?.maxUnits, 1000);
});
test("losing streaks compound the remaining capital", () => {
  assert.deepEqual(drawdown(50000, 1).map(p => Math.round(p.balance)), [49500, 48515, 47550, 45219]);
  assert.ok(drawdown(50000, 5)[3].balance < drawdown(50000, 1)[3].balance);
  assert.ok(drawdown(50000, 100).every(p => p.balance === 0));
  assert.ok(drawdown(0, 1).every(p => p.balance === 0));
  assert.deepEqual(drawdown(-1, 1), []); assert.deepEqual(drawdown(50000, 0), []);
});
