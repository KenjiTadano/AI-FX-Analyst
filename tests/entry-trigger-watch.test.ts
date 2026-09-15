import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  evaluateStructuredEntryTrigger,
  type StructuredEntryTrigger,
} from "../lib/ai/entry-trigger";
import { priceDeltaToPips } from "../lib/trades/analysis-price";
import {
  WATCH_DISTANCE_DISCLAIMER,
  WATCH_INVALID_MESSAGE,
  WATCH_NEWLY_MET_NOTICE,
  WATCH_STATUS_TEXT,
  WATCH_UNAVAILABLE_MESSAGE,
  buildEntryTriggerWatch,
  formatWatchCheckedAt,
  formatWatchDistancePips,
  nextWatchTransitionState,
  type EntryTriggerWatch,
} from "../lib/trading-plan/entry-trigger-watch";
import type { EntryTriggerEvaluation } from "../lib/ai/entry-trigger";

const NOW = Date.parse("2026-09-15T03:15:00.000Z");
const ANALYZED_AT = new Date(NOW - 30_000).toISOString();

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

function evaluation(
  trig: StructuredEntryTrigger,
  extra: { currentRate?: number | null; close?: number } = {},
): EntryTriggerEvaluation {
  const candles = extra.close == null
    ? undefined
    : { "15m": { candles: [{ time: new Date(NOW - 15 * 60_000).toISOString(), open: extra.close, high: extra.close, low: extra.close, close: extra.close }], lastClosedAt: new Date(NOW - 15 * 60_000).toISOString() } };
  return evaluateStructuredEntryTrigger({
    trigger: trig,
    pair: trig.pair,
    currentRate: extra.currentRate,
    candlesByTimeframe: candles,
    now: NOW,
  });
}

function watch(
  trig: StructuredEntryTrigger | null,
  evalResult: EntryTriggerEvaluation | null,
  extra: Partial<Parameters<typeof buildEntryTriggerWatch>[0]> = {},
) {
  return buildEntryTriggerWatch({
    trigger: trig,
    evaluation: evalResult,
    action: extra.action ?? "WAIT",
    direction: extra.direction ?? "SELL",
    stale: extra.stale ?? false,
    dailyLossLimitReached: extra.dailyLossLimitReached ?? false,
    eventRiskHigh: extra.eventRiskHigh,
    eventRiskMessage: extra.eventRiskMessage,
    analyzedAt: extra.analyzedAt ?? ANALYZED_AT,
    pair: extra.pair ?? "USD/JPY",
    ...extra,
  });
}

function assertNoPercent(model: EntryTriggerWatch | null) {
  const json = JSON.stringify(model);
  assert.doesNotMatch(json, /progressPercent|distancePercent|probability|winRate|80%|92%/);
  if (model) {
    assert.equal("progressPercent" in model, false);
    assert.equal("distancePercent" in model, false);
    assert.equal("probability" in model, false);
    assert.equal("winRate" in model, false);
  }
}

test("A: price_above distance", () => {
  const trig = trigger({ type: "price_above", price: 156.36 });
  const evalResult = evaluation(trig, { currentRate: 156.28 });
  assert.equal(evalResult.status, "not_met");
  const model = watch(trig, evalResult);
  assert.equal(model?.status, "waiting");
  assert.equal(model?.distanceToTriggerPips, priceDeltaToPips("USD/JPY", 156.36 - 156.28));
  assert.equal(model?.distanceToTriggerPips, 8);
  assert.equal(model?.showDistance, true);
});

test("B: price_below distance", () => {
  const trig = trigger({ type: "price_below", price: 156.2 });
  const evalResult = evaluation(trig, { currentRate: 156.28 });
  assert.equal(evalResult.status, "not_met");
  const model = watch(trig, evalResult);
  assert.equal(model?.distanceToTriggerPips, 8);
  assert.equal(model?.showDistance, true);
  assert.equal(model?.status, "waiting");
});

test("C: candle_close_above distance", () => {
  const trig = trigger({ type: "candle_close_above", price: 156.36, timeframe: "15min" });
  const evalResult = evaluation(trig, { close: 156.28 });
  assert.equal(evalResult.status, "not_met");
  const model = watch(trig, evalResult);
  assert.equal(model?.distanceToTriggerPips, 8);
  assert.equal(model?.observedLabel, "最新確定値");
});

