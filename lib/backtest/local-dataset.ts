import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { symbols, type Candle, type Symbol } from "../market/types";
import { historicalTimeframes, historicalTimeframeDurationMs, validateHistoricalDataset, type HistoricalDataset, type HistoricalTimeframe } from "./signal-replay";

export type DatasetKind = "SYNTHETIC" | "OBSERVED";

export interface HistoricalDatasetManifest {
  datasetId: string;
  pair: Symbol;
  source: string;
  timezone: "UTC";
  exportedAt: string;
  licenseProvenance: string;
  dataKind: DatasetKind;
  files: Partial<Record<HistoricalTimeframe, { fileName: string; sha256: string }>>;
}

export interface MissingIntervalObservation {
  timeframe: HistoricalTimeframe;
  previousCandleTime: string;
  nextCandleTime: string;
  elapsedMs: number;
  timeframeDurationMs: number;
  estimatedMissingSlots: number;
  classification: "UNCLASSIFIED_GAP";
}

export interface ImportedHistoricalDataset {
  dataset: HistoricalDataset;
  provenance: {
    datasetId: string;
    pair: Symbol;
    source: string;
    timezone: "UTC";
    exportedAt: string;
    licenseProvenance: string;
    dataKind: DatasetKind;
    checksums: Partial<Record<HistoricalTimeframe, string>>;
    rowCounts: Partial<Record<HistoricalTimeframe, number>>;
    firstTimestamps: Partial<Record<HistoricalTimeframe, string>>;
    lastTimestamps: Partial<Record<HistoricalTimeframe, string>>;
    missingIntervals: MissingIntervalObservation[];
  };
}

export type HistoricalImportResult = { valid: true; imported: ImportedHistoricalDataset; errors: [] } | { valid: false; imported: null; errors: string[] };

const CSV_HEADER = "time,open,high,low,close";
const SHA256 = /^[a-f0-9]{64}$/i;
const UTC_ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function canonicalUtc(value: unknown): value is string {
  if (typeof value !== "string" || !UTC_ISO.test(value)) return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value;
}

function validLocalFilename(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && basename(value) === value && value !== "." && value !== ".." && /^[A-Za-z0-9._-]+\.csv$/i.test(value);
}

function parseCandleCsv(text: string, timeframe: HistoricalTimeframe): { candles: Candle[]; errors: string[] } {
  const normalized = text
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
  const [header, ...lines] = normalized.split("\n");
  if (header !== CSV_HEADER) return { candles: [], errors: [`${timeframe}: CSV header must be exactly ${CSV_HEADER}`] };

  const candles: Candle[] = [];
  const errors: string[] = [];
  lines.forEach((line, index) => {
    if (!line.trim()) return;
    const rowNumber = index + 2;
    if (line.includes('"')) {
      errors.push(`${timeframe}:${rowNumber} quoted fields are not supported`);
      return;
    }
    const cells = line.split(",");
    if (cells.length !== 5) {
      errors.push(`${timeframe}:${rowNumber} must contain five columns`);
      return;
    }
    const [time, openRaw, highRaw, lowRaw, closeRaw] = cells.map((cell) => cell.trim());
    if (!canonicalUtc(time)) {
      errors.push(`${timeframe}:${rowNumber} time must be canonical UTC ISO ending in Z`);
      return;
    }
    const values = [openRaw, highRaw, lowRaw, closeRaw].map((raw) => (raw === "" ? NaN : Number(raw)));
    if (!values.every((value) => Number.isFinite(value) && value > 0)) {
      errors.push(`${timeframe}:${rowNumber} OHLC values must be finite positive numbers`);
      return;
    }
    const [open, high, low, close] = values as [number, number, number, number];
    if (high < Math.max(open, close, low) || low > Math.min(open, close, high)) {
      errors.push(`${timeframe}:${rowNumber} has malformed OHLC ordering`);
      return;
    }
    candles.push({ time, open, high, low, close });
  });
  for (let index = 1; index < candles.length; index++) {
    if (Date.parse(candles[index]!.time) <= Date.parse(candles[index - 1]!.time)) {
      errors.push(`${timeframe}: timestamps must be strictly increasing with no duplicates`);
      break;
    }
  }
  if (!candles.length) errors.push(`${timeframe}: CSV has no candle rows`);
  return { candles, errors };
}

function missingIntervals(timeframe: HistoricalTimeframe, candles: readonly Candle[]): MissingIntervalObservation[] {
  const duration = historicalTimeframeDurationMs[timeframe];
  const gaps: MissingIntervalObservation[] = [];
  for (let index = 1; index < candles.length; index++) {
    const previous = candles[index - 1]!;
    const next = candles[index]!;
    const elapsedMs = Date.parse(next.time) - Date.parse(previous.time);
    if (elapsedMs <= duration) continue;
    gaps.push({
      timeframe,
      previousCandleTime: previous.time,
      nextCandleTime: next.time,
      elapsedMs,
      timeframeDurationMs: duration,
      estimatedMissingSlots: Math.max(0, Math.round(elapsedMs / duration) - 1),
      classification: "UNCLASSIFIED_GAP",
    });
  }
  return gaps;
}

