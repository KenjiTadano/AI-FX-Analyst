import "server-only";
import { createTradingEconomics } from "../economic-calendar/trading-economics";
import { createEodhd } from "../economic-calendar/providers/eodhd";
import { calendarWithFallback } from "../economic-calendar/service";
import { createFinnhub } from "./providers/finnhub";
import { createFred } from "./providers/fred";
import { getCentralBanks } from "./central-banks";
import { getSentiment } from "./sentiment";
import { assembleFundamentals } from "./service";
import type { Symbol } from "../market/types";

const finnhub = createFinnhub({
  apiKey: process.env.FINNHUB_API_KEY?.trim() ?? "",
  calendarEnabled: process.env.FINNHUB_CALENDAR_ENABLED === "true",
  calendarAssumeUtc: process.env.FINNHUB_CALENDAR_TIMEZONE === "UTC",
});
const eodhd = createEodhd(process.env.EODHD_API_TOKEN?.trim() ?? "", { euroCountry: process.env.EODHD_EUR_COUNTRY, assumeUtc: process.env.EODHD_CALENDAR_TIMEZONE === "UTC" });
const calendar = calendarWithFallback(eodhd, calendarWithFallback(createTradingEconomics(process.env.TRADING_ECONOMICS_API_KEY?.trim() ?? ""), finnhub));
const fred = createFred(process.env.FRED_API_KEY?.trim() ?? "");
export function getFundamentalData(symbol: Symbol) {
  return assembleFundamentals(symbol, { ...finnhub, calendar: calendar.calendar, macroeconomic: fred.macroeconomic, centralBanks: getCentralBanks, sentiment: getSentiment });
}