test("D: candle_close_below distance", () => {
  const trig = trigger({ type: "candle_close_below", price: 156.2, timeframe: "15min" });
  const evalResult = evaluation(trig, { close: 156.28 });
  assert.equal(evalResult.status, "not_met");
  const model = watch(trig, evalResult);
  assert.equal(model?.distanceToTriggerPips, 8);
});

test("E: met distance 0", () => {
  const trig = trigger();
  const evalResult = evaluation(trig, { currentRate: 156.18 });
  assert.equal(evalResult.status, "met");
  const model = watch(trig, evalResult);
  assert.equal(model?.status, "met");
  assert.equal(model?.distanceToTriggerPips, 0);
  assert.equal(model?.showDistance, false);
  assert.equal(model?.statusText, "条件成立");
});

test("F: equality => waiting + 0 pips", () => {
  const trig = trigger();
  const evalResult = evaluation(trig, { currentRate: 156.2 });
  assert.equal(evalResult.status, "not_met");
  const model = watch(trig, evalResult);
  assert.equal(model?.status, "waiting");
  assert.equal(model?.distanceToTriggerPips, 0);
  assert.equal(model?.showDistance, true);
  assert.notEqual(model?.status, "met");
});

test("G: decimal pip rounding", () => {
  const trig = trigger({ price: 156.205 });
  const evalResult = evaluation(trig, { currentRate: 156.28 });
  const model = watch(trig, evalResult);
  assert.equal(model?.distanceToTriggerPips, 7.5);
  assert.equal(formatWatchDistancePips(7.999999), "8 pips");
  assert.equal(formatWatchDistancePips(0.5), "0.5 pips");
  assert.doesNotMatch(formatWatchDistancePips(7.999999), /7\.999/);
});

test("H: unavailable no distance", () => {
  const trig = trigger();
  const evalResult = evaluation(trig, { currentRate: null });
  assert.equal(evalResult.status, "unavailable");
  const model = watch(trig, evalResult);
  assert.equal(model?.status, "unavailable");
  assert.equal(model?.distanceToTriggerPips, null);
  assert.equal(model?.showDistance, false);
  assert.equal(model?.statusText, WATCH_UNAVAILABLE_MESSAGE);
  assert.match(model?.unavailableDetail ?? "", /現在価格の判定データを待っています/);
});

test("I: invalid no distance", () => {
  const evalResult = evaluateStructuredEntryTrigger({
    trigger: { version: 1, type: "macd_cross", pair: "USD/JPY", price: 156.2 },
    pair: "USD/JPY",
    currentRate: 156.1,
    now: NOW,
  });
  assert.equal(evalResult.status, "invalid");
  const model = watch(null, evalResult);
  assert.equal(model?.status, "invalid");
  assert.equal(model?.distanceToTriggerPips, null);
  assert.equal(model?.invalidMessage, WATCH_INVALID_MESSAGE);
});

test("J: trigger null", () => {
  assert.equal(watch(null, null), null);
});

test("K: SELL + WAIT preserved", () => {
  const trig = trigger();
  const model = watch(trig, evaluation(trig, { currentRate: 156.28 }), { direction: "SELL", action: "WAIT" });
  assert.equal(model?.direction, "SELL");
  assert.equal(model?.action, "WAIT");
});

test("L: BUY + WAIT preserved", () => {
  const trig = trigger({ type: "price_above" });
  const model = watch(trig, evaluation(trig, { currentRate: 156.1 }), { direction: "BUY", action: "WAIT" });
  assert.equal(model?.direction, "BUY");
  assert.equal(model?.action, "WAIT");
});

test("M: met does not alter WAIT", () => {
  const trig = trigger();
  const model = watch(trig, evaluation(trig, { currentRate: 156.1 }), { action: "WAIT", direction: "SELL" });
  assert.equal(model?.status, "met");
  assert.equal(model?.action, "WAIT");
});

test("N: stale + met warning", () => {
  const trig = trigger();
  const model = watch(trig, evaluation(trig, { currentRate: 156.1 }), { stale: true, action: "WAIT" });
  assert.equal(model?.status, "met");
  assert.equal(model?.action, "WAIT");
  assert.match(model?.staleWarning ?? "", /分析が古いため再分析してください/);
});

test("O: DLL + met warning", () => {
  const trig = trigger();
  const model = watch(trig, evaluation(trig, { currentRate: 156.1 }), { dailyLossLimitReached: true, action: "WAIT" });
  assert.equal(model?.status, "met");
  assert.equal(model?.action, "WAIT");
  assert.match(model?.dailyLossLimitWarning ?? "", /Daily Loss Limit/);
  assert.doesNotMatch(JSON.stringify(model), /取引禁止/);
});

