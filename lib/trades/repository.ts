import { validateTrade } from "./validation";
import type { Journal, Result, Trade, TradeRepository } from "./types";
export const STORAGE_KEY = "ai-fx-analyst.trade-journal";
export const SCHEMA_VERSION = 1;
export const MAX_TRADES = 5000;
export function decodeJournal(raw: string | null): Result<Journal> {
  if (raw === null) return { data: { schemaVersion: 1, revision: 0, trades: [] }, error: null };
  try {
    const value = JSON.parse(raw);
    if (!value || value.schemaVersion !== SCHEMA_VERSION) return { data: null, error: "未対応の保存バージョンです。元データを保持し、上書きを停止しています。" };
    if (!Number.isSafeInteger(value.revision) || value.revision < 0 || !Array.isArray(value.trades) || value.trades.length > MAX_TRADES) throw new Error("invalid");
    const trades: Trade[] = [];
    for (const item of value.trades) { const result = validateTrade(item); if (!result.data) throw new Error("invalid"); trades.push(result.data); }
    if (new Set(trades.map(t => t.id)).size !== trades.length) throw new Error("duplicates");
    return { data: { schemaVersion: 1, revision: value.revision, trades }, error: null };
  } catch { return { data: null, error: "保存データを読み取れません。元データを保持し、上書きを停止しています。" }; }
}
type StoragePort = Pick<Storage, "getItem" | "setItem">;
export function createTradeRepository(storage: () => StoragePort): TradeRepository {
  return {
    load() { try { return decodeJournal(storage().getItem(STORAGE_KEY)); } catch { return { data: null, error: "ブラウザ保存を利用できません。保存設定を確認してください。" }; } },
    save(trades, expectedRevision) {
      try {
        const loaded = this.load();
        if (!loaded.data) return loaded;
        if (loaded.data.revision !== expectedRevision) return { data: null, error: "別画面で記録が更新されました。再読み込みしてからやり直してください。" };
        const next = decodeJournal(JSON.stringify({ schemaVersion: SCHEMA_VERSION, revision: expectedRevision + 1, trades }));
        if (!next.data) return next;
        storage().setItem(STORAGE_KEY, JSON.stringify(next.data));
        return next;
      } catch { return { data: null, error: "保存できませんでした。ブラウザの保存容量・設定を確認してください。変更は反映していません。" }; }
    },
  };
}
// Lazy access: merely importing the module during SSR never touches window.
export const tradeRepository = createTradeRepository(() => {
  if (typeof window === "undefined") throw new Error("browser only");
  return window.localStorage;
});
