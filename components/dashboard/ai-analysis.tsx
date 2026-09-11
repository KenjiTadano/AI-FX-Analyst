"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { tradeSignals, type AIAnalysis, type AnalysisResponse, type TradeSignal } from "@/lib/ai/types";
import { categoryLabels } from "@/lib/ai/input";
import {
  actionGuidanceLabel,
  classifyWaitReasons,
  directionBiasLabel,
  evidenceConflictNote,
  formatScenarioPrices,
  isAnalysisStale,
  recommendedPositionHint,
  scenarioStance,
  signalLabels,
  splitEvidenceMaterials,
  whatToDoNow,
  whyFactors,
  ANALYSIS_STALE_MS,
} from "@/lib/ai/decision-ui";
import type { ChartImageAnalysis } from "@/lib/chart-analysis/types";
import type { RiskSettings } from "@/lib/risk/types";
import defaults from "@/lib/settings/defaults.json";
import { Panel } from "./panels";

const tone = (signal: TradeSignal) => signal.includes("buy") ? "positive" : signal.includes("sell") ? "negative" : "neutral";
const format = (value: number | null | undefined, decimals = 3) => value == null ? "—" : value.toFixed(decimals);
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
      // Always fetch the first load / manual refresh. Skip only scheduled polls while the tab is hidden.
      await run(controller.signal, mode, chartImageAnalysis);
      if (!controller.signal.aborted) {
        timer = setTimeout(function poll() {
          if (document.visibilityState === "hidden") {
            timer = setTimeout(poll, 60_000);
            return;
          }
          void refresh();
        }, 60_000);
      }
    }
    void refresh();
    return () => {
      controller.abort();
      clearTimeout(timer);
      // Strict Mode remount can otherwise leave inFlight=true and skip the next fetch forever.
      inFlight.current = false;
    };
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

function ReasonList({ items, empty }: { items: string[]; empty: string }) {
  return items.length ? <ul className="ai-reason-list">{items.map((item, index) => <li key={index}>{item}</li>)}</ul> : <p className="muted footnote">{empty}</p>;
}

