import "server-only";
import { createFinnhub } from "./providers/finnhub";
import { getCentralBanks } from "./central-banks";
import { getSentiment } from "./sentiment";
import { assembleFundamentals } from "./service";
import type { Symbol } from "../market/types";

const finnhub = createFinnhub({
  apiKey: process.env.FINNHUB_API_KEY?.trim() ?? "",
  calendarEnabled: process.env.FINNHUB_CALENDAR_ENABLED === "true",
  calendarAssumeUtc: process.env.FINNHUB_CALENDAR_TIMEZONE === "UTC",
});
export function getFundamentalData(symbol: Symbol) {
  return assembleFundamentals(symbol, { ...finnhub, centralBanks: getCentralBanks, sentiment: getSentiment });
}
