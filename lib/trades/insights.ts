import { chartEvidencePerformance, confidenceBandPerformance, pairPerformance, summarize } from "./analytics";
import { computeAiAlignment, isRichSnapshot } from "./snapshot";
import { pairs, type AiAlignment, type Trade, type TradePair } from "./types";

/** Closed trades needed before a group yields a directional insight (not a ranking claim). */
export const MIN_INSIGHT_SAMPLE_SIZE = 5;
export const MAX_INSIGHTS = 7;
export const MAX_SUMMARY_CARDS = 3;

/** JPY-quoted pairs in this app: 1 pip = 0.01. */
export const JPY_PIP_SIZE = 0.01;

export type InsightKind = "positive" | "warning" | "neutral" | "insufficient_data";
export type InsightSeverity = "info" | "good" | "caution";
export type InsightLabel = "良い傾向" | "注意" | "参考データ" | "データ不足";

export type InsightMetrics = {
  count: number;
  wins: number;
  losses: number;
  draws: number;
  winRate: number | null;
  totalPnl: number;
  averagePnl: number | null;
  /** Optional second group for comparisons. */
  compareCount?: number;
  compareWinRate?: number | null;
  compareTotalPnl?: number;
  compareAveragePnl?: number | null;
  winRateDelta?: number | null;
  averagePnlDelta?: number | null;
  averagePips?: number | null;
};

export type TradingInsight = {
  id: string;
  type: InsightKind;
  severity: InsightSeverity;
  label: InsightLabel;
  title: string;
  description: string;
  sampleSize: number;
  metrics: InsightMetrics;
  suggestion: string | null;
};

export type InsightSummaryCard = {
  id: string;
  title: string;
  label: InsightLabel;
  sampleSize: number;
  winRate: number | null;
  totalPnl: number;
  referenceOnly: boolean;
};

export type TradingInsightsResult = {
  closedCount: number;
  insights: TradingInsight[];
  summaryCards: InsightSummaryCard[];
  empty: boolean;
};

type Band = { key: string; min: number; max: number };

const SCORE_BANDS: readonly Band[] = [
  { key: "0-49", min: 0, max: 49 },
  { key: "50-69", min: 50, max: 69 },
  { key: "70-84", min: 70, max: 84 },
  { key: "85-100", min: 85, max: 100 },
] as const;

const DELTA_BANDS = [
  { key: "0-5", min: 0, max: 5 },
  { key: "5-10", min: 5, max: 10, exclusiveMin: true },
  { key: "10-20", min: 10, max: 20, exclusiveMin: true },
  { key: "20+", min: 20, max: Number.POSITIVE_INFINITY, exclusiveMin: true },
] as const;

const FORBIDDEN = /必ず勝てる|必ず負ける|最強パターン|ベスト手法|絶対に勝て|必ず利益|WAITを必ず守れば利益|AIに従えば勝て/;

function closedOnly(trades: Trade[]): Trade[] {
  return trades.filter(t => t.status === "closed" && t.realizedPnl !== null);
}

function metricsFromStats(stats: ReturnType<typeof summarize>): InsightMetrics {
  return {
    count: stats.count,
    wins: stats.wins,
    losses: stats.losses,
    draws: stats.draws,
    winRate: stats.winRate,
    totalPnl: stats.totalPnl,
    averagePnl: stats.count ? stats.totalPnl / stats.count : null,
  };
}

function kindFromPnl(pnl: number, enough: boolean): { type: InsightKind; severity: InsightSeverity; label: InsightLabel } {
  if (!enough) return { type: "insufficient_data", severity: "info", label: "データ不足" };
  if (pnl > 0) return { type: "positive", severity: "good", label: "良い傾向" };
  if (pnl < 0) return { type: "warning", severity: "caution", label: "注意" };
  return { type: "neutral", severity: "info", label: "参考データ" };
}

