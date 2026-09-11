"use client";
import { useState } from "react";
import { alignmentPerformance, chartEvidencePerformance, confidenceBandPerformance, dailyPnl, dayKey, equityCurve, monthCells, pairPerformance, signalPerformance, summarize } from "@/lib/trades/analytics";
import { alignmentLabels } from "@/lib/trades/snapshot";
import type { Trade } from "@/lib/trades/types";
import { Panel } from "../dashboard/panels";
import { TradingReviewInsights } from "./insights";
import { TradeList } from "./trade-list";
import { money, signalLabels, tone } from "./format";
export function Performance({ trades, initialBalance }: { trades: Trade[]; initialBalance: number }) {
  const [month, setMonth] = useState(() => dayKey(new Date().toISOString()).slice(0, 7));
  const [day, setDay] = useState<string | null>(null);
  const stats = summarize(trades), days = dailyPnl(trades), curve = equityCurve(trades, initialBalance);
  const values = curve.map(p => p.balance), min = Math.min(...values), max = Math.max(...values);
  const plot = curve.map((p, i) => `${24 + i / Math.max(1, curve.length - 1) * 592},${150 - (p.balance - min) / (max - min || 1) * 120}`).join(" ");
  const latest = curve.at(-1)?.balance ?? null;
  function moveMonth(offset: number) { const d = new Date(`${month}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + offset); setMonth(d.toISOString().slice(0, 7)); setDay(null); }
  return <div className="performance-grid">
    <TradingReviewInsights trades={trades} />
    <Panel title="損益サマリー" eyebrow="REALIZED RESULTS" className="journal-wide">
      <div className="journal-stats">{([
        ["総損益", money(stats.totalPnl, true)], ["総取引数（決済済み）", `${stats.count}件`], ["勝ち / 負け / 引分", `${stats.wins} / ${stats.losses} / ${stats.draws}`], ["勝率", stats.winRate === null ? "—" : `${stats.winRate.toFixed(1)}%`], ["平均利益", money(stats.averageProfit)], ["平均損失", money(stats.averageLoss)], ["Profit Factor", stats.profitFactor === null ? stats.noLosses ? "損失なし" : "—" : stats.profitFactor.toFixed(2)], ["最大利益", money(stats.maxProfit)], ["最大損失", money(stats.maxLoss)], ["平均予定RR", stats.averageRiskReward === null ? "未算出" : `1 : ${stats.averageRiskReward.toFixed(2)}`],
      ] as const).map(([label, value]) => <div key={label}><span>{label}</span><strong data-testid={label === "総損益" ? "journal-total-pnl" : undefined}>{value}</strong></div>)}</div>
      <p className="footnote">勝率 = 勝ち数 ÷ 決済済み件数（引き分けを含む）。平均予定RRは登録されたEntry・損切り・利確から計算できる{stats.riskRewardSamples}件が対象です。手数料・スワップ等は未計上です。</p>
    </Panel>
    <Panel title="資産推移" eyebrow="REALIZED EQUITY" className="journal-wide">
      <p className="footnote">Task006の設定資産 {money(Number.isFinite(initialBalance) ? initialBalance : null)} を基準に、決済損益を日時順に加算した参考推移です。口座残高への自動反映はありません。設定資産はログイン中のクラウド設定を使用します。</p>
      <strong className="trade-pnl" data-testid="journal-equity">{money(latest)}</strong>
      {curve.length > 0 ? <><svg className="equity-chart" viewBox="0 0 640 180" role="img" aria-label={`基準資産から${curve.length - 1}決済後、${money(latest)}`}><line x1="24" y1="156" x2="616" y2="156" stroke="#405169" /><polyline points={plot} fill="none" stroke="#65d9bc" strokeWidth="3" />{curve.length === 1 && <circle cx="24" cy="150" r="4" fill="#65d9bc" />}</svg><div className="row footnote"><span>基準 {money(initialBalance)}</span><span>最小 {money(min)} / 最大 {money(max)}</span></div></> : <p className="footnote">有効な基準資産を設定してください。</p>}
    </Panel>
    <Panel title="損益カレンダー" eyebrow="MONTHLY P&L / JST" className="journal-wide">
      <div className="calendar-controls"><button disabled={month === "1000-01"} onClick={() => moveMonth(-1)}>前月</button><label>表示月<input type="month" min="1000-01" max="9999-12" value={month} onChange={e => { if (/^[1-9]\d{3}-(0[1-9]|1[0-2])$/.test(e.target.value)) { setMonth(e.target.value); setDay(null); } }} /></label><button disabled={month === "9999-12"} onClick={() => moveMonth(1)}>翌月</button></div>
      <p className="footnote">決済日の日本時間で合算。緑＝利益、赤＝損失、0円＝引き分け、—＝取引なし。日付を選ぶと内訳を表示します。</p>
      <div className="pnl-calendar">{["月", "火", "水", "木", "金", "土", "日"].map(d => <span className="calendar-weekday" key={d}>{d}</span>)}{monthCells(month).map((date, i) => date ? <button key={date} aria-label={`${date} ${days[date] ? money(days[date].pnl, true) : "取引なし"}`} aria-pressed={day === date} className={days[date] ? tone(days[date].pnl) : "muted"} onClick={() => setDay(date)}><span>{Number(date.slice(-2))}</span><small>{days[date] ? money(days[date].pnl, true) : "—"}</small></button> : <span key={`empty-${i}`} />)}</div>
      {day && <section className="day-trades"><h3>{day} の決済</h3><TradeList trades={days[day]?.trades ?? []} quote={null} now={0} /></section>}
    </Panel>
    <Panel title="AI判断との一致別" eyebrow="AI ALIGNMENT" className="journal-wide">
      <p className="footnote">登録時スナップショットと取引方向から計算します。現在のAI状態ではありません。WAIT中エントリーは特に重要です。</p>
      <div className="performance-cards">{alignmentPerformance(trades).map(group => <article key={group.alignment}><h3>{alignmentLabels[group.alignment]}</h3><strong className={tone(group.totalPnl)}>{money(group.totalPnl, true)}</strong><p>{group.count}取引 · 勝率 {group.winRate === null ? "—" : `${group.winRate.toFixed(1)}%`}</p>{group.count === 0 ? <small className="muted">データなし</small> : group.insufficientData && <small className="neutral">参考値（データ不足）</small>}</article>)}</div>
    </Panel>
    <Panel title="AI判断別成績" eyebrow="SIGNAL REVIEW" className="journal-wide">
      <p className="footnote">登録時snapshotのsignalを使用します。AIの推奨方向と異なる取引も含み、AI単独の予測精度ではありません。10件未満は「データ不足」。</p>
      <div className="performance-cards">{signalPerformance(trades).map(group => <article key={group.signal}><h3>{signalLabels[group.signal]}</h3><strong className={tone(group.totalPnl)}>{money(group.totalPnl, true)}</strong><p>{group.count}取引 · 勝率 {group.winRate === null ? "—" : `${group.winRate.toFixed(1)}%`}</p>{group.insufficientData && <small className="neutral">データ不足</small>}</article>)}</div>
    </Panel>
    <Panel title="Chart Evidence別" eyebrow="CHART USED" className="journal-wide">
      <div className="performance-cards">{chartEvidencePerformance(trades).map(group => <article key={group.key}><h3>{group.label}</h3><strong className={tone(group.totalPnl)}>{money(group.totalPnl, true)}</strong><p>{group.count}取引 · 勝率 {group.winRate === null ? "—" : `${group.winRate.toFixed(1)}%`}</p>{group.count === 0 ? <small className="muted">データなし</small> : group.insufficientData && <small className="neutral">参考値</small>}</article>)}</div>
    </Panel>
    <Panel title="確信度帯別（参考）" eyebrow="CONFIDENCE BANDS" className="journal-wide">
      <p className="footnote">サンプルが少ない場合は参考値です。</p>
      <div className="performance-cards">{confidenceBandPerformance(trades).map(group => <article key={group.band}><h3>{group.band}%</h3><strong className={tone(group.totalPnl)}>{money(group.totalPnl, true)}</strong><p>{group.count}取引 · 勝率 {group.winRate === null ? "—" : `${group.winRate.toFixed(1)}%`}</p>{group.referenceOnly && <small className="neutral">参考値</small>}</article>)}</div>
    </Panel>
    <Panel title="通貨ペア別成績" eyebrow="PAIR REVIEW" className="journal-wide"><div className="performance-cards">{pairPerformance(trades).map(group => <article key={group.pair}><h3>{group.pair}</h3><strong className={tone(group.totalPnl)}>{money(group.totalPnl, true)}</strong><p>{group.count}取引 · 勝率 {group.winRate === null ? "—" : `${group.winRate.toFixed(1)}%`}</p></article>)}</div></Panel>
  </div>;
}
