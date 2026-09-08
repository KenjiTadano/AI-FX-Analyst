import type { ReactNode } from "react";
import { calculateRisk, signalLabels, signalTone, yen } from "@/lib/analysis";
import { signals, type Account, type FxAnalysis } from "@/types/analysis";

export function Panel({ title, eyebrow, children, className = "" }: { title: string; eyebrow: string; children: ReactNode; className?: string }) {
  return <section className={`panel ${className}`}><div className="section-heading"><span className="eyebrow">{eyebrow}</span><h2>{title}</h2></div>{children}</section>;
}

export function SignalPanel({ analysis }: { analysis: FxAnalysis }) {
  return <Panel title="AI総合判定" eyebrow="AI SIGNAL" className="signal-panel">
    <div className="signal-result"><div><span className={`signal-word ${signalTone(analysis.signal)}`}>{signalLabels[analysis.signal]}</span><p className="muted">{analysis.pair} の分析シナリオ</p></div><div className="score"><strong>{analysis.score}</strong><span> / 100</span><small>判定スコア</small></div></div>
    <ol className="signal-scale" aria-label="5段階の総合判定">{signals.map(signal => <li key={signal} className={signal === analysis.signal ? `selected ${signalTone(signal)}` : ""} aria-current={signal === analysis.signal ? "step" : undefined}>{signalLabels[signal]}</li>)}</ol>
    <p className="footnote">スコアはモックの評価値です。勝率を示すものではありません。</p>
  </Panel>;
}

export function TradePanel({ analysis }: { analysis: FxAnalysis }) {
  const trade = analysis.trade;
  const price = (value: number) => value.toFixed(analysis.decimals);
  return <Panel title="推奨トレード" eyebrow="TRADE PLAN">
    <div className="row trade-direction"><span className="muted">方向</span><span className={`badge ${trade ? signalTone(trade.direction) : "neutral"}`}>{trade ? trade.direction === "sell" ? "↘ 売り / SHORT" : "↗ 買い / LONG" : "待機 / NO TRADE"}</span></div>
    <dl className="metrics">{([
      ["エントリー", trade?.entry, ""], ["損切り", trade?.stopLoss, "negative"], ["利益確定 1", trade?.takeProfit1, "positive"], ["利益確定 2", trade?.takeProfit2, "positive"],
    ] as const).map(([label, value, tone]) => <div key={label}><dt>{label}</dt><dd className={tone}>{value === undefined ? "—" : price(value)}{value !== undefined && <small> {analysis.quoteCurrency}</small>}</dd></div>)}</dl>
    <p className="footnote">{trade ? "モックの価格プラン · 注文は実行されません" : "方向性が定まるまで新規エントリーを見送る想定です。"}</p>
  </Panel>;
}

export function CapitalPanel({ analysis, account }: { analysis: FxAnalysis; account: Account }) {
  const risk = calculateRisk(analysis, account);
  const progress = Math.min(100, Math.max(0, account.balance / account.target * 100));
  return <Panel title="資金管理" eyebrow="RISK MANAGEMENT">
    <div className="capital-summary"><div><span className="muted">現在資金</span><strong>{yen(account.balance)}</strong></div><div className="target"><span className="muted">目標資金</span><strong>{yen(account.target)}</strong></div></div>
    <progress className="capital-progress" value={progress} max={100} aria-label="目標資金に対する現在資金" />
    <div className="progress-caption"><span>目標達成率</span><span>{progress.toFixed(0)}%</span></div>
    <dl className="metrics"><div><dt>推奨数量</dt><dd>{(analysis.trade?.units ?? 0).toLocaleString("ja-JP")}<small> 通貨</small></dd></div><div><dt>想定損失</dt><dd className="negative">{yen(risk.loss)}</dd></div><div><dt>リスク率</dt><dd>{risk.percent.toFixed(1)}<small>% / 現在資金</small></dd></div></dl>
    <p className="footnote">想定損失はエントリーと損切りの差額から算出。手数料・スリッページは含みません。</p>
  </Panel>;
}

export function ReasonsPanel({ analysis }: { analysis: FxAnalysis }) {
  return <Panel title="判断理由" eyebrow="ANALYSIS BREAKDOWN" className="reasons-panel"><div className="reasons-grid">{analysis.reasons.map((reason, index) => <article className="reason" key={reason.category}><div className="row"><h3><span className="reason-number">0{index + 1}</span>{reason.category}</h3><span className={`badge ${reason.tone}`}>{reason.assessment}</span></div><h4>{reason.summary}</h4><p>{reason.detail}</p></article>)}</div></Panel>;
}

export function CommentaryPanel({ analysis }: { analysis: FxAnalysis }) {
  return <Panel title="AI分析コメント" eyebrow="ANALYST NOTE" className="commentary-panel"><p className="analysis-comment">{analysis.comment}</p><div className="note-footer"><span className="note-mark">✦</span><span>サンプル分析 · AIによる実際の生成結果ではありません</span></div></Panel>;
}
