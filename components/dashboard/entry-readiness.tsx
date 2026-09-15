"use client";

import {
  ENTRY_READINESS_DISCLAIMER,
  WAIT_ACTION_MESSAGE,
  type EntryReadiness,
  type ReadinessCheck,
} from "@/lib/trading-plan/entry-readiness";
import { CONFIDENCE_DISCLAIMER } from "@/lib/trading-plan/daily-plan";
import { EntryTriggerWatchCard } from "./entry-trigger-watch";
import { Panel } from "./panels";

const mark = (status: ReadinessCheck["status"]) => {
  if (status === "confirmed") return "✓";
  if (status === "warning") return "!";
  if (status === "pending") return "—";
  return "×";
};

function CheckRow({ check }: { check: ReadinessCheck }) {
  return (
    <li className={`entry-readiness-check entry-readiness-${check.status}`} data-testid={`entry-readiness-check-${check.id}`}>
      <span className="entry-readiness-mark" aria-hidden="true">{mark(check.status)}</span>
      <div>
        <p>
          <strong>{check.title}</strong>
          <span className="entry-readiness-status-label">{check.statusLabel}</span>
        </p>
        <p className="footnote">{check.detail}</p>
      </div>
    </li>
  );
}

export function EntryReadinessPanel({
  readiness,
  onRefresh,
  refreshing = false,
  analyzedAt = null,
  rateDecimals = 3,
}: {
  readiness: EntryReadiness;
  onRefresh?: () => void;
  refreshing?: boolean;
  analyzedAt?: string | null;
  rateDecimals?: number;
}) {
  const showRefresh = (readiness.stale || readiness.state === "unavailable") && !!onRefresh;
  return (
    <Panel title="エントリー準備度" eyebrow="ENTRY READINESS" className="entry-readiness-panel" testId="entry-readiness">
      <div className={`entry-readiness-hero entry-readiness-state-${readiness.state}`} data-testid="entry-readiness-hero">
        <p className="eyebrow">エントリー準備度</p>
        <p className="entry-readiness-count" data-testid="entry-readiness-count">{readiness.confirmedCount} / {readiness.totalCount} 条件確認</p>
        <p className="footnote" data-testid="entry-readiness-state">{readiness.stateMessage}</p>
        <p className="muted">現在Action</p>
        <p className="entry-readiness-action-word" data-testid="entry-readiness-action">{readiness.action ?? "—"}</p>
        <p className="entry-readiness-action-message" data-testid="entry-readiness-action-message">{readiness.actionMessage}</p>
        <p className="entry-readiness-guidance" data-testid="entry-readiness-guidance">{readiness.guidance}</p>
      </div>

      {readiness.warnings[0] && (
        <div className="entry-readiness-alert" role={readiness.dailyLossLimitReached ? "alert" : "status"} data-testid="entry-readiness-warning">
          {readiness.warnings.map(warning => <p key={warning.code}>{warning.message}</p>)}
          {showRefresh && (
            <button type="button" className="journal-primary" disabled={refreshing} onClick={onRefresh}>
              {refreshing ? "AI総合分析を更新中…" : "AI総合分析を更新"}
            </button>
          )}
        </div>
      )}

      {readiness.chartEvidenceUsed && <span className="badge positive" data-testid="entry-readiness-chart">チャート解析を含む（任意）</span>}

      <ul className="entry-readiness-list" aria-label="確認項目">
        <CheckRow check={readiness.checks.analysis} />
        <CheckRow check={readiness.checks.direction} />
        <CheckRow check={readiness.checks.dataQuality} />
        <CheckRow check={readiness.checks.risk} />
        <CheckRow check={readiness.checks.eventRisk} />
      </ul>

      <section className="entry-readiness-card" aria-label="確認すべきEntry条件" data-testid="entry-readiness-entry-condition">
        <h3>確認すべきEntry条件</h3>
        <p>
          <span className="entry-readiness-status-label">{readiness.entryCondition.statusLabel}</span>
          {" "}
          {readiness.entryCondition.label}
        </p>
        {readiness.entryCondition.text
          ? <p data-testid="entry-readiness-condition-text">{readiness.entryCondition.text}</p>
          : <p className="muted">Entry条件：データなし</p>}
        <p className="footnote" data-testid="entry-readiness-condition-note">{readiness.entryCondition.note}</p>
      </section>

      <EntryTriggerWatchCard readiness={readiness} analyzedAt={analyzedAt} rateDecimals={rateDecimals} />

      {readiness.confidence != null && (
        <p className="footnote" data-testid="entry-readiness-confidence">参考: Confidence {readiness.confidence}（勝率ではありません）</p>
      )}
      <p className="footnote">{CONFIDENCE_DISCLAIMER}</p>
      <p className="footnote" data-testid="entry-readiness-disclaimer">{ENTRY_READINESS_DISCLAIMER}</p>
      {readiness.action === "WAIT" && <p className="footnote" data-testid="entry-readiness-wait-priority">{WAIT_ACTION_MESSAGE}</p>}
    </Panel>
  );
}
