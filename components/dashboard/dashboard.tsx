"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { TechnicalPanel, useMarket } from "./market";
import { NextEventBanner } from "./economic-calendar";
import { FundamentalPanel, useFundamentals } from "./fundamental";
import { ChartAnalysisPanel } from "./chart-analysis";
import type { ChartImageAnalysis } from "@/lib/chart-analysis/types";
import type { Account, FxAnalysis } from "@/types/analysis";
import { TradeJournal } from "../trades/journal";
import { CloudSettings } from "../settings/cloud-settings";
import { useAuth } from "../auth/provider";
import { AuthStatus, LoginRequired } from "../auth/status";
import { AIOverview, AIExplanation, useAIAnalysis } from "./ai-analysis";

export function Dashboard({ analyses, account }: { analyses: FxAnalysis[]; account: Account }) {
  const auth = useAuth();
  const userId = auth.user?.id ?? "";
  const [selectedPair, setSelectedPair] = useState("USD/JPY");
  const [view, setView] = useState<"analysis" | "chart" | "trades" | "performance">("analysis");
  const [journalBalance, setJournalBalance] = useState({ userId: "", value: account.balance });
  // pending: user opted in; active: sent to /api/analysis after explicit refresh
  const [pendingChart, setPendingChart] = useState<ChartImageAnalysis | null>(null);
  const [activeChart, setActiveChart] = useState<ChartImageAnalysis | null>(null);
  const onBalanceChange = useCallback((value: number) => setJournalBalance({ userId, value }), [userId]);
  const clearCharts = useCallback(() => {
    setPendingChart(null);
    setActiveChart(null);
  }, []);
  const changePair = useCallback((pair: string) => {
    setSelectedPair(pair);
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
  const quote = market?.data?.price;
  const liveRate = quote?.stale || quote?.error ? null : quote?.data ?? null;
  const analysis = analyses.find(item => item.pair === selectedPair) ?? analyses[0];
  if (!analysis) return <main className="dashboard-shell"><p>分析データがありません。</p></main>;
  return <>
    <header className="app-header"><div className="header-inner"><Link className="brand" href="/" aria-label="AI FX Analyst ホーム"><span className="brand-icon" aria-hidden="true">↗</span><span>AI FX <span className="brand-light">Analyst</span></span></Link><span className="demo-badge"><span />MVP / TASK 012</span></div></header>
    <main className="dashboard-shell" id="main-content">
      <div className="page-heading"><div><p className="eyebrow">YOUR MARKET, AT A GLANCE</p><h1>マーケットの今を、ひと目で。</h1><p className="muted">相場の方向性とリスクを、一つのダッシュボードに。</p></div><span className="workspace-label">FX ANALYSIS / 01</span></div>
      <div className="demo-notice"><span className="notice-icon" aria-hidden="true">i</span><p><strong>レート・テクニカルはTwelve Data</strong><span>AI総合判定は取得済みデータから分析。チャート画像は補助Evidenceです。AI未取得・データ不足時は待機します。無料枠は1日800クレジットのため、常時更新には上限があります。</span></p></div>
      <AuthStatus />
      <section className="market-panel" aria-label="通貨ペアと現在レート"><div className="pair-control"><label htmlFor="currency-pair">通貨ペア</label><select id="currency-pair" value={analysis.pair} onChange={event => changePair(event.target.value)}>{analyses.map(item => <option key={item.pair} value={item.pair}>{item.pair}</option>)}</select><p>{analysis.name}</p></div><div className="rate-block"><span className="muted">現在レート <span className="mini-label">{quote?.stale ? "STALE" : "TWELVE DATA"}</span></span><div className="rate-value">{quote?.data != null ? quote.data.toFixed(analysis.decimals) : "—"}<small>{analysis.quoteCurrency}</small></div><p className="footnote" role="status">{market?.error || quote?.error || (market ? "60秒キャッシュ · 前日比は未取得" : "取得中…")}</p>{quote?.stale && <p className="negative footnote">更新失敗・最終取得値を表示</p>}<p className="footnote">取得: {quote?.fetchedAt ? new Date(quote.fetchedAt).toLocaleString("ja-JP") : "—"}</p></div><div className="snapshot"><span className="eyebrow">MARKET DATA</span><p>表示中の通貨を自動更新</p><span className="muted">レート60秒 / OHLC 5分キャッシュ</span></div></section>
      <NextEventBanner resource={fundamentals?.data?.calendar} />
      <nav className="journal-nav" aria-label="ダッシュボード表示">{([["analysis", "分析"], ["chart", "チャート読取"], ["trades", "トレード"], ["performance", "成績"]] as const).map(([key, label]) => <button key={key} aria-current={view === key ? "page" : undefined} onClick={() => setView(key)}>{label}</button>)}</nav>
      <div hidden={view !== "analysis"}><div className="dashboard-grid decision-layout" aria-live="polite" aria-atomic="false"><AIOverview response={aiResponse} pair={selectedPair} pendingChart={pendingChart} chartActive={!!activeChart} onExcludeChart={excludeChart} onRefresh={refreshAnalysis} refreshing={aiRefreshing} currentRate={liveRate} rateDecimals={analysis.decimals} />{auth.user ? <CloudSettings key={userId} userId={userId} analysis={aiResponse?.data ?? null} pair={selectedPair} currentRate={liveRate} onBalanceChange={onBalanceChange} /> : <LoginRequired settings />}<TechnicalPanel data={market?.data ?? null} error={market?.error ?? null} /><FundamentalPanel symbol={selectedPair} result={fundamentals} /><AIExplanation response={aiResponse} /></div></div>
      <div hidden={view !== "chart"}><ChartAnalysisPanel pair={selectedPair} onPairChange={changePair} includedChart={pendingChart} onIncludeChart={includeChart} onExcludeChart={clearCharts} /></div>
      {auth.user ? <TradeJournal key={userId} userId={userId} view={view === "chart" ? "analysis" : view} pair={selectedPair} quote={quote?.data != null && quote.fetchedAt ? { pair: selectedPair, price: quote.data, fetchedAt: quote.fetchedAt, stale: !!quote.stale || !!quote.error } : null} analysis={aiResponse?.data ?? null} initialBalance={journalBalance.userId === userId ? journalBalance.value : NaN} /> : view !== "analysis" && view !== "chart" && <LoginRequired />}
      <footer className="page-footer"><span>AI FX Analyst</span><p>分析は条件付きの参考情報です。WAITも正常な判断です。</p><span>PROTOTYPE / TASK 012</span></footer>
    </main>
  </>;
}
