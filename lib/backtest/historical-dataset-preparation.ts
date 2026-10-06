import { createHash, type Hash } from "node:crypto";
import { access, mkdir, mkdtemp, open, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { DatasetKind, HistoricalDatasetManifest } from "./local-dataset";
import type { HistoricalTimeframe } from "./signal-replay";
import { symbols, type Symbol, type Candle } from "../market/types";

export const HISTORICAL_PREPARATION_VERSION = "TASK116_1M_STREAM_V1" as const;
export const DEFAULT_HISTORICAL_REQUESTED_START = "2021-01-01T00:00:00.000Z";
export const DEFAULT_HISTORICAL_REQUESTED_END = "2026-01-01T00:00:00.000Z";
export const CANONICAL_1M_CSV_HEADER = "time,open,high,low,close";

export type HistoricalPriceType = "MID" | "BID" | "ASK" | "SOURCE_DEFINED";

export interface HistoricalPreparationConfig {
  datasetId: string;
  pair: Symbol;
  dataKind: DatasetKind;
  licenseProvenance: string;
  sourceName: string;
  sourceArtifactIds: string[];
  rawChecksums: Record<string, string>;
  priceType: HistoricalPriceType;
  originalTimeframe: "1m";
  originalTimezone: string;
  requestedStart?: string;
  requestedEnd?: string;
  generatedAt?: string;
}

export interface PreparationRowCounts {
  inputRows: number;
  acceptedRows: number;
  rejectedRows: number;
  ignoredOutOfRangeRows: number;
  duplicateCount: number;
  unorderedCount: number;
  invalidCount: number;
}

export interface TargetTimeframeQuality {
  outputRows: number;
  firstTimestamp: string | null;
  lastTimestamp: string | null;
  emptyBucketCount: number;
  partialRangeBucketCount: number;
  observedMinuteCount: number;
  expectedCalendarMinuteCount: number;
  missingCalendarMinuteCount: number;
  unclassifiedMissingMinuteCount: number;
  missingMinuteClassification: "UNCLASSIFIED_MISSING_MINUTES";
  partialRangeBucketClassification: "PARTIAL_RANGE_BUCKET";
}

export interface HistoricalPreparationReceipt {
  preparationVersion: typeof HISTORICAL_PREPARATION_VERSION;
  sourceName: string;
  sourceArtifactIds: string[];
  rawChecksums: Record<string, string>;
  priceType: HistoricalPriceType;
  originalTimeframe: "1m";
  originalTimezone: string;
  requestedStart: string;
  requestedEnd: string;
  targetBoundaries: Record<HistoricalTimeframe, { durationMinutes: number; utcBoundary: string }>;
  inputRows: number;
  acceptedRows: number;
  rejectedRows: number;
  ignoredOutOfRangeRows: number;
  duplicateCount: number;
  unorderedCount: number;
  invalidCount: number;
  quality: Record<HistoricalTimeframe, TargetTimeframeQuality>;
  generatedAt: string;
  normalizationRules: {
    version: typeof HISTORICAL_PREPARATION_VERSION;
    inputTimestamp: "CANONICAL_UTC_1M_BAR_START";
    bucketInterval: "UTC_HALF_OPEN_START_INCLUSIVE_END_EXCLUSIVE";
    ohlc: "FIRST_OPEN_MAX_HIGH_MIN_LOW_LAST_CLOSE";
    missingMinutes: "DO_NOT_INTERPOLATE_OR_FORWARD_FILL";
    priceRounding: "NONE";
    priceTypeTransform: "NONE";
  };
}

export interface HistoricalPreparationResult {
  outputDirectory: string;
  manifest: HistoricalDatasetManifest;
  receipt: HistoricalPreparationReceipt;
}

export class HistoricalPreparationInputError extends Error {
  constructor(
    message: string,
    readonly counts: PreparationRowCounts,
  ) {
    super(message);
    this.name = "HistoricalPreparationInputError";
  }
}

interface BucketAccumulator {
  startAt: number;
  observedMinuteCount: number;
  open: number | null;
  high: number;
  low: number;
  close: number | null;
}

interface CsvStreamWriter {
  append(line: string): Promise<void>;
  close(): Promise<string>;
  abort(): Promise<void>;
}

interface TargetState {
  timeframe: HistoricalTimeframe;
  durationMs: number;
  writer: CsvStreamWriter;
  bucket: BucketAccumulator;
  quality: TargetTimeframeQuality;
}

const MINUTE_MS = 60_000;
const SHA256 = /^[a-f0-9]{64}$/i;
const CANONICAL_UTC = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const TIMEFRAMES: readonly HistoricalTimeframe[] = ["15m", "1h", "4h", "1day"];
const DURATION_MINUTES: Record<HistoricalTimeframe, number> = { "15m": 15, "1h": 60, "4h": 240, "1day": 1440 };
const UTC_BOUNDARIES: Record<HistoricalTimeframe, string> = {
  "15m": "00/15/30/45 minutes past each UTC hour",
  "1h": "each UTC hour",
  "4h": "00:00/04:00/08:00/12:00/16:00/20:00 UTC",
  "1day": "00:00 UTC each calendar day",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseCanonicalUtc(value: unknown): number | null {
  if (typeof value !== "string" || !CANONICAL_UTC.test(value)) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value ? timestamp : null;
}

function emptyCounts(): PreparationRowCounts {
  return { inputRows: 0, acceptedRows: 0, rejectedRows: 0, ignoredOutOfRangeRows: 0, duplicateCount: 0, unorderedCount: 0, invalidCount: 0 };
}

function emptyQuality(): TargetTimeframeQuality {
  return {
    outputRows: 0,
    firstTimestamp: null,
    lastTimestamp: null,
    emptyBucketCount: 0,
    partialRangeBucketCount: 0,
    observedMinuteCount: 0,
    expectedCalendarMinuteCount: 0,
    missingCalendarMinuteCount: 0,
    unclassifiedMissingMinuteCount: 0,
    missingMinuteClassification: "UNCLASSIFIED_MISSING_MINUTES",
    partialRangeBucketClassification: "PARTIAL_RANGE_BUCKET",
  };
}

function validateConfig(config: HistoricalPreparationConfig): { startAt: number; endAt: number; generatedAt: string } {
  if (!config.datasetId.trim()) throw new Error("datasetId is required");
  if (!symbols.includes(config.pair)) throw new Error("pair is unsupported");
  if (!config.licenseProvenance.trim()) throw new Error("licenseProvenance is required");
  if (!config.sourceName.trim()) throw new Error("sourceName is required");
  if (!config.sourceArtifactIds.length || config.sourceArtifactIds.some((id) => !id.trim()) || new Set(config.sourceArtifactIds).size !== config.sourceArtifactIds.length) {
    throw new Error("sourceArtifactIds must contain unique non-empty identifiers");
  }
  if (config.originalTimeframe !== "1m") throw new Error("originalTimeframe must be 1m");
  if (!config.originalTimezone.trim()) throw new Error("originalTimezone is required and must not be inferred");
  if (!(config.priceType === "MID" || config.priceType === "BID" || config.priceType === "ASK" || config.priceType === "SOURCE_DEFINED")) throw new Error("priceType is required and unsupported");
  if (!(config.dataKind === "OBSERVED" || config.dataKind === "SYNTHETIC")) throw new Error("dataKind must be OBSERVED or SYNTHETIC");
  for (const artifactId of config.sourceArtifactIds) {
    if (!SHA256.test(config.rawChecksums[artifactId] ?? "")) throw new Error(`raw checksum is missing or invalid for ${artifactId}`);
  }

  const requestedStart = config.requestedStart ?? DEFAULT_HISTORICAL_REQUESTED_START;
  const requestedEnd = config.requestedEnd ?? DEFAULT_HISTORICAL_REQUESTED_END;
  const startAt = parseCanonicalUtc(requestedStart);
  const endAt = parseCanonicalUtc(requestedEnd);
  if (startAt === null || endAt === null) throw new Error("requested range must use canonical UTC ISO timestamps");
  if (startAt % MINUTE_MS !== 0 || endAt % MINUTE_MS !== 0) throw new Error("requested range must align to UTC minute boundaries");
  if (startAt >= endAt) throw new Error("requestedStart must be earlier than requestedEnd");
  const generatedAt = config.generatedAt ?? new Date().toISOString();
  if (parseCanonicalUtc(generatedAt) === null) throw new Error("generatedAt must use canonical UTC ISO timestamp");
  return { startAt, endAt, generatedAt };
}

function emptyBucket(startAt: number): BucketAccumulator {
  return { startAt, observedMinuteCount: 0, open: null, high: Number.NEGATIVE_INFINITY, low: Number.POSITIVE_INFINITY, close: null };
}

function csvField(value: number): string {
  return String(value);
}

function createCsvWriter(filePath: string): Promise<CsvStreamWriter> {
  return open(filePath, "wx").then((file) => {
    let buffered = "";
    let bufferedBytes = 0;
    let closed = false;
    const hash: Hash = createHash("sha256");

    const flush = async (): Promise<void> => {
      if (!buffered) return;
      await file.writeFile(buffered, { encoding: "utf8" });
      buffered = "";
      bufferedBytes = 0;
    };

    return {
      async append(line: string): Promise<void> {
        if (closed) throw new Error("CSV writer is closed");
        hash.update(line, "utf8");
        buffered += line;
        bufferedBytes += Buffer.byteLength(line, "utf8");
        if (bufferedBytes >= 64 * 1024) await flush();
      },
      async close(): Promise<string> {
        if (closed) throw new Error("CSV writer is already closed");
        await flush();
        await file.sync();
        await file.close();
        closed = true;
        return hash.digest("hex");
      },
      async abort(): Promise<void> {
        if (closed) return;
        closed = true;
        buffered = "";
        await file.close().catch(() => undefined);
      },
    };
  });
}

function filenamePrefix(pair: Symbol): string {
  return pair.replace("/", "");
}

function validateMinuteRecord(value: unknown): { timestamp: number; candle: Candle } | null {
  if (!isRecord(value)) return null;
  const timestamp = parseCanonicalUtc(value.time);
  if (timestamp === null || timestamp % MINUTE_MS !== 0) return null;
  const { open, high, low, close } = value;
  if (![open, high, low, close].every((price) => typeof price === "number" && Number.isFinite(price) && price > 0)) return null;
  if ((high as number) < Math.max(open as number, close as number, low as number) || (low as number) > Math.min(open as number, close as number, high as number)) return null;
  return { timestamp, candle: { time: value.time as string, open: open as number, high: high as number, low: low as number, close: close as number } };
}

async function finishBucket(state: TargetState, requestedStart: number, requestedEnd: number): Promise<void> {
  const bucketStart = state.bucket.startAt;
  const bucketEnd = bucketStart + state.durationMs;
  const observedStart = Math.max(bucketStart, requestedStart);
  const observedEnd = Math.min(bucketEnd, requestedEnd);
  const expectedMinutes = Math.max(0, (observedEnd - observedStart) / MINUTE_MS);
  const partial = bucketStart < requestedStart || bucketEnd > requestedEnd;
  const quality = state.quality;

  quality.expectedCalendarMinuteCount += expectedMinutes;
  quality.observedMinuteCount += state.bucket.observedMinuteCount;
  const missingMinutes = expectedMinutes - state.bucket.observedMinuteCount;
  quality.missingCalendarMinuteCount += missingMinutes;
  quality.unclassifiedMissingMinuteCount += missingMinutes;
  if (partial) quality.partialRangeBucketCount++;
  if (state.bucket.observedMinuteCount === 0) quality.emptyBucketCount++;

  if (!partial && state.bucket.observedMinuteCount > 0) {
    const timestamp = new Date(bucketStart).toISOString();
    const line = `${timestamp},${csvField(state.bucket.open!)},${csvField(state.bucket.high)},${csvField(state.bucket.low)},${csvField(state.bucket.close!)}\n`;
    await state.writer.append(line);
    if (quality.firstTimestamp === null) quality.firstTimestamp = timestamp;
    quality.lastTimestamp = timestamp;
    quality.outputRows++;
  }
}

async function advanceTo(state: TargetState, targetStart: number, requestedStart: number, requestedEnd: number): Promise<void> {
  while (state.bucket.startAt < targetStart) {
    await finishBucket(state, requestedStart, requestedEnd);
    state.bucket = emptyBucket(state.bucket.startAt + state.durationMs);
  }
  if (state.bucket.startAt !== targetStart) throw new Error(`non-monotonic target bucket for ${state.timeframe}`);
}

function createReceipt(config: HistoricalPreparationConfig, range: { startAt: number; endAt: number; generatedAt: string }, counts: PreparationRowCounts, quality: Record<HistoricalTimeframe, TargetTimeframeQuality>): HistoricalPreparationReceipt {
  return {
    preparationVersion: HISTORICAL_PREPARATION_VERSION,
    sourceName: config.sourceName,
    sourceArtifactIds: [...config.sourceArtifactIds],
    rawChecksums: Object.fromEntries(Object.entries(config.rawChecksums).map(([id, checksum]) => [id, checksum.toLowerCase()])),
    priceType: config.priceType,
    originalTimeframe: "1m",
    originalTimezone: config.originalTimezone,
    requestedStart: new Date(range.startAt).toISOString(),
    requestedEnd: new Date(range.endAt).toISOString(),
    targetBoundaries: {
      "15m": { durationMinutes: 15, utcBoundary: UTC_BOUNDARIES["15m"] },
      "1h": { durationMinutes: 60, utcBoundary: UTC_BOUNDARIES["1h"] },
      "4h": { durationMinutes: 240, utcBoundary: UTC_BOUNDARIES["4h"] },
      "1day": { durationMinutes: 1440, utcBoundary: UTC_BOUNDARIES["1day"] },
    },
    ...counts,
    quality,
    generatedAt: range.generatedAt,
    normalizationRules: {
      version: HISTORICAL_PREPARATION_VERSION,
      inputTimestamp: "CANONICAL_UTC_1M_BAR_START",
      bucketInterval: "UTC_HALF_OPEN_START_INCLUSIVE_END_EXCLUSIVE",
      ohlc: "FIRST_OPEN_MAX_HIGH_MIN_LOW_LAST_CLOSE",
      missingMinutes: "DO_NOT_INTERPOLATE_OR_FORWARD_FILL",
      priceRounding: "NONE",
      priceTypeTransform: "NONE",
    },
  };
}

export async function prepareHistoricalDataset(records: AsyncIterable<unknown> | Iterable<unknown>, config: HistoricalPreparationConfig, outputDirectory: string): Promise<HistoricalPreparationResult> {
  const range = validateConfig(config);
  const finalDirectory = resolve(outputDirectory);
  try {
    await access(finalDirectory);
    throw new Error(`output directory already exists: ${finalDirectory}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(dirname(finalDirectory), { recursive: true });
  const stagingDirectory = await mkdtemp(join(dirname(finalDirectory), `.${basename(finalDirectory)}.preparing-`));
  const counts = emptyCounts();
  const writers: CsvStreamWriter[] = [];
  const states: TargetState[] = [];
  let previousTimestamp = Number.NEGATIVE_INFINITY;

  try {
    for (const timeframe of TIMEFRAMES) {
      const durationMs = DURATION_MINUTES[timeframe] * MINUTE_MS;
      const fileName = `${filenamePrefix(config.pair)}-${timeframe}.csv`;
      const writer = await createCsvWriter(join(stagingDirectory, fileName));
      writers.push(writer);
      await writer.append(`${CANONICAL_1M_CSV_HEADER}\n`);
      states.push({ timeframe, durationMs, writer, bucket: emptyBucket(Math.floor(range.startAt / durationMs) * durationMs), quality: emptyQuality() });
    }

    for await (const row of records) {
      counts.inputRows++;
      const parsed = validateMinuteRecord(row);
      if (!parsed) {
        counts.invalidCount++;
        counts.rejectedRows++;
        throw new HistoricalPreparationInputError(`invalid canonical 1m OHLC row at input row ${counts.inputRows}`, { ...counts });
      }
      if (parsed.timestamp === previousTimestamp) {
        counts.duplicateCount++;
        counts.rejectedRows++;
        throw new HistoricalPreparationInputError(`duplicate 1m timestamp at input row ${counts.inputRows}`, { ...counts });
      }
      if (parsed.timestamp < previousTimestamp) {
        counts.unorderedCount++;
        counts.rejectedRows++;
        throw new HistoricalPreparationInputError(`unordered 1m timestamp at input row ${counts.inputRows}`, { ...counts });
      }
      previousTimestamp = parsed.timestamp;
      if (parsed.timestamp < range.startAt || parsed.timestamp >= range.endAt) {
        counts.ignoredOutOfRangeRows++;
        continue;
      }
      counts.acceptedRows++;

      for (const state of states) {
        const targetStart = Math.floor(parsed.timestamp / state.durationMs) * state.durationMs;
        await advanceTo(state, targetStart, range.startAt, range.endAt);
        const bucket = state.bucket;
        if (bucket.observedMinuteCount === 0) bucket.open = parsed.candle.open;
        bucket.high = Math.max(bucket.high, parsed.candle.high);
        bucket.low = Math.min(bucket.low, parsed.candle.low);
        bucket.close = parsed.candle.close;
        bucket.observedMinuteCount++;
      }
    }

    for (const state of states) {
      while (state.bucket.startAt < range.endAt) {
        await finishBucket(state, range.startAt, range.endAt);
        state.bucket = emptyBucket(state.bucket.startAt + state.durationMs);
      }
    }

    const outputChecksums: Partial<Record<HistoricalTimeframe, string>> = {};
    for (const state of states) {
      if (state.quality.outputRows === 0) throw new Error(`requested range produced no complete ${state.timeframe} candles`);
      outputChecksums[state.timeframe] = await state.writer.close();
    }

    const files = Object.fromEntries(
      states.map((state) => [
        state.timeframe,
        {
          fileName: `${filenamePrefix(config.pair)}-${state.timeframe}.csv`,
          sha256: outputChecksums[state.timeframe]!,
        },
      ]),
    ) as HistoricalDatasetManifest["files"];
    const manifest: HistoricalDatasetManifest = {
      datasetId: config.datasetId,
      pair: config.pair,
      source: config.sourceName,
      timezone: "UTC",
      exportedAt: range.generatedAt,
      licenseProvenance: config.licenseProvenance,
      dataKind: config.dataKind,
      files,
    };
    const quality = Object.fromEntries(states.map((state) => [state.timeframe, state.quality])) as Record<HistoricalTimeframe, TargetTimeframeQuality>;
    const receipt = createReceipt(config, range, counts, quality);
    await writeFile(join(stagingDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await writeFile(join(stagingDirectory, "preparation-receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(stagingDirectory, finalDirectory);
    return { outputDirectory: finalDirectory, manifest, receipt };
  } catch (error) {
    await Promise.all(writers.map((writer) => writer.abort()));
    await rm(stagingDirectory, { recursive: true, force: true });
    throw error;
  }
}
