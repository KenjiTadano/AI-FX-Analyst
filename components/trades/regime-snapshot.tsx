import {
  REGIME_LABEL,
  REGIME_TREND_LABEL,
  VOLATILITY_LABEL,
} from "@/lib/market/market-regime";
import {
  REGIME_SNAPSHOT_DISCLAIMER,
  REGIME_SNAPSHOT_EYEBROW,
  REGIME_SNAPSHOT_MISSING,
  REGIME_SNAPSHOT_NOTE,
  REGIME_SNAPSHOT_TITLE,
  REGIME_SNAPSHOT_UNREADABLE,
  regimeSnapshotState,
  storedMarketRegimeAnalysis,
} from "@/lib/trades/regime-snapshot";
import type { Trade } from "@/lib/trades/types";

function row(label: string, value: string, testId: string) {
  return <div><dt>{label}</dt><dd data-testid={testId}>{value}</dd></div>;
}

export function RegimeSnapshotDetail({ trade }: { trade: Trade }) {
  const analysis = storedMarketRegimeAnalysis(trade);
  const state = regimeSnapshotState(trade);
  if (state !== "ok" || !analysis) {
    return (
      <p className="footnote" data-testid={state === "unreadable" ? "regime-snapshot-unreadable" : "regime-snapshot-missing"}>
        {state === "unreadable" ? REGIME_SNAPSHOT_UNREADABLE : REGIME_SNAPSHOT_MISSING}
      </p>
    );
  }
  return (
    <section className="regime-snapshot" data-testid="regime-snapshot" aria-label={REGIME_SNAPSHOT_TITLE}>
      <h4>{REGIME_SNAPSHOT_TITLE}</h4>
      <p className="eyebrow">{REGIME_SNAPSHOT_EYEBROW}</p>
      <p className="footnote" data-testid="regime-snapshot-note">{REGIME_SNAPSHOT_NOTE}</p>
      <dl className="mtf-snapshot-grid">
        {row("相場状態", REGIME_LABEL[analysis.regime], "regime-snapshot-kind")}
        {row("方向", REGIME_TREND_LABEL[analysis.trendDirection], "regime-snapshot-trend")}
        {row("ボラティリティ", VOLATILITY_LABEL[analysis.volatility], "regime-snapshot-volatility")}
        {row("時間足", "1H", "regime-snapshot-timeframe")}
      </dl>
      <p className="footnote">{REGIME_SNAPSHOT_DISCLAIMER}</p>
    </section>
  );
}
