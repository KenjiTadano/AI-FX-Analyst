import type { Symbol } from "../market/types";

export const currencies = ["USD", "JPY", "EUR", "GBP"] as const;
export type Currency = (typeof currencies)[number];
export type Importance = "high" | "medium" | "low";
export type ImpactDirection = "bullish" | "neutral" | "bearish";
export type RiskEnvironment = "risk-on" | "neutral" | "risk-off";
export type Availability = "available" | "unavailable";
export type ResourceStatus = "ok" | "empty" | "unavailable" | "error";
export type ErrorCode = "not_configured" | "disabled" | "unauthorized" | "forbidden" | "rate_limited" | "network" | "invalid_response" | "unsupported";
export interface DataResource<T> {
  data: T | null;
  status: ResourceStatus;
  provider: string;
  fetchedAt: string | null;
  error: { code: ErrorCode; message: string } | null;
  warnings: string[];
}
export interface ImpactContext {
  affectedCurrencies: Currency[];
  impactDirection: ImpactDirection | null;
  importance: Importance;
  importanceBasis: "provider" | "keyword";
  reason: string;
}
export interface NewsItem extends ImpactContext {
  id: string;
  title: string;
  summary: string | null;
  source: string;
  publishedAt: string;
  url: string;
  currencies: Currency[];
}
export interface EconomicEvent extends ImpactContext {
  id: string;
  name: string;
  country: string;
  currency: Currency;
  scheduledAt: string | null;
  rawScheduledAt: string | null;
  timezone: "UTC" | null;
  previous: number | string | null;
  forecast: number | string | null;
  actual: number | string | null;
  updatedAt?: string;
  indicatorKey?: string | null;
  unit: string | null;
  status: "upcoming" | "released" | "awaiting_actual" | "unknown";
  source: string;
  url: string | null;
  isKeyIndicator: boolean;
}
export interface Observation<T> {
  value: T | null;
  availability: Availability;
  asOf: string | null;
  source: string | null;
  reason: string | null;
}
export interface CentralBank {
  currency: Currency;
  name: string;
  abbreviation: string;
  policyRate: Observation<{ name: string; lower: number; upper: number | null; unit: "%" }>;
  nextMeeting: Observation<string>;
  policyDirection: Observation<"hike" | "cut" | "hold">;
  relatedNewsIds: string[];
}
export interface SentimentData {
  market: Observation<RiskEnvironment>;
  currencies: { currency: Currency; sentiment: Observation<ImpactDirection> }[];
}
export interface CurrencyFactors {
  currency: Currency;
  newsIds: string[];
  economicEventIds: string[];
  centralBank: string;
  impactDirection: null;
}
export type MacroCategory = "inflation" | "labor" | "growth" | "rates";
export type FredTransformation = "lin" | "pc1" | "chg";
export interface EconomicIndicatorValue {
  id: string;
  name: string;
  shortName?: string;
  country: "US";
  currency: "USD";
  seriesId: string;
  seriesTitle: string;
  value: number | null;
  previousValue: number | null;
  unit: string | null;
  frequency: string | null;
  observationDate: string | null;
  previousObservationDate: string | null;
  category: MacroCategory;
  seasonalAdjustment: string | null;
  transformation: FredTransformation;
  source: "FRED";
  sourceUrl?: string;
  updatedAt: string;
  stale: boolean;
  ageDays: number | null;
}
export interface FundamentalData {
  schemaVersion: 1;
  symbol: Symbol;
  baseCurrency: Currency;
  quoteCurrency: Currency;
  generatedAt: string;
  news: DataResource<NewsItem[]>;
  calendar: DataResource<EconomicEvent[]>;
  macroeconomic: DataResource<EconomicIndicatorValue[]>;
  centralBanks: DataResource<CentralBank[]>;
  sentiment: DataResource<SentimentData>;
  factors: CurrencyFactors[];
}
export interface NormalizedBatch<T> { items: T[]; warnings: string[] }
export interface FundamentalProviders {
  news(): Promise<DataResource<NewsItem[]>>;
  calendar(): Promise<DataResource<EconomicEvent[]>>;
  macroeconomic?(): Promise<DataResource<EconomicIndicatorValue[]>>;
  centralBanks(context: { currencies: Currency[]; news: DataResource<NewsItem[]>; calendar: DataResource<EconomicEvent[]> }): Promise<DataResource<CentralBank[]>>;
  sentiment(currencies: Currency[]): Promise<DataResource<SentimentData>>;
}
