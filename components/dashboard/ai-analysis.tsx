"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { tradeSignals, type AIAnalysis, type AnalysisResponse, type TradeSignal } from "@/lib/ai/types";
import { categoryLabels } from "@/lib/ai/input";
import type { ChartImageAnalysis } from "@/lib/chart-analysis/types";
import { Panel } from "./panels";

const signalLabels: Record<TradeSignal, string> = { strong_buy: "すごく買い", buy: "買い", wait: "待った", sell: "売り", strong_sell: "すごく売り" };
const tone = (signal: TradeSignal) => signal.includes("buy") ? "positive" : signal.includes("sell") ? "negative" : "neutral";
const format = (value: number | null | undefined) => value == null ? "—" : value.toFixed(3);
const time = (value: string) => new Date(value).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", hour12: false });
const trendShort: Record<ChartImageAnalysis["trend"]["direction"], string> = {
  strong_up: "強い上昇", up: "上昇", sideways: "レンジ", down: "下降", strong_down: "強い下降", unknown: "不明",
};

export function useAIAnalysis(pair: string, chartImageAnalysis: ChartImageAnalysis | null) {
  const [result, setResult] = useState<{ pair: string; response: AnalysisResponse } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [manualToken, setManualToken] = useState(0);
  const inFlight = useRef(false);

  const run = useCallback(async (signal: AbortSignal, mode: "auto" | "manual", chart: ChartImageAnalysis | null) => {
    if (document.visibilityState === "hidden" && mode === "auto") return;
    if (inFlight.current) return;
    inFlight.current = true;
    if (mode === "manual") setRefreshing(true);
    try {
      const response = chart
        ? await fetch("/api/analysis", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pair, chartImageAnalysis: chart }),
          cache: "no-store",
          signal: AbortSignal.any([signal, AbortSignal.timeout(45_000)]),
        })
        : await fetch(`/api/analysis?pair=${encodeURIComponent(pair)}`, {
          cache: "no-store",
          signal: AbortSignal.any([signal, AbortSignal.timeout(45_000)]),
        });
      const value: AnalysisResponse = await response.json();
      if (!response.ok || !value.success || !value.data || value.data.pair !== pair) throw new Error("unavailable");
      if (!signal.aborted) setResult({ pair, response: value });
    } catch {
      if (!signal.aborted) setResult({ pair, response: { success: false, data: null, error: { code: "unavailable", message: "現在AI総合分析を取得できません。既存テクニカルは引き続き確認できます。" }, cached: false } });
    } finally {
      inFlight.current = false;
      if (mode === "manual" && !signal.aborted) setRefreshing(false);
    }
  }, [pair]);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let first = true;
    async function refresh() {
      const mode = first && manualToken > 0 ? "manual" : "auto";
      first = false;
      await run(controller.signal, mode, chartImageAnalysis);
      if (!controller.signal.aborted) timer = setTimeout(refresh, 60_000);
    }
    void refresh();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [pair, chartImageAnalysis, manualToken, run]);

  const refreshNow = useCallback(() => {
    setManualToken(token => token + 1);
  }, []);

  return {
    response: result?.pair === pair ? result.response : null,
    refreshing,
    refreshNow,
  };
}

