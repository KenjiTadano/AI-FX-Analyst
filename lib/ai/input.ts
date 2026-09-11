import { calendarKnown, riskState, windowFor } from "../economic-calendar/risk-window";
import { surprise } from "../economic-calendar/normalize";
import { canAttachToPairAnalysis } from "../chart-analysis/normalize";
import type { ChartImageAnalysis } from "../chart-analysis/types";
import { FRED_SERIES_COUNT } from "../fundamental/fred-series";
import type { MarketData, Symbol } from "../market/types";
import type { DataResource, EconomicIndicatorValue, FundamentalData } from "../fundamental/types";
import { currentRate, evaluateTechnical, fresh } from "./technical";
import type { AnalysisInput, Availability, DataQuality, Evidence, FactorCategory } from "./types";

export const categoryLabels: Record<FactorCategory, string> = { technical: "テクニカル", news: "ニュース", economic: "経済指標", central_bank: "中央銀行", market_environment: "市場環境" };
const weights: Record<FactorCategory, number> = { technical: 40, news: 20, economic: 20, central_bank: 10, market_environment: 10 };

export function macroeconomicQuality(resource: DataResource<EconomicIndicatorValue[]> | null | undefined): DataQuality["macroeconomicData"] {
  if (!resource || resource.status === "unavailable" || resource.status === "error" || resource.status === "empty" || !resource.data?.length) {
    return { status: "missing", detail: "米国マクロ: 未取得", fraction: 0 };
  }
  const count = resource.data.filter(item => item.value !== null && item.observationDate).length;
  const fraction = Math.min(1, count / FRED_SERIES_COUNT);
  const status: Availability = count >= FRED_SERIES_COUNT && resource.warnings.length === 0 ? "ok" : count > 0 ? "partial" : "missing";
  return {
    status,
    detail: status === "ok" ? "米国マクロ: 取得済み" : status === "partial" ? "米国マクロ: 一部不足" : "米国マクロ: 未取得",
    fraction,
  };
}

