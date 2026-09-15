import {
  POST_TRADE_REVIEW_DISCLAIMER,
  POST_TRADE_REVIEW_EYEBROW,
  POST_TRADE_REVIEW_MISSING,
  POST_TRADE_REVIEW_SNAPSHOT_NOTE,
  POST_TRADE_REVIEW_TITLE,
  POST_TRADE_REVIEW_UNREADABLE,
  buildPostTradeReview,
} from "@/lib/trades/post-trade-review";
import type { Trade } from "@/lib/trades/types";
import { PreTradeContextDetail } from "./pre-trade-context";
import { money, tone } from "./format";

function row(label: string, value: string, testId: string, valueClass?: string) {
  return <div><dt>{label}</dt><dd className={valueClass} data-testid={testId}>{value}</dd></div>;
}

export function PostTradeReview({ trade }: { trade: Trade }) {
  const review = buildPostTradeReview(trade);
  if (!review) return null;
  const pnl = review.outcome.realizedPnl;
  const missing = review.contextState === "unreadable" ? POST_TRADE_REVIEW_UNREADABLE : POST_TRADE_REVIEW_MISSING;
  return (
    <section className="posttrade-review" data-testid="post-trade-review" aria-label={POST_TRADE_REVIEW_TITLE}>
      <p className="eyebrow">{POST_TRADE_REVIEW_EYEBROW}</p>
      <h4>{POST_TRADE_REVIEW_TITLE}</h4>
      <p className="posttrade-review-intent" data-testid="post-trade-review-identity">
        <strong>{review.pair}</strong>
        <span data-testid="post-trade-review-side">{review.tradeSide}</span>
      </p>
      <dl className="posttrade-review-grid">
        {row(
          "実現損益",
          pnl == null || !Number.isFinite(pnl) ? "—" : money(pnl, true),
          "post-trade-review-pnl",
          pnl == null || !Number.isFinite(pnl) ? "muted" : tone(pnl),
        )}
        {row("結果", review.outcome.resultLabel, "post-trade-review-result")}
        {row("保有時間", review.outcome.holdingDurationLabel, "post-trade-review-duration")}
      </dl>
      <p className="footnote">エントリー時</p>
      {review.context ? <PreTradeContextDetail trade={trade} /> : (
        <p className="footnote" data-testid={review.contextState === "unreadable" ? "post-trade-review-unreadable" : "pretrade-missing"}>{missing}</p>
      )}
      {review.contextLabels.length > 0 && (
        <div className="posttrade-review-labels">
          <p>この取引のContext</p>
          <ul aria-label="この取引のContext" data-testid="post-trade-review-labels">
            {review.contextLabels.map(label => <li key={label}>{label}</li>)}
          </ul>
        </div>
      )}
      <p className="footnote" data-testid="post-trade-review-snapshot-note">{POST_TRADE_REVIEW_SNAPSHOT_NOTE}</p>
      <p className="footnote" data-testid="post-trade-review-disclaimer">{POST_TRADE_REVIEW_DISCLAIMER}</p>
    </section>
  );
}
