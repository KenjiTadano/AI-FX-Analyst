"use client";
import { useMemo } from "react";
import { MIN_INSIGHT_SAMPLE_SIZE } from "@/lib/trades/insights";
import {
  MTF_PERFORMANCE_COVERAGE_LABEL,
  MTF_PERFORMANCE_DISCLAIMER,
  MTF_PERFORMANCE_EMPTY,
  MTF_PERFORMANCE_EYEBROW,
  MTF_PERFORMANCE_SAMPLE_NOTE,
  MTF_PERFORMANCE_TITLE,
  MTF_PERFORMANCE_WINRATE_NOTE,
  buildMtfPerformanceAnalysis,
  formatContextProfitFactor,
  type PerformanceGroup,
} from "@/lib/trades/mtf-performance";
import type { Trade } from "@/lib/trades/types";
import { Panel } from "../dashboard/panels";
import { money, tone } from "./format";

function GroupCards({
  title,
  headingId,
  groups,
  testId,
}: {
  title: string;
  headingId: string;
  groups: PerformanceGroup[];
  testId: string;
}) {
  if (!groups.length) return null;
  return (
    <section className="mtf-perf-section" aria-labelledby={headingId} data-testid={testId}>
      <h3 id={headingId}>{title}</h3>
      <div className="performance-cards mtf-perf-cards">
        {groups.map(group => (
          <article key={group.key} data-testid={`${testId}-${group.key}`}>
            <h3>{group.label}</h3>
            <strong className={tone(group.totalPnl)}>{money(group.totalPnl, true)}</strong>
            <p>{group.sampleSize}件</p>
            <p>勝 {group.wins} / 負 {group.losses} / ±0 {group.breakEven}</p>
            <p>勝率 {group.winRate === null ? "—" : `${group.winRate.toFixed(1)}%`}</p>
            <p className="footnote">平均損益 {group.averagePnl === null ? "—" : money(group.averagePnl, true)} · PF {formatContextProfitFactor(group.profitFactor)}</p>
            {group.sufficientSample
              ? <small>過去の取引結果</small>
              : <small className="neutral">参考値</small>}
          </article>
        ))}
      </div>
    </section>
  );
}

export function MtfPerformancePanel({ trades, periodLabel }: { trades: Trade[]; periodLabel: string }) {
  const analysis = useMemo(() => buildMtfPerformanceAnalysis(trades, periodLabel), [trades, periodLabel]);
  const coverage = analysis.coverage;

  let body: React.ReactNode;
  if (coverage.eligibleTrades === 0 || coverage.withMtfContext === 0) {
    body = (
      <>
        {coverage.eligibleTrades > 0 && (
          <div className="mtf-perf-coverage" data-testid="mtf-performance-coverage">
            <p>MTF Snapshot Coverage</p>
            <p>{MTF_PERFORMANCE_COVERAGE_LABEL} {coverage.withMtfContext} / {coverage.eligibleTrades}</p>
            <p>{coverage.coverageRate === null ? "—" : `${coverage.coverageRate.toFixed(1)}%`}</p>
          </div>
        )}
        <p className="material-empty" role="status" data-testid="mtf-performance-empty">{MTF_PERFORMANCE_EMPTY}</p>
      </>
    );
  } else {
    body = (
      <>
        <div className="mtf-perf-coverage" data-testid="mtf-performance-coverage">
          <p>MTF Snapshot Coverage</p>
          <p>{MTF_PERFORMANCE_COVERAGE_LABEL} {coverage.withMtfContext} / {coverage.eligibleTrades}</p>
          <p>{coverage.coverageRate === null ? "—" : `${coverage.coverageRate.toFixed(1)}%`}</p>
        </div>
        <GroupCards title="MTF Alignment" headingId="mtf-perf-alignment" groups={analysis.byAlignment} testId="mtf-performance-alignment" />
        <GroupCards title="上位足バイアス" headingId="mtf-perf-htf" groups={analysis.byHigherTimeframeBias} testId="mtf-performance-htf" />
        <GroupCards title="AI方向との関係" headingId="mtf-perf-ai" groups={analysis.byAiDirectionContext} testId="mtf-performance-ai" />
        {analysis.comparisons.length > 0 && (
          <ul className="mtf-perf-comparisons" data-testid="mtf-performance-comparisons">
            {analysis.comparisons.map(item => <li key={item.id}>{item.text}</li>)}
          </ul>
        )}
      </>
    );
  }

  return (
    <Panel title={MTF_PERFORMANCE_TITLE} eyebrow={MTF_PERFORMANCE_EYEBROW} className="journal-wide mtf-perf-panel" testId="mtf-performance">
      <p className="footnote" data-testid="mtf-performance-period">対象期間：{periodLabel}</p>
      <p className="footnote" data-testid="mtf-performance-disclaimer">{MTF_PERFORMANCE_DISCLAIMER}</p>
      <p className="footnote">{MTF_PERFORMANCE_WINRATE_NOTE} 傾向判定の目安は決済済み {MIN_INSIGHT_SAMPLE_SIZE} 件以上です。{MTF_PERFORMANCE_SAMPLE_NOTE}</p>
      {body}
    </Panel>
  );
}
