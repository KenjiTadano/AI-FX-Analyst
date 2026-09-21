"use client";

import { useMemo } from "react";
import { formatRealizedR } from "@/lib/trades/exit-plan";
import {
  MAX_EVOLUTION_OBSERVATIONS,
  MIN_INSIGHT_SAMPLE_SIZE,
  TRADE_EVOLUTION_EYEBROW,
  TRADE_EVOLUTION_NOTE,
  TRADE_EVOLUTION_TITLE,
  buildTradeEvolutionPerformance,
  evolutionEmptyMessage,
  type EvolutionDimensionBlock,
  type EvolutionGroupSummary,
} from "@/lib/trades/trade-evolution-performance";
import type { Trade } from "@/lib/trades/types";
import { money, tone } from "./format";

function EvolutionGroupCards({
  block,
  testId,
}: {
  block: EvolutionDimensionBlock;
  testId: string;
}) {
  if (!block.groups.length) {
    return (
      <p className="material-empty" role="status" data-testid={`${testId}-empty`}>
        {block.noDataReason ?? "比較可能なデータがありません"}
      </p>
    );
  }
  return (
    <div className="performance-cards pi-cards te-cards">
      {block.groups.map(group => (
        <EvolutionCard key={group.key} group={group} testId={`${testId}-${group.key.split(":").pop()}`} />
      ))}
    </div>
  );
}

function EvolutionCard({
  group,
  testId,
}: {
  group: EvolutionGroupSummary;
  testId: string;
}) {
  return (
    <article key={group.key} data-testid={testId}>
      <h3>{group.label}</h3>
      <strong className={tone(group.totalPnl)}>{money(group.totalPnl, true)}</strong>
      <p>
        {group.sampleSize}件 · 勝 {group.wins} / 負 {group.losses}
        {" · "}勝率 {group.winRate === null ? "—" : `${group.winRate.toFixed(1)}%`}
      </p>
      <p className="footnote">
        平均 {group.averagePnl === null ? "—" : money(group.averagePnl, true)}
      </p>
      <p className="footnote">
        R n={group.rSampleSize}
        {" · "}平均R {formatRealizedR(group.averageR)}
        {" · "}合計R {formatRealizedR(group.totalR)}
      </p>
      <p className="footnote">
        +R {group.positiveRCount} / −R {group.negativeRCount}
      </p>
      {group.sufficientSample
        ? <small>過去の取引結果</small>
        : <small className="neutral">{`サンプル不足（n<${MIN_INSIGHT_SAMPLE_SIZE}・参考値）`}</small>}
    </article>
  );
}

function DimensionSection({
  title,
  headingId,
  block,
  testId,
}: {
  title: string;
  headingId: string;
  block: EvolutionDimensionBlock;
  testId: string;
}) {
  return (
    <div className="te-dimension" aria-labelledby={headingId} data-testid={testId}>
      <h4 id={headingId}>{title}</h4>
      <EvolutionGroupCards block={block} testId={testId} />
    </div>
  );
}

