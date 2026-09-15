"use client";

import { useState } from "react";
import { TRIGGER_MET_LABEL, type EntryTriggerEvaluationStatus } from "@/lib/ai/entry-trigger";
import type { EntryReadiness } from "@/lib/trading-plan/entry-readiness";
import {
  WATCH_NEWLY_MET_NOTICE,
  buildEntryTriggerWatch,
  formatWatchCheckedAt,
  formatWatchDistancePips,
  nextWatchTransitionState,
  type WatchTransitionMemory,
} from "@/lib/trading-plan/entry-trigger-watch";

function formatRate(value: number, decimals: number): string {
  const fixed = value.toFixed(decimals);
  return fixed.includes(".") ? fixed.replace(/\.?0+$/, "") : fixed;
}

export function EntryTriggerWatchCard({
  readiness,
  analyzedAt = null,
  rateDecimals = 3,
}: {
  readiness: EntryReadiness;
  analyzedAt?: string | null;
  rateDecimals?: number;
}) {
  const watch = buildEntryTriggerWatch({
    trigger: readiness.entryTrigger,
    evaluation: readiness.triggerEvaluation,
    action: readiness.action,
    direction: readiness.direction,
    stale: readiness.stale,
    dailyLossLimitReached: readiness.dailyLossLimitReached,
    eventRiskHigh: readiness.checks.eventRisk.status === "warning",
    eventRiskMessage: readiness.warnings.find(warning => warning.code === "high_event_risk")?.message ?? readiness.checks.eventRisk.detail,
    analyzedAt,
    pair: readiness.pair,
  });
  const [memory, setMemory] = useState<WatchTransitionMemory | null>(null);
  const evaluationStatus: EntryTriggerEvaluationStatus | null = readiness.triggerEvaluation?.status ?? null;
  const nextMemory = nextWatchTransitionState(memory, {
    identityKey: watch?.identityKey ?? null,
    evaluationStatus,
  });
  if (
    memory?.identityKey !== nextMemory.identityKey
    || memory?.evaluationStatus !== nextMemory.evaluationStatus
    || memory?.newlyMet !== nextMemory.newlyMet
  ) {
    setMemory(nextMemory);
  }
  const newlyMet = nextMemory.newlyMet;

  if (!watch || !readiness.triggerEvaluation) return null;

  const evaluation = readiness.triggerEvaluation;
  const observedText = watch.observedValue == null ? "—" : formatRate(watch.observedValue, rateDecimals);
  const directionText = watch.direction === "NEUTRAL" ? "NEUTRAL" : watch.direction;
  const actionText = watch.action ?? "—";

  return (
    <section className="entry-readiness-card entry-trigger-card entry-trigger-watch" aria-label="ENTRY TRIGGER WATCH" data-testid="entry-trigger">
      <div data-testid="entry-trigger-watch">
        <h3>ENTRY TRIGGER WATCH</h3>
        <p className="footnote">{readiness.triggerSourceLabel}</p>
        <dl className="entry-trigger-watch-hero">
          <div>
            <dt>AI方向</dt>
            <dd data-testid="entry-trigger-watch-direction">{directionText}</dd>
          </div>
          <div>
            <dt>現在Action</dt>
            <dd data-testid="entry-trigger-watch-action">{actionText}</dd>
          </div>
        </dl>
        {readiness.entryTrigger ? (
          <>
            <p data-testid="entry-trigger-human">{watch.humanCondition}</p>
            <p className="entry-trigger-expression" data-testid="entry-trigger-expression">{watch.expression}</p>
            {readiness.entryTrigger.timeframe && (
              <p className="footnote" data-testid="entry-trigger-timeframe">{watch.humanCondition}</p>
            )}
            <dl className="metrics">
              <div>
                <dt>{watch.observedLabel}</dt>
                <dd data-testid="entry-trigger-observed">{observedText}</dd>
              </div>
              {watch.showDistance && watch.distanceToTriggerPips != null && (
                <div>
                  <dt>条件まで</dt>
                  <dd data-testid="entry-trigger-watch-distance">あと {formatWatchDistancePips(watch.distanceToTriggerPips)}</dd>
                </div>
              )}
              {watch.status === "met" && (
                <div>
                  <dt>確認</dt>
                  <dd data-testid="entry-trigger-watch-checked-at">{formatWatchCheckedAt(watch.checkedAt)}</dd>
                </div>
              )}
              <div>
                <dt>判定時刻</dt>
                <dd data-testid="entry-trigger-checked-at">{new Date(evaluation.checkedAt).toLocaleString("ja-JP", { hour12: false })}</dd>
              </div>
            </dl>
          </>
        ) : (
          <p data-testid="entry-trigger-invalid">{watch.invalidMessage ?? evaluation.reason}</p>
        )}
        <p data-testid="entry-trigger-status">
          <span className="entry-readiness-status-label" data-testid="entry-trigger-watch-status">{watch.statusText}</span>
          {" "}
          {watch.status === "met" ? TRIGGER_MET_LABEL : evaluation.reason}
          {watch.status === "unavailable" && watch.unavailableDetail ? ` ${watch.unavailableDetail}` : ""}
        </p>
        {newlyMet && (
          <p className="entry-trigger-watch-notice" role="status" data-testid="entry-trigger-watch-notice">
            {WATCH_NEWLY_MET_NOTICE}
          </p>
        )}
        {watch.staleWarning && <p className="footnote" data-testid="entry-trigger-stale">{watch.staleWarning}</p>}
        <p className="footnote" data-testid="entry-trigger-watch-distance-disclaimer">{watch.distanceDisclaimer}</p>
        <p className="footnote" data-testid="entry-trigger-disclaimer">{watch.triggerDisclaimer}</p>
        {watch.status === "met" && <p className="footnote">{watch.checkedAtNote}</p>}
      </div>
    </section>
  );
}
