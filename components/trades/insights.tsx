"use client";
import { useMemo } from "react";
import {
  MAX_SUMMARY_CARDS,
  MIN_INSIGHT_SAMPLE_SIZE,
  generateTradingInsights,
  type InsightSummaryCard,
  type TradingInsight,
} from "@/lib/trades/insights";
import type { Trade } from "@/lib/trades/types";
import { Panel } from "../dashboard/panels";
import { money, tone } from "./format";

function cardClass(label: InsightSummaryCard["label"] | TradingInsight["label"]): string {
  if (label === "良い傾向") return "insight-good";
  if (label === "注意") return "insight-caution";
  if (label === "データ不足") return "insight-insufficient";
  return "insight-neutral";
}

export function TradingReviewInsights({ trades }: { trades: Trade[] }) {
  const review = useMemo(() => generateTradingInsights(trades), [trades]);

  return (
    <Panel title="トレード振り返り" eyebrow="TRADING REVIEW INSIGHTS" className="journal-wide insights-panel">
      <p className="footnote">過去の取引結果に基づく参考情報です。次の取引で利益が出ることや、特定の方法で勝てることを示すものではありません。</p>
      <p className="footnote">AI Confidenceは分析判断の確信度であり、勝率を保証する値ではありません。傾向判定の目安は決済済み {MIN_INSIGHT_SAMPLE_SIZE} 件以上です。</p>

      {review.empty ? (
        <p className="material-empty" role="status">
          トレードデータを蓄積すると、AI判断との一致やWAIT中エントリーなどの傾向を確認できます。
        </p>
      ) : (
        <>
          {review.summaryCards.length > 0 && (
            <div className="insight-summary-cards" aria-label="振り返りサマリー">
              {review.summaryCards.slice(0, MAX_SUMMARY_CARDS).map(card => (
                <article key={card.id} className={`insight-summary-card ${cardClass(card.label)}`}>
                  <div className="row">
                    <h3>{card.title}</h3>
                    <span className="badge">{card.label}</span>
                  </div>
                  <strong className={tone(card.totalPnl)}>{money(card.totalPnl, true)}</strong>
                  <p>{card.sampleSize}件 · 勝率 {card.winRate === null ? "—" : `${card.winRate.toFixed(1)}%`}</p>
                  {card.referenceOnly && <small className="neutral">参考データ（件数不足）</small>}
                </article>
              ))}
            </div>
          )}

          <section className="insight-list" aria-label="振り返りインサイト">
            <h3 className="insight-list-heading">最近の傾向</h3>
            <div className="insight-cards">
              {review.insights.map(insight => (
                <article key={insight.id} className={`insight-card ${cardClass(insight.label)}`}>
                  <div className="row">
                    <h3>{insight.title}</h3>
                    <span className="badge">{insight.label}</span>
                  </div>
                  <p className="insight-metrics">
                    {insight.sampleSize}件
                    {insight.metrics.winRate !== null ? ` / 勝率${insight.metrics.winRate.toFixed(1)}%` : ""}
                    {` / ${money(insight.metrics.totalPnl, true)}`}
                    {insight.metrics.averagePips != null ? ` · 平均 ${insight.metrics.averagePips.toFixed(1)} pips` : ""}
                  </p>
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
        </>
      )}
    </Panel>
  );
}
