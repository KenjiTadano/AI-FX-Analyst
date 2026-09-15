"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { AIAnalysis } from "@/lib/ai/types";
import type { DataResource, EconomicEvent } from "@/lib/fundamental/types";
import type { RiskSettings } from "@/lib/risk/types";
import type { Trade } from "@/lib/trades/types";
import {
  ANALYSIS_STALE_MESSAGE,
  CONFIDENCE_DISCLAIMER,
  NO_AUTO_TRADING_COPY,
  UNAVAILABLE_MESSAGE,
  buildDailyTradingPlan,
  parseDailyLossLimitPercent,
  type DailyPlanStatus,
} from "@/lib/trading-plan/daily-plan";
import { Panel } from "./panels";

const LIMIT_KEY = (userId: string) => `ai-fx-analyst.daily-loss-limit-percent:${userId || "anon"}`;
const money = (n: number | null | undefined) => n == null || !Number.isFinite(n)
  ? "—"
  : new Intl.NumberFormat("ja-JP", { style: "currency", currency: "JPY", maximumFractionDigits: 2 }).format(n);
const signedMoney = (n: number) => `${n > 0 ? "+" : ""}${money(n)}`;
const rateText = (value: number | null, decimals: number) => value == null || !Number.isFinite(value) ? "—" : value.toFixed(decimals);
const localTime = (value: string | null) => value ? new Date(value).toLocaleString("ja-JP", { hour12: false }) : "—";
const actionTone = (action: string | null) => action === "BUY" ? "positive" : action === "SELL" ? "negative" : "neutral";
const statusLabel: Record<DailyPlanStatus, string> = {
  wait: "WAIT",
  review_buy: "BUY条件確認",
  review_sell: "SELL条件確認",
  risk_limit: "Daily Loss Limit",
  stale: "分析期限切れ",
  unavailable: "未取得",
};
const eventLevelLabel: Record<string, string> = { high: "高", medium: "中", low: "低", unknown: "不明" };

