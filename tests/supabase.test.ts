import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../lib/supabase/database.types";
import { numeric, fromTradeRow, toTradeRow, fromSettingsRow, toSettingsRow, validateSettings } from "../lib/supabase/mappers";
import { createCloudRepository, createSettingsRepository } from "../lib/supabase/cloud-repository";
import { validPublicConfig } from "../lib/supabase/config";
import { pendingMigration } from "../lib/trades/migration";
import { createTrade, closeTrade } from "../lib/trades/service";
import { buildInput } from "../lib/ai/input";
import { finalizeAnalysis } from "../lib/ai/engine";
import defaults from "../lib/settings/defaults.json";
const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", other = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const id = "cccccccc-cccc-4ccc-8ccc-cccccccccccc", now = "2026-09-08T03:00:00.000Z";
function trade() {
  const ai = finalizeAnalysis(buildInput("USD/JPY", null, null, Date.parse(now)), null, "TEST", "not_configured", Date.parse(now));
  return createTrade({ pair: "USD/JPY", side: "long", status: "open", quantity: 1000, entryPrice: 153.5, exitPrice: null, openedAt: now, closedAt: null, stopLoss: 153, takeProfit: 154.5, notes: "test" }, ai, id, now).data!;
}
function row() { return { ...toTradeRow(trade(), owner), version: 1, local_trade_id: null }; }
function settingsRow() { return { user_id: owner, ...toSettingsRow(defaults), version: 1, created_at: now, updated_at: now }; }
// In-memory transport tests repository contracts only. Actual PostgreSQL RLS is tested separately.
function fixture() {
  const state = { user: owner as string | null, failure: false, rows: [row()] as Record<string, unknown>[], settings: settingsRow() as Record<string, unknown>, requests: 0, writes: [] as Record<string, unknown>[], imported: new Set<string>(), rpcCalls: 0 };
  function query(table: string) {
    let action = "read", payload: Record<string, unknown> = {}, single = false, from = 0, to = Infinity;
    const filters: [string, unknown][] = [];
    const q = {
      select: () => q, eq: (key: string, value: unknown) => { filters.push([key, value]); return q; }, order: () => q,
      range: (a: number, b: number) => { from = a; to = b; return q; }, single: () => { single = true; return q; },
      insert: (value: Record<string, unknown>) => { action = "insert"; payload = value; return q; },
      update: (value: Record<string, unknown>) => { action = "update"; payload = value; return q; }, delete: () => { action = "delete"; return q; },
      then(resolve: (result: unknown) => unknown) {
        state.requests++;
        if (state.failure) return Promise.resolve(resolve({ data: null, error: { message: "SECRET must not escape" } }));
        const source = table === "trades" ? state.rows : [state.settings];
        let selected = source.filter(r => filters.every(([k, v]) => r[k] === v)).slice(from, to + 1);
        if (action === "insert") { const saved = { ...payload, version: 1, local_trade_id: null }; state.rows.push(saved); selected = [saved]; }
        if (action === "update") { state.writes.push(payload); selected.forEach(r => Object.assign(r, payload, { version: Number(r.version) + 1, updated_at: now })); }
        if (action === "delete") state.rows = state.rows.filter(r => !selected.includes(r));
        return Promise.resolve(resolve({ data: single ? selected.length === 1 ? selected[0] : null : selected, error: single && selected.length !== 1 ? { message: "conflict" } : null }));
      },
    }; return q;
  }
  const client = { auth: { getUser: async () => ({ data: { user: state.user ? { id: state.user } : null }, error: null }) }, from: query,
    rpc: async (_name: string, { payload }: { payload: Record<string, unknown>[] }) => {
      state.rpcCalls++; if (state.failure) return { data: null, error: { message: "SECRET" } };
      let count = 0; for (const r of payload) { const key = String(r.local_trade_id); if (!state.imported.has(key)) { state.imported.add(key); count++; } }
      return { data: count, error: null };
    },
  } as unknown as SupabaseClient<Database>;
  return { state, client, repository: createCloudRepository(client, owner), settings: createSettingsRepository(client, owner) };
}
test("DB mapper round trip preserves immutable AI snapshot", () => {
  assert.deepEqual(fromTradeRow(row(), owner), trade());
  const closed = closeTrade(trade(), 154, now, now).data!;
  assert.equal(fromTradeRow({ ...toTradeRow(closed, owner), entry_price: "153.5", exit_price: "154", realized_pnl: "500" }, owner).realizedPnl, 500);
});
test("numeric accepts finite decimal strings, rejects malformed and unbounded values", () => {
  assert.equal(numeric("-10.25"), -10.25); assert.equal(numeric(0), 0);
  for (const v of [NaN, Infinity, -Infinity, "NaN", "Infinity", "", " ", "1e2", null, undefined, true, {}, "0x10", 1e20]) assert.throws(() => numeric(v));
});
test("DB mapping normalizes timestamps and rejects other owners", () => {
  assert.equal(fromTradeRow({ ...row(), opened_at: "2026-09-08T12:00:00+09:00" }, owner).openedAt, now);
  assert.throws(() => fromTradeRow(row(), other)); assert.throws(() => toTradeRow(trade(), "invalid"));
  assert.throws(() => fromTradeRow({ ...row(), id: "bad" }, owner));
});
test("DB mapping rejects invalid trade, tampered PnL and snapshot", () => {
  for (const change of [{ quantity: 0 }, { entry_price: "Infinity" }, { pair: "AUD/JPY" }, { analysis_snapshot: { signal: "buy" } }, { opened_at: "bad" }, { realized_pnl: 99 }]) assert.throws(() => fromTradeRow({ ...row(), ...change }, owner));
});
test("settings round trip and owner validation", () => {
  assert.deepEqual(fromSettingsRow({ ...settingsRow(), current_capital: "50000.00" }, owner), defaults);
  assert.throws(() => fromSettingsRow(settingsRow(), other));
  for (const change of [{ balance: -1 }, { target: 0 }, { riskPercent: 0 }, { riskPercent: 10.01 }, { tradeUnit: .5 }, { balance: NaN }]) assert.throws(() => validateSettings({ ...defaults, ...change }));
  assert.equal(validateSettings({ ...defaults, balance: 0, riskPercent: 10 }).balance, 0);
});
test("public config tolerates missing values and rejects private service keys", () => {
  assert.equal(validPublicConfig(undefined, undefined), null);
  assert.equal(validPublicConfig("http://example.com", "sb_publishable_test"), null);
  assert.equal(validPublicConfig("https://example.supabase.co", "sb_secret_test"), null);
  const jwt = (role: string) => `e30.${Buffer.from(JSON.stringify({ role })).toString("base64url")}.signature`;
  assert.equal(validPublicConfig("https://example.supabase.co", jwt("service_role")), null);
  assert.ok(validPublicConfig("https://example.supabase.co", jwt("anon")));
  assert.ok(validPublicConfig("http://127.0.0.1:54321", "sb_publishable_test"));
});
test("logged-in repository loads owner rows and snapshots", async () => {
  const f = fixture(); assert.deepEqual((await f.repository.load()).data?.trades, [trade()]);
});
test("no session or account switch blocks all cloud operations before requests", async () => {
  for (const user of [null, other]) {
    const f = fixture(); f.state.user = user;
    for (const result of [await f.repository.load(), await f.repository.create(trade()), await f.repository.update(trade()), await f.repository.remove(trade()), await f.repository.importTrades([trade()]), await f.settings.load()]) assert.equal(result.data, null);
    assert.equal(f.state.requests, 0); assert.equal(f.state.rpcCalls, 0);
  }
});
test("unexpected foreign-owner row is rejected at mapping boundary", async () => {
  const f = fixture(); f.state.rows[0].user_id = other;
  assert.throws(() => fromTradeRow(f.state.rows[0], owner));
});
test("create edit close delete return only acknowledged database state", async () => {
  const f = fixture(); f.state.rows = [];
  assert.equal((await f.repository.create(trade())).data?.id, id);
  const edited = { ...trade(), notes: "edited" };
  assert.equal((await f.repository.update(edited)).data?.notes, "edited");
  assert.equal("analysis_snapshot" in f.state.writes[0], false); assert.equal("user_id" in f.state.writes[0], false);
  const closed = closeTrade(edited, 154, now, now).data!;
  assert.equal((await f.repository.update(closed)).data?.realizedPnl, 500);
  assert.equal((await f.repository.remove(closed)).data, true); assert.equal(f.state.rows.length, 0);
});
test("stale version update and delete cannot overwrite another device", async () => {
  const f = fixture(); await f.repository.load(); f.state.rows[0].version = 2;
  assert.equal((await f.repository.update(trade())).data, null); assert.equal((await f.repository.remove(trade())).data, null); assert.equal(f.state.rows.length, 1);
});
test("communication errors are failures and do not expose provider details", async () => {
  const f = fixture(); await f.repository.load(); await f.settings.load(); f.state.failure = true;
  for (const result of [await f.repository.load(), await f.repository.create(trade()), await f.repository.update(trade()), await f.repository.remove(trade()), await f.repository.importTrades([trade()]), await f.settings.save(defaults)]) {
    assert.equal(result.data, null); assert.ok(result.error); assert.ok(!result.error.includes("SECRET"));
  }
  assert.equal(f.state.rows.length, 1);
});
test("invalid create and entire invalid import are rejected before network write", async () => {
  const f = fixture(); const invalid = { ...trade(), quantity: -1 };
  assert.equal((await f.repository.create(invalid)).data, null);
  assert.equal((await f.repository.importTrades([trade(), invalid])).data, null);
  assert.equal(f.state.requests, 0); assert.equal(f.state.rpcCalls, 0);
});
test("settings saves use version and reject stale changes", async () => {
  const f = fixture(); assert.equal((await f.settings.save(defaults)).data, null);
  assert.deepEqual((await f.settings.load()).data, defaults);
  assert.equal((await f.settings.save({ ...defaults, balance: 60000 })).data?.balance, 60000);
  f.state.settings.version = 3; assert.equal((await f.settings.save(defaults)).data, null);
});
test("migration is explicit input, idempotent by original id, and does not mutate local data", async () => {
  const f = fixture(); const legacy = { ...trade(), id: "task007-legacy-id" };
  const raw = JSON.stringify({ schemaVersion: 1, revision: 1, trades: [legacy] });
  const pending = pendingMigration(raw, []).data!; assert.equal(pending.length, 1); assert.equal(f.state.rpcCalls, 0);
  assert.equal((await f.repository.importTrades(pending)).data, 1);
  assert.equal((await f.repository.importTrades(pending)).data, 0);
  assert.deepEqual(pendingMigration(raw, [legacy.id]).data, []);
  assert.equal(pendingMigration(raw, []).data?.[0].id, legacy.id);
});
test("corrupted local JSON, invalid snapshots and duplicate local ids block migration", () => {
  for (const raw of ["{broken", "null", JSON.stringify({ schemaVersion: 2, trades: [] }), JSON.stringify({ schemaVersion: 1, revision: 1, trades: [trade(), trade()] }), JSON.stringify({ schemaVersion: 1, revision: 1, trades: [{ ...trade(), analysisSnapshot: {} }] })]) assert.equal(pendingMigration(raw, []).data, null);
  assert.deepEqual(pendingMigration(null, []).data, []);
});
test("migration sends bounded batches, validates all records first", async () => {
  const f = fixture(); const data = Array.from({ length: 201 }, (_, i) => ({ ...trade(), id: `legacy-${i}` }));
  assert.equal((await f.repository.importTrades(data)).data, 201); assert.equal(f.state.rpcCalls, 3);
});
test("migration SQL keeps defaults, RLS ownership and DB idempotence contracts", () => {
  const sql = readFileSync("supabase/migrations/20260908000000_initial_cloud.sql", "utf8");
  for (const table of ["profiles", "user_settings", "trades"]) assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security`, "i"));
  for (const [column, value] of Object.entries(toSettingsRow(defaults))) assert.match(sql, new RegExp(`${column}[^\\n]+default ${value}(?:[^0-9]|$)`, "i"));
  assert.match(sql, /on conflict\s*\(user_id, local_trade_id\) do nothing/i);
  assert.match(sql, /security invoker/i); assert.match(sql, /with check/i); assert.match(sql, /auth\.uid\(\)/i);
});
test("session changing while a read is in flight does not release account data", async () => {
  const f = fixture(); let checks = 0;
  f.client.auth.getUser = (async () => ({ data: { user: { id: ++checks === 1 ? owner : other } }, error: null })) as typeof f.client.auth.getUser;
  assert.equal((await f.repository.load()).data, null);
});
test("thrown transport failure is returned as an explicit error", async () => {
  const f = fixture();
  f.client.auth.getUser = async () => { throw new Error("network failure with secret"); };
  assert.equal((await f.repository.load()).data, null); assert.equal((await f.settings.load()).data, null);
});
test("paginated cloud reads retrieve records beyond the first 500", async () => {
  const f = fixture(); f.state.rows = Array.from({ length: 501 }, (_, i) => ({ ...row(), id: `${i.toString(16).padStart(8, "0")}-cccc-4ccc-8ccc-cccccccccccc` }));
  const result = await f.repository.load(); assert.equal(result.data?.trades.length, 501); assert.equal(f.state.requests, 2);
});
