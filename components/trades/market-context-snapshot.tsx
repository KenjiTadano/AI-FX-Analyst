"use client";
import {
  MARKET_CONTEXT_DISCLAIMER,
  MARKET_CONTEXT_EYEBROW,
  MARKET_CONTEXT_LEGACY,
  MARKET_CONTEXT_NOTE,
  MARKET_CONTEXT_TITLE,
  marketContextFieldStates,
  marketContextFromTrade,
} from "@/lib/trades/market-context-snapshot";
import type { Trade } from "@/lib/trades/types";
import { dateTime } from "./format";

function stateLabel(state: "saved" | "unavailable" | "legacy"): string {
  if (state === "saved") return "saved";
  if (state === "unavailable") return "unavailable";
  return "legacy";
}

export function MarketContextSnapshotDetail({ trade }: { trade: Trade }) {
  const ctx = marketContextFromTrade(trade);
  const states = marketContextFieldStates(trade);
  return (
    <section className="market-context-snapshot" data-testid="market-context-snapshot" aria-label={MARKET_CONTEXT_TITLE}>
      <p className="eyebrow">{MARKET_CONTEXT_EYEBROW}</p>
      <h4>{MARKET_CONTEXT_TITLE}</h4>
      {!ctx ? (
        <p className="footnote" data-testid="market-context-legacy">{MARKET_CONTEXT_LEGACY}</p>
      ) : (
        <>
          <p className="footnote" data-testid="market-context-note">{MARKET_CONTEXT_NOTE}</p>
          <dl className="market-context-meta">
            <div><dt>Captured</dt><dd data-testid="market-context-captured">{dateTime(ctx.capturedAt)}</dd></div>
            <div><dt>Pair</dt><dd data-testid="market-context-pair">{ctx.pair}</dd></div>
            <div><dt>Market rate</dt><dd data-testid="market-context-rate">{ctx.marketRate == null ? "unavailable" : ctx.marketRate}</dd></div>
            <div><dt>MTF</dt><dd data-testid="market-context-mtf">{stateLabel(states.mtf)}</dd></div>
            <div><dt>Regime</dt><dd data-testid="market-context-regime">{stateLabel(states.regime)}</dd></div>
            <div><dt>Technical</dt><dd data-testid="market-context-technical">{stateLabel(states.technical)}</dd></div>
          </dl>
        </>
      )}
      <p className="footnote">{MARKET_CONTEXT_DISCLAIMER}</p>
    </section>
  );
}