function subscribeLimit(onStoreChange: () => void) {
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

function writeLimit(userId: string, value: string) {
  const parsed = parseDailyLossLimitPercent(value);
  try {
    if (parsed == null) window.localStorage.removeItem(LIMIT_KEY(userId));
    else window.localStorage.setItem(LIMIT_KEY(userId), String(parsed));
    window.dispatchEvent(new Event("ai-fx-daily-loss-limit"));
  } catch { /* private mode */ }
}

export function DailyTradingPlanPanel({
  pair,
  analysis,
  trades,
  riskSettings,
  currentRate,
  calendar,
  rateDecimals = 3,
  userId = "",
  onRefresh,
  refreshing = false,
}: {
  pair: string;
  analysis: AIAnalysis | null;
  trades: Trade[];
  riskSettings: RiskSettings;
  currentRate: number | null;
  calendar?: DataResource<EconomicEvent[]> | null;
  rateDecimals?: number;
  userId?: string;
  onRefresh?: () => void;
  refreshing?: boolean;
}) {
  const [now, setNow] = useState(0);
  const [limitDraft, setLimitDraft] = useState<string | null>(null);
  const storedLimit = useSyncExternalStore(subscribeLimit, () => readLimit(userId), () => "");
  const limitField = limitDraft ?? storedLimit;
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const immediate = setTimeout(tick, 0);
    const timer = setInterval(tick, 1000);
    return () => { clearTimeout(immediate); clearInterval(timer); };
  }, []);
  const limitPercent = parseDailyLossLimitPercent(limitField);
  const plan = useMemo(() => buildDailyTradingPlan({
    pair,
    analysis,
    trades,
    riskSettings,
    currentRate,
    calendar,
    dailyLossLimitPercent: limitPercent,
    now,
  }), [pair, analysis, trades, riskSettings, currentRate, calendar, limitPercent, now]);

  function changeLimit(value: string) {
    setLimitDraft(value);
    writeLimit(userId, value);
  }

  return (
    <Panel title="今日のトレード計画" eyebrow="DAILY TRADING PLAN" className="daily-plan-panel">
      <div className="daily-plan-header">
        <div>
          <p className="muted daily-plan-pair" data-testid="daily-plan-pair">{plan.pair}</p>
          <p className="daily-plan-rate">現在レート <strong>{rateText(plan.currentRate, rateDecimals)}</strong></p>
          <p className="footnote">分析時刻 {localTime(plan.analyzedAt)}</p>
        </div>
        <dl className="daily-plan-meta" aria-label="計画の要約">
          <div><dt>AI方向</dt><dd className={actionTone(plan.direction === "NEUTRAL" ? "WAIT" : plan.direction)} data-testid="daily-plan-direction">{plan.direction}</dd></div>
          <div><dt>現在Action</dt><dd className={actionTone(plan.action)} data-testid="daily-plan-action">{plan.action ?? "—"}</dd></div>
          <div><dt>Confidence</dt><dd data-testid="daily-plan-confidence">{plan.confidence != null ? plan.confidence : "—"}</dd></div>
          <div><dt>Data Quality</dt><dd data-testid="daily-plan-quality">{plan.dataQuality != null ? plan.dataQuality : "—"}</dd></div>
        </dl>
      </div>

      <div className={`daily-plan-hero daily-plan-${plan.status}`} data-testid="daily-plan-hero">
        <p className="eyebrow">今のAction</p>
        <p className={`daily-plan-status-word ${actionTone(plan.action)}`} data-testid="daily-plan-status">{statusLabel[plan.status]}</p>
        <p className="daily-plan-message" data-testid="daily-plan-message">{plan.mainMessage}</p>
        {plan.directionNote && <p className="daily-plan-direction-note" data-testid="daily-plan-direction-note">{plan.directionNote}</p>}
        <p className="footnote">理由：{plan.statusReason}</p>
      </div>

      {plan.stale && plan.status !== "unavailable" && (
        <div className="daily-plan-alert" role="status">
          <p>{ANALYSIS_STALE_MESSAGE}。再分析を推奨します。</p>
          {onRefresh && <button type="button" className="journal-primary" disabled={refreshing} onClick={onRefresh}>{refreshing ? "AI総合分析を更新中…" : "AI総合分析を更新"}</button>}
        </div>
      )}
      {plan.status === "unavailable" && (
        <div className="daily-plan-alert" role="status">
          <p>{UNAVAILABLE_MESSAGE}</p>
          {onRefresh && <button type="button" className="journal-primary" disabled={refreshing} onClick={onRefresh}>{refreshing ? "AI総合分析を更新中…" : "AI総合分析を更新"}</button>}
        </div>
      )}
      {plan.status === "risk_limit" && (
        <p className="daily-plan-limit-alert" role="alert">{plan.mainMessage}。注文は自動制御されません。</p>
      )}

      {plan.chartEvidenceUsed && <span className="badge positive" data-testid="daily-plan-chart-badge">チャート解析を含む</span>}

      <div className="daily-plan-grid">
        <section className="daily-plan-card" aria-label="Entry条件">
          <h3>Entry条件</h3>
          {plan.entryCondition ? (
            <>
              <p data-testid="daily-plan-entry">{plan.direction === "SELL" ? "SELL検討条件" : plan.direction === "BUY" ? "BUY検討条件" : "検討条件"}</p>
              <p>{plan.entryCondition}</p>
            </>
          ) : <p className="muted" data-testid="daily-plan-entry">Entry条件：データなし</p>}
          <p className="footnote" data-testid="daily-plan-invalidation">{plan.invalidationCondition ?? "無効化条件：データなし"}</p>
          {(plan.stopLoss != null || plan.takeProfit != null) && (
            <dl className="metrics">
              {plan.stopLoss != null && <div><dt>Stop Loss</dt><dd className="negative">{plan.stopLoss.toFixed(rateDecimals)}</dd></div>}
              {plan.takeProfit != null && <div><dt>Take Profit</dt><dd className="positive">{plan.takeProfit.toFixed(rateDecimals)}</dd></div>}
            </dl>
          )}
          {plan.conditionSource && <p className="footnote">{plan.conditionSource}</p>}
        </section>

        <section className="daily-plan-card" aria-label="今日のRisk基準">
          <h3>Risk</h3>
          <dl className="metrics">
            <div><dt>資金</dt><dd>{money(plan.capital)}</dd></div>
            <div><dt>1回あたりRisk</dt><dd>{plan.riskPercent != null ? `${plan.riskPercent}%` : "—"}</dd></div>
            <div><dt>1回あたりRisk基準</dt><dd data-testid="daily-plan-risk-per-trade">{money(plan.riskPerTrade)}</dd></div>
            <div><dt>Daily Loss Limit</dt><dd data-testid="daily-plan-loss-limit">{plan.dailyLossLimit != null ? money(plan.dailyLossLimit) : "未設定"}</dd></div>
            {plan.dailyLossRemaining != null && <div><dt>残りDaily Loss許容額</dt><dd>{money(plan.dailyLossRemaining)}</dd></div>}
          </dl>
          <label className="daily-plan-limit">Daily Loss Limit（資金に対する%、ユーザー設定）
            <input type="number" inputMode="decimal" min="0.1" max="10" step="0.1" value={limitField} placeholder="未設定" onChange={event => changeLimit(event.target.value)} />
          </label>
          <p className="footnote">AI推奨値ではありません。Task006の1回あたりRiskとは別です。未設定なら日次上限は計算しません。</p>
        </section>

        <section className="daily-plan-card" aria-label="Event Risk">
          <h3>Event Risk</h3>
          <p><span className="badge">{eventLevelLabel[plan.eventRisk.level] ?? "不明"}</span></p>
          <p data-testid="daily-plan-event">{plan.eventRisk.message}</p>
          {plan.eventRisk.name && <p className="footnote">{plan.eventRisk.name}{plan.eventRisk.scheduledAt ? ` · ${localTime(plan.eventRisk.scheduledAt)}` : ""}</p>}
          <p className="footnote">経済カレンダーの既存データのみ。FRED実績を未来の発表時刻には使いません。</p>
        </section>

        <section className="daily-plan-card" aria-label="Today's Result">
          <h3>Today&apos;s Result</h3>
          <p className="footnote">{plan.todayScopeLabel}</p>
          <dl className="metrics">
            <div><dt>今日の取引</dt><dd data-testid="daily-plan-today-count">{plan.todayTradeCount}件</dd></div>
            <div><dt>決済済み</dt><dd>{plan.todayClosedCount}件</dd></div>
            <div><dt>本日確定損益</dt><dd className={plan.todayRealizedPnl > 0 ? "positive" : plan.todayRealizedPnl < 0 ? "negative" : ""} data-testid="daily-plan-today-pnl">{signedMoney(plan.todayRealizedPnl)}</dd></div>
            <div><dt>選択ペア</dt><dd>{plan.todayPairTradeCount}件</dd></div>
          </dl>
        </section>
      </div>

      <p className="footnote" data-testid="daily-plan-confidence-disclaimer">{CONFIDENCE_DISCLAIMER}</p>
      <p className="footnote" data-testid="daily-plan-no-auto">{NO_AUTO_TRADING_COPY}</p>
    </Panel>
  );
}