function fmtMoney(n: number): string {
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toLocaleString("ja-JP", { maximumFractionDigits: 2 })}円`;
}

function fmtRate(n: number | null): string {
  return n === null ? "—" : `${n.toFixed(1)}%`;
}

function assertSafe(text: string): string {
  if (FORBIDDEN.test(text)) throw new Error(`insight wording rejected: ${text}`);
  return text;
}

/** Convert absolute price delta to pips for supported JPY pairs. */
export function priceDeltaToPips(pair: string, absPriceDelta: number): number | null {
  if (!pairs.includes(pair as TradePair) || !Number.isFinite(absPriceDelta) || absPriceDelta < 0) return null;
  return Math.round((absPriceDelta / JPY_PIP_SIZE) * 100) / 100;
}

/** Analysis reference price from snapshot (rich only). Pair mismatch / missing → null. */
export function analysisReferencePrice(trade: Trade): number | null {
  const snap = trade.analysisSnapshot;
  if (!snap || snap.pair !== trade.pair) return null;
  if (!isRichSnapshot(snap)) return null;
  const price = snap.analysisPrice ?? snap.marketPrice;
  return price !== null && Number.isFinite(price) ? price : null;
}

export function entryPriceDeltaPips(trade: Trade): number | null {
  const ref = analysisReferencePrice(trade);
  if (ref === null) return null;
  return priceDeltaToPips(trade.pair, Math.abs(trade.entryPrice - ref));
}

export function dataQualityBandPerformance(trades: Trade[]) {
  return SCORE_BANDS.map(band => {
    const selected = trades.filter(t => {
      const snap = t.analysisSnapshot;
      return !!snap && snap.pair === t.pair && snap.dataQualityScore >= band.min && snap.dataQualityScore <= band.max;
    });
    const stats = summarize(selected);
    return { band: band.key, ...stats, referenceOnly: stats.count < MIN_INSIGHT_SAMPLE_SIZE };
  });
}

export function sidePerformance(trades: Trade[]) {
  return ([{ side: "long" as const, label: "BUY / Long" }, { side: "short" as const, label: "SELL / Short" }]).map(group => {
    const stats = summarize(trades.filter(t => t.side === group.side));
    return { ...group, ...stats, referenceOnly: stats.count < MIN_INSIGHT_SAMPLE_SIZE };
  });
}

export function priceDeltaBandPerformance(trades: Trade[]) {
  const withDelta = closedOnly(trades).flatMap(t => {
    const pips = entryPriceDeltaPips(t);
    return pips === null ? [] : [{ trade: t, pips }];
  });
  return DELTA_BANDS.map(band => {
    const selected = withDelta.filter(({ pips }) => {
      if ("exclusiveMin" in band && band.exclusiveMin) return pips > band.min && pips <= band.max;
      return pips >= band.min && pips <= band.max;
    }).map(x => x.trade);
    const stats = summarize(selected);
    return { band: band.key, ...stats, referenceOnly: stats.count < MIN_INSIGHT_SAMPLE_SIZE };
  });
}

function alignmentStats(trades: Trade[], alignment: AiAlignment) {
  return summarize(trades.filter(t => computeAiAlignment(t.side, t.analysisSnapshot, t.pair) === alignment));
}

function buildInsight(partial: Omit<TradingInsight, "label" | "type" | "severity"> & { type?: InsightKind; severity?: InsightSeverity; label?: InsightLabel; enough: boolean; pnlHint: number }): TradingInsight {
  const tone = kindFromPnl(partial.pnlHint, partial.enough);
  const insight: TradingInsight = {
    id: partial.id,
    type: partial.type ?? tone.type,
    severity: partial.severity ?? tone.severity,
    label: partial.label ?? tone.label,
    title: assertSafe(partial.title),
    description: assertSafe(partial.description),
    sampleSize: partial.sampleSize,
    metrics: partial.metrics,
    suggestion: partial.suggestion ? assertSafe(partial.suggestion) : null,
  };
  return insight;
}

/**
 * Deterministic Trading Review Insights from closed trades + registration snapshots.
 * Does not call OpenAI / external APIs. Not a forecast of future profits.
 */
export function generateTradingInsights(trades: Trade[]): TradingInsightsResult {
  const closed = closedOnly(trades);
  const closedCount = closed.length;

  if (closedCount === 0) {
    return {
      closedCount: 0,
      empty: true,
      insights: [],
      summaryCards: [],
    };
  }

  const insights: TradingInsight[] = [];
  const push = (insight: TradingInsight | null) => {
    if (insight && insights.length < MAX_INSIGHTS) insights.push(insight);
  };

  if (closedCount < MIN_INSIGHT_SAMPLE_SIZE) {
    push(buildInsight({
      id: "insufficient-overall",
      enough: false,
      pnlHint: 0,
      type: "insufficient_data",
      severity: "info",
      label: "データ不足",
      title: "傾向判定にはまだデータが足りません",
      description: `決済済みは${closedCount}件です。参考データがまだ少ないため、傾向判定は保留しています。数字自体は既存の成績パネルで確認できます。`,
      sampleSize: closedCount,
      metrics: metricsFromStats(summarize(closed)),
      suggestion: null,
    }));
  }

  const wait = alignmentStats(closed, "wait_override");
  const contrary = alignmentStats(closed, "contrary");
  const aligned = alignmentStats(closed, "aligned");

  if (wait.count >= MIN_INSIGHT_SAMPLE_SIZE) {
    push(buildInsight({
      id: "wait-override",
      enough: true,
      pnlHint: wait.totalPnl,
      title: "WAIT中にエントリーした記録",
      description: `過去の記録では、WAIT中にエントリーした取引は${wait.count}件中${wait.wins}勝、勝率${fmtRate(wait.winRate)}、損益 ${fmtMoney(wait.totalPnl)}でした。これは過去実績の振り返りであり、WAITを必ず守れば結果が良くなるという意味ではありません。`,
      sampleSize: wait.count,
      metrics: metricsFromStats(wait),
      suggestion: wait.totalPnl < 0
        ? "WAIT表示中にEntryする場合、Entry理由をJournal noteに残して後から比較してみましょう。"
        : null,
    }));
  }

  if (contrary.count >= MIN_INSIGHT_SAMPLE_SIZE) {
    push(buildInsight({
      id: "contrary",
      enough: true,
      pnlHint: contrary.totalPnl,
      title: "AI方向と逆に入った記録",
      description: `過去の記録では、AI方向と逆に入った取引は${contrary.count}件、勝率${fmtRate(contrary.winRate)}、損益 ${fmtMoney(contrary.totalPnl)}でした。`,
      sampleSize: contrary.count,
      metrics: metricsFromStats(contrary),
      suggestion: contrary.totalPnl < 0
        ? "AI方向と逆にEntryした理由をJournal noteに残すと検証しやすくなります。"
        : null,
    }));
  }

  if (aligned.count >= MIN_INSIGHT_SAMPLE_SIZE && contrary.count >= MIN_INSIGHT_SAMPLE_SIZE) {
    const aAvg = aligned.count ? aligned.totalPnl / aligned.count : null;
    const cAvg = contrary.count ? contrary.totalPnl / contrary.count : null;
    const winDelta = aligned.winRate !== null && contrary.winRate !== null ? aligned.winRate - contrary.winRate : null;
    const avgDelta = aAvg !== null && cAvg !== null ? aAvg - cAvg : null;
    push(buildInsight({
      id: "aligned-vs-contrary",
      enough: true,
      pnlHint: (aAvg ?? 0) - (cAvg ?? 0),
      type: "neutral",
      severity: "info",
      label: "参考データ",
      title: "AI一致と逆方向の比較（過去データ）",
      description: `過去データの比較です。一致：勝率${fmtRate(aligned.winRate)}・平均 ${aAvg === null ? "—" : fmtMoney(aAvg)} / 取引。逆方向：勝率${fmtRate(contrary.winRate)}・平均 ${cAvg === null ? "—" : fmtMoney(cAvg)} / 取引。勝率差 ${winDelta === null ? "—" : `${winDelta > 0 ? "+" : ""}${winDelta.toFixed(1)}pt`}、平均損益差 ${avgDelta === null ? "—" : fmtMoney(avgDelta)} / 取引。将来の利益を保証しません。`,
      sampleSize: aligned.count + contrary.count,
      metrics: {
        ...metricsFromStats(aligned),
        compareCount: contrary.count,
        compareWinRate: contrary.winRate,
        compareTotalPnl: contrary.totalPnl,
        compareAveragePnl: cAvg,
        winRateDelta: winDelta,
        averagePnlDelta: avgDelta,
      },
      suggestion: null,
    }));
  } else if (aligned.count >= MIN_INSIGHT_SAMPLE_SIZE) {
    push(buildInsight({
      id: "aligned",
      enough: true,
      pnlHint: aligned.totalPnl,
      title: "AI方向と一致した記録",
      description: `過去の記録では、AI方向と一致した取引は${aligned.count}件で勝率${fmtRate(aligned.winRate)}、損益 ${fmtMoney(aligned.totalPnl)}でした。AIの方向に合わせれば利益が出る、という意味ではありません。`,
      sampleSize: aligned.count,
      metrics: metricsFromStats(aligned),
      suggestion: null,
    }));
  }

  const dqBands = dataQualityBandPerformance(closed).filter(b => b.count >= MIN_INSIGHT_SAMPLE_SIZE);
  if (dqBands.length) {
    const best = [...dqBands].sort((a, b) => b.totalPnl - a.totalPnl || (b.winRate ?? 0) - (a.winRate ?? 0))[0];
    push(buildInsight({
      id: "data-quality",
      enough: true,
      pnlHint: best.totalPnl,
      type: "neutral",
      severity: "info",
      label: "参考データ",
      title: `Data Quality ${best.band}% 帯の記録`,
      description: `過去の記録では、Data Quality ${best.band} の分析を保存した取引は${best.count}件、勝率${fmtRate(best.winRate)}、損益 ${fmtMoney(best.totalPnl)}でした。Data Qualityが高いから結果が良いとは断定できません。`,
      sampleSize: best.count,
      metrics: metricsFromStats(best),
      suggestion: null,
    }));
  }

  const chart = chartEvidencePerformance(closed);
  const used = chart.find(g => g.key === "used")!;
  const unused = chart.find(g => g.key === "unused")!;
  if (used.count >= MIN_INSIGHT_SAMPLE_SIZE && unused.count >= MIN_INSIGHT_SAMPLE_SIZE) {
    const usedAvg = used.count ? used.totalPnl / used.count : null;
    const unusedAvg = unused.count ? unused.totalPnl / unused.count : null;
    const relative = (usedAvg ?? 0) >= (unusedAvg ?? 0);
    push(buildInsight({
      id: "chart-evidence",
      enough: true,
      pnlHint: (usedAvg ?? 0) - (unusedAvg ?? 0),
      type: "neutral",
      severity: "info",
      label: "参考データ",
      title: "Chart Evidence 使用有無の比較",
      description: `過去データでは Chart Evidence 使用：勝率${fmtRate(used.winRate)}・平均 ${usedAvg === null ? "—" : fmtMoney(usedAvg)}、未使用：勝率${fmtRate(unused.winRate)}・平均 ${unusedAvg === null ? "—" : fmtMoney(unusedAvg)}でした。${relative ? "使用時の成績が相対的に高くなっています。" : "未使用時の成績が相対的に高くなっています。"}サンプル数と相場環境の影響を受けます。`,
      sampleSize: used.count + unused.count,
      metrics: {
        ...metricsFromStats(used),
        compareCount: unused.count,
        compareWinRate: unused.winRate,
        compareTotalPnl: unused.totalPnl,
        compareAveragePnl: unusedAvg,
        averagePnlDelta: usedAvg !== null && unusedAvg !== null ? usedAvg - unusedAvg : null,
      },
      suggestion: null,
    }));
  }

  const confBands = confidenceBandPerformance(closed).filter(b => b.count >= MIN_INSIGHT_SAMPLE_SIZE);
  if (confBands.length) {
    const best = [...confBands].sort((a, b) => b.totalPnl - a.totalPnl || (b.winRate ?? 0) - (a.winRate ?? 0))[0];
    push(buildInsight({
      id: "confidence",
      enough: true,
      pnlHint: best.totalPnl,
      type: "neutral",
      severity: "info",
      label: "参考データ",
      title: `Confidence ${best.band}% 帯の記録`,
      description: `過去の記録では、Confidence ${best.band} の取引は${best.count}件、勝率${fmtRate(best.winRate)}、平均 ${best.count ? fmtMoney(best.totalPnl / best.count) : "—"}でした。AI Confidenceは分析判断の確信度であり、勝率を保証する値ではありません。`,
      sampleSize: best.count,
      metrics: metricsFromStats(best),
      suggestion: null,
    }));
  }

  const pairStats = pairPerformance(closed).filter(p => p.count >= MIN_INSIGHT_SAMPLE_SIZE);
  if (pairStats.length >= 2) {
    const ranked = [...pairStats].sort((a, b) => b.totalPnl - a.totalPnl || (b.winRate ?? 0) - (a.winRate ?? 0));
    const top = ranked[0];
    push(buildInsight({
      id: "pair",
      enough: true,
      pnlHint: top.totalPnl,
      type: "neutral",
      severity: "info",
      label: "参考データ",
      title: "通貨ペア別の過去記録",
      description: `現在の記録では ${top.pair} が${top.count}件・勝率${fmtRate(top.winRate)}・損益 ${fmtMoney(top.totalPnl)}でした。件数不足のペアはランキング対象外です。将来の優位性を示すものではありません。`,
      sampleSize: top.count,
      metrics: metricsFromStats(top),
      suggestion: null,
    }));
  } else if (pairStats.length === 1) {
    const only = pairStats[0];
    push(buildInsight({
      id: "pair",
      enough: true,
      pnlHint: only.totalPnl,
      type: "neutral",
      severity: "info",
      label: "参考データ",
      title: `${only.pair} の過去記録`,
      description: `過去の記録では ${only.pair} は${only.count}件、勝率${fmtRate(only.winRate)}、損益 ${fmtMoney(only.totalPnl)}でした。他ペアとの比較はサンプル不足のため保留しています。`,
      sampleSize: only.count,
      metrics: metricsFromStats(only),
      suggestion: null,
    }));
  }

  const sides = sidePerformance(closed);
  const buy = sides.find(s => s.side === "long")!;
  const sell = sides.find(s => s.side === "short")!;
  if (buy.count >= MIN_INSIGHT_SAMPLE_SIZE && sell.count >= MIN_INSIGHT_SAMPLE_SIZE) {
    const buyAvg = buy.totalPnl / buy.count;
    const sellAvg = sell.totalPnl / sell.count;
    push(buildInsight({
      id: "side",
      enough: true,
      pnlHint: buyAvg - sellAvg,
      type: "neutral",
      severity: "info",
      label: "参考データ",
      title: "BUY / SELL の過去比較",
      description: `過去データでは BUY：勝率${fmtRate(buy.winRate)}・平均 ${fmtMoney(buyAvg)}、SELL：勝率${fmtRate(sell.winRate)}・平均 ${fmtMoney(sellAvg)}でした。${sellAvg < buyAvg ? "SELL取引の平均損益がBUYより低い記録です。" : buyAvg < sellAvg ? "BUY取引の平均損益がSELLより低い記録です。" : "BUYとSELLの平均損益は同程度でした。"}将来の売買推奨ではありません。`,
      sampleSize: buy.count + sell.count,
      metrics: {
        ...metricsFromStats(buy),
        compareCount: sell.count,
        compareWinRate: sell.winRate,
        compareTotalPnl: sell.totalPnl,
        compareAveragePnl: sellAvg,
        averagePnlDelta: buyAvg - sellAvg,
      },
      suggestion: null,
    }));
  }

  const deltas = closed.map(entryPriceDeltaPips).filter((n): n is number => n !== null);
  if (deltas.length >= MIN_INSIGHT_SAMPLE_SIZE) {
    const averagePips = deltas.reduce((a, b) => a + b, 0) / deltas.length;
    const bands = priceDeltaBandPerformance(closed).filter(b => b.count >= MIN_INSIGHT_SAMPLE_SIZE);
    const bandNote = bands.length
      ? `帯別では ${bands.map(b => `${b.band} pips：${b.count}件・勝率${fmtRate(b.winRate)}`).join(" / ")}。`
      : "帯別の成績比較はサンプル不足のため保留しています。";
    push(buildInsight({
      id: "price-delta",
      enough: true,
      pnlHint: 0,
      type: "neutral",
      severity: "info",
      label: "参考データ",
      title: "分析時点からEntryまでの価格差",
      description: `過去の記録では、分析時点から平均${averagePips.toFixed(1)} pips動いた後にEntryしています。${bandNote}遅すぎる・追いかけすぎといった断定はしません。`,
      sampleSize: deltas.length,
      metrics: { ...metricsFromStats(summarize(closed.filter(t => entryPriceDeltaPips(t) !== null))), averagePips },
      suggestion: null,
    }));
  }

  // If we only have the overall insufficient card (or nothing meaningful beyond empty groups), keep it.
  if (insights.length === 0) {
    push(buildInsight({
      id: "insufficient-groups",
      enough: false,
      pnlHint: 0,
      type: "insufficient_data",
      severity: "info",
      label: "データ不足",
      title: "傾向判定にはまだデータが足りません",
      description: "各観点（WAIT中エントリー、AI一致/逆行など）の件数がまだ少ないため、傾向判定は保留しています。数字自体は下の成績パネルで確認できます。",
      sampleSize: closedCount,
      metrics: metricsFromStats(summarize(closed)),
      suggestion: null,
    }));
  }

  const summaryCards = buildSummaryCards({ wait, contrary, aligned, used, closedCount });

  return {
    closedCount,
    empty: false,
    insights: insights.slice(0, MAX_INSIGHTS),
    summaryCards,
  };
}

function buildSummaryCards(input: {
  wait: ReturnType<typeof summarize>;
  contrary: ReturnType<typeof summarize>;
  aligned: ReturnType<typeof summarize>;
  used: ReturnType<typeof summarize> & { key?: string };
  closedCount: number;
}): InsightSummaryCard[] {
  const candidates: InsightSummaryCard[] = [
    {
      id: "card-wait",
      title: "WAIT中エントリー",
      label: input.wait.count >= MIN_INSIGHT_SAMPLE_SIZE ? (input.wait.totalPnl < 0 ? "注意" : input.wait.totalPnl > 0 ? "良い傾向" : "参考データ") : "参考データ",
      sampleSize: input.wait.count,
      winRate: input.wait.winRate,
      totalPnl: input.wait.totalPnl,
      referenceOnly: input.wait.count < MIN_INSIGHT_SAMPLE_SIZE,
    },
    {
      id: "card-aligned",
      title: "AI方向一致",
      label: input.aligned.count >= MIN_INSIGHT_SAMPLE_SIZE ? (input.aligned.totalPnl > 0 ? "良い傾向" : input.aligned.totalPnl < 0 ? "注意" : "参考データ") : "参考データ",
      sampleSize: input.aligned.count,
      winRate: input.aligned.winRate,
      totalPnl: input.aligned.totalPnl,
      referenceOnly: input.aligned.count < MIN_INSIGHT_SAMPLE_SIZE,
    },
    {
      id: "card-contrary",
      title: "AIと逆方向",
      label: input.contrary.count >= MIN_INSIGHT_SAMPLE_SIZE ? (input.contrary.totalPnl < 0 ? "注意" : input.contrary.totalPnl > 0 ? "良い傾向" : "参考データ") : "参考データ",
      sampleSize: input.contrary.count,
      winRate: input.contrary.winRate,
      totalPnl: input.contrary.totalPnl,
      referenceOnly: input.contrary.count < MIN_INSIGHT_SAMPLE_SIZE,
    },
    {
      id: "card-chart",
      title: "Chart使用",
      label: input.used.count >= MIN_INSIGHT_SAMPLE_SIZE ? "参考データ" : "参考データ",
      sampleSize: input.used.count,
      winRate: input.used.winRate,
      totalPnl: input.used.totalPnl,
      referenceOnly: input.used.count < MIN_INSIGHT_SAMPLE_SIZE,
    },
  ];

  // Prefer cards with samples; keep up to MAX_SUMMARY_CARDS.
  return candidates
    .filter(c => c.sampleSize > 0 || input.closedCount > 0)
    .sort((a, b) => Number(b.sampleSize >= MIN_INSIGHT_SAMPLE_SIZE) - Number(a.sampleSize >= MIN_INSIGHT_SAMPLE_SIZE) || b.sampleSize - a.sampleSize)
    .slice(0, MAX_SUMMARY_CARDS);
}

/** Test helper: collect generated insight text for wording checks. */
export function insightTexts(result: TradingInsightsResult): string[] {
  return result.insights.flatMap(i => [i.title, i.description, i.suggestion ?? ""]);
}
