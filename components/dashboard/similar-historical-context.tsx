"use client";

import { useMemo, useState } from "react";
import type { MarketData } from "@/lib/market/types";
import { formatRealizedR } from "@/lib/trades/exit-plan";
import {
  MAX_SIMILAR_RESULTS,
  MIN_COMPARABLE_DIMENSIONS,
  MIN_SIMILARITY,
  SIMILAR_HISTORICAL_DISCLAIMER,
  SIMILAR_HISTORICAL_EYEBROW,
  SIMILAR_HISTORICAL_NOTE,
  SIMILAR_HISTORICAL_OUTCOME_NOTE,
  SIMILAR_HISTORICAL_TITLE,
  buildCurrentMarketContext,
  findSimilarHistoricalContexts,
  similarHistoricalEmptyMessage,
  type SimilarHistoricalMatch,
} from "@/lib/trades/context-similarity";
import type { Trade, TradePair } from "@/lib/trades/types";
import { Panel } from "./panels";
import { money, tone } from "../trades/format";

function formatDate(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  return new Date(ms).toISOString().slice(0, 10);
}

function statusLabel(status: string): string {
  if (status === "match") return "match";
  if (status === "mismatch") return "mismatch";
  return "not comparable";
}

function MatchCard({
  match,
  rank,
}: {
  match: SimilarHistoricalMatch;
  rank: number;
}) {
  const [open, setOpen] = useState(false);
  const percent = match.similarity.percent == null ? "—" : `${match.similarity.percent}%`;

  return (
    <article className="similar-match-card" data-testid={`similar-match-${rank}`}>
      <header className="similar-match-header">
        <strong data-testid={`similar-match-${rank}-rank`}>#{rank}</strong>
        <span data-testid={`similar-match-${rank}-similarity`}>Similarity {percent}</span>
        <span data-testid={`similar-match-${rank}-comparable`}>
          Comparable {match.similarity.comparable}/{match.similarity.totalDimensions}
        </span>
      </header>
      <p className="footnote">
        {formatDate(match.outcome.openedAt)}
        {" · "}{match.pair}
        {" · "}{match.outcome.side.toUpperCase()}
      </p>
      <div className="similar-outcome" data-testid={`similar-match-${rank}-outcome`}>
        <span>Historical Outcome</span>
        {match.outcome.available && match.outcome.realizedPnl != null ? (
          <>
            <strong className={tone(match.outcome.realizedPnl)}>
              P/L {money(match.outcome.realizedPnl, true)}
            </strong>
            <span className="footnote">R {formatRealizedR(match.outcome.realizedR)}</span>
          </>
        ) : (
          <span className="footnote">outcome unavailable</span>
        )}
      </div>
      <button
        type="button"
        className="similar-details-toggle"
        data-testid={`similar-match-${rank}-details-toggle`}
        aria-expanded={open}
        onClick={() => setOpen(value => !value)}
      >
        {open ? "詳細を閉じる" : "詳細"}
      </button>
      {open ? (
        <dl className="similar-dimension-list" data-testid={`similar-match-${rank}-details`}>
          {match.similarity.dimensions.map(dim => (
            <div key={dim.key}>
              <dt>{dim.label}</dt>
              <dd data-testid={`similar-dim-${rank}-${dim.key}`}>{statusLabel(dim.status)}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </article>
  );
}

export function SimilarHistoricalContextPanel({
  pair,
  market,
  marketRate,
  trades,
  capturedAt,
}: {
  pair: TradePair;
  market: MarketData | null;
  marketRate?: number | null;
  trades: Trade[];
  capturedAt: string;
}) {
  const analysis = useMemo(() => {
    const current = buildCurrentMarketContext({
      pair,
      capturedAt,
      market,
      marketRate: marketRate ?? null,
    });
    return findSimilarHistoricalContexts({ pair, current, trades });
  }, [pair, market, marketRate, trades, capturedAt]);

  return (
    <Panel
      title={SIMILAR_HISTORICAL_TITLE}
      eyebrow={SIMILAR_HISTORICAL_EYEBROW}
      className="reasons-panel similar-historical-panel"
      testId="similar-historical-context"
    >
      <p className="footnote">{SIMILAR_HISTORICAL_NOTE}</p>
      <p className="footnote" data-testid="similar-disclaimer">{SIMILAR_HISTORICAL_DISCLAIMER}</p>
      <p className="footnote" data-testid="similar-outcome-note">{SIMILAR_HISTORICAL_OUTCOME_NOTE}</p>
      <p className="footnote" data-testid="similar-current-pair">Current Context · {pair}</p>
      <p className="footnote">
        表示上限 {MAX_SIMILAR_RESULTS}件 · 最低比較項目 {MIN_COMPARABLE_DIMENSIONS}
        {" · "}類似度しきい値 {Math.round(MIN_SIMILARITY * 100)}%
      </p>

      {analysis.emptyReason ? (
        <p className="material-empty" role="status" data-testid="similar-empty">
          {similarHistoricalEmptyMessage(analysis.emptyReason)}
        </p>
      ) : (
        <div className="similar-match-list" data-testid="similar-match-list">
          {analysis.matches.map((match, index) => (
            <MatchCard key={match.tradeId} match={match} rank={index + 1} />
          ))}
        </div>
      )}
    </Panel>
  );
}