export function importHistoricalCsvManifest(raw: unknown, csvByTimeframe: Partial<Record<HistoricalTimeframe, string>>): HistoricalImportResult {
  const errors: string[] = [];
  if (!isRecord(raw)) return { valid: false, imported: null, errors: ["manifest must be an object"] };
  const datasetId = typeof raw.datasetId === "string" ? raw.datasetId.trim() : "";
  const pair = typeof raw.pair === "string" ? raw.pair : "";
  const source = typeof raw.source === "string" ? raw.source.trim() : "";
  const timezone = raw.timezone;
  const exportedAt = raw.exportedAt;
  const licenseProvenance = typeof raw.licenseProvenance === "string" ? raw.licenseProvenance.trim() : "";
  const dataKind = raw.dataKind;
  if (!datasetId) errors.push("datasetId is required");
  if (!symbols.includes(pair as Symbol)) errors.push("pair is unsupported");
  if (!source) errors.push("source is required");
  if (timezone !== "UTC") errors.push("timezone must be UTC");
  if (!canonicalUtc(exportedAt)) errors.push("exportedAt must be canonical UTC ISO");
  if (!licenseProvenance) errors.push("licenseProvenance is required");
  if (dataKind !== "SYNTHETIC" && dataKind !== "OBSERVED") errors.push("dataKind must be SYNTHETIC or OBSERVED");
  if (!isRecord(raw.files)) return { valid: false, imported: null, errors: [...errors, "files must be an object"] };

  const fileMetadata = raw.files;
  for (const key of Object.keys(fileMetadata)) if (!(historicalTimeframes as readonly string[]).includes(key)) errors.push(`unsupported timeframe file: ${key}`);
  const timeframes: HistoricalDataset["timeframes"] = {};
  const checksums: ImportedHistoricalDataset["provenance"]["checksums"] = {};
  const rowCounts: ImportedHistoricalDataset["provenance"]["rowCounts"] = {};
  const firstTimestamps: ImportedHistoricalDataset["provenance"]["firstTimestamps"] = {};
  const lastTimestamps: ImportedHistoricalDataset["provenance"]["lastTimestamps"] = {};
  const gaps: MissingIntervalObservation[] = [];

  for (const timeframe of historicalTimeframes) {
    const entry = fileMetadata[timeframe];
    const csv = csvByTimeframe[timeframe];
    if (entry === undefined && csv === undefined) continue;
    if (entry === undefined || csv === undefined) {
      errors.push(`${timeframe}: manifest file entry and CSV text must both be supplied`);
      continue;
    }
    if (!isRecord(entry)) {
      errors.push(`${timeframe}: file entry must be an object`);
      continue;
    }
    if (!validLocalFilename(entry.fileName)) errors.push(`${timeframe}: fileName must be a local CSV basename`);
    if (typeof entry.sha256 !== "string" || !SHA256.test(entry.sha256)) {
      errors.push(`${timeframe}: sha256 must be a 64-character hexadecimal digest`);
      continue;
    }
    const checksum = sha256Hex(csv);
    if (checksum !== entry.sha256.toLowerCase()) {
      errors.push(`${timeframe}: SHA-256 checksum mismatch`);
      continue;
    }
    const parsed = parseCandleCsv(csv, timeframe);
    errors.push(...parsed.errors);
    if (parsed.errors.length) continue;
    timeframes[timeframe] = parsed.candles;
    checksums[timeframe] = checksum;
    rowCounts[timeframe] = parsed.candles.length;
    firstTimestamps[timeframe] = parsed.candles[0]!.time;
    lastTimestamps[timeframe] = parsed.candles.at(-1)!.time;
    gaps.push(...missingIntervals(timeframe, parsed.candles));
  }
  if (errors.length) return { valid: false, imported: null, errors };
  const dataset = { id: datasetId, pair, timeframes };
  const validation = validateHistoricalDataset(dataset);
  if (!validation.valid) return { valid: false, imported: null, errors: validation.errors };
  return {
    valid: true,
    errors: [],
    imported: {
      dataset: validation.dataset,
      provenance: {
        datasetId,
        pair: pair as Symbol,
        source,
        timezone: "UTC",
        exportedAt: exportedAt as string,
        licenseProvenance,
        dataKind: dataKind as DatasetKind,
        checksums,
        rowCounts,
        firstTimestamps,
        lastTimestamps,
        missingIntervals: gaps,
      },
    },
  };
}

export function loadLocalHistoricalDataset(directory: string): HistoricalImportResult {
  let rawManifest: unknown;
  try {
    rawManifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
  } catch {
    return { valid: false, imported: null, errors: ["manifest.json could not be read or parsed"] };
  }
  if (!isRecord(rawManifest) || !isRecord(rawManifest.files)) {
    return { valid: false, imported: null, errors: ["manifest or files metadata is invalid"] };
  }
  const csvByTimeframe: Partial<Record<HistoricalTimeframe, string>> = {};
  const errors: string[] = [];
  for (const timeframe of historicalTimeframes) {
    const entry = rawManifest.files[timeframe];
    if (entry === undefined) continue;
    if (!isRecord(entry) || !validLocalFilename(entry.fileName)) {
      errors.push(`${timeframe}: invalid local filename`);
      continue;
    }
    try {
      csvByTimeframe[timeframe] = readFileSync(join(directory, entry.fileName), "utf8");
    } catch {
      errors.push(`${timeframe}: local CSV file could not be read`);
    }
  }
  if (errors.length) return { valid: false, imported: null, errors };
  return importHistoricalCsvManifest(rawManifest, csvByTimeframe);
}
