import type { MarketData, Symbol } from "@/lib/market/types";
import {
  ALIGNMENT_LABEL,
  MTF_UNAVAILABLE_MESSAGE,
  STRUCTURE_LABEL,
  TIMEFRAME_LABEL,
  TREND_LABEL,
  multiTimeframeForPair,
  type MarketStructure,
  type TimeframeTrend,
} from "@/lib/market/multi-timeframe";
import { Panel } from "./panels";

function format(value: number | null) {
  return value === null ? "—" : value.toFixed(3);
}

function trendClass(trend: TimeframeTrend) {
  return trend === "bullish" ? "positive" : trend === "bearish" ? "negative" : "neutral";
}

export function MultiTimeframePanel({ pair, data, error }: { pair: Symbol; data: MarketData | null; error: string | null }) {
  const analysis = multiTimeframeForPair(data, pair, data?.daily?.fetchedAt ?? data?.price.fetchedAt ?? undefined);
  return (
    <Panel title="マルチタイムフレーム分析" eyebrow="MULTI-TIMEFRAME" className="reasons-panel mtf-panel" testId="multi-timeframe" ariaLabel="マルチタイムフレーム分析">
      {!data && !error && <p className="footnote">取得中…</p>}
      {error && <p role="status" className="footnote negative">{error}</p>}
      {analysis && (
        <>
          <dl className="mtf-summary">
            <div>
              <dt>上位足バイアス</dt>
              <dd data-testid="mtf-bias" className={trendClass(analysis.higherTimeframeBias)}>{TREND_LABEL[analysis.higherTimeframeBias]}</dd>
            </div>
            <div>
              <dt>整合状態</dt>
              <dd data-testid="mtf-alignment">{ALIGNMENT_LABEL[analysis.alignment]}</dd>
            </div>
            <div>
              <dt>データ</dt>
              <dd data-testid="mtf-status">{analysis.availableTimeframes} / {analysis.totalTimeframes} timeframes</dd>
            </div>
          </dl>
          {analysis.availableTimeframes === 0 && <p role="status" data-testid="mtf-unavailable-all">{MTF_UNAVAILABLE_MESSAGE}</p>}
          <div className="mtf-frames">
            {analysis.timeframes.map(frame => (
              <article key={frame.timeframe} className="mtf-frame" data-testid={`mtf-row-${frame.timeframe}`}>
                <h3>
                  {TIMEFRAME_LABEL[frame.timeframe]}
                  <span className={`badge ${trendClass(frame.trend)}`} data-testid={`mtf-trend-${frame.timeframe}`}>{TREND_LABEL[frame.trend]}</span>
                </h3>
                <p className="footnote" data-testid={`mtf-structure-${frame.timeframe}`}>{STRUCTURE_LABEL[frame.structure as MarketStructure]}</p>
                <details>
                  <summary>指標</summary>
                  <dl className="metrics">
                    <div><dt>終値</dt><dd>{format(frame.lastClose)}</dd></div>
                    <div><dt>SMA20</dt><dd>{format(frame.sma20)}</dd></div>
                    <div><dt>SMA75</dt><dd>{format(frame.sma75)}</dd></div>
                    <div><dt>SMA200</dt><dd>{format(frame.sma200)}</dd></div>
                    <div><dt>RSI14</dt><dd>{format(frame.rsi14)}</dd></div>
                  </dl>
                </details>
              </article>
            ))}
          </div>
          {analysis.conflicts.length > 0 && (
            <div className="mtf-conflicts" data-testid="mtf-conflicts">
              <p>Conflict</p>
              <ul>
                {analysis.conflicts.map((item, index) => (
                  <li key={item.id} data-testid={`mtf-conflict-${index}`}>{item.message}</li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
      <p className="footnote">各時間軸は確定足のSMA並びから計算した市場状態です。売買の推奨ではありません。</p>
    </Panel>
  );
}
