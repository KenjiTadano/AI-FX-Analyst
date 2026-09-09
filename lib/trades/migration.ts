import { decodeJournal } from "./repository";
import type { Trade, Result } from "./types";
export function pendingMigration(raw: string | null, importedIds: string[]): Result<Trade[]> {
  const local = decodeJournal(raw);
  if (!local.data) return local;
  const done = new Set(importedIds);
  return { data: local.data.trades.filter(t => !done.has(t.id)), error: null };
}