test("P: Event high + met warning", () => {
  const trig = trigger();
  const model = watch(trig, evaluation(trig, { currentRate: 156.1 }), {
    eventRiskHigh: true,
    eventRiskMessage: "米CPI（予定あり）",
    action: "WAIT",
  });
  assert.equal(model?.status, "met");
  assert.equal(model?.eventRiskWarning, "米CPI（予定あり）");
  assert.equal(model?.action, "WAIT");
});

test("Q: no percentage", () => {
  const trig = trigger();
  const model = watch(trig, evaluation(trig, { currentRate: 156.28 }));
  assertNoPercent(model);
  assert.match(model?.distanceDisclaimer ?? "", /成立確率やエントリー推奨度ではありません/);
  assert.equal(model?.distanceDisclaimer, WATCH_DISTANCE_DISCLAIMER);
});

test("R: deterministic model", () => {
  const trig = trigger();
  const evalResult = evaluation(trig, { currentRate: 156.28 });
  assert.deepEqual(watch(trig, evalResult), watch(trig, evalResult));
});

test("S: very large distance", () => {
  const trig = trigger({ price: 141.2 });
  const evalResult = evaluation(trig, { currentRate: 156.2 });
  const model = watch(trig, evalResult);
  assert.equal(model?.distanceToTriggerPips, 1500);
  assert.doesNotMatch(JSON.stringify(model), /遠すぎる|成立しにくい/);
});

test("T: pair mismatch safe", () => {
  const trig = trigger({ pair: "USD/JPY" });
  const evalResult = evaluation(trig, { currentRate: 156.28 });
  const model = watch(trig, evalResult, { pair: "EUR/JPY" });
  assert.equal(model?.status, "invalid");
  assert.equal(model?.distanceToTriggerPips, null);
  assert.equal(model?.identity, null);
});

test("U: checkedAt preserved", () => {
  const trig = trigger();
  const evalResult = evaluation(trig, { currentRate: 156.1 });
  const model = watch(trig, evalResult);
  assert.equal(model?.checkedAt, evalResult.checkedAt);
  assert.equal(model?.checkedAt, new Date(NOW).toISOString());
  assert.equal(formatWatchCheckedAt(evalResult.checkedAt), "12:15");
});

test("V: no raw candle evaluation in Watch", () => {
  const source = readFileSync(join(process.cwd(), "lib/trading-plan/entry-trigger-watch.ts"), "utf8");
  assert.doesNotMatch(source, /lastClosedCandle|candles\.filter|forming|candlesByTimeframe/);
  assert.doesNotMatch(source, /evaluateStructuredEntryTrigger/);
});

test("W: no fetch", () => {
  const source = readFileSync(join(process.cwd(), "lib/trading-plan/entry-trigger-watch.ts"), "utf8");
  assert.doesNotMatch(source, /openai|twelvedata|finnhub|stlouisfed|eodhd|fetch\(/i);
  const original = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error("unexpected fetch"); }) as typeof fetch;
  try {
    const trig = trigger();
    assert.equal(watch(trig, evaluation(trig, { currentRate: 156.1 }))?.status, "met");
  } finally {
    globalThis.fetch = original;
  }
});

test("X: no timer", () => {
  const source = readFileSync(join(process.cwd(), "lib/trading-plan/entry-trigger-watch.ts"), "utf8");
  assert.doesNotMatch(source, /setInterval|setTimeout|Notification|serviceWorker|PushManager/);
});

test("Y: no probability/winRate", () => {
  const trig = trigger();
  const model = watch(trig, evaluation(trig, { currentRate: 156.1 }));
  assertNoPercent(model);
  assert.doesNotMatch(JSON.stringify(model), /勝率|チャンス|今です/);
});

test("Z: legacy Task020 behavior preserved", () => {
  const trig = trigger();
  assert.equal(evaluateStructuredEntryTrigger({ trigger: trig, pair: "USD/JPY", currentRate: 156.2, now: NOW }).status, "not_met");
  assert.equal(evaluateStructuredEntryTrigger({ trigger: trig, pair: "USD/JPY", currentRate: 156.19, now: NOW }).status, "met");
  const equal = watch(trig, evaluation(trig, { currentRate: 156.2 }));
  assert.equal(equal?.status, "waiting");
  assert.equal(equal?.distanceToTriggerPips, 0);
});

