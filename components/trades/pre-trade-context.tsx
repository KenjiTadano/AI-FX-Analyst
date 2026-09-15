import { CONFIDENCE_DISCLAIMER } from "@/lib/trading-plan/daily-plan";
import { triggerExpression } from "@/lib/ai/entry-trigger";
import { formatWatchCheckedAt, formatWatchDistancePips } from "@/lib/trading-plan/entry-trigger-watch";
import {
  PRE_TRADE_CHECKED_AT_LABEL,
  PRE_TRADE_EYEBROW,
  PRE_TRADE_MISSING,
  PRE_TRADE_SOURCE_NOTE,
  PRE_TRADE_TITLE,
  formatPreTradeEvent,
  formatPreTradeTriggerStatus,
} from "@/lib/trades/pre-trade-context";
import { isRichSnapshot } from "@/lib/trades/snapshot";
import type { PreTradeContextSnapshot, Trade } from "@/lib/trades/types";
import { money } from "./format";

function row(label: string, value: string, testId: string) {
  return <div><dt>{label}</dt><dd data-testid={testId}>{value}</dd></div>;
}

export function PreTradeContextPreview({ context }: { context: PreTradeContextSnapshot | null }) {
  if (!context) return null;
  return (
    <div className="pretrade-preview" data-testid="pretrade-preview">
      <p><strong>保存される判断状況</strong></p>
      <p className="eyebrow">{PRE_TRADE_EYEBROW}</p>
      <p>AI方向 {context.direction ?? "—"}</p>
      <p>Action {context.action ?? "—"}</p>
      <p>Readiness {context.readiness ? `${context.readiness.confirmedCount} / ${context.readiness.totalCount}` : "—"}</p>
      <p>Trigger {formatPreTradeTriggerStatus(context)}</p>
    </div>
  );
}

export function PreTradeContextDetail({
  trade,
}: {
  trade: Trade;
}) {
  const snapshot = isRichSnapshot(trade.analysisSnapshot) ? trade.analysisSnapshot : null;
  const context = snapshot?.preTradeContext ?? null;
  if (!context) {
    return <p className="footnote" data-testid="pretrade-missing">{PRE_TRADE_MISSING}</p>;
  }
  const trigger = context.trigger;
  const observed = trigger?.evaluation.observedValue;
  const checkedAt = trigger?.evaluation.checkedAt;
  const distance = trigger?.evaluation.distanceToTriggerPips;
  return (
    <section className="pretrade-context" aria-label={PRE_TRADE_TITLE} data-testid="pretrade-context">
      <h4>{PRE_TRADE_TITLE}</h4>
      <p className="eyebrow">{PRE_TRADE_EYEBROW}</p>
      <p className="footnote" data-testid="pretrade-source-note">{PRE_TRADE_SOURCE_NOTE}</p>
      <dl className="pretrade-grid">
        {row("AI方向", context.direction ?? "—", "pretrade-direction")}
        {row("Action", context.action ?? "—", "pretrade-action")}
        {row("準備度", context.readiness ? `${context.readiness.confirmedCount} / ${context.readiness.totalCount}` : "—", "pretrade-readiness")}
        {row("Trigger", formatPreTradeTriggerStatus(context), "pretrade-trigger-status")}
        {trigger && row("条件", triggerExpression(trigger.structuredTrigger), "pretrade-trigger-expression")}
        {observed != null && row("確認値", String(observed), "pretrade-observed")}
        {checkedAt && row(PRE_TRADE_CHECKED_AT_LABEL, formatWatchCheckedAt(checkedAt), "pretrade-checked-at")}
        {distance != null && trigger?.evaluation.status === "not_met" && row("条件まで", formatWatchDistancePips(distance), "pretrade-distance")}
        {row("DQ", context.dataQuality?.score != null ? String(context.dataQuality.score) : "—", "pretrade-dq")}
        {row("Confidence", context.confidence != null ? String(context.confidence) : "—", "pretrade-confidence")}
        {row("Event", formatPreTradeEvent(context), "pretrade-event")}
        {row("Risk", context.risk ? money(context.risk.riskPerTrade) : "—", "pretrade-risk")}
      </dl>
      {context.analysisStale && <p data-testid="pretrade-stale">分析期限切れの状態で登録</p>}
      {context.dailyLossLimitReached && <p data-testid="pretrade-dll">Daily Loss Limit到達時に登録</p>}
      {context.confidence != null && <p className="footnote">{CONFIDENCE_DISCLAIMER}</p>}
    </section>
  );
}
