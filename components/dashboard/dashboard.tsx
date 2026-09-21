"use client";

import { useCallback, useRef, useState } from "react";
import Link from "next/link";
import { TechnicalPanel, useMarket } from "./market";
import { MultiTimeframePanel } from "./multi-timeframe";
import { MarketRegimePanel } from "./market-regime";
import { SimilarHistoricalContextPanel } from "./similar-historical-context";
import { TradingDecisionWorkspacePanel } from "./trading-decision-workspace";
import { NextEventBanner } from "./economic-calendar";
import { FundamentalPanel, useFundamentals } from "./fundamental";
import { ChartAnalysisPanel } from "./chart-analysis";
import type { ChartImageAnalysis } from "@/lib/chart-analysis/types";
import type { Account, FxAnalysis } from "@/types/analysis";
import type { Trade } from "@/lib/trades/types";
import type { RiskSettings } from "@/lib/risk/types";
import defaults from "@/lib/settings/defaults.json";
import { TradeJournal } from "../trades/journal";
import { CloudSettings } from "../settings/cloud-settings";
import { useAuth } from "../auth/provider";
import { AuthStatus, LoginRequired } from "../auth/status";
import { AIOverview, AIExplanation, useAIAnalysis } from "./ai-analysis";
import { DailyTradingPlanPanel } from "./daily-plan";
import type { DailyTradingPlan } from "@/lib/trading-plan/daily-plan";
import type { EntryReadiness } from "@/lib/trading-plan/entry-readiness";
import type { Symbol } from "@/lib/market/types";