export function AIOverview({
  response,
  pair,
  pendingChart,
  chartActive,
  onExcludeChart,
  onRefresh,
  refreshing,
  currentRate,
  rateDecimals = 3,
  riskSettings,
}: {
  response: AnalysisResponse | null;
  pair: string;
  pendingChart: ChartImageAnalysis | null;
  chartActive: boolean;
  onExcludeChart: () => void;
  onRefresh: () => void;
  refreshing: boolean;
  currentRate: number | null;
  rateDecimals?: number;
  riskSettings?: RiskSettings;
}) {
  const [now, setNow] = useState(0);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const data = response?.data;
  const expired = !!data && now >= Date.parse(data.expiresAt);
  const signal = expired ? "wait" : data?.signal ?? "wait";
  const direction = data?.directionSignal ?? "wait";
  const action = expired ? "WAIT" : data?.action ?? (signal === "wait" ? "WAIT" : signal.includes("buy") ? "BUY" : signal.includes("sell") ? "SELL" : "WAIT");
  const scenario = expired ? null : data?.scenario;
  const prices = formatScenarioPrices(scenario, rateDecimals);
  const message = expired
    ? "分析の有効期限を過ぎました。更新まで待機してください。"
    : response?.error?.message ?? data?.ai.message ?? (!response ? "市場データを集めて分析中…" : null);
  const chartUsed = !!data?.chartEvidence?.used;
  const stale = !!data && isAnalysisStale(data.analyzedAt, now);
  const waitReasons = classifyWaitReasons(data);
  const stance = scenarioStance(data);
  const todo = whatToDoNow(data);
  const settings = riskSettings ?? { balance: defaults.balance, target: defaults.target, riskPercent: defaults.riskPercent, tradeUnit: defaults.tradeUnit };
  const position = recommendedPositionHint(expired ? null : data, pair, settings, now);
  const fallbackOnly = !!data && data.ai.status !== "available";
  const nextEvent = data?.economicRisk?.nextHigh;

  return <>
    <Panel title="AI総合判定" eyebrow="AI SIGNAL / DECISION SUPPORT" className="signal-panel decision-panel">
      {pendingChart && <div className="chart-ai-banner" role="status">
        <p>{chartActive ? "チャート画像Evidenceを含めて分析しています" : "チャート画像Evidenceを含められます"}（{pendingChart.detected.timeframe ?? "時間足未検出"} · {trendShort[pendingChart.trend.direction]} · 品質 {pendingChart.dataQuality.score}）。{!chartActive && "「AI総合分析を更新」で反映します。"}</p>
        <div className="chart-actions">
          <button type="button" className="journal-primary" disabled={refreshing} onClick={onRefresh}>{refreshing ? "AI総合分析を更新中…" : "AI総合分析を更新"}</button>
          <button type="button" disabled={refreshing} onClick={onExcludeChart}>チャートを総合分析から外す</button>
        </div>
      </div>}

      <div className="decision-header">
        <div>
          <p className="muted decision-pair">{pair}</p>
          <p className="decision-live-rate">現在レート <strong>{format(currentRate, rateDecimals)}</strong></p>
          {data?.currentRate != null && <p className="footnote">分析時点レート {format(data.currentRate, rateDecimals)}</p>}
        </div>
        <div className="decision-actions-top chart-actions">
          <button type="button" className="journal-primary" disabled={refreshing} onClick={onRefresh}>
            {refreshing ? "AI総合分析を更新中…" : "AI総合分析を更新"}
          </button>
        </div>
      </div>

      {stale && !expired && <p className="neutral" role="status">分析結果が古くなっています（{Math.round(ANALYSIS_STALE_MS / 60_000)}分以上）。再分析を推奨します。</p>}
      {fallbackOnly && <p className="neutral" role="status">AI分析：一部利用不可。技術分析ベースの暫定判断です。</p>}
      {!data && response?.error && <div className="chart-actions"><p className="material-empty negative" role="alert">分析に失敗しました。</p><button type="button" className="journal-primary" disabled={refreshing} onClick={onRefresh}>再分析</button></div>}

      <div className="decision-hero">
        <div>
          <p className="eyebrow">AI判断</p>
          <span className={`signal-word ${tone(signal)}`} data-testid="ai-signal">{signalLabels[signal]}</span>
        </div>
        <div className="decision-meta-grid" aria-label="方向と行動の分離">
          <div>
            <span className="muted">方向感</span>
            <strong className={tone(direction)} data-testid="ai-direction">{directionBiasLabel(direction)}</strong>
          </div>
          <div>
            <span className="muted">現在の行動</span>
            <strong className={action === "WAIT" ? "neutral" : tone(signal)} data-testid="ai-action">{actionGuidanceLabel(action, signal)}</strong>
            <small className="footnote">Action: {action}</small>
          </div>
          <div>
            <span className="muted">確信度</span>
            <strong data-testid="ai-confidence">{data ? `${data.confidence}%` : "—"}</strong>
            <progress className="decision-confidence" value={data?.confidence ?? 0} max={100} aria-label={`確信度 ${data?.confidence ?? 0}%`} />
          </div>
        </div>
      </div>

      {data?.summary && <p className="analysis-comment decision-summary" data-testid="ai-quick-summary">{data.summary}</p>}

      <section className="decision-now" aria-label="今やること">
        <h3>今やること</h3>
        <p data-testid="ai-what-to-do">{expired ? "分析の有効期限を過ぎました。再分析してください" : todo}</p>
      </section>

      {data?.economicRisk?.active && <div className="decision-event" role="status">
        <p><strong>重要イベント接近中</strong>{nextEvent ? ` · ${nextEvent.name}` : ""}{nextEvent?.scheduledAt ? ` · ${time(nextEvent.scheduledAt)}` : ""}</p>
        <p className="footnote">発表前のため WAIT を優先します。新規エントリーは見送ります。</p>
        {data.economicRisk.reasons[0] && <p className="footnote">{data.economicRisk.reasons[0]}</p>}
      </div>}

      {(action === "WAIT" || signal === "wait") && <section className="decision-wait-reasons" aria-label="WAIT理由">
        <h3>WAIT理由</h3>
        <ul className="ai-reason-list">{waitReasons.map(item => <li key={`${item.kind}-${item.label}`}>{item.label}</li>)}</ul>
        <p className="footnote">WAITは分析失敗ではありません。条件が整うまでの正常な判断です。</p>
      </section>}

      <section className="decision-position" aria-label="推奨ポジション">
        <h3>推奨ポジション</h3>
        <p data-testid="ai-position">{position.wait ? (position.maxUnits === 0 ? "0（新規エントリーなし）" : position.label) : position.label}</p>
        {action === "WAIT" && <p className="footnote">方向が買い/売り寄りでも、WAIT中は新規ポジションを勧めません。</p>}
      </section>

      <ol className="signal-scale" aria-label="5段階のAI総合判定">{tradeSignals.map(item => <li key={item} className={signal === item ? `selected ${tone(item)}` : ""} aria-current={signal === item ? "step" : undefined}>{signalLabels[item]}</li>)}</ol>

      <div className="ai-confidence"><span>方向スコア <strong>{data ? `${data.score > 0 ? "+" : ""}${data.score}` : "—"}</strong></span><span>データ充足率 <strong>{data ? `${data.dataQuality.score}%` : "—"}</strong></span></div>

      {data && <div className="quality-grid used-data-grid" aria-label="使用データ">
        <span className="badge">Market Data · {data.currentRate != null ? "✓" : "—"}</span>
        <span className="badge">Technical · {data.dataQuality.categories.technical.status === "missing" ? "—" : "✓"}</span>
        <span className="badge">News · {data.dataQuality.categories.news.status === "missing" ? "—" : "✓"}</span>
        <span className="badge">FRED Macro · {data.dataQuality.macroeconomicData?.status === "missing" ? "—" : "✓"}</span>
        <span className="badge">Economic Calendar · {data.dataQuality.categories.economic.status === "missing" ? "—" : "✓"}</span>
        <span className={`badge ${chartUsed ? "positive" : ""}`}>Chart Image · {chartUsed ? "✓" : "—"}</span>
      </div>}
      {chartUsed && data?.chartEvidence && <p className="footnote" data-testid="ai-chart-evidence">チャート画像: {data.chartEvidence.timeframe ?? "時間足未検出"} · {trendShort[data.chartEvidence.trend]} · 品質 {data.chartEvidence.qualityScore}</p>}
      {data?.dataQuality.categories.economic.status === "missing" && <p className="footnote">利用不可: Economic Calendar</p>}

      {message && <p className="footnote neutral" role="status">{message}</p>}
      {data && <><span className="badge">{data.ai.status === "available" ? "AI統合済み" : "テクニカルのみ"}{response?.cached ? " · キャッシュ" : ""}</span><p className="footnote" data-testid="ai-analyzed-at">分析時刻: {time(data.analyzedAt)} JST<br />有効期限: {time(data.expiresAt)} JST</p></>}
      <p className="footnote">方向の強さと確信度は別の指標です。いずれも勝率ではありません。注文は実行しません。</p>
    </Panel>

    <Panel title="エントリー条件" eyebrow="CONDITIONAL SCENARIOS" className="scenario-decision-panel">
      <div className="scenario-stance" aria-label="シナリオ状態">
        <span className="badge">BUY · {stance.buy}</span>
        <span className="badge">SELL · {stance.sell}</span>
        <span className={`badge ${stance.wait === "現在推奨" ? "neutral" : ""}`}>WAIT · {stance.wait}</span>
      </div>
      {scenario && prices ? (
        <div className="scenario-active">
          <div className="row">
            <span className="muted">{scenario.direction === "long" ? "BUYシナリオ" : "SELLシナリオ"}</span>
            <span className={`badge ${tone(signal)}`}>{scenario.direction === "long" ? "買い / LONG" : "売り / SHORT"}</span>
          </div>
          <p>{scenario.condition}</p>
          <dl className="metrics">
            <div><dt>Entry候補</dt><dd className="entry-zone">{prices.entry}</dd></div>
            <div><dt>Stop Loss</dt><dd className="negative">{prices.stop}</dd></div>
            <div><dt>Take Profit①</dt><dd className="positive">{prices.takeProfit1}</dd></div>
            <div><dt>Take Profit②</dt><dd className="positive">{prices.takeProfit2}</dd></div>
            <div><dt>Risk / Reward</dt><dd>1 : {scenario.riskReward.toFixed(2)}</dd></div>
            <div><dt>分析時レート</dt><dd>{format(data?.currentRate, rateDecimals)}</dd></div>
          </dl>
          <p className="footnote">{scenario.invalidation}</p>
          {!position.wait && position.maxUnits != null && <p className="footnote">資金・リスク設定に基づく目安: {position.label}</p>}
        </div>
      ) : (
        <div>
          <p className="footnote" data-testid="ai-scenario-empty">現在は条件付きEntryを提示していません。価格は未取得のままにし、UI側で生成しません。</p>
          <dl className="metrics">
            <div><dt>Entry候補</dt><dd>条件未設定</dd></div>
            <div><dt>Stop Loss</dt><dd>条件未設定</dd></div>
            <div><dt>Take Profit</dt><dd>条件未設定</dd></div>
          </dl>
        </div>
      )}
      <p className="footnote">単位 JPY · 不利な端でRRを計算 · 自動売買しません</p>
    </Panel>
  </>;
}

