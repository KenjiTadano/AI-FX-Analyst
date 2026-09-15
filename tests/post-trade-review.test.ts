import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { EntryTriggerEvaluationStatus } from "../lib/ai/entry-trigger";
import {
  POST_TRADE_REVIEW_DISCLAIMER,
  POST_TRADE_REVIEW_MISSING,
  POST_TRADE_REVIEW_SNAPSHOT_NOTE,
  POST_TRADE_REVIEW_UNREADABLE,
  buildContextLabels,
  buildPostTradeReview,
  formatHoldingDuration,
  holdingDurationMinutes,
  storedPreTradeContext,
} from "../lib/trades/post-trade-review";
import { closeTrade, createTrade, editTrade } from "../lib/trades/service";
import type { PreTradeContextSnapshot, Trade, TradeAiAnalysisSnapshot, TradeAnalysisSnapshot, TradeDraft } from "../lib/trades/types";

const NOW = "2026-09-15T03:15:00.000Z";
const SOURCE = [
  readFileSync(join(process.cwd(), "lib/trades/post-trade-review.ts"), "utf8"),
  readFileSync(join(process.cwd(), "components/trades/post-trade-review.tsx"), "utf8"),
].join("\n");

const FORBIDDEN =
  /ルール遵守|ルール違反|正しいEntry|間違ったEntry|良いEntry|悪いEntry|成功した判断|失敗した判断|Triggerを待つべき|WAITを無視|勝ちパターン|次回は|改善すべき|goodEntry|badEntry|ruleFollowed|ruleBroken|正しい判断だった|間違った判断だった|Triggerを守った/;

function triggerEval(status: EntryTriggerEvaluationStatus, extra: Partial<NonNullable<PreTradeContextSnapshot["trigger"]>["evaluation"]> = {}): NonNullable<PreTradeContextSnapshot["trigger"]> {
  return {
    structuredTrigger: {
      version: 1,
      type: "price_below",
      pair: "USD/JPY",
      price: 156.2,
      timeframe: null,
      sourceCondition: "現在価格が156.20を下回った場合",
    },
    evaluation: { status, observedValue: 156.18, checkedAt: NOW, distanceToTriggerPips: 0, ...extra },
  };
}

function context(partial: Partial<PreTradeContextSnapshot> = {}): PreTradeContextSnapshot {
  return {
    version: 1,
    capturedAt: NOW,
    pair: "USD/JPY",
    direction: "SELL",
    action: "WAIT",
    readiness: { confirmedCount: 5, totalCount: 5, state: "waiting" },
    trigger: triggerEval("met"),
    dataQuality: { score: 82 },
    confidence: 76,
    eventRisk: { level: "low", available: true },
    risk: { capital: 50_000, riskPercent: 1, riskPerTrade: 500 },
    dailyLossLimitPercent: 3,
    dailyLossRemaining: 1_000,
    dailyLossLimitReached: false,
    analysisStale: false,
    eventRiskHigh: false,
    ...partial,
  };
}

function snap(preTrade?: PreTradeContextSnapshot | null): TradeAiAnalysisSnapshot {
  return {
    pair: "USD/JPY",
    signal: "wait",
    score: 10,
    confidence: 70,
    summary: "t025",
    dataQualityScore: 80,
    analyzedAt: NOW,
    capturedAt: NOW,
    expiresAt: NOW,
    aiStatus: "available",
    model: "x",
    bullishReasons: [],
    bearishReasons: [],
    version: 1,
    directionSignal: "sell",
    action: preTrade?.action ?? "WAIT",
    marketPrice: 156.5,
    analysisPrice: 156.5,
    factors: [],
    scenario: null,
    dataQuality: {
      score: 80,
      missingData: [],
      categories: {
        technical: { status: "ok", detail: "", fraction: 1 },
        news: { status: "ok", detail: "", fraction: 1 },
        economic: { status: "ok", detail: "", fraction: 1 },
        central_bank: { status: "ok", detail: "", fraction: 1 },
        market_environment: { status: "ok", detail: "", fraction: 1 },
      },
      macroeconomicData: { status: "ok", detail: "", fraction: 1 },
    },
    economicRisk: null,
    chartEvidence: null,
    chartAnalysis: null,
    aiCode: null,
    isFallback: false,
    ...(preTrade !== undefined ? { preTradeContext: preTrade } : {}),
  };
}