export function buildInput(pair: Symbol, market: MarketData | null, fundamentals: FundamentalData | null, now = Date.now(), chartImageAnalysis?: ChartImageAnalysis | null): AnalysisInput {
  if (market?.symbol !== pair) market = null;
  if (fundamentals?.symbol !== pair) fundamentals = null;
  const technicalAnalysis = evaluateTechnical(market, now);
  const rate = currentRate(market, now);
  const evidence: Evidence[] = technicalAnalysis.frames.filter(frame => frame.available).map(frame => ({ id: `technical:${frame.timeframe}`, categories: ["technical"], source: "Twelve Data", title: `${frame.timeframe} technical`, observedAt: frame.lastClosedAt, data: frame }));
  const news = fundamentals?.news;
  const calendar = fundamentals?.calendar;
  const macroeconomic = fundamentals?.macroeconomic;
  const newsFresh = !!news && ["ok", "empty"].includes(news.status) && fresh(news.fetchedAt, 15 * 60_000, now);
  const calendarFresh = calendarKnown(calendar, now);
  const newsItems = newsFresh ? (news.data ?? []).slice(0, 10) : [];
  newsItems.forEach((item, index) => {
    const bankRelated = fundamentals?.centralBanks.data?.some(bank => bank.relatedNewsIds.includes(item.id));
    evidence.push({ id: `news:${index}`, categories: bankRelated ? ["news", "central_bank"] : ["news"], title: item.title.slice(0, 300), source: item.source.slice(0, 100), observedAt: item.publishedAt, data: { summary: item.summary?.slice(0, 800) ?? null, affectedCurrencies: item.affectedCurrencies, importance: item.importance, impactDirection: item.impactDirection } });
  });
  const events = calendarFresh ? (calendar!.data ?? []).filter(event => pair.split("/").includes(event.currency)) : [];
  // Keep imminent events in the bounded model input before less urgent records.
  const sortedEvents = [...events].sort((a, b) => {
    const distance = (at: string | null) => at ? Math.abs(Date.parse(at) - now) : Number.MAX_SAFE_INTEGER;
    return distance(a.scheduledAt) - distance(b.scheduledAt);
  }).slice(0, 20);
  sortedEvents.forEach((item, index) => evidence.push({ id: `economic:${index}`, categories: ["economic"], title: item.name.slice(0, 300), source: item.source, observedAt: calendar?.fetchedAt ?? null, data: { currency: item.currency, country: item.country, scheduledAt: item.scheduledAt, rawScheduledAt: item.rawScheduledAt, timezone: item.timezone, previous: item.previous, forecast: item.forecast, actual: item.actual, unit: item.unit, importance: item.importance, status: item.status, minutesUntil: item.scheduledAt ? (Date.parse(item.scheduledAt) - now) / 60_000 : null, inRiskWindow: riskState([item], now).imminent, riskWindow: windowFor(item), surprise: surprise(item) } }));
  const macroItems = macroeconomic && ["ok", "empty"].includes(macroeconomic.status) ? (macroeconomic.data ?? []).filter(item => item.value !== null && item.observationDate) : [];
  macroItems.slice(0, 12).forEach((item, index) => evidence.push({
    id: `macro:${index}`,
    categories: ["economic"],
    title: item.name.slice(0, 300),
    source: "FRED",
    observedAt: item.observationDate,
    data: {
      kind: "released_macro_observation",
      seriesId: item.seriesId,
      latestValue: item.value,
      previousValue: item.previousValue,
      unit: item.unit,
      frequency: item.frequency,
      observationDate: item.observationDate,
      previousObservationDate: item.previousObservationDate,
      stale: item.stale,
      ageDays: item.ageDays,
      transformation: item.transformation,
      note: "FRED発表済み実績。市場予想・速報・将来値ではない。",
    },
  }));
  const banks = fundamentals?.centralBanks.data ?? [];
  let bankObservations = 0;
  for (const bank of banks) {
    for (const [field, observation] of Object.entries({ policyRate: bank.policyRate, nextMeeting: bank.nextMeeting, policyDirection: bank.policyDirection })) {
      if (observation.availability === "available" && observation.value !== null && fresh(observation.asOf, 86_400_000, now)) {
        bankObservations++;
        evidence.push({ id: `bank:${bank.currency}:${field}`, categories: ["central_bank"], title: `${bank.abbreviation} ${field}`, source: observation.source ?? bank.name, observedAt: observation.asOf, data: { currency: bank.currency, value: observation.value } });
      }
    }
  }
  const sentiment = fundamentals?.sentiment.data;
  let sentimentCount = 0;
  if (sentiment) {
    const observations = [{ id: "market", observation: sentiment.market }, ...sentiment.currencies.map(item => ({ id: item.currency, observation: item.sentiment }))];
    for (const item of observations) if (item.observation.availability === "available" && item.observation.value !== null && fresh(item.observation.asOf, 60 * 60_000, now)) {
      sentimentCount++;
      evidence.push({ id: `sentiment:${item.id}`, categories: ["market_environment"], title: item.id, source: item.observation.source ?? "sentiment provider", observedAt: item.observation.asOf, data: { subject: item.id, value: item.observation.value } });
    }
  }
  const attachedChart = canAttachToPairAnalysis(chartImageAnalysis, pair) ? chartImageAnalysis : undefined;
  if (attachedChart) {
    evidence.push({
      id: "technical:chart_image",
      categories: ["technical"],
      title: "ユーザー提供チャート画像の観察",
      source: "chart_image",
      observedAt: attachedChart.analyzedAt,
      data: {
        kind: "chart_image_snapshot",
        detectedPair: attachedChart.detected.pair,
        timeframe: attachedChart.detected.timeframe,
        chartType: attachedChart.detected.chartType,
        currentPrice: attachedChart.detected.currentPrice,
        trend: attachedChart.trend,
        structure: attachedChart.structure,
        levels: attachedChart.levels,
        patterns: attachedChart.patterns,
        indicators: attachedChart.indicators,
        observations: attachedChart.observations.slice(0, 8),
        warnings: attachedChart.warnings.slice(0, 8),
        dataQuality: attachedChart.dataQuality,
        note: "チャート画像はユーザー提供のスナップショットであり、時刻や価格が現在市場と一致しない可能性がある。市場APIの価格・OHLCを上書きしない。",
      },
    });
  }
  const macroQuality = macroeconomicQuality(macroeconomic);
  const fractions: Record<FactorCategory, number> = {
    technical: (rate !== null ? 0.2 : 0) + technicalAnalysis.frames.reduce((sum, frame) => sum + frame.completeness * 0.8 / 3, 0),
    news: newsItems.length ? 1 : newsFresh ? 0.5 : 0,
    // Keep calendar-driven economic quality unchanged; FRED is tracked separately as macroeconomicData.
    economic: events.length ? events.reduce((sum, item) => sum + (item.scheduledAt ? 0.5 : 0) + (item.previous !== null ? 0.25 : 0) + (item.forecast !== null || item.actual !== null ? 0.25 : 0), 0) / events.length : calendarFresh ? 0.5 : 0,
    central_bank: Math.min(1, bankObservations / 6 * 0.75 + (evidence.some(item => item.categories.includes("central_bank") && item.id.startsWith("news:")) ? 0.25 : 0)),
    market_environment: Math.min(1, sentimentCount / 3),
  };
  const categories = Object.fromEntries(Object.entries(fractions).map(([category, fraction]) => {
    const status = fraction >= 0.999 ? "ok" : fraction > 0 ? "partial" : "missing";
    return [category, { status, fraction, detail: `${categoryLabels[category as FactorCategory]}: ${status === "ok" ? "取得済み" : status === "partial" ? "一部不足・対象材料なし" : "未取得・期限切れ"}` }];
  })) as DataQuality["categories"];
  const missingData = [
    ...Object.values(categories).filter(category => category.status !== "ok").map(category => category.detail),
    ...(macroQuality.status !== "ok" ? [macroQuality.detail] : []),
  ];
  const dataAvailability: DataQuality = {
    score: Math.round(Object.entries(fractions).reduce((sum, [category, fraction]) => sum + weights[category as FactorCategory] * fraction, 0)),
    missingData,
    categories,
    macroeconomicData: macroQuality,
  };
  const eventRisk: AnalysisInput["eventRisk"] = { ...riskState(events, now), events, known: calendarFresh };
  return { pair, currentRate: rate, technicalAnalysis, fundamentalData: evidence, dataAvailability, timestamp: new Date(now).toISOString(), eventRisk, ...(attachedChart ? { chartImageAnalysis: attachedChart } : {}) };
}
