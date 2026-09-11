"use client";
import { useState, type FormEvent } from "react";
import type { AIAnalysis } from "@/lib/ai/types";
import type { ChartImageAnalysis } from "@/lib/chart-analysis/types";
import { actionGuidanceLabel, directionBiasLabel, signalLabels as decisionSignalLabels } from "@/lib/ai/decision-ui";
import { pairs, type Trade, type TradeDraft } from "@/lib/trades/types";
import { isRichSnapshot } from "@/lib/trades/snapshot";
import { dateTime, fromLocalDateTime, localDateTime, signalLabels } from "./format";

interface Props {
  trade: Trade | null;
  mode: "new" | "edit" | "close";
  pair: string;
  rate: number | null;
  analysis: AIAnalysis | null;
  chartImageAnalysis?: ChartImageAnalysis | null;
  onSave: (draft: TradeDraft, options?: { saveSnapshot?: boolean }) => Promise<string | null>;
  onCancel: () => void;
}

export function TradeForm({ trade, mode, pair, rate, analysis, chartImageAnalysis = null, onSave, onCancel }: Props) {
  const [fields, setFields] = useState(() => ({
    pair: trade?.pair ?? pair,
    side: trade?.side ?? (analysis?.signal.includes("sell") ? "short" : "long"),
    entryPrice: String(trade?.entryPrice ?? rate ?? ""),
    quantity: String(trade?.quantity ?? ""),
    openedAt: localDateTime(trade?.openedAt ?? new Date().toISOString()),
    stopLoss: String(trade?.stopLoss ?? ""),
    takeProfit: String(trade?.takeProfit ?? ""),
    notes: trade?.notes ?? "",
    exitPrice: String(trade?.exitPrice ?? ""),
    closedAt: localDateTime(trade?.closedAt ?? new Date().toISOString()),
  }));
  const [saveSnapshot, setSaveSnapshot] = useState(true);
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
    const draft: TradeDraft = {
      pair: fields.pair as TradeDraft["pair"],
      side: fields.side as TradeDraft["side"],
      status: isClosed ? "closed" : "open",
      quantity: numeric(fields.quantity),
      entryPrice: numeric(fields.entryPrice),
      openedAt: trade && fields.openedAt === localDateTime(trade.openedAt) ? trade.openedAt : fromLocalDateTime(fields.openedAt),
      stopLoss: fields.stopLoss.trim() ? numeric(fields.stopLoss) : null,
      takeProfit: fields.takeProfit.trim() ? numeric(fields.takeProfit) : null,
      notes: fields.notes,
      exitPrice: isClosed ? numeric(fields.exitPrice) : null,
      closedAt: isClosed ? trade?.closedAt && fields.closedAt === localDateTime(trade.closedAt) ? trade.closedAt : fromLocalDateTime(fields.closedAt) : null,
    };
    setError(await onSave(
      mode === "close" && trade ? { ...trade, status: "closed", exitPrice: draft.exitPrice, closedAt: draft.closedAt } : draft,
      mode === "new" ? { saveSnapshot } : undefined,
    ));
    setBusy(false);
  }
  const live = mode === "new" && analysis?.pair === fields.pair ? analysis : null;
  const stored = mode !== "new" ? trade?.analysisSnapshot ?? null : null;
  const action = live?.action ?? (live?.signal === "wait" ? "WAIT" : live?.signal.includes("buy") ? "BUY" : live?.signal.includes("sell") ? "SELL" : null);
  const direction = live?.directionSignal ?? live?.signal ?? null;
  const waitWarn = mode === "new" && live && (action === "WAIT" || live.signal === "wait");
  const aiBuy = direction === "buy" || direction === "strong_buy";
  const aiSell = direction === "sell" || direction === "strong_sell";
  const conflict = mode === "new" && live && action !== "WAIT" && ((fields.side === "long" && aiSell) || (fields.side === "short" && aiBuy));
  const chartPreview = live?.chartEvidence?.used
    ? `${live.chartEvidence.timeframe ?? "時間足未検出"} / ${live.chartEvidence.trend} / quality ${live.chartEvidence.qualityScore}`
    : chartImageAnalysis && chartImageAnalysis.pair === fields.pair
      ? `${chartImageAnalysis.detected.timeframe ?? "時間足未検出"} / ${chartImageAnalysis.trend.direction} / 未添付`
      : "なし";

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

    {mode === "new" && <section className="snapshot-preview" aria-label="保存するAI分析">
      {live ? <>
        <label className="snapshot-toggle"><input type="checkbox" checked={saveSnapshot} onChange={e => setSaveSnapshot(e.target.checked)} />現在のAI分析をこの取引に保存</label>
        {saveSnapshot && <div className="snapshot-card">
          <p><strong>保存するAI分析</strong></p>
          <p>判断：{decisionSignalLabels[live.signal]} · 方向：{directionBiasLabel(direction)} · Action：{actionGuidanceLabel(action, live.signal)}</p>
          <p>確信度：{live.confidence}% · 分析時刻：{dateTime(live.analyzedAt)}</p>
          <p>Chart：{chartPreview}</p>
          {live.ai.status !== "available" && <p className="neutral">AI一部利用不可時の暫定分析です。</p>}
        </div>}
      </> : <p className="footnote">AI分析なし。スナップショットなしで記録できます。</p>}
      {waitWarn && <p className="neutral" role="status">AI分析では現在WAITです。登録は禁止しません。</p>}
      {conflict && <p className="neutral" role="status">現在のAI方向と逆方向の取引です。登録は禁止しません。</p>}
      <p className="footnote">登録時に表示中の分析をコピーします。OpenAI / Vision は再実行しません。チャート画像そのものは保存しません。</p>
    </section>}

    {mode !== "new" && <p className="footnote">{stored
      ? `登録時AI：${signalLabels[stored.signal]}${isRichSnapshot(stored) ? ` / ${directionBiasLabel(stored.directionSignal)} / ${stored.action}` : ""} · 分析日時 ${dateTime(stored.analyzedAt)}`
      : "エントリー時AI分析：保存なし"}。登録時のAIスナップショットは変更しません。</p>}

    {error && <p role="alert" className="negative">{error}</p>}
    <div className="journal-actions"><button disabled={busy} className="journal-primary" type="submit">{mode === "close" ? "決済を保存" : "取引を保存"}</button><button disabled={busy} type="button" onClick={onCancel}>キャンセル</button></div>
  </form>;
}
