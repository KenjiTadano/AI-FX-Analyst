"use client";

import { useMemo, useSyncExternalStore } from "react";
import type { AIAnalysis } from "@/lib/ai/types";
import type { DataResource, EconomicEvent } from "@/lib/fundamental/types";
import type { MarketData } from "@/lib/market/types";
import type { RiskSettings } from "@/lib/risk/types";
import type { Trade } from "@/lib/trades/types";
import { parseDailyLossLimitPercent } from "@/lib/trading-plan/daily-plan";
import {
  WORKSPACE_AI_UNAVAILABLE_NOTE,
  WORKSPACE_EYEBROW,
  WORKSPACE_NOTE,
  WORKSPACE_TITLE,
  WORKSPACE_TRIGGER_NOTE,
  buildTradingDecisionWorkspace,
} from "@/lib/dashboard/trading-decision-workspace";
import { Panel } from "./panels";

const LIMIT_KEY = (userId: string) => `ai-fx-analyst.daily-loss-limit-percent:${userId || "anon"}`;

function subscribeLimit(onStoreChange: () => void) {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("storage", onStoreChange);
  window.addEventListener("ai-fx-daily-loss-limit", onStoreChange);
  return () => {
    window.removeEventListener("storage", onStoreChange);
    window.removeEventListener("ai-fx-daily-loss-limit", onStoreChange);
  };
}

function readLimit(userId: string): string {
  try {
    return window.localStorage.getItem(LIMIT_KEY(userId)) ?? "";
  } catch {
    return "";
  }
}

function rateText(value: number | null, decimals: number) {
  return value == null || !Number.isFinite(value) ? "—" : value.toFixed(decimals);
}

function toneForAction(action: string) {
  if (action === "BUY") return "positive";
  if (action === "SELL") return "negative";
  return "neutral";
}

function WorkspaceField({
  label,
  value,
  testId,
  toneClass,
  note,
  className,
}: {
  label: string;
  value: string;
  testId: string;
  toneClass?: string;
  note?: string | null;
  className?: string;
}) {
  return (
    <div className={className ? `tdw-field ${className}` : "tdw-field"}>
      <span className="muted">{label}</span>
      <strong className={toneClass} data-testid={testId}>{value}</strong>
      {note ? <small className="footnote">{note}</small> : null}
    </div>
  );
}

