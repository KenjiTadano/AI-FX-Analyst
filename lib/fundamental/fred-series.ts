import type { FredTransformation, MacroCategory } from "./types";

/**
 * Verified against FRED series metadata API on 2026-09-11.
 * CPI/PCE YoY and NFP MoM use FRED observation `units` transforms (pc1/chg), not separate series IDs.
 * @see https://fred.stlouisfed.org/docs/api/fred/series_observations.html
 */
export interface FredSeriesDefinition {
  id: string;
  seriesId: string;
  name: string;
  shortName: string;
  seriesTitle: string;
  nativeUnits: string;
  displayUnit: string;
  frequency: string;
  seasonalAdjustment: string;
  transformation: FredTransformation;
  category: MacroCategory;
  /** Soft freshness hint only; observationDate is always passed to UI/AI. */
  staleAfterDays: number;
}

export const FRED_SERIES: FredSeriesDefinition[] = [
  {
    id: "us-cpi-yoy",
    seriesId: "CPIAUCSL",
    name: "米CPI（前年比）",
    shortName: "米CPI",
    seriesTitle: "Consumer Price Index for All Urban Consumers: All Items in U.S. City Average",
    nativeUnits: "Index 1982-1984=100",
    displayUnit: "% 前年比",
    frequency: "Monthly",
    seasonalAdjustment: "Seasonally Adjusted",
    transformation: "pc1",
    category: "inflation",
    staleAfterDays: 45,
  },
  {
    id: "us-core-cpi-yoy",
    seriesId: "CPILFESL",
    name: "米Core CPI（前年比）",
    shortName: "Core CPI",
    seriesTitle: "Consumer Price Index for All Urban Consumers: All Items Less Food and Energy in U.S. City Average",
    nativeUnits: "Index 1982-1984=100",
    displayUnit: "% 前年比",
    frequency: "Monthly",
    seasonalAdjustment: "Seasonally Adjusted",
    transformation: "pc1",
    category: "inflation",
    staleAfterDays: 45,
  },
  {
    id: "us-pce-yoy",
    seriesId: "PCEPI",
    name: "米PCE（前年比）",
    shortName: "米PCE",
    seriesTitle: "Personal Consumption Expenditures: Chain-type Price Index",
    nativeUnits: "Index 2017=100",
    displayUnit: "% 前年比",
    frequency: "Monthly",
    seasonalAdjustment: "Seasonally Adjusted",
    transformation: "pc1",
    category: "inflation",
    staleAfterDays: 45,
  },
  {
    id: "us-core-pce-yoy",
    seriesId: "PCEPILFE",
    name: "米Core PCE（前年比）",
    shortName: "Core PCE",
    seriesTitle: "Personal Consumption Expenditures Excluding Food and Energy (Chain-Type Price Index)",
    nativeUnits: "Index 2017=100",
    displayUnit: "% 前年比",
    frequency: "Monthly",
    seasonalAdjustment: "Seasonally Adjusted",
    transformation: "pc1",
    category: "inflation",
    staleAfterDays: 45,
  },
  {
    id: "us-nfp-change",
    seriesId: "PAYEMS",
    name: "米非農業部門雇用者数増減（NFP）",
    shortName: "NFP増減",
    seriesTitle: "All Employees, Total Nonfarm",
    nativeUnits: "Thousands of Persons",
    displayUnit: "千人（前月差）",
    frequency: "Monthly",
    seasonalAdjustment: "Seasonally Adjusted",
    transformation: "chg",
    category: "labor",
    staleAfterDays: 45,
  },
  {
    id: "us-unemployment",
    seriesId: "UNRATE",
    name: "米失業率",
    shortName: "失業率",
    seriesTitle: "Unemployment Rate",
    nativeUnits: "Percent",
    displayUnit: "%",
    frequency: "Monthly",
    seasonalAdjustment: "Seasonally Adjusted",
    transformation: "lin",
    category: "labor",
    staleAfterDays: 45,
  },
  {
    id: "us-real-gdp-growth",
    seriesId: "A191RL1Q225SBEA",
    name: "米実質GDP成長率（前期比年率）",
    shortName: "実質GDP",
    seriesTitle: "Real Gross Domestic Product",
    nativeUnits: "Percent Change from Preceding Period",
    displayUnit: "% 前期比年率",
    frequency: "Quarterly",
    seasonalAdjustment: "Seasonally Adjusted Annual Rate",
    transformation: "lin",
    category: "growth",
    staleAfterDays: 120,
  },
  {
    id: "us-effr",
    seriesId: "FEDFUNDS",
    name: "米実効FF金利",
    shortName: "実効FF金利",
    seriesTitle: "Federal Funds Effective Rate",
    nativeUnits: "Percent",
    displayUnit: "%",
    frequency: "Monthly",
    seasonalAdjustment: "Not Seasonally Adjusted",
    transformation: "lin",
    category: "rates",
    staleAfterDays: 45,
  },
];

export const FRED_SERIES_COUNT = FRED_SERIES.length;
