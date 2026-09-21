"use client";
import { useMemo } from "react";
import { formatRealizedR } from "@/lib/trades/exit-plan";
import {
  MAX_PERFORMANCE_OBSERVATIONS,
  MIN_INSIGHT_SAMPLE_SIZE,
  PERFORMANCE_INTELLIGENCE_DISCLAIMER,
  PERFORMANCE_INTELLIGENCE_EMPTY,
  PERFORMANCE_INTELLIGENCE_EYEBROW,
  PERFORMANCE_INTELLIGENCE_TITLE,
  R_DISTRIBUTION_LABELS,
  R_DISTRIBUTION_ORDER,
  buildPerformanceIntelligence,
  formatContextProfitFactor,
  formatCoverage,
  type ContextSummary,
} from "@/lib/trades/performance-intelligence";
import type { ContextPerformanceGroup } from "@/lib/trades/pre-trade-performance";
import type { Trade } from "@/lib/trades/types";
import { Panel } from "../dashboard/panels";
import { money, tone } from "./format";

function MetricCard({
  label,
  value,
  testId,
  toneClass,
}: {
  label: string;
  value: string;
  testId?: string;
  toneClass?: string;
}) {
  return (
    <div>
      <span>{label}</span>
      <strong className={toneClass} data-testid={testId}>{value}</strong>
    </div>
  );
}

function GroupGrid({
  title,
  headingId,
  groups,
  testId,
  showR = false,
}: {
  title: string;
  headingId: string;
  groups: Array<ContextSummary | ContextPerformanceGroup>;
  testId: string;
  showR?: boolean;
}) {
  if (!groups.length) return null;
  return (
    <section className="pi-section" aria-labelledby={headingId} data-testid={testId}>
      <h3 id={headingId}>{title}</h3>
      <div className="performance-cards pi-cards">
        {groups.map(group => {
          const rGroup = group as ContextSummary;
          return (
            <article key={group.key} data-testid={`${testId}-${group.key}`}>
              <h3>{group.label}</h3>
              <strong className={tone(group.totalPnl)}>{money(group.totalPnl, true)}</strong>
              <p>{group.sampleSize}件 · 勝率 {group.winRate === null ? "—" : `${group.winRate.toFixed(1)}%`}</p>
              <p className="footnote">
                平均 {group.averagePnl === null ? "—" : money(group.averagePnl, true)}
                {" · "}PF {formatContextProfitFactor(group.profitFactor)}
              </p>
              {showR && "rSampleSize" in rGroup && (
                <p className="footnote">
                  R n={rGroup.rSampleSize}
                  {" · "}平均R {formatRealizedR(rGroup.averageR)}
                </p>
              )}
              {group.sufficientSample
                ? <small>過去の取引結果</small>
                : <small className="neutral">参考値（n&lt;{MIN_INSIGHT_SAMPLE_SIZE}）</small>}
            </article>
          );
        })}
      </div>
    </section>
  );
}