function legacySnap(): TradeAnalysisSnapshot {
  return {
    pair: "USD/JPY", signal: "sell", score: 10, confidence: 70, summary: "legacy",
    dataQualityScore: 80, analyzedAt: NOW, capturedAt: NOW, expiresAt: NOW,
    aiStatus: "available", model: "x", bullishReasons: [], bearishReasons: [],
  };
}

function trade(partial: Partial<Trade> & Pick<Trade, "id">): Trade {
  return {
    pair: "USD/JPY",
    side: "short",
    status: "closed",
    quantity: 1000,
    entryPrice: 156.5,
    exitPrice: 156.0,
    openedAt: NOW,
    closedAt: NOW,
    stopLoss: null,
    takeProfit: null,
    notes: "",
    realizedPnl: 500,
    analysisSnapshot: snap(context()),
    createdAt: NOW,
    updatedAt: NOW,
    ...partial,
  };
}

function draft(): TradeDraft {
  return {
    pair: "USD/JPY", side: "short", status: "open", quantity: 1000, entryPrice: 156.5, exitPrice: null,
    openedAt: NOW, closedAt: null, stopLoss: null, takeProfit: null, notes: "T025",
  };
}

test("A: OPEN no review", () => {
  assert.equal(buildPostTradeReview(trade({ id: "a", status: "open", realizedPnl: null, closedAt: null, exitPrice: null })), null);
});

test("B: CLOSED review", () => {
  const review = buildPostTradeReview(trade({ id: "b" }));
  assert.ok(review);
  assert.equal(review.pair, "USD/JPY");
});

test("C: profit", () => {
  const review = buildPostTradeReview(trade({ id: "c", realizedPnl: 820 }))!;
  assert.equal(review.outcome.result, "profit");
  assert.equal(review.outcome.resultLabel, "利益");
  assert.equal(review.outcome.realizedPnl, 820);
});

test("D: loss", () => {
  const review = buildPostTradeReview(trade({ id: "d", realizedPnl: -820, exitPrice: 157.32 }))!;
  assert.equal(review.outcome.result, "loss");
  assert.equal(review.outcome.resultLabel, "損失");
});

test("E: flat", () => {
  const review = buildPostTradeReview(trade({ id: "e", realizedPnl: 0, exitPrice: 156.5 }))!;
  assert.equal(review.outcome.result, "flat");
  assert.equal(review.outcome.resultLabel, "損益なし");
});

test("F: realizedPnl source of truth", () => {
  const review = buildPostTradeReview(trade({ id: "f", realizedPnl: 820, entryPrice: 156.5, exitPrice: 156.0 }))!;
  assert.equal(review.outcome.realizedPnl, 820);
});

test("G: holding 35m", () => {
  assert.equal(formatHoldingDuration(holdingDurationMinutes("2026-09-15T03:00:00.000Z", "2026-09-15T03:35:00.000Z")), "35分");
});

test("H: holding 2h35m", () => {
  assert.equal(formatHoldingDuration(holdingDurationMinutes("2026-09-15T03:00:00.000Z", "2026-09-15T05:35:00.000Z")), "2時間35分");
});

test("I: holding 1d3h", () => {
  assert.equal(formatHoldingDuration(holdingDurationMinutes("2026-09-14T03:00:00.000Z", "2026-09-15T06:00:00.000Z")), "1日3時間");
});

test("J: invalid openedAt", () => {
  const review = buildPostTradeReview(trade({ id: "j", openedAt: "not-a-date" }))!;
  assert.equal(review.outcome.holdingDurationMinutes, null);
  assert.equal(review.outcome.holdingDurationLabel, "—");
});

