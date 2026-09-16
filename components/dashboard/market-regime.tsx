"use client";

import type { MarketData, Symbol } from "@/lib/market/types";
import {
  REGIME_DISCLAIMER,
  REGIME_LABEL,
  REGIME_TREND_LABEL,
  REGIME_UNAVAILABLE_MESSAGE,
  VOLATILITY_LABEL,
  marketRegimeForPair,
  type MarketRegimeKind,
  type RegimeTrendDirection,
  type VolatilityRegime,
} from "@/lib/market/market-regime";
import { Panel } from "./panels";

function format(value: number | null, digits = 2, suffix = "") {
  return value === null ? "—" : `${value.toFixed(digits)}${suffix}`;
}

function tone(value: MarketRegimeKind | RegimeTrendDirection | VolatilityRegime) {
  if (value === "trending" || value === "bullish") return "positive";
  if (value === "bearish") return "negative";
  return "neutral";
}

export function MarketRegimePanel({ pair, data, error }: { pair: Symbol; data: MarketData | null; error: string | null }) {
  const analyzedAt = data?.timeframes["1h"]?.fetchedAt ?? data?.price.fetchedAt ?? undefined;
  const analysis = marketRegimeForPair(data, pair, analyzedAt);
  return (
    <Panel title="相場環境" eyebrow="MARKET REGIME" className="reasons-panel regime-panel" testId="market-regime" ariaLabel="相場環境">
      {!data && !error && <p className="footnote">取得中…</p>}
      {error && <p role="status" className="footnote negative">{error}</p>}
      {analysis && (
        <>
          <dl className="mtf-summary">
            <div>
              <dt>相場状態</dt>
              <dd data-testid="regime-kind" className={tone(analysis.regime)}>{REGIME_LABEL[analysis.regime]}</dd>
            </div>
            <div>
              <dt>方向</dt>
              <dd data-testid="regime-trend" className={tone(analysis.trendDirection)}>{REGIME_TREND_LABEL[analysis.trendDirection]}</dd>
            </div>
            <div>
              <dt>ボラティリティ</dt>
              <dd data-testid="regime-volatility" className={tone(analysis.volatility)}>{VOLATILITY_LABEL[analysis.volatility]}</dd>
            </div>
          </dl>
          <p className="footnote" data-testid="regime-timeframe">1H</p>
          {analysis.regime === "unavailable" && (
            <p role="status" data-testid="regime-unavailable">{REGIME_UNAVAILABLE_MESSAGE}</p>
          )}
          <dl className="metrics">
            <div>
              <dt>ATR</dt>
              <dd data-testid="regime-atr-percent">{format(analysis.evidence.atrPercent, 2, "%")}</dd>
            </div>
            <div>
              <dt>基準比</dt>
              <dd data-testid="regime-atr-ratio">{analysis.evidence.atrRatio === null ? "—" : `${analysis.evidence.atrRatio.toFixed(2)}x`}</dd>
            </div>
            <div>
              <dt>SMA spread</dt>
              <dd data-testid="regime-sma-spread">{format(analysis.evidence.smaSpreadPercent, 2, "%")}</dd>
            </div>
          </dl>
          {analysis.reasons.length > 0 && (
            <ul className="regime-reasons" data-testid="regime-reasons">
              {analysis.reasons.map(reason => <li key={reason}>{reason}</li>)}
            </ul>
          )}
        </>
      )}
      {!analysis && data && <p role="status" data-testid="regime-unavailable">{REGIME_UNAVAILABLE_MESSAGE}</p>}
      <p className="footnote">{REGIME_DISCLAIMER}</p>
    </Panel>
  );
}