export function AIOverview({
  response,
  pair,
  pendingChart,
  chartActive,
  onExcludeChart,
  onRefresh,
  refreshing,
}: {
  response: AnalysisResponse | null;
  pair: string;
  pendingChart: ChartImageAnalysis | null;
  chartActive: boolean;
  onExcludeChart: () => void;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const [now, setNow] = useState(0);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const data = response?.data;
  const expired = !!data && now >= Date.parse(data.expiresAt);
  const signal = expired ? "wait" : data?.signal ?? "wait";
  const scenario = expired ? null : data?.scenario;
  const message = expired ? "分析の有効期限を過ぎました。更新まで待機してください。" : response?.error?.message ?? data?.ai.message ?? (!response ? "市場データを集めて分析中…" : null);
  const chartUsed = !!data?.chartEvidence?.used;
  return <>
    <Panel title="AI総合判定" eyebrow="AI SIGNAL / STRUCTURED ANALYSIS" className="signal-panel">
      {pendingChart && <div className="chart-ai-banner" role="status">
        <p>{chartActive ? "チャート画像Evidenceを含めて分析しています" : "チャート画像Evidenceを含められます"}（{pendingChart.detected.timeframe ?? "時間足未検出"} · {trendShort[pendingChart.trend.direction]} · 品質 {pendingChart.dataQuality.score}）。{!chartActive && "「AI総合分析を更新」で反映します。"}</p>
        <div className="chart-actions">
          <button type="button" className="journal-primary" disabled={refreshing} onClick={onRefresh}>{refreshing ? "AI総合分析を更新中…" : "AI総合分析を更新"}</button>
          <button type="button" disabled={refreshing} onClick={onExcludeChart}>チャートを総合分析から外す</button>
        </div>
      </div>}
      <div className="signal-result"><div><span className={`signal-word ${tone(signal)}`} data-testid="ai-signal">{signalLabels[signal]}</span><p className="muted">{pair} の総合分析</p></div><div className="score"><strong>{data ? `${data.score > 0 ? "+" : ""}${data.score}` : "—"}</strong><small>方向スコア / −100〜+100</small></div></div>
      {data?.directionSignal && <p className="footnote">相場方向：{signalLabels[data.directionSignal]} / 現在の行動：{signalLabels[signal]}（{expired ? "WAIT" : data.action ?? "WAIT"}）</p>}
      {data?.economicRisk?.active && <p className="neutral" role="status">経済指標のリスク時間帯です。新規エントリーは待機します。</p>}
      <ol className="signal-scale" aria-label="5段階のAI総合判定">{tradeSignals.map(item => <li key={item} className={signal === item ? `selected ${tone(item)}` : ""} aria-current={signal === item ? "step" : undefined}>{signalLabels[item]}</li>)}</ol>
      <div className="ai-confidence"><span>確信度 <strong>{data ? `${data.confidence}%` : "—"}</strong></span><span>データ充足率 <strong>{data ? `${data.dataQuality.score}%` : "—"}</strong></span></div>
      {data && <div className="quality-grid used-data-grid" aria-label="使用データ">
        <span className="badge">Market Data · {data.currentRate != null ? "✓" : "—"}</span>
        <span className="badge">Technical · {data.dataQuality.categories.technical.status === "missing" ? "—" : "✓"}</span>
        <span className="badge">News · {data.dataQuality.categories.news.status === "missing" ? "—" : "✓"}</span>
        <span className="badge">FRED Macro · {data.dataQuality.macroeconomicData?.status === "missing" ? "—" : "✓"}</span>
        <span className={`badge ${chartUsed ? "positive" : ""}`}>Chart Image · {chartUsed ? "✓" : "—"}</span>
      </div>}
      {chartUsed && data?.chartEvidence && <p className="footnote">チャート画像: {data.chartEvidence.timeframe ?? "時間足未検出"} · {trendShort[data.chartEvidence.trend]} · 品質 {data.chartEvidence.qualityScore}</p>}
      {message && <p className="footnote neutral" role="status">{message}</p>}
      {data && <><span className="badge">{data.ai.status === "available" ? "AI統合済み" : "テクニカルのみ"}{response?.cached ? " · キャッシュ" : ""}</span><p className="footnote">分析: {time(data.analyzedAt)} JST<br />有効期限: {time(data.expiresAt)} JST</p></>}
      <p className="footnote">方向の強さと確信度は別の指標です。いずれも勝率ではありません。</p>
    </Panel>
    <Panel title="取引シナリオ" eyebrow="CONDITIONAL TRADE PLAN">
      <div className="row"><span className="muted">条件付き候補</span><span className={`badge ${tone(signal)}`}>{scenario ? scenario.direction === "long" ? "買い / LONG" : "売り / SHORT" : "待機 / NO TRADE"}</span></div>
      <dl className="metrics"><div><dt>分析時レート</dt><dd>{format(data?.currentRate)}</dd></div><div><dt>エントリー帯</dt><dd className="entry-zone">{scenario ? `${format(scenario.entryZone.min)} ～ ${format(scenario.entryZone.max)}` : "—"}</dd></div><div><dt>損切り</dt><dd className="negative">{format(scenario?.stopLoss)}</dd></div><div><dt>利確①</dt><dd className="positive">{format(scenario?.takeProfit1)}</dd></div><div><dt>利確②</dt><dd className="positive">{format(scenario?.takeProfit2)}</dd></div><div><dt>Risk / Reward</dt><dd>{scenario ? `1 : ${scenario.riskReward.toFixed(2)}` : "—"}</dd></div></dl>
      <p className="footnote">{scenario?.condition ?? "WAITは正常な判断です。条件が整うまでエントリー候補は表示しません。"}</p>
      {scenario && <p className="footnote">{scenario.invalidation}</p>}
      <p className="footnote">単位 JPY · エントリー帯の不利な端でRRを計算 · 注文は実行しません</p>
    </Panel>

  </>;
}
function ReasonList({ items, empty }: { items: string[]; empty: string }) {
  return items.length ? <ul className="ai-reason-list">{items.map((item, index) => <li key={index}>{item}</li>)}</ul> : <p className="muted footnote">{empty}</p>;
}
export function AIExplanation({ response }: { response: AnalysisResponse | null }) {
  const data: AIAnalysis | null | undefined = response?.data;
  return <>
    <Panel title="判断理由" eyebrow="ANALYSIS BREAKDOWN" className="reasons-panel">
      {!data ? <p className="muted" role="status">{response?.error?.message ?? "分析結果を取得中…"}</p> : <>
        <p className="analysis-comment">{data.summary}</p>
        <div className="quality-grid">{Object.entries(data.dataQuality.categories).map(([category, value]) => <span className="badge" key={category}>{categoryLabels[category as keyof typeof categoryLabels]} · {value.status === "ok" ? "OK" : value.status === "partial" ? "Partial" : "Missing"}</span>)}{data.dataQuality.macroeconomicData && <span className="badge">米国マクロ · {data.dataQuality.macroeconomicData.status === "ok" ? "OK" : data.dataQuality.macroeconomicData.status === "partial" ? "Partial" : "Missing"}</span>}{data.chartEvidence?.used && <span className="badge positive">チャート画像 · 使用</span>}</div>
        <div className="ai-factors">{data.factors.map((factor, index) => <article className="reason" key={`${factor.category}-${index}`}><div className="row"><h3>{factor.title}</h3><span className={`badge ${factor.direction === "bullish" ? "positive" : factor.direction === "bearish" ? "negative" : "neutral"}`}>{{ bullish: "↑ 上昇要因", bearish: "↓ 下落要因", neutral: "→ 中立", unknown: "未評価" }[factor.direction]}</span></div><p>{factor.reason}</p><small className="material-source">{factor.source}</small></article>)}</div>
        <div className="ai-reason-columns"><section><h3 className="positive">強気材料</h3><ReasonList items={data.bullishReasons} empty="確認できる強気材料はありません。" /></section><section><h3 className="negative">弱気材料</h3><ReasonList items={data.bearishReasons} empty="確認できる弱気材料はありません。" /></section></div>
      </>}
    </Panel>
    <Panel title="判断条件と注意点" eyebrow="DECISION & RISK NOTES" className="commentary-panel">
      <ReasonList items={data?.decisionReasons ?? []} empty={data ? "方向・データ品質・価格関係の条件を満たす候補です。実行前に最新情報をご確認ください。" : "分析結果を待っています。"} />
      {data && <details className="ai-warnings"><summary>データ不足・過熱・その他の注意点（{data.riskWarnings.length}件）</summary><ReasonList items={data.riskWarnings} empty="追加の注意点はありません。" /></details>}
    </Panel>
  </>;
}