test("K: invalid closedAt", () => {
  const review = buildPostTradeReview(trade({ id: "k", closedAt: "nope" }))!;
  assert.equal(review.outcome.holdingDurationLabel, "—");
});

test("L: closed < opened => —", () => {
  const review = buildPostTradeReview(trade({ id: "l", openedAt: "2026-09-15T05:00:00.000Z", closedAt: "2026-09-15T03:00:00.000Z" }))!;
  assert.equal(review.outcome.holdingDurationLabel, "—");
});

test("M: Trade SELL vs AI SELL separate", () => {
  const review = buildPostTradeReview(trade({ id: "m" }))!;
  assert.equal(review.tradeSide, "SELL");
  assert.equal(review.direction, "SELL");
});

test("N: Trade BUY vs AI SELL separate", () => {
  const review = buildPostTradeReview(trade({ id: "n", side: "long", realizedPnl: -500, entryPrice: 156.5, exitPrice: 156.0 }))!;
  assert.equal(review.tradeSide, "BUY");
  assert.equal(review.direction, "SELL");
});

test("O: Action WAIT factual", () => {
  const review = buildPostTradeReview(trade({ id: "o" }))!;
  assert.equal(review.action, "WAIT");
  assert.ok(review.contextLabels.some(item => item === "Action WAIT時に登録"));
  assert.doesNotMatch(review.contextLabels.join("\n"), /違反|無視/);
});

test("P: readiness 5/5", () => {
  assert.equal(buildPostTradeReview(trade({ id: "p" }))!.readinessCount, "5 / 5");
});

test("Q: 5/5 not Entry OK", () => {
  const review = buildPostTradeReview(trade({ id: "q" }))!;
  assert.doesNotMatch(JSON.stringify(review), /Entry OK|準備万全/);
});

test("R: trigger met", () => {
  assert.equal(buildPostTradeReview(trade({ id: "r" }))!.triggerStatus, "条件成立");
});

test("S: trigger not_met", () => {
  const review = buildPostTradeReview(trade({ id: "s", analysisSnapshot: snap(context({ trigger: triggerEval("not_met", { distanceToTriggerPips: 8, observedValue: 156.28 }) })) }))!;
  assert.equal(review.triggerStatus, "条件未成立");
  assert.equal(review.triggerDistance, "条件まであと 8 pips");
});

test("T: equality not_met + 0", () => {
  const review = buildPostTradeReview(trade({ id: "t", analysisSnapshot: snap(context({ trigger: triggerEval("not_met", { distanceToTriggerPips: 0, observedValue: 156.2 }) })) }))!;
  assert.equal(review.triggerStatus, "条件未成立");
  assert.equal(review.triggerDistance, "条件まであと 0 pips");
});

test("U: trigger unavailable", () => {
  const review = buildPostTradeReview(trade({ id: "u", analysisSnapshot: snap(context({ trigger: triggerEval("unavailable", { observedValue: null, distanceToTriggerPips: null }) })) }))!;
  assert.equal(review.triggerStatus, "判定データ不足");
});

test("V: trigger null", () => {
  const review = buildPostTradeReview(trade({ id: "v", analysisSnapshot: snap(context({ trigger: null })) }))!;
  assert.equal(review.triggerStatus, "Triggerなし");
  assert.ok(review.contextLabels.includes("Triggerなしで登録"));
});

test("W: checkedAt", () => {
  assert.equal(buildPostTradeReview(trade({ id: "w" }))!.triggerCheckedAt, NOW);
});

test("X: Event LOW", () => {
  assert.equal(buildPostTradeReview(trade({ id: "x" }))!.eventRisk, "LOW");
});

test("Y: Event HIGH", () => {
  const review = buildPostTradeReview(trade({ id: "y", analysisSnapshot: snap(context({ eventRisk: { level: "high", available: true }, eventRiskHigh: true })) }))!;
  assert.equal(review.eventRisk, "HIGH");
});

