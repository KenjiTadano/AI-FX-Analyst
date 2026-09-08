import type { MarketData, Symbol } from "../market/types";
import type { FundamentalData } from "../fundamental/types";
import { currentRate, evaluateTechnical, fresh } from "./technical";
import type { AnalysisInput, DataQuality, Evidence, FactorCategory } from "./types";

export const categoryLabels: Record<FactorCategory, string> = { technical: "テクニカル", news: "ニュース", economic: "経済指標", central_bank: "中央銀行", market_environment: "市場環境" };
const weights: Record<FactorCategory, number> = { technical: 40, news: 20, economic: 20, central_bank: 10, market_environment: 10 };
export function buildInput(pair: Symbol, market: MarketData | null, fundamentals: FundamentalData | null, now = Date.now()): AnalysisInput {
  if (market?.symbol !== pair) market = null;
  if (fundamentals?.symbol !== pair) fundamentals = null;
  const technicalAnalysis = evaluateTechnical(market, now);
  const rate = currentRate(market, now);
  const evidence: Evidence[] = technicalAnalysis.frames.filter(frame => frame.available).map(frame => ({ id: `technical:${frame.timeframe}`, categories: ["technical"], source: "Twelve Data", title: `${frame.timeframe} technical`, observedAt: frame.lastClosedAt, data: frame }));
  const news = fundamentals?.news;
  const calendar = fundamentals?.calendar;
  const newsFresh = !!news && ["ok", "empty"].includes(news.status) && fresh(news.fetchedAt, 15 * 60_000, now);
  const calendarFresh = !!calendar && ["ok", "empty"].includes(calendar.status) && fresh(calendar.fetchedAt, 60 * 60_000, now);
  const newsItems = newsFresh ? (news.data ?? []).slice(0, 10) : [];
  newsItems.forEach((item, index) => {
    const bankRelated = fundamentals?.centralBanks.data?.some(bank => bank.relatedNewsIds.includes(item.id));
    evidence.push({ id: `news:${index}`, categories: bankRelated ? ["news", "central_bank"] : ["news"], title: item.title.slice(0, 300), source: item.source.slice(0, 100), observedAt: item.publishedAt, data: { summary: item.summary?.slice(0, 800) ?? null, affectedCurrencies: item.affectedCurrencies, importance: item.importance, impactDirection: item.impactDirection } });
  });
  const events = calendarFresh ? (calendar.data ?? []) : [];
  // Keep imminent events in the bounded model input before less urgent records.
  const sortedEvents = [...events].sort((a, b) => {
    const distance = (at: string | null) => at ? Math.abs(Date.parse(at) - now) : Number.MAX_SAFE_INTEGER;
    return distance(a.scheduledAt) - distance(b.scheduledAt);
  }).slice(0, 20);
  sortedEvents.forEach((item, index) => evidence.push({ id: `economic:${index}`, categories: ["economic"], title: item.name.slice(0, 300), source: item.source, observedAt: calendar?.fetchedAt ?? null, data: { currency: item.currency, country: item.country, scheduledAt: item.scheduledAt, rawScheduledAt: item.rawScheduledAt, timezone: item.timezone, previous: item.previous, forecast: item.forecast, actual: item.actual, unit: item.unit, importance: item.importance, status: item.status } }));
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
  const fractions: Record<FactorCategory, number> = {
    technical: (rate !== null ? 0.2 : 0) + technicalAnalysis.frames.reduce((sum, frame) => sum + frame.completeness * 0.8 / 3, 0),
    news: newsItems.length ? 1 : newsFresh ? 0.5 : 0,
    economic: events.length ? events.reduce((sum, item) => sum + (item.scheduledAt ? 0.5 : 0) + (item.previous !== null ? 0.25 : 0) + (item.forecast !== null || item.actual !== null ? 0.25 : 0), 0) / events.length : calendarFresh ? 0.5 : 0,
    central_bank: Math.min(1, bankObservations / 6 * 0.75 + (evidence.some(item => item.categories.includes("central_bank") && item.id.startsWith("news:")) ? 0.25 : 0)),
    market_environment: Math.min(1, sentimentCount / 3),
  };
  const categories = Object.fromEntries(Object.entries(fractions).map(([category, fraction]) => {
    const status = fraction >= 0.999 ? "ok" : fraction > 0 ? "partial" : "missing";
    return [category, { status, fraction, detail: `${categoryLabels[category as FactorCategory]}: ${status === "ok" ? "取得済み" : status === "partial" ? "一部不足・対象材料なし" : "未取得・期限切れ"}` }];
  })) as DataQuality["categories"];
  const dataAvailability: DataQuality = { score: Math.round(Object.entries(fractions).reduce((sum, [category, fraction]) => sum + weights[category as FactorCategory] * fraction, 0)), missingData: Object.values(categories).filter(category => category.status !== "ok").map(category => category.detail), categories };
  const eventRisk: AnalysisInput["eventRisk"] = { imminent: false, uncertainTime: false, nextRiskAt: null, reasons: [] };
  for (const event of events.filter(item => item.importance === "high")) {
    if (event.scheduledAt) {
      const until = Date.parse(event.scheduledAt) - now;
      if (event.actual === null && until > 30 * 60_000) {
        const riskAt = Date.parse(event.scheduledAt) - 30 * 60_000;
        if (!eventRisk.nextRiskAt || riskAt < Date.parse(eventRisk.nextRiskAt)) eventRisk.nextRiskAt = new Date(riskAt).toISOString();
      }
      if (until >= -15 * 60_000 && until <= 30 * 60_000 && event.actual === null) { eventRisk.imminent = true; eventRisk.reasons.push(`${event.name}: 重要指標の発表直前、または発表後の実績待ちです。`); }
    } else {
      // Do not guess timezone or assume a scheduled release is safely in the past.
      eventRisk.uncertainTime = true;
      eventRisk.reasons.push(`${event.name}: 重要指標の発表時刻を確認できません。`);
    }
  }
  return { pair, currentRate: rate, technicalAnalysis, fundamentalData: evidence, dataAvailability, timestamp: new Date(now).toISOString(), eventRisk };
}
