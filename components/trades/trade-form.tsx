"use client";
import { useState, type FormEvent } from "react";
import type { AIAnalysis } from "@/lib/ai/types";
import type { ChartImageAnalysis } from "@/lib/chart-analysis/types";
import { actionGuidanceLabel, directionBiasLabel, signalLabels as decisionSignalLabels } from "@/lib/ai/decision-ui";
import { ALIGNMENT_LABEL, TREND_LABEL } from "@/lib/market/multi-timeframe";
import type { MarketData } from "@/lib/market/types";
import { pairs, type Trade, type TradeDraft } from "@/lib/trades/types";
import { isRichSnapshot } from "@/lib/trades/snapshot";
import { captureMultiTimeframeSnapshot } from "@/lib/trades/mtf-snapshot";
import { buildPreTradeReview } from "@/lib/trades/pre-trade-review";
import type { DailyTradingPlan } from "@/lib/trading-plan/daily-plan";
import type { EntryReadiness } from "@/lib/trading-plan/entry-readiness";
import { PreTradeReview } from "./pre-trade-review";
import { captureMarketRegimeSnapshot } from "@/lib/trades/regime-snapshot";
import {
  EXIT_PLAN_PREFILL_NOTE,
  aiScenarioPrefill,
  createExitPlan,
  exitPlanInputErrors,
  formatPlannedRR,
  formatRiskPips,
} from "@/lib/trades/exit-plan";
import { REGIME_LABEL, REGIME_TREND_LABEL, VOLATILITY_LABEL } from "@/lib/market/market-regime";
import { dateTime, fromLocalDateTime, localDateTime, signalLabels } from "./format";

const PREVIEW_AT = "2000-01-01T00:00:00.000Z";

interface Props {
  trade: Trade | null;
  mode: "new" | "edit" | "close";
  pair: string;
  rate: number | null;
  analysis: AIAnalysis | null;
  chartImageAnalysis?: ChartImageAnalysis | null;
  market?: MarketData | null;
  getPreTradeSource?: () => { plan: DailyTradingPlan; readiness: EntryReadiness } | null;
  onSave: (draft: TradeDraft, options?: { saveSnapshot?: boolean }) => Promise<string | null>;
  onCancel: () => void;
}