test("Z: Event unavailable", () => {
  const review = buildPostTradeReview(trade({ id: "z", analysisSnapshot: snap(context({ eventRisk: { level: "unknown", available: false }, eventRiskHigh: false })) }))!;
  assert.equal(review.eventRisk, "未取得");
  assert.notEqual(review.eventRisk, "LOW");
});

test("AA: fresh", () => {
  assert.equal(buildPostTradeReview(trade({ id: "aa" }))!.freshness, "最新分析");
});

test("AB: stale", () => {
  const review = buildPostTradeReview(trade({ id: "ab", analysisSnapshot: snap(context({ analysisStale: true })) }))!;
  assert.equal(review.freshness, "期限切れ分析");
});

test("AC: Risk", () => {
  assert.match(buildPostTradeReview(trade({ id: "ac" }))!.risk, /500円 \/ 1\.0%/);
});

test("AD: DLL reached", () => {
  const review = buildPostTradeReview(trade({ id: "ad", analysisSnapshot: snap(context({ dailyLossLimitReached: true, dailyLossRemaining: 0 })) }))!;
  assert.equal(review.dailyLossLimit, "到達");
  assert.ok(review.contextLabels.includes("Daily Loss Limit到達時に登録"));
  assert.doesNotMatch(review.contextLabels.join("\n"), /ルール違反/);
});

test("AE: context labels order", () => {
  assert.deepEqual(buildContextLabels(context()), [
    "Trigger条件成立時に登録",
    "Action WAIT時に登録",
    "最新分析時に登録",
    "Event Risk LOW時に登録",
    "Daily Loss Limit未到達時に登録",
  ]);
});

test("AF: context labels cap", () => {
  assert.equal(buildContextLabels(context()).length, 5);
});

test("AG: MET not compliance", () => {
  assert.doesNotMatch(buildPostTradeReview(trade({ id: "ag" }))!.contextLabels.join("\n"), /遵守|守った/);
});

test("AH: WAIT not violation", () => {
  assert.doesNotMatch(JSON.stringify(buildPostTradeReview(trade({ id: "ah" }))), /WAITを無視|違反/);
});

test("AI: profit not good entry", () => {
  assert.doesNotMatch(JSON.stringify(buildPostTradeReview(trade({ id: "ai", realizedPnl: 820 }))), FORBIDDEN);
});

test("AJ: loss not bad entry", () => {
  const same = context();
  const profit = buildPostTradeReview(trade({ id: "aj1", realizedPnl: 820, analysisSnapshot: snap(same) }))!;
  const loss = buildPostTradeReview(trade({ id: "aj2", realizedPnl: -820, analysisSnapshot: snap(same) }))!;
  assert.deepEqual(loss.context, profit.context);
  assert.deepEqual(loss.contextLabels, profit.contextLabels);
  assert.equal(loss.triggerStatus, profit.triggerStatus);
  assert.doesNotMatch(JSON.stringify(loss), FORBIDDEN);
});

test("AK: no causal text", () => {
  assert.doesNotMatch(SOURCE, /利益につなが|損失になりました|敗因|損失原因/);
  assert.match(POST_TRADE_REVIEW_SNAPSHOT_NOTE, /後から変更・再評価していません/);
});

test("AL: no future prediction", () => {
  assert.doesNotMatch(SOURCE, /将来勝率|勝率予測|必ず勝て/);
  assert.match(POST_TRADE_REVIEW_DISCLAIMER, /将来の成果を示すものではありません/);
});

test("AM: legacy closed review", () => {
  const review = buildPostTradeReview(trade({ id: "am", analysisSnapshot: null }))!;
  assert.equal(review.contextState, "absent");
  assert.equal(review.context, null);
  assert.equal(review.outcome.result, "profit");
  assert.deepEqual(review.contextLabels, []);
});

test("AN: Task013-only legacy context missing", () => {
  const review = buildPostTradeReview(trade({ id: "an", analysisSnapshot: legacySnap() }))!;
  assert.equal(review.contextState, "absent");
  assert.notEqual(review.triggerStatus, "Triggerなし");
});