export function TradeEvolutionSection({
  trades,
  periodLabel,
}: {
  trades: Trade[];
  periodLabel: string;
}) {
  const analysis = useMemo(
    () => buildTradeEvolutionPerformance(trades, periodLabel),
    [trades, periodLabel],
  );
  const { coverage, elapsed } = analysis;

  return (
    <section
      className="pi-section trade-evolution-section"
      aria-labelledby="te-heading"
      data-testid="trade-evolution"
    >
      <h3 id="te-heading">{TRADE_EVOLUTION_TITLE}</h3>
      <p className="footnote" data-testid="te-eyebrow">{TRADE_EVOLUTION_EYEBROW}</p>
      <p className="footnote">{TRADE_EVOLUTION_NOTE}</p>
      <p className="footnote" data-testid="te-selection-bias">{analysis.selectionBiasWarning}</p>
      <p className="footnote" data-testid="te-timing-caveat">{analysis.timingCaveat}</p>
      <p className="footnote">対象期間：{periodLabel}</p>

      <div className="journal-stats pi-coverage-stats" data-testid="te-coverage">
        <div>
          <span>Period CLOSED</span>
          <strong data-testid="te-coverage-closed">{coverage.periodClosed}件</strong>
        </div>
        <div>
          <span>Original available</span>
          <strong data-testid="te-coverage-original">{coverage.originalAvailable}件</strong>
        </div>
        <div>
          <span>Revision available</span>
          <strong data-testid="te-coverage-revision">{coverage.revisionAvailable}件</strong>
        </div>
        <div>
          <span>Evolution eligible</span>
          <strong data-testid="te-coverage-eligible">{coverage.evolutionEligible}件</strong>
        </div>
      </div>

      {elapsed.sampleSize > 0 ? (
        <p className="footnote" data-testid="te-elapsed">
          Original→Latest 経過時間（再取得タイミング）:
          {" "}min {elapsed.minLabel ?? "—"}
          {" · "}median {elapsed.medianLabel ?? "—"}
          {" · "}max {elapsed.maxLabel ?? "—"}
          {" "}（n={elapsed.sampleSize}）
        </p>
      ) : null}

      {analysis.emptyReason ? (
        <p className="material-empty" role="status" data-testid="te-empty">
          {evolutionEmptyMessage(analysis.emptyReason)}
        </p>
      ) : (
        <>
          <DimensionSection
            title="Any Context Change"
            headingId="te-any"
            block={analysis.anyContextChange}
            testId="te-any"
          />

          <div className="te-dimension" data-testid="te-timeframe-trend">
            <h4 id="te-timeframe-trend">Timeframe Trend</h4>
            <div className="pi-timeframe-stack">
              {analysis.timeframeTrend.map(block => (
                <DimensionSection
                  key={block.key}
                  title={block.label}
                  headingId={`te-${block.key.replace(":", "-")}`}
                  block={block}
                  testId={`te-${block.key.replace(":", "-")}`}
                />
              ))}
            </div>
          </div>

          <div className="te-dimension" data-testid="te-regime">
            <h4>Market Regime</h4>
            <DimensionSection
              title="Regime"
              headingId="te-regime-kind"
              block={analysis.regime.regime}
              testId="te-regime-kind"
            />
            <DimensionSection
              title="Trend Direction"
              headingId="te-regime-trend"
              block={analysis.regime.trendDirection}
              testId="te-regime-trend"
            />
            <DimensionSection
              title="Volatility"
              headingId="te-regime-vol"
              block={analysis.regime.volatility}
              testId="te-regime-vol"
            />
          </div>

          <div className="te-dimension" data-testid="te-sma">
            <h4>SMA Relation</h4>
            <DimensionSection
              title="SMA20 relation"
              headingId="te-sma20"
              block={analysis.smaRelation.sma20}
              testId="te-sma20"
            />
            <DimensionSection
              title="SMA75 relation"
              headingId="te-sma75"
              block={analysis.smaRelation.sma75}
              testId="te-sma75"
            />
            <DimensionSection
              title="SMA200 relation"
              headingId="te-sma200"
              block={analysis.smaRelation.sma200}
              testId="te-sma200"
            />
          </div>

          <DimensionSection
            title="RSI Bucket"
            headingId="te-rsi"
            block={analysis.rsiBucket}
            testId="te-rsi"
          />

          <div className="te-dimension" data-testid="te-observations">
            <h4 id="te-observations-heading">Observations</h4>
            <p className="footnote">
              最大{MAX_EVOLUTION_OBSERVATIONS}件。n≥{MIN_INSIGHT_SAMPLE_SIZE}の記述のみ。推奨や因果は述べません。
            </p>
            {analysis.observations.length === 0 ? (
              <p className="material-empty" role="status" data-testid="te-observations-empty">
                この期間に表示できる observation はありません。
              </p>
            ) : (
              <ul className="pi-observations-list">
                {analysis.observations.map((text, index) => (
                  <li key={`te-obs-${index}`} data-testid={`te-observation-${index}`}>{text}</li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </section>
  );
}