export function AIExplanation({ response }: { response: AnalysisResponse | null }) {
  const data: AIAnalysis | null | undefined = response?.data;
  const materials = splitEvidenceMaterials(data);
  const conflict = evidenceConflictNote(data);
  const why = whyFactors(data);
  return <>
    <Panel title="なぜ？" eyebrow="WHY THIS DECISION" className="reasons-panel">
      {!data ? <p className="muted" role="status">{response?.error?.message ?? "分析結果を取得中…"}</p> : <>
        {conflict && <p className="neutral" role="status" data-testid="ai-conflict">{conflict}</p>}
        <div className="ai-factors why-factors">
          {why.map((factor, index) => (
            <article className="reason" key={`${factor.category}-${index}`}>
              <div className="row">
                <h3>{categoryLabels[factor.category] ?? factor.title}</h3>
                <span className={`badge ${factor.direction === "bullish" ? "positive" : factor.direction === "bearish" ? "negative" : "neutral"}`}>
                  {{ bullish: "↑ BUY材料", bearish: "↓ SELL材料", neutral: "→ 中立", unknown: "未評価" }[factor.direction]}
                </span>
              </div>
              <p>{factor.reason}</p>
              <small className="material-source">{factor.source}</small>
            </article>
          ))}
        </div>
        {!why.length && <p className="muted footnote">判断理由を取得中、または未評価です。</p>}
        <div className="ai-reason-columns evidence-split">
          <section>
            <h3 className="positive">BUY材料</h3>
            <ReasonList items={materials.buy.map(item => `${item.title}: ${item.reason}`)} empty="確認できるBUY材料はありません。" />
          </section>
          <section>
            <h3 className="negative">SELL材料</h3>
            <ReasonList items={materials.sell.map(item => `${item.title}: ${item.reason}`)} empty="確認できるSELL材料はありません。" />
          </section>
          <section>
            <h3 className="neutral">WAIT材料</h3>
            <ReasonList items={materials.wait.map(item => item.reason)} empty="追加のWAIT材料はありません。" />
          </section>
        </div>
        <div className="quality-grid">
          {Object.entries(data.dataQuality.categories).map(([category, value]) => (
            <span className="badge" key={category}>{categoryLabels[category as keyof typeof categoryLabels]} · {value.status === "ok" ? "OK" : value.status === "partial" ? "Partial" : "Missing"}</span>
          ))}
          {data.dataQuality.macroeconomicData && <span className="badge">米国マクロ · {data.dataQuality.macroeconomicData.status === "ok" ? "OK" : data.dataQuality.macroeconomicData.status === "partial" ? "Partial" : "Missing"}</span>}
          {data.chartEvidence?.used && <span className="badge positive">チャート画像 · 使用</span>}
        </div>
      </>}
    </Panel>
    <Panel title="判断条件と注意点" eyebrow="DECISION & RISK NOTES" className="commentary-panel">
      <ReasonList items={data?.decisionReasons ?? []} empty={data ? "方向・データ品質・価格関係の条件を満たす候補です。実行前に最新情報をご確認ください。" : "分析結果を待っています。"} />
      {data && <details className="ai-warnings"><summary>データ不足・過熱・その他の注意点（{data.riskWarnings.length}件）</summary><ReasonList items={data.riskWarnings} empty="追加の注意点はありません。" /></details>}
    </Panel>
  </>;
}