test("AO: invalid context", () => {
  const review = buildPostTradeReview(trade({
    id: "ao",
    analysisSnapshot: snap({ version: 1, pair: "USD/JPY", direction: "SIDEWAYS" } as never),
  }))!;
  assert.equal(review.context, null);
  assert.equal(review.contextState, "unreadable");
});

test("AP: pair mismatch", () => {
  const review = buildPostTradeReview(trade({
    id: "ap",
    pair: "USD/JPY",
    analysisSnapshot: snap(context({ pair: "EUR/JPY" })),
  }))!;
  assert.equal(review.context, null);
  assert.equal(review.contextState, "unreadable");
});

test("AQ: sanitizer reuse", () => {
  const item = trade({ id: "aq" });
  assert.deepEqual(storedPreTradeContext(item), item.analysisSnapshot && "preTradeContext" in item.analysisSnapshot
    ? item.analysisSnapshot.preTradeContext
    : null);
});

test("AR: no mutation", () => {
  const item = trade({ id: "ar" });
  const before = JSON.stringify(item);
  buildPostTradeReview(item);
  assert.equal(JSON.stringify(item), before);
});

test("AS-AV: no fetch OpenAI Supabase polling", () => {
  assert.doesNotMatch(SOURCE, /\bfetch\s*\(/);
  assert.doesNotMatch(SOURCE, /openai|responses\.create/i);
  assert.doesNotMatch(SOURCE, /supabase|from\("trades"\)/i);
  assert.doesNotMatch(SOURCE, /setInterval|setTimeout/);
});

test("AW: no schema changes", () => {
  const types = readFileSync(join(process.cwd(), "lib/trades/types.ts"), "utf8");
  assert.doesNotMatch(types, /postTradeReview|reviewAccepted|holdingDuration/);
});

test("AX: duration deterministic", () => {
  assert.equal(holdingDurationMinutes("2026-09-15T03:00:00.000Z", "2026-09-15T03:00:59.000Z"), 0);
  assert.equal(formatHoldingDuration(0), "0分");
  assert.equal(holdingDurationMinutes("2026-09-15T03:00:00.000Z", "2026-09-15T03:59:59.000Z"), 59);
  assert.equal(formatHoldingDuration(60), "1時間");
});

test("AY: result update doesn't alter context", () => {
  const opened = createTrade(draft(), null, "ay", NOW, { saveSnapshot: false }).data!;
  const closed = closeTrade(opened, 156.0, NOW, NOW).data!;
  const edited = editTrade(closed, { ...closed, exitPrice: 155.5, notes: "edited" }, NOW).data!;
  assert.equal(edited.analysisSnapshot, closed.analysisSnapshot);
  assert.deepEqual(buildPostTradeReview(edited)?.context, buildPostTradeReview(closed)?.context);
});

test("AZ: context unchanged after close", () => {
  const opened = createTrade({ ...draft(), notes: "az" }, null, "az", NOW, { saveSnapshot: false }).data!;
  opened.analysisSnapshot = snap(context());
  const before = JSON.stringify(storedPreTradeContext(opened));
  const closed = closeTrade(opened, 156.0, NOW, NOW).data!;
  assert.equal(JSON.stringify(storedPreTradeContext(closed)), before);
});

test("critical: same context profit and loss", () => {
  const ctx = context();
  const profit = buildPostTradeReview(trade({ id: "c1", realizedPnl: 820, analysisSnapshot: snap(ctx) }))!;
  const loss = buildPostTradeReview(trade({ id: "c2", realizedPnl: -820, analysisSnapshot: snap(ctx) }))!;
  assert.equal(profit.action, "WAIT");
  assert.equal(loss.action, "WAIT");
  assert.equal(profit.triggerStatus, "条件成立");
  assert.equal(loss.triggerStatus, "条件成立");
  assert.equal(profit.readinessCount, "5 / 5");
  assert.equal(loss.readinessCount, "5 / 5");
});

test("missing copy", () => {
  assert.match(POST_TRADE_REVIEW_MISSING, /保存されていません/);
  assert.match(POST_TRADE_REVIEW_UNREADABLE, /確認できません/);
});