export function TradingDecisionWorkspacePanel({
  pair,
  analysis,
  trades,
  riskSettings,
  currentRate,
  calendar,
  market = null,
  marketError = null,
  rateDecimals = 3,
  userId = "",
  capturedAt,
}: {
  pair: string;
  analysis: AIAnalysis | null;
  trades: Trade[];
  riskSettings: RiskSettings;
  currentRate: number | null;
  calendar?: DataResource<EconomicEvent[]> | null;
  market?: MarketData | null;
  marketError?: string | null;
  rateDecimals?: number;
  userId?: string;
  capturedAt?: string;
}) {
  const storedLimit = useSyncExternalStore(
    subscribeLimit,
    () => readLimit(userId),
    () => "",
  );
  const limitPercent = parseDailyLossLimitPercent(storedLimit);

  const model = useMemo(
    () => buildTradingDecisionWorkspace({
      pair,
      analysis,
      trades,
      riskSettings,
      currentRate,
      market,
      marketError,
      calendar,
      dailyLossLimitPercent: limitPercent,
      capturedAt,
    }),
    [pair, analysis, trades, riskSettings, currentRate, market, marketError, calendar, limitPercent, capturedAt],
  );

  const rateLoading = model.rate.freshness === "loading";

  return (
    <Panel
      title={WORKSPACE_TITLE}
      eyebrow={WORKSPACE_EYEBROW}
      className="reasons-panel trading-decision-workspace"
      testId="trading-decision-workspace"
      ariaLabel="Trading Decision Workspace"
    >
      <p className="footnote">{WORKSPACE_NOTE}</p>
      <p className="footnote" data-testid="tdw-trigger-note">{WORKSPACE_TRIGGER_NOTE}</p>

      <section className="tdw-layer tdw-layer-primary" aria-labelledby="tdw-layer1" data-testid="tdw-layer-summary">
        <h3 id="tdw-layer1">Decision Summary</h3>
        <p className="sr-only">判断サマリー</p>
        <div className="tdw-meta" data-testid="tdw-pair-rate">
          <WorkspaceField label="通貨ペア" value={model.pair} testId="tdw-pair" />
          <WorkspaceField
            label="現在レート"
            value={rateText(model.rate.value, rateDecimals)}
            testId="tdw-rate"
          />
          <WorkspaceField
            label="鮮度"
            value={model.rate.freshnessLabel}
            testId="tdw-freshness"
            note={model.rate.fetchedAt ? `更新: ${new Date(model.rate.fetchedAt).toLocaleString("ja-JP")}` : null}
          />
        </div>
        {rateLoading ? (
          <p className="footnote tdw-placeholder" role="status" data-testid="tdw-rate-loading">
            市場レートを取得中です。仮の数値は表示しません。
          </p>
        ) : null}

        <div className="tdw-decision-grid" data-testid="tdw-decision-grid">
          <WorkspaceField
            className="tdw-primary tdw-direction"
            label="Direction（方向）"
            value={`${model.ai.directionCode} · ${model.ai.directionLabel}`}
            testId="tdw-direction"
            toneClass={toneForAction(model.ai.directionCode === "NEUTRAL" ? "WAIT" : model.ai.directionCode)}
          />
          <WorkspaceField
            className="tdw-primary tdw-action"
            label="Action（行動）"
            value={`${model.ai.actionCode} · ${model.ai.actionLabel}`}
            testId="tdw-action"
            toneClass={toneForAction(model.ai.actionCode)}
          />
          <WorkspaceField
            label="信頼度"
            value={model.ai.confidence == null ? "—" : String(model.ai.confidence)}
            testId="tdw-confidence"
          />
          <WorkspaceField
            label="AI状態"
            value={model.ai.statusLabel}
            testId="tdw-ai-status"
          />
          <WorkspaceField
            label="エントリー準備状況"
            value={`${model.readiness.countLabel} · ${model.readiness.stateLabel}`}
            testId="tdw-readiness"
          />
          <WorkspaceField
            label="エントリー条件"
            value={model.trigger.statusText}
            testId="tdw-trigger"
          />
          <WorkspaceField
            label="イベントリスク"
            value={model.eventRisk.levelLabel}
            testId="tdw-event-risk"
            toneClass={model.eventRisk.highImpact ? "negative" : undefined}
            note={model.eventRisk.highImpact
              ? (model.eventRisk.name ? `高重要度: ${model.eventRisk.name}` : model.eventRisk.message)
              : model.eventRisk.available ? model.eventRisk.message : "Event Risk unavailable"}
          />
        </div>

        {model.ai.unavailableSeparatesWait ? (
          <p className="neutral" role="status" data-testid="tdw-ai-unavailable-note">
            {WORKSPACE_AI_UNAVAILABLE_NOTE}
          </p>
        ) : null}
      </section>

      <section className="tdw-layer tdw-layer-secondary" aria-labelledby="tdw-layer2" data-testid="tdw-layer-market">
        <h3 id="tdw-layer2">Market Context</h3>
        <p className="sr-only">市場コンテキスト</p>
        <div className="tdw-mtf" data-testid="tdw-mtf">
          {model.mtf.frames.map(frame => (
            <div key={frame.timeframe} data-testid={`tdw-mtf-${frame.timeframe}`}>
              <span className="muted">{frame.label}</span>
              <strong>{frame.trend}</strong>
              <small className="footnote">{frame.trendLabel}</small>
            </div>
          ))}
        </div>
        {!model.mtf.available ? (
          <p className="footnote" role="status" data-testid="tdw-mtf-unavailable">MTF unavailable</p>
        ) : null}

        <div className="tdw-regime" data-testid="tdw-regime">
          <WorkspaceField label="レジーム" value={model.regime.regimeLabel} testId="tdw-regime-kind" />
          <WorkspaceField label="トレンド" value={model.regime.trendLabel} testId="tdw-regime-trend" />
          <WorkspaceField label="ボラティリティ" value={model.regime.volatilityLabel} testId="tdw-regime-vol" />
        </div>
        {!model.regime.available ? (
          <p className="footnote" role="status" data-testid="tdw-regime-unavailable">Regime unavailable</p>
        ) : null}
      </section>

      <section className="tdw-layer tdw-layer-secondary" aria-labelledby="tdw-layer3" data-testid="tdw-layer-history">
        <h3 id="tdw-layer3">Historical Reference</h3>
        <p className="sr-only">過去事例の参照</p>
        {model.similar.available ? (
          <div className="tdw-similar" data-testid="tdw-similar">
            <WorkspaceField
              label="類似する過去事例"
              value={`${model.similar.count} matches`}
              testId="tdw-similar-count"
            />
            <WorkspaceField
              label="上位類似度"
              value={model.similar.topPercent == null ? "—" : `${model.similar.topPercent}%`}
              testId="tdw-similar-top"
            />
          </div>
        ) : (
          <p className="footnote" role="status" data-testid="tdw-similar-empty">
            {model.similar.emptyMessage ?? "Similar History unavailable"}
          </p>
        )}
        <p className="footnote">過去の実現損益やR倍数は Workspace 要約に表示しません。</p>
        <a className="tdw-jump" href="#similar-historical-context" data-testid="tdw-jump-similar">
          過去事例の詳細を見る
        </a>
      </section>

      <nav className="tdw-jumps" aria-label="詳細セクションへ">
        <a className="tdw-jump" href="#ia-analysis" data-testid="tdw-jump-ai">Analysis detail</a>
        <a className="tdw-jump" href="#ia-trade-setup" data-testid="tdw-jump-setup">Trade Setup detail</a>
        <a className="tdw-jump" href="#ia-market" data-testid="tdw-jump-market">Market detail</a>
      </nav>
    </Panel>
  );
}
