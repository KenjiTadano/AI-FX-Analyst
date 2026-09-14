"use client";
import { useMemo } from "react";
import { analyzeAiEntryContext } from "@/lib/trades/ai-entry-context";
import { MIN_INSIGHT_SAMPLE_SIZE } from "@/lib/trades/insights";
import type { Trade } from "@/lib/trades/types";
import { Panel } from "../dashboard/panels";
import { money, tone } from "./format";

export function AiEntryContextPanel({ trades, periodLabel }: { trades: Trade[]; periodLabel: string }) {
  const analysis = useMemo(() => analyzeAiEntryContext(trades), [trades]);

  let body: React.ReactNode;
  if (analysis.eligibleClosedCount === 0 && analysis.unavailableClosedCount === 0) {
    body = <p className="material-empty" role="status">この期間にはAI方向とEntry位置を比較できる取引がありません。</p>;
  } else if (analysis.eligibleClosedCount === 0) {
    body = <p className="material-empty" role="status">比較可能なAI分析スナップショットがまだありません。</p>;
  } else {
    body = (
      <>
        <p className="footnote">
          比較可能 {analysis.eligibleClosedCount}件
          {analysis.unavailableClosedCount > 0 ? ` · 比較対象外 ${analysis.unavailableClosedCount}件` : ""}
        </p>
        <div className="performance-cards ai-entry-context-cards" aria-label="AI方向×Entry位置">
          {analysis.groups.map(group => (
            <article key={group.context}>
              <h3>{group.label}</h3>
              <strong className={tone(group.totalPnl)}>{money(group.totalPnl, true)}</strong>
              <p>{group.count}取引 · 勝率 {group.winRate === null ? "—" : `${group.winRate.toFixed(1)}%`}</p>
              <p className="footnote">平均 {group.averagePnl === null ? "—" : money(group.averagePnl, true)}</p>
              {group.count === 0
                ? <small className="muted">データなし</small>
                : group.referenceOnly && <small className="neutral">参考データ（件数不足）</small>}
            </article>
          ))}
        </div>
      </>
    );
  }

  return (
    <Panel title="AI方向とEntry位置" eyebrow="AI ENTRY CONTEXT" className="journal-wide ai-entry-context-panel">
      <p className="footnote">対象期間：{periodLabel}。AI分析時点の方向と、実際にEntryした価格までの値動きを比較しています。</p>
      <p className="footnote">
        Task015の「Trade方向に対する値動き」とは別指標です。こちらは AI directionSignal 基準です。
        Action（BUY/SELL/WAIT）とは別に方向だけを見ます。傾向判定の目安は決済済み {MIN_INSIGHT_SAMPLE_SIZE} 件以上です。
      </p>
      <p className="footnote">この比較は過去の取引結果の振り返りであり、将来の勝率や利益を予測するものではありません。</p>
      {body}
    </Panel>
  );
}
