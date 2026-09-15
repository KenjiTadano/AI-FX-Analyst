"use client";
import { useMemo } from "react";
import { MIN_INSIGHT_SAMPLE_SIZE } from "@/lib/trades/insights";
import {
  PRE_TRADE_PERFORMANCE_COVERAGE_LABEL,
  PRE_TRADE_PERFORMANCE_DISCLAIMER,
  PRE_TRADE_PERFORMANCE_EMPTY,
  PRE_TRADE_PERFORMANCE_EYEBROW,
  PRE_TRADE_PERFORMANCE_NO_CONTEXT,
  PRE_TRADE_PERFORMANCE_SAMPLE_NOTE,
  PRE_TRADE_PERFORMANCE_TITLE,
  PRE_TRADE_PERFORMANCE_WINRATE_NOTE,
  buildPreTradeContextPerformance,
  formatContextProfitFactor,
  type ContextPerformanceGroup,
} from "@/lib/trades/pre-trade-performance";
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
  groups: ContextPerformanceGroup[];
  testId: string;
}) {
  if (!groups.length) return null;
  return (
    <section className="pretrade-perf-section" aria-labelledby={headingId} data-testid={testId}>
      <h3 id={headingId}>{title}</h3>
      <div className="performance-cards pretrade-perf-cards">
        {groups.map(group => (
          <article key={group.key} data-testid={`${testId}-${group.key}`}>
            <h3>{group.label}</h3>
            <strong className={tone(group.totalPnl)}>{money(group.totalPnl, true)}</strong>
            <p>{group.sampleSize}件 · 勝率 {group.winRate === null ? "—" : `${group.winRate.toFixed(1)}%`}</p>
            <p className="footnote">平均 {group.averagePnl === null ? "—" : money(group.averagePnl, true)} · PF {formatContextProfitFactor(group.profitFactor)}</p>
            {group.sufficientSample
              ? <small>過去の取引結果</small>
              : <small className="neutral">参考値</small>}
          </article>
        ))}
      </div>
    </section>
  );
}

export function PreTradeContextPerformancePanel({ trades, periodLabel }: { trades: Trade[]; periodLabel: string }) {
  const analysis = useMemo(() => buildPreTradeContextPerformance(trades, periodLabel), [trades, periodLabel]);

  let body: React.ReactNode;
  if (analysis.eligibleClosedTrades === 0) {
    body = <p className="material-empty" role="status" data-testid="pretrade-performance-empty">{PRE_TRADE_PERFORMANCE_EMPTY}</p>;
  } else if (analysis.contextTrades === 0) {
    body = <p className="material-empty" role="status" data-testid="pretrade-performance-no-context">{PRE_TRADE_PERFORMANCE_NO_CONTEXT}</p>;
  } else {
    body = (
      <>
        <div className="pretrade-perf-coverage" data-testid="pretrade-performance-coverage">
          <p>分析対象 CLOSED trades {analysis.eligibleClosedTrades}</p>
          <p>Pre-Trade Contextあり {analysis.contextTrades}</p>
          <p>Contextなし {analysis.missingContextTrades}</p>
          <p>{PRE_TRADE_PERFORMANCE_COVERAGE_LABEL} {analysis.coverageRate === null ? "—" : `${analysis.coverageRate.toFixed(1)}%`}</p>
        </div>
        <GroupCards title="エントリー時Trigger" headingId="pretrade-perf-trigger" groups={analysis.triggerGroups} testId="pretrade-performance-trigger" />
        <GroupCards title="エントリー時Action" headingId="pretrade-perf-action" groups={analysis.actionGroups} testId="pretrade-performance-action" />
        <GroupCards title="分析の鮮度" headingId="pretrade-perf-freshness" groups={analysis.freshnessGroups} testId="pretrade-performance-freshness" />
        <GroupCards title="Event Risk" headingId="pretrade-perf-event" groups={analysis.eventRiskGroups} testId="pretrade-performance-event" />
        <GroupCards title="Daily Loss Limit" headingId="pretrade-perf-dll" groups={analysis.dailyLossLimitGroups} testId="pretrade-performance-dll" />
        {analysis.comparisons.length > 0 && (
          <ul className="pretrade-perf-comparisons" data-testid="pretrade-performance-comparisons">
            {analysis.comparisons.map(item => <li key={item.id}>{item.text}</li>)}
          </ul>
        )}
      </>
    );
  }

  return (
    <Panel title={PRE_TRADE_PERFORMANCE_TITLE} eyebrow={PRE_TRADE_PERFORMANCE_EYEBROW} className="journal-wide pretrade-perf-panel" testId="pretrade-performance">
      <p className="footnote" data-testid="pretrade-performance-period">対象期間：{periodLabel}</p>
      <p className="footnote">{PRE_TRADE_PERFORMANCE_DISCLAIMER}</p>
      <p className="footnote">{PRE_TRADE_PERFORMANCE_WINRATE_NOTE} 傾向判定の目安は決済済み {MIN_INSIGHT_SAMPLE_SIZE} 件以上です。{PRE_TRADE_PERFORMANCE_SAMPLE_NOTE}</p>
      {body}
    </Panel>
  );
}
