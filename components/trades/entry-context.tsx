import {
  ENTRY_CONTEXT_DISCLAIMER,
  ENTRY_CONTEXT_EYEBROW,
  ENTRY_CONTEXT_NOTE,
  ENTRY_CONTEXT_TITLE,
  buildStoredEntryContext,
} from "@/lib/trades/entry-context";
import type { Trade } from "@/lib/trades/types";
import { PreTradeContextDetail } from "./pre-trade-context";
import { MtfSnapshotDetail } from "./mtf-snapshot";
import { RegimeSnapshotDetail } from "./regime-snapshot";
import { MarketContextSnapshotDetail } from "./market-context-snapshot";

export function StoredEntryContext({
  trade,
  onRefreshMarketContext,
  refreshBusy,
}: {
  trade: Trade;
  onRefreshMarketContext?: (trade: Trade) => Promise<string | null>;
  refreshBusy?: boolean;
}) {
  const context = buildStoredEntryContext(trade);
  return (
    <section className="entry-context" data-testid="entry-context" aria-label={ENTRY_CONTEXT_TITLE}>
      <p className="eyebrow">{ENTRY_CONTEXT_EYEBROW}</p>
      <h4>{ENTRY_CONTEXT_TITLE}</h4>
      <p className="footnote" data-testid="entry-context-note">{context ? ENTRY_CONTEXT_NOTE : ENTRY_CONTEXT_DISCLAIMER}</p>
      <MarketContextSnapshotDetail trade={trade} onRefreshRevision={onRefreshMarketContext} refreshBusy={refreshBusy} />
      <PreTradeContextDetail trade={trade} />
      <MtfSnapshotDetail trade={trade} />
      <RegimeSnapshotDetail trade={trade} />
      <p className="footnote">{ENTRY_CONTEXT_DISCLAIMER}</p>
    </section>
  );
}