export function Dashboard({ analyses, account }: { analyses: FxAnalysis[]; account: Account }) {
  const auth = useAuth();
  const userId = auth.user?.id ?? "";
  const [selectedPair, setSelectedPair] = useState<Symbol>("USD/JPY");
  const [view, setView] = useState<"analysis" | "chart" | "trades" | "performance">("analysis");
  const [journalBalance, setJournalBalance] = useState({ userId: "", value: account.balance });
  const [riskSettings, setRiskSettings] = useState<RiskSettings>({
    balance: defaults.balance, target: defaults.target, riskPercent: defaults.riskPercent, tradeUnit: defaults.tradeUnit,
  });
  const [trades, setTrades] = useState<Trade[]>([]);
  // pending: user opted in; active: sent to /api/analysis after explicit refresh
  const [pendingChart, setPendingChart] = useState<ChartImageAnalysis | null>(null);
  const [activeChart, setActiveChart] = useState<ChartImageAnalysis | null>(null);
  const onBalanceChange = useCallback((value: number) => {
    setJournalBalance({ userId, value });
    setRiskSettings(current => ({ ...current, balance: value }));
  }, [userId]);
  const onSettingsChange = useCallback((settings: RiskSettings) => {
    setRiskSettings(settings);
    if (Number.isFinite(settings.balance)) setJournalBalance({ userId, value: settings.balance });
  }, [userId]);
  const clearCharts = useCallback(() => {
    setPendingChart(null);
    setActiveChart(null);
  }, []);
  const changePair = useCallback((pair: string) => {
    setSelectedPair(pair as Symbol);
    setPendingChart(null);
    setActiveChart(null);
  }, []);
  const includeChart = useCallback((analysis: ChartImageAnalysis) => {
    setPendingChart(analysis);
    setActiveChart(null);
    setView("analysis");
  }, []);
  const excludeChart = useCallback(() => {
    setPendingChart(null);
    setActiveChart(null);
  }, []);
  const market = useMarket(selectedPair);
  const fundamentals = useFundamentals(selectedPair);
  const { response: aiResponse, refreshing: aiRefreshing, refreshNow } = useAIAnalysis(selectedPair, activeChart);
  const refreshAnalysis = useCallback(() => {
    if (pendingChart) setActiveChart(pendingChart);
    refreshNow();
  }, [pendingChart, refreshNow]);
  const preTradeRef = useRef<{ plan: DailyTradingPlan; readiness: EntryReadiness } | null>(null);
  const onPlanContext = useCallback((context: { plan: DailyTradingPlan; readiness: EntryReadiness }) => {
    preTradeRef.current = context;
  }, []);
  const getPreTradeSource = useCallback(() => preTradeRef.current, []);
  const quote = market?.data?.price;
  const liveRate = quote?.stale || quote?.error ? null : quote?.data ?? null;
  const analysis = analyses.find(item => item.pair === selectedPair) ?? analyses[0];
  if (!analysis) return <main className="dashboard-shell"><p>分析データがありません。</p></main>;
  return <>
    <header className="app-header"><div className="header-inner"><Link className="brand" href="/" aria-label="AI-FX-Analyst ホーム"><span className="brand-icon" aria-hidden="true">↗</span><span>AI-FX-<span className="brand-light">Analyst</span></span></Link><span className="product-badge" data-testid="product-badge"><span />Reference</span></div></header>
    <main className="dashboard-shell" id="main-content">
      <div className="page-heading"><div><p className="eyebrow">TRADING DECISION SUPPORT</p><h1>判断材料を、ひと目で。</h1><p className="muted">Direction と Action は別です。参考情報であり、自動売買ではありません。</p></div></div>
      <div className="demo-notice" data-testid="product-notice"><span className="notice-icon" aria-hidden="true">i</span><p><strong>データとAIは参考情報です</strong><span>市場データ・AI判定・過去事例は判断補助です。売買推奨や注文実行ではありません。</span></p></div>
      <AuthStatus />
      <section className="market-panel" aria-label="通貨ペアと現在レート" data-testid="market-context"><div className="pair-control"><label htmlFor="currency-pair">通貨ペア</label><select id="currency-pair" value={analysis.pair} onChange={event => changePair(event.target.value)}>{analyses.map(item => <option key={item.pair} value={item.pair}>{item.pair}</option>)}</select><p data-testid="dashboard-pair">{analysis.pair}</p></div><div className="rate-block"><span className="muted">現在レート <span className="mini-label" data-testid="market-freshness-label">{quote?.stale ? "STALE" : quote?.data != null ? "FRESH" : market?.error ? "ERROR" : "LOADING"}</span></span><div className="rate-value">{quote?.data != null ? quote.data.toFixed(analysis.decimals) : "—"}<small>{analysis.quoteCurrency}</small></div><p className="footnote" role="status" data-testid="market-status">{market?.error || quote?.error || (market ? "60秒キャッシュ · 前日比は未取得" : "取得中…")}</p>{quote?.stale && <p className="negative footnote" role="status" data-testid="market-stale-note">更新失敗・最終取得値を表示</p>}<p className="footnote">取得: {quote?.fetchedAt ? new Date(quote.fetchedAt).toLocaleString("ja-JP") : "—"}</p></div><div className="snapshot"><span className="eyebrow">MARKET</span><p>表示中: {analysis.pair}</p><span className="muted">レート60秒 / OHLC 5分キャッシュ</span></div></section>
      <NextEventBanner resource={fundamentals?.data?.calendar} />
      <nav className="journal-nav" aria-label="ダッシュボード表示" data-testid="dashboard-tabs">{([["analysis", "分析"], ["chart", "チャート読取"], ["trades", "トレード"], ["performance", "成績"]] as const).map(([key, label]) => <button key={key} type="button" aria-current={view === key ? "page" : undefined} onClick={() => setView(key)}>{label}</button>)}</nav>
      <p className="footnote ia-flow" data-testid="dashboard-flow">分析（判断ワークスペース → 詳細）→ トレード記録 → 成績。過去の取引は保存時点の情報のままです。</p>
      <div hidden={view !== "analysis"}>
        <section className="ia-section" aria-label="Trading Decision Workspace" data-testid="ia-decision-workspace">
          <TradingDecisionWorkspacePanel
            pair={selectedPair}
            analysis={aiResponse?.data && aiResponse.data.pair === selectedPair ? aiResponse.data : null}
            trades={trades}
            riskSettings={riskSettings}
            currentRate={liveRate}
            calendar={fundamentals?.data?.calendar}
            market={market?.data && market.data.symbol === selectedPair ? market.data : null}
            marketError={market?.error ?? null}
            rateDecimals={analysis.decimals}
            userId={userId}
            capturedAt={
              (market?.data?.price.fetchedAt
                && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(market.data.price.fetchedAt)
                && new Date(market.data.price.fetchedAt).toISOString() === market.data.price.fetchedAt)
                ? market.data.price.fetchedAt
                : "2026-09-21T12:00:00.000Z"
            }
          />
        </section>
        <section className="ia-section ia-section-detail" aria-labelledby="ia-analysis" data-testid="ia-analysis">
          <h2 id="ia-analysis">Analysis detail · {analysis.pair}</h2>
          <p className="footnote">Workspace と同じ Direction / Action の詳細です。Direction と Action は別です。</p>
          <div className="dashboard-grid decision-layout">
            <AIOverview response={aiResponse} pair={selectedPair} pendingChart={pendingChart} chartActive={!!activeChart} onExcludeChart={excludeChart} onRefresh={refreshAnalysis} refreshing={aiRefreshing} currentRate={liveRate} rateDecimals={analysis.decimals} />
          </div>
        </section>
        <section className="ia-section ia-section-detail" aria-labelledby="ia-setup" data-testid="ia-trade-setup">
          <h2 id="ia-setup">Trade Setup detail · {analysis.pair}</h2>
          <p className="footnote">Workspace の Readiness / Trigger / Event Risk の詳細です。Trigger 成立はエントリー推奨ではありません。</p>
          <div className="dashboard-grid decision-layout">
            <DailyTradingPlanPanel key={userId || "anon"} pair={selectedPair} analysis={aiResponse?.data && aiResponse.data.pair === selectedPair ? aiResponse.data : null} trades={trades} riskSettings={riskSettings} currentRate={liveRate} calendar={fundamentals?.data?.calendar} market={market?.data && market.data.symbol === selectedPair ? market.data : null} rateDecimals={analysis.decimals} userId={userId} onRefresh={refreshAnalysis} refreshing={aiRefreshing} onPlanContext={onPlanContext} />
          </div>
        </section>
        <section className="ia-section ia-section-detail" aria-labelledby="ia-market" data-testid="ia-market-detail">
          <h2 id="ia-market">Market detail · {analysis.pair}</h2>
          <p className="footnote">Workspace の MTF / Regime / 類似事例の詳細です。</p>
          <div className="dashboard-grid decision-layout">
            <TechnicalPanel data={market?.data ?? null} error={market?.error ?? null} />
            <MultiTimeframePanel pair={selectedPair} data={market?.data && market.data.symbol === selectedPair ? market.data : null} error={market?.error ?? null} />
            <MarketRegimePanel pair={selectedPair} data={market?.data && market.data.symbol === selectedPair ? market.data : null} error={market?.error ?? null} />
            <FundamentalPanel symbol={selectedPair} result={fundamentals} />
          </div>
          <SimilarHistoricalContextPanel
            pair={selectedPair}
            market={market?.data && market.data.symbol === selectedPair ? market.data : null}
            marketRate={liveRate}
            trades={trades}
            capturedAt={
              (market?.data?.price.fetchedAt
                && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(market.data.price.fetchedAt)
                && new Date(market.data.price.fetchedAt).toISOString() === market.data.price.fetchedAt)
                ? market.data.price.fetchedAt
                : "2026-09-21T12:00:00.000Z"
            }
          />
        </section>
        <details className="ia-disclosure" open>
          <summary>分析の詳細（根拠・シナリオ）</summary>
          <div className="dashboard-grid decision-layout">
            <AIExplanation response={aiResponse} />
            {auth.user ? <CloudSettings key={userId} userId={userId} analysis={aiResponse?.data ?? null} pair={selectedPair} currentRate={liveRate} onBalanceChange={onBalanceChange} onSettingsChange={onSettingsChange} /> : <LoginRequired settings />}
          </div>
        </details>
      </div>
      <div hidden={view !== "chart"}><ChartAnalysisPanel pair={selectedPair} onPairChange={changePair} includedChart={pendingChart} onIncludeChart={includeChart} onExcludeChart={clearCharts} /></div>
      {auth.user ? <TradeJournal key={userId} userId={userId} view={view === "chart" ? "analysis" : view} pair={selectedPair} quote={quote?.data != null && quote.fetchedAt ? { pair: selectedPair, price: quote.data, fetchedAt: quote.fetchedAt, stale: !!quote.stale || !!quote.error } : null} analysis={aiResponse?.data ?? null} chartImageAnalysis={activeChart ?? pendingChart} market={market?.data && market.data.symbol === selectedPair ? market.data : null} initialBalance={journalBalance.userId === userId ? journalBalance.value : NaN} onTradesChange={setTrades} getPreTradeSource={getPreTradeSource} /> : view !== "analysis" && view !== "chart" && <LoginRequired />}
      <footer className="page-footer"><span>AI-FX-Analyst</span><p>分析は条件付きの参考情報です。WAITも正常な判断です。</p><span>Reference only</span></footer>
    </main>
  </>;
}