export function PerformanceIntelligencePanel({
  trades,
  periodLabel,
}: {
  trades: Trade[];
  periodLabel: string;
}) {
  const analysis = useMemo(
    () => buildPerformanceIntelligence(trades, periodLabel),
    [trades, periodLabel],
  );
  const { overview, coverage, rPerformance } = analysis;

  return (
    <Panel
      title={PERFORMANCE_INTELLIGENCE_TITLE}
      eyebrow={PERFORMANCE_INTELLIGENCE_EYEBROW}
      className="journal-wide performance-intelligence-panel"
    >
      <p className="footnote">対象期間：{periodLabel}。保存済み取引コンテキストと決済結果のみを集計しています。</p>
      <p className="footnote">{PERFORMANCE_INTELLIGENCE_DISCLAIMER}</p>

      {overview.closedTrades === 0 ? (
        <p className="material-empty" role="status" data-testid="pi-empty">{PERFORMANCE_INTELLIGENCE_EMPTY}</p>
      ) : (
        <>
          <section className="pi-section" aria-labelledby="pi-overview" data-testid="pi-overview">
            <h3 id="pi-overview">Overview</h3>
            <div className="journal-stats pi-overview-stats">
              <MetricCard label="Closed Trades" value={`${overview.closedTrades}件`} testId="pi-closed-trades" />
              <MetricCard label="Total P/L" value={money(overview.totalPnl, true)} testId="pi-total-pnl" toneClass={tone(overview.totalPnl)} />
              <MetricCard label="Average P/L" value={overview.averagePnl === null ? "—" : money(overview.averagePnl, true)} testId="pi-average-pnl" />
              <MetricCard label="Win Rate" value={overview.winRate === null ? "—" : `${overview.winRate.toFixed(1)}%`} testId="pi-win-rate" />
              <MetricCard label="Profit Factor" value={formatContextProfitFactor(overview.profitFactor)} testId="pi-profit-factor" />
              <MetricCard label="R Coverage" value={formatCoverage(overview.rCoverage)} testId="pi-r-coverage" />
              <MetricCard label="Total R" value={formatRealizedR(overview.totalR)} testId="pi-total-r" />
              <MetricCard label="Average R" value={formatRealizedR(overview.averageR)} testId="pi-average-r" />
            </div>
          </section>

          <section className="pi-section" aria-labelledby="pi-coverage" data-testid="pi-coverage">
            <h3 id="pi-coverage">Coverage</h3>
            <div className="journal-stats pi-coverage-stats">
              <MetricCard label="Pre-Trade" value={formatCoverage(coverage.preTrade)} testId="pi-coverage-pretrade" />
              <MetricCard label="MTF" value={formatCoverage(coverage.mtf)} testId="pi-coverage-mtf" />
              <MetricCard label="Regime" value={formatCoverage(coverage.regime)} testId="pi-coverage-regime" />
              <MetricCard label="R" value={formatCoverage(coverage.r)} testId="pi-coverage-r" />
            </div>
            <p className="footnote" data-testid="pi-regime-missing-note">
              Regime missing（未保存）{coverage.regime.contextMissing}件 /
              保存時点 unavailable {coverage.regime.unavailableSaved}件。missing と unavailable は区別します。
            </p>
          </section>

          <section className="pi-section" aria-labelledby="pi-r-multiple" data-testid="pi-r-multiple">
            <h3 id="pi-r-multiple">R-Multiple</h3>
            <div className="journal-stats">
              <MetricCard label="Total R" value={formatRealizedR(rPerformance.totalR)} />
              <MetricCard label="Average R" value={formatRealizedR(rPerformance.averageR)} />
              <MetricCard label="R Coverage" value={formatCoverage(rPerformance.coverage)} />
            </div>
            <div className="performance-cards pi-cards" data-testid="pi-r-distribution" aria-label="R Distribution">
              {R_DISTRIBUTION_ORDER.map(key => (
                <article key={key} data-testid={`pi-r-bucket-${key}`}>
                  <h3>{R_DISTRIBUTION_LABELS[key]}</h3>
                  <strong>{rPerformance.distribution[key]}件</strong>
                  <p className="footnote">historical distribution</p>
                </article>
              ))}
            </div>
          </section>

          <section className="pi-section" aria-labelledby="pi-market" data-testid="pi-market-context">
            <h3 id="pi-market">Market Context</h3>
            <GroupGrid title="MTF Alignment" headingId="pi-mtf-alignment" groups={analysis.mtf.byAlignment} testId="pi-mtf-alignment" />
            <GroupGrid title="HTF Bias" headingId="pi-mtf-htf" groups={analysis.mtf.byHigherTimeframeBias} testId="pi-mtf-htf" />
            <GroupGrid title="AI Direction × MTF" headingId="pi-mtf-ai" groups={analysis.mtf.byAiDirectionContext} testId="pi-mtf-ai" />
            <GroupGrid title="Regime" headingId="pi-regime" groups={analysis.regime.byRegime} testId="pi-regime" showR />
            <GroupGrid title="Volatility" headingId="pi-volatility" groups={analysis.regime.byVolatility} testId="pi-volatility" showR />
            <GroupGrid title="Regime × MTF" headingId="pi-cross" groups={analysis.cross.regimeMtf} testId="pi-cross" showR />
          </section>

          <section className="pi-section" aria-labelledby="pi-entry" data-testid="pi-entry-context">
            <h3 id="pi-entry">Entry Context</h3>
            <GroupGrid title="AI Direction（保存Action）" headingId="pi-ai-direction" groups={analysis.aiDirection.groups} testId="pi-ai-direction" />
            <GroupGrid title="Trigger" headingId="pi-trigger" groups={analysis.preTrade.byTrigger} testId="pi-trigger" />
            <GroupGrid title="Action" headingId="pi-action" groups={analysis.preTrade.byAction} testId="pi-action" />
            <GroupGrid title="Event Risk" headingId="pi-event" groups={analysis.preTrade.byEventRisk} testId="pi-event" />
            <GroupGrid title="Freshness" headingId="pi-freshness" groups={analysis.preTrade.byFreshness} testId="pi-freshness" />
            <GroupGrid title="DLL" headingId="pi-dll" groups={analysis.preTrade.byDll} testId="pi-dll" />
          </section>

          <section className="pi-section" aria-labelledby="pi-observations" data-testid="pi-observations">
            <h3 id="pi-observations">Observations</h3>
            <p className="footnote">最大{MAX_PERFORMANCE_OBSERVATIONS}件。比較は両グループ n≥{MIN_INSIGHT_SAMPLE_SIZE}（R比較は両グループ R n≥{MIN_INSIGHT_SAMPLE_SIZE}）のときのみ。</p>
            {analysis.observations.length === 0 ? (
              <p className="material-empty" role="status">この期間に表示できる observation はありません。</p>
            ) : (
              <ul className="pi-observations-list">
                {analysis.observations.map((text, index) => (
                  <li key={`obs-${index}`} data-testid={`pi-observation-${index}`}>{text}</li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </Panel>
  );
}
