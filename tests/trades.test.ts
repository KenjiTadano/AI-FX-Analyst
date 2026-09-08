import test from "node:test";
import assert from "node:assert/strict";
import { pnl, unrealizedPnl, plannedRiskReward } from "../lib/trades/calculations";
import { createTrade, editTrade, closeTrade, captureAnalysis } from "../lib/trades/service";
import { validateDraft, validDate } from "../lib/trades/validation";
import { summarize, signalPerformance, pairPerformance, dailyPnl, equityCurve, dayKey, monthCells } from "../lib/trades/analytics";
import { createTradeRepository, decodeJournal, STORAGE_KEY } from "../lib/trades/repository";
import { fromLocalDateTime } from "../components/trades/format";
import type { TradeDraft, Trade } from "../lib/trades/types";
import { buildInput } from "../lib/ai/input";
import { finalizeAnalysis } from "../lib/ai/engine";
const now = "2026-09-08T03:00:00.000Z";
const ms = Date.parse(now);
const draft = (changes: Partial<TradeDraft> = {}): TradeDraft => ({ pair: "USD/JPY", side: "long", status: "open", quantity: 1000, entryPrice: 153.5, exitPrice: null, openedAt: "2026-09-08T00:00:00.000Z", closedAt: null, stopLoss: 153, takeProfit: 154.5, notes: "TEST", ...changes });
let id = 0;
function open(changes: Partial<TradeDraft> = {}): Trade { return createTrade(draft(changes), null, `test-${++id}`, now).data!; }
function closed(exit = 154, changes: Partial<TradeDraft> = {}): Trade { return closeTrade(open(changes), exit, now, now).data!; }
function ai() { return finalizeAnalysis(buildInput("USD/JPY", null, null, ms), null, "TEST", "not_configured", ms); }
for (const [side, exit, expected] of [["long", 154, 500], ["long", 153, -500], ["short", 154, -500], ["short", 153, 500]] as const) test(`${side} exit ${exit} realizes ${expected} yen`, () => { assert.equal(pnl(side, 153.5, exit, 1000), expected); });
test("decimal PnL is rounded symmetrically to cents", () => {
  assert.equal(pnl("long", 153.1, 153.2, 1000), 100);
  assert.equal(pnl("long", 153, 153.005, 1), .01);
  assert.equal(pnl("short", 153, 153.005, 1), -.01);
  assert.equal(pnl("long", 153, 153, 1000), 0);
});
test("unrealized PnL requires matching fresh quotes", () => {
  const trade = open(); const quote = { pair: "USD/JPY", price: 154, fetchedAt: now, stale: false };
  assert.equal(unrealizedPnl(trade, quote, ms), 500);
  assert.equal(unrealizedPnl(open({ side: "short" }), quote, ms), -500);
  for (const q of [null, { ...quote, pair: "EUR/JPY" }, { ...quote, stale: true }, { ...quote, fetchedAt: "invalid" }, { ...quote, price: Infinity }]) assert.equal(unrealizedPnl(trade, q, ms), null);
  assert.equal(unrealizedPnl(trade, quote, ms + 120001), null); assert.equal(unrealizedPnl(trade, quote, ms - 1), null);
  assert.equal(unrealizedPnl(closed(), quote, ms), null);
});
test("open and close lifecycle stores computed PnL", () => {
  const trade = open(); assert.equal(trade.status, "open"); assert.equal(trade.realizedPnl, null);
  const c = closeTrade(trade, 154, now, now).data!; assert.equal(c.realizedPnl, 500); assert.equal(c.status, "closed");
  assert.equal(closeTrade(c, 155, now, now).data, null);
});
test("closed trade edit recomputes PnL and preserves identity", () => {
  const c = closed(); const e = editTrade(c, { ...c, quantity: 2000, exitPrice: 153 }, now).data!;
  assert.equal(e.realizedPnl, -1000); assert.equal(e.id, c.id); assert.equal(e.createdAt, c.createdAt);
});
test("WAIT can be recorded and snapshot remains independent of live AI", () => {
  const source = ai(); source.bullishReasons = ["before"];
  const trade = createTrade(draft(), source, "wait", now).data!;
  assert.equal(trade.analysisSnapshot?.signal, "wait");
  source.signal = "strong_buy"; source.summary = "after"; source.bullishReasons.push("after");
  assert.equal(trade.analysisSnapshot?.signal, "wait"); assert.deepEqual(trade.analysisSnapshot?.bullishReasons, ["before"]);
  const e = editTrade(trade, { ...trade, notes: "edited" }, now).data!;
  assert.deepEqual(e.analysisSnapshot, trade.analysisSnapshot);
  assert.equal(captureAnalysis(source, "EUR/JPY", now), null);
  assert.equal(createTrade(draft(), null, "none", now).data?.analysisSnapshot, null);
});
test("edited pair retains provenance but leaves original AI signal group", () => {
  const trade = createTrade(draft(), ai(), "pair-change", now).data!;
  const e = editTrade(trade, { ...trade, pair: "EUR/JPY", status: "closed", exitPrice: 154, closedAt: now }, now).data!;
  assert.equal(e.analysisSnapshot?.pair, "USD/JPY"); assert.equal(signalPerformance([e]).find(g => g.signal === "unrecorded")?.count, 1);
});
test("summary covers wins losses draws averages and PF", () => {
  const result = summarize([closed(154), closed(154.5), closed(153.25), closed(153.5), open()]);
  assert.equal(result.count, 4); assert.equal(result.wins, 2); assert.equal(result.losses, 1); assert.equal(result.draws, 1);
  assert.equal(result.totalPnl, 1250); assert.equal(result.winRate, 50); assert.equal(result.averageProfit, 750); assert.equal(result.averageLoss, -250);
  assert.equal(result.profitFactor, 6); assert.equal(result.maxProfit, 1000); assert.equal(result.maxLoss, -250); assert.equal(result.averageRiskReward, 2);
});
test("zero trades and no losses never yield Infinity or NaN", () => {
  for (const trades of [[], [closed(154)], [closed(153.5)]]) {
    const result = summarize(trades); assert.equal(result.profitFactor, null);
    assert.ok(!JSON.stringify(result).includes("Infinity"));
    for (const value of Object.values(result)) if (typeof value === "number") assert.ok(Number.isFinite(value));
  }
  assert.equal(summarize([]).winRate, null); assert.equal(summarize([closed(153.5)]).winRate, 0);
});
test("planned RR excludes incomplete and inverted stop plans", () => {
  assert.equal(plannedRiskReward(open()), 2); assert.equal(plannedRiskReward(open({ stopLoss: null })), null);
  assert.equal(plannedRiskReward(open({ stopLoss: 154 })), null);
  assert.equal(plannedRiskReward(open({ side: "short", stopLoss: 154, takeProfit: 152.5 })), 2);
});
test("signal and pair statistics include all three pairs", () => {
  const signalTrade = closeTrade(createTrade(draft(), ai(), "signal", now).data!, 154, now, now).data!;
  const data = [signalTrade, closed(154, { pair: "EUR/JPY" }), closed(153, { pair: "GBP/JPY" })];
  const wait = signalPerformance(data).find(g => g.signal === "wait")!;
  assert.equal(wait.count, 1); assert.equal(wait.winRate, 100); assert.equal(wait.insufficientData, true);
  assert.deepEqual(pairPerformance(data).map(g => g.count), [1, 1, 1]);
  assert.equal(signalPerformance(data).find(g => g.signal === "unrecorded")?.count, 2);
});
test("JST daily totals combine multiple closes and separate midnight", () => {
  const a = closed(154); const b = closed(153.25);
  const c = { ...closed(154.5), closedAt: "2026-09-08T15:00:00.000Z" };
  const groups = dailyPnl([a, b, c, open()]); assert.equal(groups["2026-09-08"].pnl, 250); assert.equal(groups["2026-09-09"].pnl, 1000);
  assert.equal(dayKey("2026-09-08T14:59:59.000Z"), "2026-09-08");
});
test("equity sorts chronologically and does not mutate source", () => {
  const first = { ...closed(154), closedAt: "2026-09-08T01:00:00.000Z" };
  const last = { ...closed(153.25), closedAt: "2026-09-08T02:00:00.000Z" };
  const source = [last, first];
  assert.deepEqual(equityCurve(source, 50000).map(p => p.balance), [50000, 50500, 50250]);
  assert.equal(source[0].id, last.id); assert.equal(equityCurve([], 50000)[0].balance, 50000);
  assert.deepEqual(equityCurve(source, NaN), []);
});
test("calendar uses Monday-first positions and leap months", () => {
  assert.deepEqual(monthCells("invalid"), []); assert.deepEqual(monthCells("0001-01"), []);
  const cells = monthCells("2026-09"); assert.equal(cells[0], null); assert.equal(cells[1], "2026-09-01"); assert.equal(cells.filter(Boolean).length, 30);
  assert.equal(monthCells("2028-02").filter(Boolean).length, 29);
});
test("validation rejects unsupported pair side amounts and dates", () => {
  for (const quantity of [0, -1, .5, NaN, Infinity, 1e9]) assert.equal(validateDraft(draft({ quantity })).data, null);
  for (const entryPrice of [0, -1, NaN, Infinity]) assert.equal(validateDraft(draft({ entryPrice })).data, null);
  assert.equal(validateDraft({ ...draft(), pair: "AUD/JPY" }).data, null); assert.equal(validateDraft({ ...draft(), side: "BUY" }).data, null);
  assert.equal(validateDraft(draft({ openedAt: "invalid" })).data, null);
  assert.equal(validateDraft(draft({ stopLoss: -1 })).data, null); assert.equal(validateDraft(draft({ notes: "a".repeat(4001) })).data, null);
  assert.equal(validateDraft(draft({ status: "closed", exitPrice: 154, closedAt: "2026-09-07T00:00:00.000Z" })).data, null);
  assert.equal(validateDraft(draft({ status: "closed", exitPrice: 0, closedAt: now })).data, null);
  assert.equal(validateDraft(draft({ exitPrice: 154 })).data, null);
});
test("invalid calendar dates and ambiguous local time are rejected", () => {
  assert.equal(validDate("2026-02-30T00:00:00.000Z"), false); assert.equal(validDate(now), true);
  assert.equal(fromLocalDateTime("2026-02-30T12:00"), ""); assert.equal(fromLocalDateTime("2026-09-08T12:00"), now);
});
function storage() {
  const entries = new Map<string, string>();
  return { entries, port: { getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => { entries.set(key, value); } } };
}
test("repository round trip restores snapshots and edits/deletes", () => {
  const s = storage(), repo = createTradeRepository(() => s.port);
  assert.equal(repo.load().data?.trades.length, 0);
  const trade = createTrade(draft(), ai(), "persist", now).data!;
  assert.equal(repo.save([trade], 0).data?.revision, 1);
  assert.deepEqual(createTradeRepository(() => s.port).load().data?.trades[0], trade);
  assert.equal(repo.save([], 1).data?.trades.length, 0); assert.equal(repo.load().data?.revision, 2);
});
test("corrupt JSON and unsupported schema are preserved and writes blocked", () => {
  for (const raw of ["{broken", JSON.stringify({ schemaVersion: 0, trades: [] }), JSON.stringify({ schemaVersion: 2, trades: [] }), "null"]) {
    const s = storage(); s.entries.set(STORAGE_KEY, raw); const repo = createTradeRepository(() => s.port);
    assert.equal(repo.load().data, null); assert.equal(repo.save([], 0).data, null); assert.equal(s.entries.get(STORAGE_KEY), raw);
  }
});
test("persisted invalid trades duplicates and tampered PnL are rejected", () => {
  const c = closed();
  for (const trades of [[{ ...c, quantity: -1 }], [{ ...c, realizedPnl: 999 }], [c, c], [{ ...c, analysisSnapshot: { signal: "invalid" } }]]) assert.equal(decodeJournal(JSON.stringify({ schemaVersion: 1, revision: 1, trades })).data, null);
});
test("storage quota and security failures do not claim a save", () => {
  const repo = createTradeRepository(() => ({ getItem: () => null, setItem: () => { throw new Error("quota"); } }));
  assert.equal(repo.save([open()], 0).data, null);
  assert.equal(createTradeRepository(() => { throw new Error("blocked"); }).load().data, null);
});
test("stale revisions do not overwrite another tab's records", () => {
  const s = storage(), first = createTradeRepository(() => s.port), second = createTradeRepository(() => s.port);
  assert.equal(second.load().data?.revision, 0); const trade = open(); first.save([trade], 0);
  assert.equal(second.save([], 0).data, null); assert.equal(first.load().data?.trades[0].id, trade.id);
});
