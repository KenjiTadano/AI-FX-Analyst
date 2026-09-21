"use client";
import { useState } from "react";
import {
  MARKET_CONTEXT_CHANGE_DISCLAIMER,
  MARKET_CONTEXT_CHANGE_EYEBROW,
  MARKET_CONTEXT_CHANGE_NO_ORIGINAL,
  MARKET_CONTEXT_CHANGE_NO_REVISIONS,
  MARKET_CONTEXT_CHANGE_NOTE,
  MARKET_CONTEXT_CHANGE_TITLE,
  buildMarketContextChangeAnalysis,
  rsiBucketLabel,
  type ChangeMode,
  type ChangeStatus,
  type FieldChange,
  type MarketContextChange,
  type NumericChange,
} from "@/lib/trades/market-context-change";
import type { Trade } from "@/lib/trades/types";
import { dateTime } from "./format";

function statusClass(status: ChangeStatus): string {
  if (status === "changed") return "mcc-changed";
  if (status === "unchanged") return "mcc-unchanged";
  return "mcc-unavailable";
}

function fmtNum(value: number | null, digits = 2): string {
  if (value == null || !Number.isFinite(value)) return "unavailable";
  return value.toFixed(digits);
}

function fmtSigned(value: number | null, digits = 2): string {
  if (value == null || !Number.isFinite(value)) return "unavailable";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(digits)}`;
}

function FieldRow({
  label,
  change,
  format = String,
  testId,
}: {
  label: string;
  change: FieldChange<string | number | boolean | null>;
  format?: (value: string | number | boolean | null) => string;
  testId: string;
}) {
  const before = change.before == null ? "unavailable" : format(change.before);
  const after = change.after == null ? "unavailable" : format(change.after);
  const text = change.status === "unchanged" ? `${before} (unchanged)` : `${before} → ${after}`;
  return (
    <div className={statusClass(change.status)} data-testid={testId} data-status={change.status}>
      <dt>{label}</dt>
      <dd>{text}</dd>
    </div>
  );
}

function NumericRow({ label, change, testId }: { label: string; change: NumericChange; testId: string }) {
  const before = fmtNum(change.before, 3);
  const after = fmtNum(change.after, 3);
  const delta = change.delta == null ? "" : ` · Δ ${fmtSigned(change.delta, 3)}`;
  const text = change.status === "unchanged"
    ? `${before} (unchanged)`
    : `${before} → ${after}${delta}`;
  return (
    <div className={statusClass(change.status)} data-testid={testId} data-status={change.status}>
      <dt>{label}</dt>
      <dd>{text}</dd>
    </div>
  );
}

function ComparisonBody({ comparison }: { comparison: MarketContextChange }) {
  const rate = comparison.rate;
  const rateText = rate.status === "unavailable"
    ? "unavailable"
    : rate.status === "unchanged"
      ? `${fmtNum(rate.before, 3)} (unchanged)`
      : [
        `${fmtNum(rate.before, 3)} → ${fmtNum(rate.after, 3)}`,
        rate.absolute == null ? null : fmtSigned(rate.absolute, 3),
        rate.percent == null ? null : `${fmtSigned(rate.percent, 2)}%`,
      ].filter(Boolean).join(" · ");

  return (
    <div className="market-context-change-body" data-testid="market-context-change-body">
      <p className="footnote" data-testid="market-context-change-pair-label">
        {comparison.fromLabel} → {comparison.toLabel}
      </p>
      <dl className="market-context-meta">
        <div>
          <dt>From</dt>
          <dd data-testid="market-context-change-from">{comparison.fromCapturedAt ? dateTime(comparison.fromCapturedAt) : "unavailable"}</dd>
        </div>
        <div>
          <dt>To</dt>
          <dd data-testid="market-context-change-to">{comparison.toCapturedAt ? dateTime(comparison.toCapturedAt) : "unavailable"}</dd>
        </div>
        <div className={comparison.elapsed.invalid ? "mcc-unavailable" : undefined}>
          <dt>Elapsed</dt>
          <dd data-testid="market-context-change-elapsed">
            {comparison.elapsed.invalid ? "invalid timestamp" : comparison.elapsed.label}
          </dd>
        </div>
        <div className={statusClass(rate.status)}>
          <dt>Market rate</dt>
          <dd data-testid="market-context-change-rate">{rateText}</dd>
        </div>
      </dl>

      {comparison.timestampAnomaly && (
        <p className="footnote" data-testid="market-context-change-timestamp-anomaly">timestamp anomaly</p>
      )}

      <h6>Timeframes</h6>
      <p className="footnote" data-testid="market-context-change-tf-summary">
        {comparison.timeframeSummary.total} timeframes中 {comparison.timeframeSummary.changed} changed · {comparison.timeframeSummary.unchanged} unchanged
        {comparison.timeframeSummary.unavailable ? ` · ${comparison.timeframeSummary.unavailable} unavailable` : ""}
      </p>
      <dl className="market-context-change-grid">
        {comparison.timeframes.map(tf => (
          <div key={tf.timeframe} className={statusClass(tf.status)} data-testid={`market-context-change-tf-${tf.timeframe}`} data-status={tf.status}>
            <dt>{tf.label}</dt>
            <dd>
              Trend: {tf.trend.before ?? "unavailable"} → {tf.trend.after ?? "unavailable"}
              {" · "}
              Structure: {tf.structure.before ?? "unavailable"} → {tf.structure.after ?? "unavailable"}
              {tf.status === "unchanged" ? " (unchanged)" : ""}
            </dd>
          </div>
        ))}
      </dl>

      <h6>Market Regime</h6>
      <dl className="market-context-change-grid">
        <FieldRow label="Regime" change={comparison.regime.regime} testId="market-context-change-regime" />
        <FieldRow label="Trend" change={comparison.regime.trendDirection} testId="market-context-change-regime-trend" />
        <FieldRow label="Volatility" change={comparison.regime.volatility} testId="market-context-change-regime-vol" />
      </dl>

      <h6>Technical</h6>
      <dl className="market-context-change-grid">
        <NumericRow label="lastClose" change={comparison.technical.lastClose} testId="market-context-change-last-close" />
        <NumericRow label="SMA20" change={comparison.technical.sma20} testId="market-context-change-sma20" />
        <NumericRow label="SMA75" change={comparison.technical.sma75} testId="market-context-change-sma75" />
        <NumericRow label="SMA200" change={comparison.technical.sma200} testId="market-context-change-sma200" />
        <NumericRow label="RSI14" change={comparison.technical.rsi14} testId="market-context-change-rsi" />
        <FieldRow label="SMA20 relation" change={comparison.technical.smaRelations.sma20} testId="market-context-change-sma20-rel" />
        <FieldRow label="SMA75 relation" change={comparison.technical.smaRelations.sma75} testId="market-context-change-sma75-rel" />
        <FieldRow label="SMA200 relation" change={comparison.technical.smaRelations.sma200} testId="market-context-change-sma200-rel" />
        <FieldRow
          label="RSI bucket"
          change={comparison.technical.rsiBucket}
          format={value => rsiBucketLabel(value as never)}
          testId="market-context-change-rsi-bucket"
        />
      </dl>
    </div>
  );
}

export function MarketContextChangeDetail({ trade }: { trade: Trade }) {
  const [mode, setMode] = useState<ChangeMode>("original_to_latest");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const analysis = buildMarketContextChangeAnalysis(trade, {
    mode,
    selectedRevisionIndex: selectedIndex,
  });

  return (
    <section className="market-context-change" data-testid="market-context-change" aria-label={MARKET_CONTEXT_CHANGE_TITLE}>
      <p className="eyebrow">{MARKET_CONTEXT_CHANGE_EYEBROW}</p>
      <h4>{MARKET_CONTEXT_CHANGE_TITLE}</h4>
      <p className="footnote" data-testid="market-context-change-note">{MARKET_CONTEXT_CHANGE_NOTE}</p>

      {analysis.unavailableReason === "no_original" && (
        <p className="footnote" data-testid="market-context-change-no-original">{MARKET_CONTEXT_CHANGE_NO_ORIGINAL}</p>
      )}
      {analysis.unavailableReason === "no_revisions" && (
        <p className="footnote" data-testid="market-context-change-no-revisions">{MARKET_CONTEXT_CHANGE_NO_REVISIONS}</p>
      )}

      {analysis.unavailableReason == null && analysis.comparison && (
        <>
          <div className="market-context-change-modes" data-testid="market-context-change-modes">
            <button
              type="button"
              data-testid="market-context-change-mode-latest"
              aria-pressed={mode === "original_to_latest"}
              onClick={() => setMode("original_to_latest")}
            >
              Original → 最新
            </button>
            <button
              type="button"
              data-testid="market-context-change-mode-previous"
              aria-pressed={mode === "previous_to_latest"}
              onClick={() => setMode("previous_to_latest")}
            >
              直前 → 最新
            </button>
            {analysis.revisions.length > 1 && (
              <label className="market-context-change-select">
                Original → 選択
                <select
                  data-testid="market-context-change-select"
                  value={mode === "original_to_selected" ? selectedIndex : analysis.revisions.length - 1}
                  onChange={e => {
                    setSelectedIndex(Number(e.target.value));
                    setMode("original_to_selected");
                  }}
                >
                  {analysis.revisions.map((_, i) => (
                    <option key={i} value={i}>再取得 {i + 1}</option>
                  ))}
                </select>
              </label>
            )}
          </div>
          {analysis.appendOrderAnomaly && (
            <p className="footnote" data-testid="market-context-change-order-anomaly">capturedAt anomaly in append order</p>
          )}
          <ComparisonBody comparison={analysis.comparison} />
        </>
      )}

      <p className="footnote">{MARKET_CONTEXT_CHANGE_DISCLAIMER}</p>
    </section>
  );
}
