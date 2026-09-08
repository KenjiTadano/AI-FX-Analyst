"use client";

import { useState } from "react";
import Link from "next/link";
import { TechnicalPanel, useMarket } from "./market";
import { FundamentalPanel } from "./fundamental";
import type { Account, FxAnalysis } from "@/types/analysis";
import { CapitalPanel, CommentaryPanel, ReasonsPanel, SignalPanel, TradePanel } from "./panels";

export function Dashboard({ analyses, account }: { analyses: FxAnalysis[]; account: Account }) {
  const [selectedPair, setSelectedPair] = useState("USD/JPY");
  const market = useMarket(selectedPair);
  const quote = market?.data?.price;
  const analysis = analyses.find(item => item.pair === selectedPair) ?? analyses[0];
  if (!analysis) return <main className="dashboard-shell"><p>分析データがありません。</p></main>;
  return <>
    <header className="app-header"><div className="header-inner"><Link className="brand" href="/" aria-label="AI FX Analyst ホーム"><span className="brand-icon" aria-hidden="true">↗</span><span>AI FX <span className="brand-light">Analyst</span></span></Link><span className="demo-badge"><span />MVP / TASK 004</span></div></header>
    <main className="dashboard-shell" id="main-content">
      <div className="page-heading"><div><p className="eyebrow">YOUR MARKET, AT A GLANCE</p><h1>マーケットの今を、ひと目で。</h1><p className="muted">相場の方向性とリスクを、一つのダッシュボードに。</p></div><span className="workspace-label">FX ANALYSIS / 01</span></div>
      <div className="demo-notice"><span className="notice-icon" aria-hidden="true">i</span><p><strong>レート・テクニカルはTwelve Data</strong><span>マーケット材料は取得状況を個別に表示。AI判定・推奨トレード・資金管理・判断理由はモックです。無料枠は1日800クレジットのため、常時更新には上限があります。</span></p></div>
      <section className="market-panel" aria-label="通貨ペアと現在レート"><div className="pair-control"><label htmlFor="currency-pair">通貨ペア</label><select id="currency-pair" value={analysis.pair} onChange={event => setSelectedPair(event.target.value)}>{analyses.map(item => <option key={item.pair} value={item.pair}>{item.pair}</option>)}</select><p>{analysis.name}</p></div><div className="rate-block"><span className="muted">現在レート <span className="mini-label">{quote?.stale ? "STALE" : "TWELVE DATA"}</span></span><div className="rate-value">{quote?.data != null ? quote.data.toFixed(analysis.decimals) : "—"}<small>{analysis.quoteCurrency}</small></div><p className="footnote" role="status">{market?.error || quote?.error || (market ? "60秒キャッシュ · 前日比は未取得" : "取得中…")}</p>{quote?.stale && <p className="negative footnote">更新失敗・最終取得値を表示</p>}<p className="footnote">取得: {quote?.fetchedAt ? new Date(quote.fetchedAt).toLocaleString("ja-JP") : "—"}</p></div><div className="snapshot"><span className="eyebrow">MARKET DATA</span><p>表示中の通貨を自動更新</p><span className="muted">レート60秒 / OHLC 5分キャッシュ</span></div></section>
      <div className="dashboard-grid" aria-live="polite" aria-atomic="false"><SignalPanel analysis={analysis} /><TradePanel analysis={analysis} /><CapitalPanel analysis={analysis} account={account} /><TechnicalPanel data={market?.data ?? null} error={market?.error ?? null} /><FundamentalPanel symbol={selectedPair} /><ReasonsPanel analysis={analysis} /><CommentaryPanel analysis={analysis} /></div>
      <footer className="page-footer"><span>AI FX Analyst</span><p>AI判定・推奨トレードはサンプルです。実際の投資判断には使用しないでください。</p><span>PROTOTYPE / TASK 004</span></footer>
    </main>
  </>;
}
