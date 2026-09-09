import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "./database.types";
import { fromSettingsRow, fromTradeRow, numeric, toSettingsRow, toTradeRow, UUID } from "./mappers";
import type { Result, Trade } from "../trades/types";
import type { RiskSettings } from "../risk/types";
import { MAX_TRADES } from "../trades/repository";
export interface CloudJournal { trades: Trade[]; importedIds: string[] }
export interface CloudTradeRepository {
  load(): Promise<Result<CloudJournal>>;
  create(trade: Trade): Promise<Result<Trade>>;
  update(trade: Trade): Promise<Result<Trade>>;
  remove(trade: Trade): Promise<Result<boolean>>;
  importTrades(trades: Trade[]): Promise<Result<number>>;
}
export function createCloudRepository(client: SupabaseClient<Database>, userId: string): CloudTradeRepository {
  const versions = new Map<string, number>();
  async function authorized() {
    const { data, error } = await client.auth.getUser();
    if (error || data.user?.id !== userId || !UUID.test(userId)) throw new Error("認証が必要です。再度ログインしてください。");
  }
  async function attempt<T>(work: () => Promise<T>): Promise<Result<T>> {
    try { await authorized(); const data = await work(); await authorized(); return { data, error: null }; }
    catch { return { data: null, error: "クラウド操作を完了できませんでした。ログイン状態・接続・他端末の更新を確認し、再読み込みしてください。" }; }
  }
  function mapped(row: unknown): Trade { const r = row as Record<string, unknown>; const trade = fromTradeRow(r, userId); const version = numeric(r.version); if (!Number.isSafeInteger(version) || version < 1) throw new Error("version"); versions.set(trade.id, version); return trade; }
  return {
    load: () => attempt(async () => {
      const trades: Trade[] = [], importedIds: string[] = [];
      for (let start = 0; start <= MAX_TRADES; start += 500) {
        const { data, error } = await client.from("trades").select("*").eq("user_id", userId).order("id").range(start, start + 499);
        if (error || !data) throw new Error("read");
        for (const row of data) { trades.push(mapped(row)); if (row.local_trade_id) importedIds.push(row.local_trade_id); }
        if (trades.length > MAX_TRADES) throw new Error("limit");
        if (data.length < 500) break;
      }
      return { trades, importedIds };
    }),
    create: trade => attempt(async () => {
      if (!UUID.test(trade.id)) throw new Error("id");
      const { data, error } = await client.from("trades").insert(toTradeRow(trade, userId)).select().single();
      if (error || !data) throw new Error("create"); return mapped(data);
    }),
    update: trade => attempt(async () => {
      const row = toTradeRow(trade, userId);
      delete row.id; delete row.user_id; delete row.created_at; delete row.updated_at; delete row.analysis_snapshot;
      const version = versions.get(trade.id); if (!version) throw new Error("reload");
      const { data, error } = await client.from("trades").update(row).eq("id", trade.id).eq("user_id", userId).eq("version", version).select().single();
      if (error || !data) throw new Error("update"); return mapped(data);
    }),
    remove: trade => attempt(async () => {
      const version = versions.get(trade.id); if (!version) throw new Error("reload");
      const { data, error } = await client.from("trades").delete().eq("id", trade.id).eq("user_id", userId).eq("version", version).select("id");
      if (error || data?.length !== 1) throw new Error("delete"); versions.delete(trade.id); return true;
    }),
    importTrades: trades => attempt(async () => {
      if (trades.length > MAX_TRADES) throw new Error("limit");
      // Validate the entire import before sending the first batch. Never overwrite existing cloud rows.
      const rows = trades.map(trade => ({ ...toTradeRow(trade, userId), local_trade_id: trade.id }));
      let inserted = 0;
      for (let start = 0; start < rows.length; start += 100) {
        const { data, error } = await client.rpc("import_local_trades", { payload: rows.slice(start, start + 100) as unknown as Json });
        if (error || typeof data !== "number") throw new Error("import"); inserted += data;
      }
      return inserted;
    }),
  };
}
export function createSettingsRepository(client: SupabaseClient<Database>, userId: string) {
  let version: number | null = null;
  async function run(settings?: RiskSettings): Promise<Result<RiskSettings>> {
    try {
      const { data: auth, error: authError } = await client.auth.getUser();
      if (authError || auth.user?.id !== userId || !UUID.test(userId)) throw new Error("auth");
      if (settings && version === null) throw new Error("read first");
      const query = settings ? client.from("user_settings").update(toSettingsRow(settings)).eq("user_id", userId).eq("version", version!).select() : client.from("user_settings").select("*").eq("user_id", userId);
      const { data, error } = await query.single();
      if (error || !data) throw new Error("settings");
      const mapped = fromSettingsRow(data as unknown as Record<string, unknown>, userId);
      version = numeric(data.version); if (!Number.isSafeInteger(version) || version < 1) throw new Error("version");
      return { data: mapped, error: null };
    } catch { return { data: null, error: settings ? "設定を保存できませんでした。未保存です。接続を確認してください。他端末と競合した場合は再読み込みして入力し直してください。" : "設定を取得できません。ログイン状態・接続・DB migrationを確認してください。" }; }
  }
  return { load: () => run(), save: (settings: RiskSettings) => run(settings) };
}
