import {
  ALIGNMENT_LABEL,
  STRUCTURE_LABEL,
  TIMEFRAME_LABEL,
  TREND_LABEL,
  type TimeframeTrend,
} from "@/lib/market/multi-timeframe";
import {
  MTF_SNAPSHOT_DISCLAIMER,
  MTF_SNAPSHOT_EYEBROW,
  MTF_SNAPSHOT_MISSING,
  MTF_SNAPSHOT_NOTE,
  MTF_SNAPSHOT_TITLE,
  MTF_SNAPSHOT_UNREADABLE,
  mtfSnapshotState,
  storedMultiTimeframeAnalysis,
} from "@/lib/trades/mtf-snapshot";
import type { Trade } from "@/lib/trades/types";

function trendClass(trend: TimeframeTrend) {
  return trend === "bullish" ? "positive" : trend === "bearish" ? "negative" : "neutral";
}

export function MtfSnapshotDetail({ trade }: { trade: Trade }) {
  const analysis = storedMultiTimeframeAnalysis(trade);
  const state = mtfSnapshotState(trade);
  if (state !== "ok" || !analysis) {
    return (
      <p className="footnote" data-testid={state === "unreadable" ? "mtf-snapshot-unreadable" : "mtf-snapshot-missing"}>
        {state === "unreadable" ? MTF_SNAPSHOT_UNREADABLE : MTF_SNAPSHOT_MISSING}
      </p>
    );
  }
  return (
    <section className="mtf-snapshot" data-testid="mtf-snapshot" aria-label={MTF_SNAPSHOT_TITLE}>
      <h4>{MTF_SNAPSHOT_TITLE}</h4>
      <p className="eyebrow">{MTF_SNAPSHOT_EYEBROW}</p>
      <p className="footnote" data-testid="mtf-snapshot-note">{MTF_SNAPSHOT_NOTE}</p>
      <dl className="mtf-snapshot-grid">
        <div>
          <dt>上位足バイアス</dt>
          <dd data-testid="mtf-snapshot-bias" className={trendClass(analysis.higherTimeframeBias)}>{TREND_LABEL[analysis.higherTimeframeBias]}</dd>
        </div>
        <div>
          <dt>整合状態</dt>
          <dd data-testid="mtf-snapshot-alignment">{ALIGNMENT_LABEL[analysis.alignment]}</dd>
        </div>
        <div>
          <dt>データ</dt>
          <dd data-testid="mtf-snapshot-status">{analysis.availableTimeframes} / {analysis.totalTimeframes} timeframes</dd>
        </div>
      </dl>
      <ul className="mtf-snapshot-frames">
        {analysis.timeframes.map(frame => (
          <li key={frame.timeframe} data-testid={`mtf-snapshot-row-${frame.timeframe}`}>
            {TIMEFRAME_LABEL[frame.timeframe]}：
            <span data-testid={`mtf-snapshot-trend-${frame.timeframe}`}>{TREND_LABEL[frame.trend]}</span>
            ／{STRUCTURE_LABEL[frame.structure]}
          </li>
        ))}
      </ul>
      {analysis.conflicts.length > 0 && (
        <div className="mtf-snapshot-conflicts" data-testid="mtf-snapshot-conflicts">
          <p>Conflict</p>
          <ul>
            {analysis.conflicts.map((item, index) => (
              <li key={item.id} data-testid={`mtf-snapshot-conflict-${index}`}>{item.message}</li>
            ))}
          </ul>
        </div>
      )}
      <p className="footnote">{MTF_SNAPSHOT_DISCLAIMER}</p>
    </section>
  );
}
