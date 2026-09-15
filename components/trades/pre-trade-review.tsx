import {
  PRE_TRADE_REVIEW_DISCLAIMER,
  PRE_TRADE_REVIEW_DISTANCE_DISCLAIMER,
  PRE_TRADE_REVIEW_EYEBROW,
  PRE_TRADE_REVIEW_TITLE,
  PRE_TRADE_REVIEW_TRIGGER_DISCLAIMER,
  type PreTradeReviewModel,
} from "@/lib/trades/pre-trade-review";

function row(label: string, value: string, testId: string) {
  return <div><dt>{label}</dt><dd data-testid={testId}>{value}</dd></div>;
}

export function PreTradeReview({ review }: { review: PreTradeReviewModel }) {
  const showPreview = review.saveAnalysis && !!review.context;
  const showTriggerDisclaimer = !!review.context?.trigger || review.triggerStatus === "構造化条件利用不可";
  return (
    <section className="pretrade-review" data-testid="pretrade-review" aria-label={PRE_TRADE_REVIEW_TITLE}>
      <p className="eyebrow">{PRE_TRADE_REVIEW_EYEBROW}</p>
      <h4>{PRE_TRADE_REVIEW_TITLE}</h4>
      <p data-testid="pretrade-review-intent" className="pretrade-review-intent">
        <strong>{review.pair}</strong>
        <span>{review.tradeSide}で登録予定</span>
      </p>
      <dl
        className="pretrade-review-grid"
        data-testid={showPreview ? "pretrade-preview" : "pretrade-review-summary"}
      >
        {row("登録予定", review.tradeSide, "pretrade-review-trade-side")}
        {row("AI方向", review.direction ?? "未取得", "pretrade-review-direction")}
        {row("現在Action", review.action ?? "未取得", "pretrade-review-action")}
        {row("準備度", review.readinessCount, "pretrade-review-readiness")}
        {row("Trigger", review.triggerStatus, "pretrade-review-trigger")}
        {row("Event Risk", review.eventRisk, "pretrade-review-event")}
        {row("分析", review.freshness, "pretrade-review-freshness")}
        {row("想定リスク", review.risk, "pretrade-review-risk")}
        {review.readinessState && row("準備状態", review.readinessState, "pretrade-review-readiness-state")}
        {review.triggerDistance && row("条件まで", review.triggerDistance, "pretrade-review-distance")}
        {review.triggerCheckedAt && row("判定確認", review.triggerCheckedAt, "pretrade-review-checked-at")}
      </dl>
      {review.triggerDistance && <p className="footnote">{PRE_TRADE_REVIEW_DISTANCE_DISCLAIMER}</p>}
      {showTriggerDisclaimer && <p className="footnote">{PRE_TRADE_REVIEW_TRIGGER_DISCLAIMER}</p>}
      {review.warnings.length > 0 && (
        <ul className="pretrade-review-warnings" aria-label="エントリー前の注意" data-testid="pretrade-review-warnings">
          {review.warnings.map(warning => (
            <li
              key={warning.code}
              className={warning.severity === "info" ? "pretrade-review-info" : "pretrade-review-warning"}
              data-testid={`pretrade-review-warning-${warning.code}`}
              data-severity={warning.severity}
            >
              {warning.message}
            </li>
          ))}
        </ul>
      )}
      <p className="footnote" data-testid="pretrade-review-save-message">{review.saveMessage}</p>
      <p className="footnote" data-testid="pretrade-review-disclaimer">{PRE_TRADE_REVIEW_DISCLAIMER}</p>
    </section>
  );
}
