"use client";

import { useState } from "react";
import Link from "next/link";
import type { Account, FxAnalysis } from "@/types/analysis";
import { CapitalPanel, CommentaryPanel, ReasonsPanel, SignalPanel, TradePanel } from "./panels";

export function Dashboard({ analyses, account }: { analyses: FxAnalysis[]; account: Account }) {
  const [selectedPair, setSelectedPair] = useState("USD/JPY");
  const analysis = analyses.find(item => item.pair === selectedPair) ?? analyses[0];
  if (!analysis) return <main className="dashboard-shell"><p>分析データがありません。</p></main>;
  return <>
    <header className="app-header"><div className="header-inner"><Link className="brand" href="/" aria-label="AI FX Analyst ホーム"><span className="brand-icon" aria-hidden="true">↗</span><span>AI FX <span className="brand-light">Analyst</span></span></Link><span className="demo-badge"><span />DEMO MODE</span></div></header>
    <main className="dashboard-shell" id="main-content">
      <div className="page-heading"><div><p className="eyebrow">YOUR MARKET, AT A GLANCE</p><h1>マーケットの今を、ひと目で。</h1><p className="muted">相場の方向性とリスクを、一つのダッシュボードに。</p></div><span className="workspace-label">FX ANALYSIS / 01</span></div>
      <div className="demo-notice"><span className="notice-icon" aria-hidden="true">i</span><p><strong>モックデータを表示しています</strong><span>レート・ニュース・判定はすべて架空のサンプルです。</span></p></div>
      <section className="market-panel" aria-label="通貨ペアと現在レート"><div className="pair-control"><label htmlFor="currency-pair">通貨ペア</label><select id="currency-pair" value={analysis.pair} onChange={event => setSelectedPair(event.target.value)}>{analyses.map(item => <option key={item.pair} value={item.pair}>{item.pair}</option>)}</select><p>{analysis.name}</p></div><div className="rate-block"><span className="muted">現在レート <span className="mini-label">MOCK</span></span><div className="rate-value">{analysis.rate.toFixed(analysis.decimals)}<small>{analysis.quoteCurrency}</small></div><p className={analysis.changePercent < 0 ? "negative" : analysis.changePercent > 0 ? "positive" : "neutral"}>{analysis.changePercent > 0 ? "+" : ""}{analysis.changePercent.toFixed(2)}% <span className="muted">前日比</span></p></div><div className="snapshot"><span className="eyebrow">SNAPSHOT</span><p>{analysis.asOf}</p><span className="muted">固定サンプル · 自動更新なし</span></div></section>
      <div className="dashboard-grid" aria-live="polite" aria-atomic="false"><SignalPanel analysis={analysis} /><TradePanel analysis={analysis} /><CapitalPanel analysis={analysis} account={account} /><ReasonsPanel analysis={analysis} /><CommentaryPanel analysis={analysis} /></div>
      <footer className="page-footer"><span>AI FX Analyst</span><p>表示はUI確認用のサンプルです。実際の投資判断には使用しないでください。</p><span>PROTOTYPE / TASK 002</span></footer>
    </main>
  </>;
}