test("AA: not_met → met = transitioned true", () => {
  const previous = nextWatchTransitionState(null, { identityKey: "a", evaluationStatus: "not_met" });
  const next = nextWatchTransitionState(previous, { identityKey: "a", evaluationStatus: "met" });
  assert.equal(next.newlyMet, true);
  assert.equal(WATCH_NEWLY_MET_NOTICE.length > 0, true);
});

test("AB: initial met = transitioned false", () => {
  const next = nextWatchTransitionState(null, { identityKey: "a", evaluationStatus: "met" });
  assert.equal(next.newlyMet, false);
});

test("AC: met → met = false", () => {
  const initial = nextWatchTransitionState(null, { identityKey: "a", evaluationStatus: "met" });
  const next = nextWatchTransitionState(initial, { identityKey: "a", evaluationStatus: "met" });
  assert.equal(next.newlyMet, false);
});

test("AD: unavailable → met newlyMet false", () => {
  const previous = nextWatchTransitionState(null, { identityKey: "a", evaluationStatus: "unavailable" });
  const next = nextWatchTransitionState(previous, { identityKey: "a", evaluationStatus: "met" });
  assert.equal(next.newlyMet, false);
});

test("AE: trigger identity change resets", () => {
  const previous = nextWatchTransitionState(null, { identityKey: "price_below|156.2", evaluationStatus: "not_met" });
  const armed = nextWatchTransitionState(previous, { identityKey: "price_below|156.2", evaluationStatus: "met" });
  assert.equal(armed.newlyMet, true);
  const reset = nextWatchTransitionState(armed, { identityKey: "price_below|155", evaluationStatus: "met" });
  assert.equal(reset.newlyMet, false);
});

test("AF: pair change resets", () => {
  const previous = nextWatchTransitionState(null, { identityKey: "USD/JPY|a", evaluationStatus: "not_met" });
  const armed = nextWatchTransitionState(previous, { identityKey: "USD/JPY|a", evaluationStatus: "met" });
  const reset = nextWatchTransitionState(armed, { identityKey: "EUR/JPY|a", evaluationStatus: "met" });
  assert.equal(reset.newlyMet, false);
});

test("AG: analysis timestamp change resets", () => {
  const previous = nextWatchTransitionState(null, { identityKey: "ts1|USD/JPY", evaluationStatus: "not_met" });
  const armed = nextWatchTransitionState(previous, { identityKey: "ts1|USD/JPY", evaluationStatus: "met" });
  const reset = nextWatchTransitionState(armed, { identityKey: "ts2|USD/JPY", evaluationStatus: "met" });
  assert.equal(reset.newlyMet, false);
});

test("AH: reanalysis no old transition", () => {
  const first = nextWatchTransitionState(null, { identityKey: "old", evaluationStatus: "not_met" });
  const met = nextWatchTransitionState(first, { identityKey: "old", evaluationStatus: "met" });
  assert.equal(met.newlyMet, true);
  const reanalysis = nextWatchTransitionState(met, { identityKey: "new", evaluationStatus: "not_met" });
  assert.equal(reanalysis.newlyMet, false);
  const laterMet = nextWatchTransitionState(reanalysis, { identityKey: "new", evaluationStatus: "met" });
  assert.equal(laterMet.newlyMet, true);
});

test("candle unavailable uses timeframe waiting copy", () => {
  const trig = trigger({ type: "candle_close_below", timeframe: "1min" });
  const evalResult = evaluateStructuredEntryTrigger({ trigger: trig, pair: "USD/JPY", now: NOW });
  assert.equal(evalResult.status, "unavailable");
  const model = watch(trig, evalResult);
  assert.equal(model?.status, "unavailable");
  assert.match(model?.unavailableDetail ?? "", /1分足の確定データを待っています/);
  assert.equal(model?.distanceToTriggerPips, null);
});

test("Watch UI has no timer or fetch", () => {
  const source = readFileSync(join(process.cwd(), "components/dashboard/entry-trigger-watch.tsx"), "utf8");
  assert.doesNotMatch(source, /setInterval|setTimeout|Notification|serviceWorker|fetch\(/);
});

test("Watch status text is not color-only", () => {
  assert.equal(WATCH_STATUS_TEXT.waiting, "条件待ち");
  assert.equal(WATCH_STATUS_TEXT.met, "条件成立");
  assert.equal(WATCH_STATUS_TEXT.unavailable, "判定データ待ち");
  assert.equal(WATCH_STATUS_TEXT.invalid, "利用不可");
});
