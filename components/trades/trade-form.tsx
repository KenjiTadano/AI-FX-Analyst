"use client";
import { useState, type FormEvent } from "react";
import type { AIAnalysis } from "@/lib/ai/types";
import { pairs, type Trade, type TradeDraft } from "@/lib/trades/types";
import { dateTime, fromLocalDateTime, localDateTime, signalLabels } from "./format";
interface Props { trade: Trade | null; mode: "new" | "edit" | "close"; pair: string; rate: number | null; analysis: AIAnalysis | null; onSave: (draft: TradeDraft) => Promise<string | null>; onCancel: () => void }
export function TradeForm({ trade, mode, pair, rate, analysis, onSave, onCancel }: Props) {
  const [fields, setFields] = useState(() => ({ pair: trade?.pair ?? pair, side: trade?.side ?? (analysis?.signal.includes("sell") ? "short" : "long"), entryPrice: String(trade?.entryPrice ?? rate ?? ""), quantity: String(trade?.quantity ?? ""), openedAt: localDateTime(trade?.openedAt ?? new Date().toISOString()), stopLoss: String(trade?.stopLoss ?? ""), takeProfit: String(trade?.takeProfit ?? ""), notes: trade?.notes ?? "", exitPrice: String(trade?.exitPrice ?? ""), closedAt: localDateTime(trade?.closedAt ?? new Date().toISOString()) }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isClosed = mode === "close" || trade?.status === "closed";
  function update(key: keyof typeof fields, value: string) { setFields(previous => ({ ...previous, [key]: value })); }
  function input(key: keyof typeof fields, label: string, type = "number", optional = false) {
    return <label>{label}<input type={type} required={!optional} step={type === "number" ? "any" : undefined} min={type === "number" ? "0" : undefined} value={fields[key]} onChange={e => update(key, e.target.value)} /></label>;
  }
  async function submit(e: FormEvent) {
    e.preventDefault(); if (busy) return; setBusy(true);
    const numeric = (s: string) => s.trim() ? Number(s) : NaN;
    const draft: TradeDraft = { pair: fields.pair as TradeDraft["pair"], side: fields.side as TradeDraft["side"], status: isClosed ? "closed" : "open", quantity: numeric(fields.quantity), entryPrice: numeric(fields.entryPrice), openedAt: trade && fields.openedAt === localDateTime(trade.openedAt) ? trade.openedAt : fromLocalDateTime(fields.openedAt), stopLoss: fields.stopLoss.trim() ? numeric(fields.stopLoss) : null, takeProfit: fields.takeProfit.trim() ? numeric(fields.takeProfit) : null, notes: fields.notes, exitPrice: isClosed ? numeric(fields.exitPrice) : null, closedAt: isClosed ? trade?.closedAt && fields.closedAt === localDateTime(trade.closedAt) ? trade.closedAt : fromLocalDateTime(fields.closedAt) : null };
    // Closing a position only changes exit information, preserving entry timestamps including seconds.
    setError(await onSave(mode === "close" && trade ? { ...trade, status: "closed", exitPrice: draft.exitPrice, closedAt: draft.closedAt } : draft)); setBusy(false);
  }
  const snapshot = mode === "new" ? analysis?.pair === fields.pair ? analysis : null : trade?.analysisSnapshot;
  return <form className="journal-form" onSubmit={submit} aria-label={mode === "new" ? "新規トレード登録" : mode === "close" ? "決済記録" : "取引編集"}>
    <h3>{mode === "new" ? "実際の取引を記録" : mode === "close" ? "決済を記録" : "取引を編集"}</h3>
    <p className="footnote">証券会社で行った取引の手動記録です。注文は発注しません。日時は日本時間（JST）で入力してください。</p>
    {mode !== "close" ? <div className="journal-fields">
      <label>記録する通貨ペア<select value={fields.pair} onChange={e => update("pair", e.target.value)}>{pairs.map(p => <option key={p}>{p}</option>)}</select></label>
      <label>売買方向<select value={fields.side} onChange={e => update("side", e.target.value)}><option value="long">買い / Long</option><option value="short">売り / Short</option></select></label>
      {input("entryPrice", "エントリー価格")}{input("quantity", "取引数量（通貨）")}{input("openedAt", "エントリー日時（JST）", "datetime-local")}{input("stopLoss", "損切り価格（任意）", "number", true)}{input("takeProfit", "利益確定価格（任意）", "number", true)}
      <label className="journal-wide">メモ<textarea maxLength={4000} rows={3} value={fields.notes} onChange={e => update("notes", e.target.value)} /></label>
    </div> : <p className="footnote">{trade?.pair} · {trade?.side === "long" ? "Long" : "Short"} · {trade?.quantity.toLocaleString()}通貨 · Entry {trade?.entryPrice}</p>}
    {isClosed && <div className="journal-fields">{input("exitPrice", "決済価格")}{input("closedAt", "決済日時（JST）", "datetime-local")}</div>}
    <p className="footnote">{snapshot ? `保存するAI判断：${signalLabels[snapshot.signal]} / ${snapshot.score} · 分析日時 ${dateTime(snapshot.analyzedAt)}` : "この通貨のAI分析は未取得です。スナップショットなしで記録します。"}</p>
    {snapshot?.signal === "wait" && <p className="neutral footnote">AI分析では待機判断でした。実際に行った取引の記録は可能です。</p>}
    <p className="footnote">{mode === "new" ? "登録時に表示中の分析をコピーします。過去のエントリー時点の分析を復元するものではありません。" : "登録時のAIスナップショットは変更しません。"}</p>
    {error && <p role="alert" className="negative">{error}</p>}
    <div className="journal-actions"><button disabled={busy} className="journal-primary" type="submit">{mode === "close" ? "決済を保存" : "取引を保存"}</button><button disabled={busy} type="button" onClick={onCancel}>キャンセル</button></div>
  </form>;
}
