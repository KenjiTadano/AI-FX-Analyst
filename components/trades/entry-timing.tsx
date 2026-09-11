"use client";
import { useMemo } from "react";
import { analyzeEntryTiming, type EntryTimingInsight } from "@/lib/trades/entry-timing";
import { MIN_INSIGHT_SAMPLE_SIZE } from "@/lib/trades/insights";
import type { Trade } from "@/lib/trades/types";
import { Panel } from "../dashboard/panels";
import { money, tone } from "./format";

function labelClass(label: EntryTimingInsight["label"]): string {
  if (label === "良い傾向") return "insight-good";
  if (label === "注意") return "insight-caution";
  if (label === "データ不足") return "insight-insufficient";
  return "insight-neutral";
}

export function EntryTimingPanel({ trades, periodLabel }: { trades: Trade[]; periodLabel: string }) {
  const timing = useMemo(() => analyzeEntryTiming(trades), [trades]);

  return (
    <Panel title="分析時点からEntryまで" eyebrow="ENTRY TIMING" className="journal-wide entry-timing-panel">
      <p className="footnote">対象期間：{periodLabel}。分析時点からEntryまでの価格差は、エントリーの良し悪しを直接判定するものではありません。</p>
      <p className="footnote">Trade side基準の値動きです。AI directionとの一致比較ではありません。傾向判定の目安は決済済み {MIN_INSIGHT_SAMPLE_SIZE} 件以上です。</p>

      {timing.empty ? (
        <p className="material-empty" role="status">この期間には、分析時点価格があるEntryタイミング記録がありません。</p>
      ) : (
        <>
          <p className="footnote">
            対象 {timing.eligibleClosedCount}件
            {timing.averageAbsolutePips !== null ? ` · 平均距離 ${timing.averageAbsolutePips.toFixed(1)} pips` : ""}
          </p>
          <div className="performance-cards entry-timing-bands" aria-label="Entry距離帯別">
            {timing.bands.map(band => (
              <article key={band.band}>
                <h3>{band.band} pips</h3>
                <strong className={tone(band.totalPnl)}>{money(band.totalPnl, true)}</strong>
                <p>{band.count}取引 · 勝率 {band.winRate === null ? "—" : `${band.winRate.toFixed(1)}%`}</p>
                <p className="footnote">平均 {band.averagePnl === null ? "—" : money(band.averagePnl, true)}</p>
                {band.count === 0 ? <small className="muted">データなし</small> : band.referenceOnly && <small className="neutral">参考データ（件数不足）</small>}
              </article>
            ))}
          </div>

          <div className="performance-cards entry-timing-direction" aria-label="方向別Entry">
            <article>
              <h3>分析方向に進んだ後のEntry</h3>
              <strong className={tone(timing.withDirection.totalPnl)}>{money(timing.withDirection.totalPnl, true)}</strong>
              <p>{timing.withDirection.count}取引 · 勝率 {timing.withDirection.winRate === null ? "—" : `${timing.withDirection.winRate.toFixed(1)}%`}</p>
              <small className="neutral">directionalEntryMovePips &gt; 0（Trade side基準）</small>
            </article>
            <article>
              <h3>分析方向と逆に動いた後のEntry</h3>
              <strong className={tone(timing.againstDirection.totalPnl)}>{money(timing.againstDirection.totalPnl, true)}</strong>
              <p>{timing.againstDirection.count}取引 · 勝率 {timing.againstDirection.winRate === null ? "—" : `${timing.againstDirection.winRate.toFixed(1)}%`}</p>
              <small className="neutral">directionalEntryMovePips ≤ 0（Trade side基準）</small>
            </article>
          </div>

          {timing.insights.length > 0 && (
            <section className="insight-list" aria-label="Entry Timingインサイト">
              <div className="insight-cards">
                {timing.insights.map(insight => (
                  <article key={insight.id} className={`insight-card ${labelClass(insight.label)}`}>
                    <div className="row">
                      <h3>{insight.title}</h3>
                      <span className="badge">{insight.label}</span>
                    </div>
                    <p className="insight-description">{insight.description}</p>
                    {insight.suggestion && (
                      <p className="insight-suggestion">
                        <span className="badge">次回確認ポイント</span>
                        {insight.suggestion}
                      </p>
                    )}
                  </article>
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </Panel>
  );
}
