import { currencies, type Currency, type Importance } from "./types";

// Association and display priority only; these rules never infer buy/sell direction.
const currencyPatterns: Record<Currency, RegExp> = {
  USD: /\b(?:USD|U\.?S\.?|United States|Federal Reserve|Fed|FOMC|nonfarm payrolls?|NFP)\b|米国|米ドル|米連邦|米雇用/i,
  JPY: /\b(?:JPY|yen|Japan|Japanese|BOJ|Bank of Japan)\b|日本|日銀|円相場|為替介入/i,
  EUR: /\b(?:EUR|euro|eurozone|euro area|ECB|European Central Bank|Germany|German|France|French)\b|ユーロ|欧州中央銀行|ユーロ圏/i,
  GBP: /\b(?:GBP|sterling|pound|Britain|British|United Kingdom|U\.?K\.?|BOE|Bank of England)\b|英国|英ポンド|イングランド銀行/i,
};
export const bankPatterns: Record<Currency, RegExp> = {
  USD: /\b(?:Fed|Federal Reserve|FOMC)\b/i,
  JPY: /\b(?:BOJ|Bank of Japan)\b|日銀|日本銀行/i,
  EUR: /\b(?:ECB|European Central Bank)\b|欧州中央銀行/i,
  GBP: /\b(?:BOE|Bank of England)\b|イングランド銀行/i,
};
export function relatedCurrencies(text: string): Currency[] {
  return currencies.filter(currency => currencyPatterns[currency].test(text));
}
export const keyIndicatorPattern = /\b(?:CPI|consumer price|PCE|personal consumption expenditures|non.?farm|payrolls?|unemployment|GDP|gross domestic product|retail sales|ISM|FOMC|interest rate|rate decision|monetary policy|wages?|earnings|employment)\b|政策金利|消費者物価|雇用|賃金|日銀会合/i;
export function classifyImportance(text: string): Importance {
  if (keyIndicatorPattern.test(text) || /\b(?:intervention|rate cut|rate hike)\b|為替介入/i.test(text)) return "high";
  if (/\b(?:inflation|economy|economic|yield|central bank|Fed|BOJ|ECB|BOE|PMI)\b|金利|景気|物価/i.test(text)) return "medium";
  return "low";
}
export const countryCurrencies: Record<string, Currency> = {
  US: "USD", USA: "USD", JP: "JPY", JPN: "JPY", GB: "GBP", GBR: "GBP", UK: "GBP",
  EU: "EUR", EMU: "EUR", EA: "EUR", EZ: "EUR", DE: "EUR", FR: "EUR", IT: "EUR", ES: "EUR",
  AT: "EUR", BE: "EUR", CY: "EUR", EE: "EUR", FI: "EUR", GR: "EUR", HR: "EUR", IE: "EUR",
  LT: "EUR", LU: "EUR", LV: "EUR", MT: "EUR", NL: "EUR", PT: "EUR", SI: "EUR", SK: "EUR",
};