export function TradeForm({ trade, mode, pair, rate, analysis, chartImageAnalysis = null, market = null, getPreTradeSource, onSave, onCancel }: Props) {
  const initialSide = trade?.side ?? (analysis?.signal.includes("sell") ? "short" : "long");
  const initialPrefill = mode === "new" ? aiScenarioPrefill(analysis, trade?.pair ?? pair, initialSide, trade?.entryPrice ?? rate) : null;
  const [fields, setFields] = useState(() => ({
    pair: trade?.pair ?? pair,
    side: initialSide,
    entryPrice: String(trade?.entryPrice ?? rate ?? ""),
    quantity: String(trade?.quantity ?? ""),
    openedAt: localDateTime(trade?.openedAt ?? new Date().toISOString()),
    stopLoss: String(trade?.stopLoss ?? initialPrefill?.stopLoss ?? ""),
    takeProfit: String(trade?.takeProfit ?? initialPrefill?.takeProfit ?? ""),
    notes: trade?.notes ?? "",
    exitPrice: String(trade?.exitPrice ?? ""),
    closedAt: localDateTime(trade?.closedAt ?? new Date().toISOString()),
  }));
  const [planDirty, setPlanDirty] = useState(false);
  const [usedAiPrefill, setUsedAiPrefill] = useState(!!initialPrefill);
  const [saveSnapshot, setSaveSnapshot] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isClosed = mode === "close" || trade?.status === "closed";
  const numeric = (s: string) => s.trim() ? Number(s) : NaN;
  function update(key: keyof typeof fields, value: string) {
    const nextDirty = planDirty || key === "stopLoss" || key === "takeProfit";
    if (nextDirty !== planDirty) setPlanDirty(nextDirty);
    setFields(previous => {
      const next = { ...previous, [key]: value };
      if ((key === "pair" || key === "side") && !nextDirty) {
        const prefill = aiScenarioPrefill(analysis, next.pair, next.side as "long" | "short", numeric(next.entryPrice));
        setUsedAiPrefill(!!prefill);
        next.stopLoss = prefill ? String(prefill.stopLoss) : "";
        next.takeProfit = prefill?.takeProfit != null ? String(prefill.takeProfit) : "";
      }
      return next;
    });
  }
  function input(key: keyof typeof fields, label: string, type = "number", optional = false, testId?: string, fieldError?: string | null) {
    return <div>
      <label>{label}<input data-testid={testId} type={type} required={!optional} step={type === "number" ? "any" : undefined} min={type === "number" ? "0" : undefined} value={fields[key]} aria-invalid={fieldError ? true : undefined} onChange={e => update(key, e.target.value)} /></label>
      {fieldError && <span role="alert" className="field-error" data-testid={testId ? `${testId}-error` : undefined}>{fieldError}</span>}
    </div>;
  }
  const draftStop = fields.stopLoss.trim() ? numeric(fields.stopLoss) : null;
  const draftTake = fields.takeProfit.trim() ? numeric(fields.takeProfit) : null;
  const planErrors = mode === "new"
    ? exitPlanInputErrors({
      pair: fields.pair,
      side: fields.side as TradeDraft["side"],
      entryPrice: numeric(fields.entryPrice),
      stopLoss: draftStop,
      takeProfit: draftTake,
      capturedAt: PREVIEW_AT,
    })
    : { stopLoss: null, takeProfit: null };
  const preview = mode === "new"
    ? createExitPlan({
      pair: fields.pair,
      side: fields.side as TradeDraft["side"],
      entryPrice: numeric(fields.entryPrice),
      stopLoss: planErrors.stopLoss ? null : draftStop,
      takeProfit: planErrors.takeProfit ? null : draftTake,
      capturedAt: PREVIEW_AT,
    })
    : null;
  async function submit(e: FormEvent) {
    e.preventDefault(); if (busy) return; setBusy(true);
    if (mode === "new" && (planErrors.stopLoss || planErrors.takeProfit)) {
      setError(planErrors.stopLoss ?? planErrors.takeProfit);
      setBusy(false);
      return;
    }
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
  const chartPreview = live?.chartEvidence?.used
    ? `${live.chartEvidence.timeframe ?? "時間足未検出"} / ${live.chartEvidence.trend} / quality ${live.chartEvidence.qualityScore}`
    : chartImageAnalysis && chartImageAnalysis.pair === fields.pair
      ? `${chartImageAnalysis.detected.timeframe ?? "時間足未検出"} / ${chartImageAnalysis.trend.direction} / 未添付`
      : "なし";
  const source = mode === "new" ? getPreTradeSource?.() ?? null : null;
  const mtfPreview = mode === "new" && saveSnapshot
    ? captureMultiTimeframeSnapshot(market, fields.pair, market?.daily?.fetchedAt ?? market?.price.fetchedAt ?? new Date().toISOString())
    : null;
  const regimePreview = mode === "new" && saveSnapshot
    ? captureMarketRegimeSnapshot(market, fields.pair, market?.timeframes["1h"]?.fetchedAt ?? market?.price.fetchedAt ?? new Date().toISOString())
    : null;
  const review = mode === "new"
    ? buildPreTradeReview({
      pair: fields.pair,
      tradeSide: fields.side === "short" ? "SELL" : "BUY",
      analysis: live,
      dailyPlan: source?.plan ?? null,
      readiness: source?.readiness ?? null,
      saveAnalysis: saveSnapshot,
      market: market && market.symbol === fields.pair ? market : null,
    })
    : null;

  return <form className="journal-form" onSubmit={submit} aria-label={mode === "new" ? "新規トレード登録" : mode === "close" ? "決済記録" : "取引編集"}>
    <h3>{mode === "new" ? "実際の取引を記録" : mode === "close" ? "決済を記録" : "取引を編集"}</h3>
    <p className="footnote">証券会社で行った取引の手動記録です。注文は発注しません。日時は日本時間（JST）で入力してください。</p>
    {mode !== "close" ? <div className="journal-fields">
      <label>記録する通貨ペア<select value={fields.pair} onChange={e => update("pair", e.target.value)}>{pairs.map(p => <option key={p}>{p}</option>)}</select></label>
      <label>売買方向<select value={fields.side} onChange={e => update("side", e.target.value)}><option value="long">買い / Long</option><option value="short">売り / Short</option></select></label>
      {input("entryPrice", "エントリー価格")}{input("quantity", "取引数量（通貨）")}{input("openedAt", "エントリー日時（JST）", "datetime-local")}
      {input("stopLoss", mode === "new" ? "初期損切り" : "損切り価格（任意）", "number", true, "exit-plan-sl-field", planErrors.stopLoss)}
      {input("takeProfit", mode === "new" ? "初期利確" : "利益確定価格（任意）", "number", true, "exit-plan-tp-field", planErrors.takeProfit)}
      <label className="journal-wide">メモ<textarea maxLength={4000} rows={3} value={fields.notes} onChange={e => update("notes", e.target.value)} /></label>
    </div> : <p className="footnote">{trade?.pair} · {trade?.side === "long" ? "Long" : "Short"} · {trade?.quantity.toLocaleString()}通貨 · Entry {trade?.entryPrice}</p>}
    {isClosed && <div className="journal-fields">{input("exitPrice", "決済価格")}{input("closedAt", "決済日時（JST）", "datetime-local")}</div>}

    {mode === "new" && <section className="exit-plan-preview" data-testid="exit-plan-preview" aria-label="Exit Plan">
      <p className="eyebrow">EXIT PLAN</p>
      <h4>Exit Plan</h4>
      {usedAiPrefill && <p className="footnote" data-testid="exit-plan-prefill-note">{EXIT_PLAN_PREFILL_NOTE}</p>}
      <dl className="exit-plan-grid">
        <div><dt>初期リスク</dt><dd data-testid="exit-plan-preview-risk">{preview ? formatRiskPips(preview.initialRiskPips) : "—"}</dd></div>
        <div><dt>計画R:R</dt><dd data-testid="exit-plan-preview-rr">{preview ? formatPlannedRR(preview.plannedRewardRiskRatio) : "—"}</dd></div>
      </dl>
      <p className="footnote">登録時の値幅計画です。取引の良し悪しや推奨を示すものではありません。</p>
    </section>}
    {mode === "edit" && <p className="footnote">登録時のExit Planは変更しません。</p>}

    {mode === "new" && <section className="snapshot-preview" aria-label="保存するAI分析">
      {live ? <>
        <label className="snapshot-toggle"><input type="checkbox" checked={saveSnapshot} onChange={e => setSaveSnapshot(e.target.checked)} />現在のAI分析をこの取引に保存</label>
        {saveSnapshot && <div className="snapshot-card">
          <p><strong>保存するAI分析</strong></p>
          <p>判断：{decisionSignalLabels[live.signal]} · 方向：{directionBiasLabel(direction)} · Action：{actionGuidanceLabel(action, live.signal)}</p>
          <p>確信度：{live.confidence}% · 分析時刻：{dateTime(live.analyzedAt)}</p>
          <p>Chart：{chartPreview}</p>
          {mtfPreview && <p data-testid="mtf-snapshot-preview">市場構造：{TREND_LABEL[mtfPreview.higherTimeframeBias]} · {ALIGNMENT_LABEL[mtfPreview.alignment]}</p>}
          {regimePreview && <p data-testid="regime-snapshot-preview">相場環境：{REGIME_LABEL[regimePreview.regime]} · {REGIME_TREND_LABEL[regimePreview.trendDirection]} · {VOLATILITY_LABEL[regimePreview.volatility]}</p>}
          {live.ai.status !== "available" && <p className="neutral">AI一部利用不可時の暫定分析です。</p>}
        </div>}
      </> : <p className="footnote">AI分析なし。スナップショットなしで記録できます。</p>}
      {review && <PreTradeReview review={review} />}
      <p className="footnote">登録時に表示中の分析をコピーします。OpenAI / Vision は再実行しません。チャート画像そのものは保存しません。</p>
    </section>}

    {mode !== "new" && <p className="footnote">{stored
      ? `登録時AI：${signalLabels[stored.signal]}${isRichSnapshot(stored) ? ` / ${directionBiasLabel(stored.directionSignal)} / ${stored.action}` : ""} · 分析日時 ${dateTime(stored.analyzedAt)}`
      : "エントリー時AI分析：保存なし"}。登録時のAIスナップショットは変更しません。</p>}

    {error && <p role="alert" className="negative">{error}</p>}
    <div className="journal-actions"><button disabled={busy} className="journal-primary" type="submit">{mode === "close" ? "決済を保存" : "取引を保存"}</button><button disabled={busy} type="button" onClick={onCancel}>キャンセル</button></div>
  </form>;
}
