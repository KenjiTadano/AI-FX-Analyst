"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { TechnicalPanel, useMarket } from "./market";
import { NextEventBanner } from "./economic-calendar";
import { FundamentalPanel, useFundamentals } from "./fundamental";
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
  const [view, setView] = useState<"analysis" | "trades" | "performance">("analysis");
  const [journalBalance, setJournalBalance] = useState({ userId: "", value: account.balance });
  const onBalanceChange = useCallback((value: number) => setJournalBalance({ userId, value }), [userId]);
  const market = useMarket(selectedPair);
  const fundamentals = useFundamentals(selectedPair);
  const ai = useAIAnalysis(selectedPair);
  const quote = market?.data?.price;
  const analysis = analyses.find(item => item.pair === selectedPair) ?? analyses[0];
  if (!analysis) return <main className="dashboard-shell"><p>分析データがありません。</p></main>;
  return <>
    <header className="app-header"><div className="header-inner"><Link className="brand" href="/" aria-label="AI FX Analyst ホーム"><span className="brand-icon" aria-hidden="true">↗</span><span>AI FX <span className="brand-light">Analyst</span></span></Link><span className="demo-badge"><span />MVP / TASK 009</span></div></header>
    <main className="dashboard-shell" id="main-content">
      <div className="page-heading"><div><p className="eyebrow">YOUR MARKET, AT A GLANCE</p><h1>マーケットの今を、ひと目で。</h1><p className="muted">相場の方向性とリスクを、一つのダッシュボードに。</p></div><span className="workspace-label">FX ANALYSIS / 01</span></div>
      <div className="demo-notice"><span className="notice-icon" aria-hidden="true">i</span><p><strong>レート・テクニカルはTwelve Data</strong><span>AI総合判定は取得済みデータから分析。AI未取得・データ不足時は待機します。資金と許容リスクは画面で設定できます。無料枠は1日800クレジットのため、常時更新には上限があります。</span></p></div>
      <AuthStatus />
      <section className="market-panel" aria-label="通貨ペアと現在レート"><div className="pair-control"><label htmlFor="currency-pair">通貨ペア</label><select id="currency-pair" value={analysis.pair} onChange={event => setSelectedPair(event.target.value)}>{analyses.map(item => <option key={item.pair} value={item.pair}>{item.pair}</option>)}</select><p>{analysis.name}</p></div><div className="rate-block"><span className="muted">現在レート <span className="mini-label">{quote?.stale ? "STALE" : "TWELVE DATA"}</span></span><div className="rate-value">{quote?.data != null ? quote.data.toFixed(analysis.decimals) : "—"}<small>{analysis.quoteCurrency}</small></div><p className="footnote" role="status">{market?.error || quote?.error || (market ? "60秒キャッシュ · 前日比は未取得" : "取得中…")}</p>{quote?.stale && <p className="negative footnote">更新失敗・最終取得値を表示</p>}<p className="footnote">取得: {quote?.fetchedAt ? new Date(quote.fetchedAt).toLocaleString("ja-JP") : "—"}</p></div><div className="snapshot"><span className="eyebrow">MARKET DATA</span><p>表示中の通貨を自動更新</p><span className="muted">レート60秒 / OHLC 5分キャッシュ</span></div></section>
      <NextEventBanner resource={fundamentals?.data?.calendar} />
      <nav className="journal-nav" aria-label="ダッシュボード表示">{([["analysis", "分析"], ["trades", "トレード"], ["performance", "成績"]] as const).map(([key, label]) => <button key={key} aria-current={view === key ? "page" : undefined} onClick={() => setView(key)}>{label}</button>)}</nav>
      <div hidden={view !== "analysis"}><div className="dashboard-grid" aria-live="polite" aria-atomic="false"><AIOverview response={ai} pair={selectedPair} />{auth.user ? <CloudSettings key={userId} userId={userId} analysis={ai?.data ?? null} pair={selectedPair} currentRate={quote?.stale || quote?.error ? null : quote?.data ?? null} onBalanceChange={onBalanceChange} /> : <LoginRequired settings />}<TechnicalPanel data={market?.data ?? null} error={market?.error ?? null} /><FundamentalPanel symbol={selectedPair} result={fundamentals} /><AIExplanation response={ai} /></div></div>
      {auth.user ? <TradeJournal key={userId} userId={userId} view={view} pair={selectedPair} quote={quote?.data != null && quote.fetchedAt ? { pair: selectedPair, price: quote.data, fetchedAt: quote.fetchedAt, stale: !!quote.stale || !!quote.error } : null} analysis={ai?.data ?? null} initialBalance={journalBalance.userId === userId ? journalBalance.value : NaN} /> : view !== "analysis" && <LoginRequired />}
      <footer className="page-footer"><span>AI FX Analyst</span><p>分析は条件付きの参考情報です。WAITも正常な判断です。</p><span>PROTOTYPE / TASK 009</span></footer>
    </main>
  </>;
}
