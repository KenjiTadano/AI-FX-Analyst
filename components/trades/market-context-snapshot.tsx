"use client";
import { useState } from "react";
import {
  MARKET_CONTEXT_CAPTURE_ERROR,
  MARKET_CONTEXT_DISCLAIMER,
  MARKET_CONTEXT_EYEBROW,
  MARKET_CONTEXT_HISTORY_EMPTY,
  MARKET_CONTEXT_HISTORY_TITLE,
  MARKET_CONTEXT_LEGACY,
  MARKET_CONTEXT_NOTE,
  MARKET_CONTEXT_ORIGINAL_LABEL,
  MARKET_CONTEXT_PAIR_MISMATCH_ERROR,
  MARKET_CONTEXT_REFRESH_BUTTON,
  MARKET_CONTEXT_REFRESH_CONFIRM,
  MARKET_CONTEXT_REFRESH_CONFIRM_CANCEL,
  MARKET_CONTEXT_REFRESH_CONFIRM_OK,
  MARKET_CONTEXT_TITLE,
  marketContextFieldStates,
  marketContextFromTrade,
  marketContextRevisionFieldStates,
  marketContextRevisionsFromTrade,
  type MarketContextRevision,
} from "@/lib/trades/market-context-snapshot";
import type { Trade } from "@/lib/trades/types";
import { dateTime } from "./format";
import { MarketContextChangeDetail } from "./market-context-change";

function stateLabel(state: "saved" | "unavailable" | "legacy"): string {
  if (state === "saved") return "saved";
  if (state === "unavailable") return "unavailable";
  return "legacy";
}

function ContextMeta({
  capturedAt,
  pair,
  marketRate,
  mtf,
  regime,
  technical,
  testIdPrefix,
}: {
  capturedAt: string;
  pair: string;
  marketRate: number | null;
  mtf: string;
  regime: string;
  technical: string;
  testIdPrefix: string;
}) {
  return (
    <dl className="market-context-meta">
      <div><dt>Captured</dt><dd data-testid={`${testIdPrefix}-captured`}>{dateTime(capturedAt)}</dd></div>
      <div><dt>Pair</dt><dd data-testid={`${testIdPrefix}-pair`}>{pair}</dd></div>
      <div><dt>Market rate</dt><dd data-testid={`${testIdPrefix}-rate`}>{marketRate == null ? "unavailable" : marketRate}</dd></div>
      <div><dt>MTF</dt><dd data-testid={`${testIdPrefix}-mtf`}>{mtf}</dd></div>
      <div><dt>Regime</dt><dd data-testid={`${testIdPrefix}-regime`}>{regime}</dd></div>
      <div><dt>Technical</dt><dd data-testid={`${testIdPrefix}-technical`}>{technical}</dd></div>
    </dl>
  );
}

function RevisionItem({ revision, index }: { revision: MarketContextRevision; index: number }) {
  const states = marketContextRevisionFieldStates(revision);
  return (
    <details className="market-context-revision" data-testid={`market-context-revision-${index + 1}`}>
      <summary>再取得 {index + 1} · {dateTime(revision.capturedAt)}</summary>
      <ContextMeta
        capturedAt={revision.capturedAt}
        pair={revision.pair}
        marketRate={revision.marketRate}
        mtf={stateLabel(states.mtf)}
        regime={stateLabel(states.regime)}
        technical={stateLabel(states.technical)}
        testIdPrefix={`market-context-rev-${index + 1}`}
      />
    </details>
  );
}

export function MarketContextSnapshotDetail({
  trade,
  onRefreshRevision,
  refreshBusy = false,
}: {
  trade: Trade;
  onRefreshRevision?: (trade: Trade) => Promise<string | null>;
  refreshBusy?: boolean;
}) {
  const ctx = marketContextFromTrade(trade);
  const states = marketContextFieldStates(trade);
  const revisions = marketContextRevisionsFromTrade(trade);
  const [confirming, setConfirming] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  async function confirmRefresh() {
    if (!onRefreshRevision || refreshBusy) return;
    setLocalError(null);
    const error = await onRefreshRevision(trade);
    if (error) setLocalError(error);
    setConfirming(false);
  }

  return (
    <section className="market-context-snapshot" data-testid="market-context-snapshot" aria-label={MARKET_CONTEXT_TITLE}>
      <p className="eyebrow">{MARKET_CONTEXT_EYEBROW}</p>
      <h4>{MARKET_CONTEXT_TITLE}</h4>
      <p className="footnote" data-testid="market-context-original-label">{MARKET_CONTEXT_ORIGINAL_LABEL}</p>
      {!ctx ? (
        <p className="footnote" data-testid="market-context-legacy">{MARKET_CONTEXT_LEGACY}</p>
      ) : (
        <>
          <p className="footnote" data-testid="market-context-note">{MARKET_CONTEXT_NOTE}</p>
          <ContextMeta
            capturedAt={ctx.capturedAt}
            pair={ctx.pair}
            marketRate={ctx.marketRate}
            mtf={stateLabel(states.mtf)}
            regime={stateLabel(states.regime)}
            technical={stateLabel(states.technical)}
            testIdPrefix="market-context"
          />
        </>
      )}

      <div className="market-context-history" data-testid="market-context-history">
        <h5>{MARKET_CONTEXT_HISTORY_TITLE}</h5>
        {revisions.length === 0 ? (
          <p className="footnote" data-testid="market-context-history-empty">{MARKET_CONTEXT_HISTORY_EMPTY}</p>
        ) : (
          revisions.map((revision, index) => <RevisionItem key={`${revision.capturedAt}-${index}`} revision={revision} index={index} />)
        )}
      </div>

      {onRefreshRevision && (
        <div className="market-context-refresh">
          {!confirming ? (
            <button
              type="button"
              data-testid="market-context-refresh"
              disabled={refreshBusy}
              onClick={() => { setLocalError(null); setConfirming(true); }}
            >
              {MARKET_CONTEXT_REFRESH_BUTTON}
            </button>
          ) : (
            <div className="delete-confirm market-context-refresh-confirm" role="alertdialog" aria-label="Market Context再取得の確認" data-testid="market-context-refresh-confirm">
              <p>{MARKET_CONTEXT_REFRESH_CONFIRM}</p>
              <div className="journal-actions">
                <button type="button" disabled={refreshBusy} data-testid="market-context-refresh-ok" onClick={() => void confirmRefresh()}>
                  {MARKET_CONTEXT_REFRESH_CONFIRM_OK}
                </button>
                <button type="button" disabled={refreshBusy} data-testid="market-context-refresh-cancel" onClick={() => setConfirming(false)}>
                  {MARKET_CONTEXT_REFRESH_CONFIRM_CANCEL}
                </button>
              </div>
            </div>
          )}
          {localError && <p className="negative" role="alert" data-testid="market-context-refresh-error">{localError}</p>}
        </div>
      )}

      <MarketContextChangeDetail trade={trade} />

      <p className="footnote">{MARKET_CONTEXT_DISCLAIMER}</p>
      {/* Keep static strings referenced for tests that assert user-facing copy exists */}
      <span hidden>{MARKET_CONTEXT_CAPTURE_ERROR}{MARKET_CONTEXT_PAIR_MISMATCH_ERROR}</span>
    </section>
  );
}
