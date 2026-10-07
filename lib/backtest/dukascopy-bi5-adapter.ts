import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import type { Readable } from "node:stream";
import type { HistoricalPreparationConfig, HistoricalPreparationResult, HistoricalPreparationReceipt } from "./historical-dataset-preparation";
import { prepareHistoricalDataset } from "./historical-dataset-preparation";
import { concatenateCanonicalMinuteChunks } from "./dukascopy-tick-adapter";
import type { Candle } from "../market/types";

export const DUKASCOPY_BI5_ADAPTER_VERSION = "DUKASCOPY_S3_BI5_MID_V2" as const;
export const DUKASCOPY_BI5_SOURCE_NAME = "Dukascopy Official Historical Price Data S3" as const;
export const DUKASCOPY_BI5_BUCKET = "cfg-public-proper-wallaby" as const;
export const DUKASCOPY_BI5_REGION = "eu-west-1" as const;
export const DUKASCOPY_BI5_RECORD_SIZE = 20 as const;
export const DUKASCOPY_BI5_DECODER_FORMAT = ">IIIff" as const;

export interface Bi5DecompressionSession {
  output: Readable;
  finish(): Promise<void>;
  abort(): void;
}

export type Bi5Decompressor = (artifactPath: string) => Bi5DecompressionSession;

export interface DukascopyBi5AdapterOptions {
  artifactPath: string;
  instrument: string;
  sourceUtcDay: string;
  objectKey?: string;
  bucket?: string;
  region?: string;
  expectedRawSha256?: string;
  decompressor?: Bi5Decompressor;
}

export interface DukascopyBi5Receipt {
  adapterVersion: typeof DUKASCOPY_BI5_ADAPTER_VERSION;
  sourceName: typeof DUKASCOPY_BI5_SOURCE_NAME;
  sourceMethod: "S3_BI5";
  bucket: string;
  region: string;
  objectKey: string;
  instrument: string;
  pair: "USD/JPY";
  sourceUtcDay: string;
  rawSha256: string;
  rawByteSize: number;
  decompressedByteSize: number;
  recordCount: number;
  firstTickTimestamp: string;
  lastTickTimestamp: string;
  equalTimestampCount: number;
  timestampDecreaseCount: number;
  crossedQuoteCount: number;
  minSpread: number;
  maxSpread: number;
  meanSpread: number;
  canonicalMinuteCount: number;
  firstCanonicalMinute: string | null;
  lastCanonicalMinute: string | null;
  priceType: "MID";
  priceTransform: "SAME_RECORD_BID_ASK_MID";
  pointValue: 1000;
  decoderFormat: typeof DUKASCOPY_BI5_DECODER_FORMAT;
  recordSize: typeof DUKASCOPY_BI5_RECORD_SIZE;
  compression: "LZMA_ALONE";
}

export interface DukascopyBi5MinuteStream extends AsyncIterable<Candle> {
  readonly rawSha256: string;
  readonly rawByteSize: number;
  getReceipt(): DukascopyBi5Receipt | null;
}

export interface DukascopyBi5Phase1Config {
  datasetId: string;
  dataKind: HistoricalPreparationConfig["dataKind"];
  licenseProvenance: string;
  requestedStart?: string;
  requestedEnd?: string;
  generatedAt?: string;
}

export interface DukascopyBi5PreparedDataset extends HistoricalPreparationResult {
  artifactReceipts: DukascopyBi5Receipt[];
  phase1Receipt: HistoricalPreparationReceipt;
}

export interface CanonicalMinuteMismatch {
  index: number;
  timestamp: string | null;
  reference: Candle | null;
  candidate: Candle | null;
  fields: Array<"time" | "open" | "high" | "low" | "close">;
}

export interface CanonicalMinuteMismatch {
  index: number;
  timestamp: string | null;
  reference: Candle | null;
  candidate: Candle | null;
  fields: Array<"time" | "open" | "high" | "low" | "close">;
}

interface MinuteAccumulator {
  minuteStart: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

interface DecodedTick {
  at: number;
  timestamp: string;
  bid: number;
  ask: number;
}

const SUPPORTED_POINT_VALUE: Record<string, number> = { USDJPY: 1000 };
const UTC_DAY = /^\d{4}-\d\d-\d\d$/;
const SHA256 = /^[a-f0-9]{64}$/i;
const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

function parseUtcDay(day: string): number {
  if (!UTC_DAY.test(day)) throw new Error("sourceUtcDay must use YYYY-MM-DD");
  const start = Date.parse(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(start) || new Date(start).toISOString().slice(0, 10) !== day) throw new Error("sourceUtcDay is not a valid UTC calendar date");
  return start;
}

async function hashRawFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export function createXzLzmaDecompressor(binaryPath = "xz"): Bi5Decompressor {
  return (artifactPath) => {
    const process = spawn(binaryPath, ["--format=lzma", "--decompress", "--stdout", "--", artifactPath], { stdio: ["ignore", "pipe", "pipe"] });
    const stderrChunks: Buffer[] = [];
    let stderrSize = 0;
    process.stderr.on("data", (chunk: Buffer) => {
      if (stderrSize >= 4096) return;
      const remaining = 4096 - stderrSize;
      const saved = chunk.subarray(0, remaining);
      stderrChunks.push(saved);
      stderrSize += saved.length;
    });
    const closed = once(process, "close").then(([code, signal]) => ({ code, signal }));
    const failed = once(process, "error").then(([error]) => {
      throw error;
    });
    return {
      output: process.stdout,
      async finish() {
        const result = await Promise.race([closed, failed]);
        if (result.code !== 0) {
          const detail = Buffer.concat(stderrChunks).toString("utf8").trim();
          throw new Error(`LZMA decompression failed (exit=${String(result.code)}, signal=${String(result.signal)}): ${detail || "no decoder detail"}`);
        }
      },
      abort() {
        if (process.exitCode === null && process.signalCode === null) process.kill("SIGTERM");
      },
    };
  };
}

function decodeRecord(record: Buffer, dayStart: number, pointValue: number, index: number): DecodedTick {
  const milliseconds = record.readUInt32BE(0);
  const askInteger = record.readUInt32BE(4);
  const bidInteger = record.readUInt32BE(8);
  const askVolume = record.readFloatBE(12);
  const bidVolume = record.readFloatBE(16);
  if (milliseconds >= DAY_MS) throw new Error(`record ${index} timestamp is outside sourceUtcDay`);
  if (!Number.isFinite(askVolume) || !Number.isFinite(bidVolume) || askVolume < 0 || bidVolume < 0) throw new Error(`record ${index} has invalid BID/ASK volume fields`);
  const ask = askInteger / pointValue;
  const bid = bidInteger / pointValue;
  if (!Number.isFinite(ask) || !Number.isFinite(bid) || ask <= 0 || bid <= 0) throw new Error(`record ${index} has invalid scaled BID/ASK price`);
  if (ask < bid) throw new Error(`record ${index} contains ASK < BID`);
  const at = dayStart + milliseconds;
  return { at, timestamp: new Date(at).toISOString(), bid, ask };
}

export async function createDukascopyBi5MidStream(options: DukascopyBi5AdapterOptions): Promise<DukascopyBi5MinuteStream> {
  const pointValue = SUPPORTED_POINT_VALUE[options.instrument];
  if (!pointValue) throw new Error(`unsupported BI5 point scale for instrument: ${options.instrument}`);
  const dayStart = parseUtcDay(options.sourceUtcDay);
  const bucket = options.bucket ?? DUKASCOPY_BI5_BUCKET;
  const region = options.region ?? DUKASCOPY_BI5_REGION;
  const objectKey = options.objectKey ?? options.artifactPath.split(/[\\/]/).at(-1)!;
  const rawByteSize = (await stat(options.artifactPath)).size;
  const rawSha256 = await hashRawFile(options.artifactPath);
  if (options.expectedRawSha256 !== undefined) {
    if (!SHA256.test(options.expectedRawSha256)) throw new Error("expectedRawSha256 must be a 64-character hex digest");
    if (rawSha256 !== options.expectedRawSha256.toLowerCase()) throw new Error("BI5 raw checksum mismatch");
  }
  let receipt: DukascopyBi5Receipt | null = null;
  let consumed = false;
  const decompress = options.decompressor ?? createXzLzmaDecompressor();

  async function* generate(): AsyncGenerator<Candle> {
    const session = decompress(options.artifactPath);
    let remainder = Buffer.alloc(0);
    let decompressedByteSize = 0;
    let recordCount = 0;
    let equalTimestampCount = 0;
    let timestampDecreaseCount = 0;
    const crossedQuoteCount = 0;
    let spreadSum = 0;
    let minSpread = Number.POSITIVE_INFINITY;
    let maxSpread = Number.NEGATIVE_INFINITY;
    let firstTickTimestamp = "";
    let lastTickTimestamp = "";
    let previousTickAt = Number.NEGATIVE_INFINITY;
    let currentMinute: MinuteAccumulator | null = null;
    let canonicalMinuteCount = 0;
    let firstCanonicalMinute: string | null = null;
    let lastCanonicalMinute: string | null = null;

    try {
      for await (const chunkValue of session.output) {
        const chunk = Buffer.isBuffer(chunkValue) ? chunkValue : Buffer.from(chunkValue);
        decompressedByteSize += chunk.length;
        const data = remainder.length ? Buffer.concat([remainder, chunk]) : chunk;
        const completeLength = data.length - (data.length % DUKASCOPY_BI5_RECORD_SIZE);
        for (let offset = 0; offset < completeLength; offset += DUKASCOPY_BI5_RECORD_SIZE) {
          const record = data.subarray(offset, offset + DUKASCOPY_BI5_RECORD_SIZE);
          recordCount++;
          const tick = decodeRecord(record, dayStart, pointValue, recordCount);
          if (tick.at < previousTickAt) {
            timestampDecreaseCount++;
            throw new Error(`BI5 timestamp decreased at record ${recordCount}`);
          }
          if (tick.at === previousTickAt) equalTimestampCount++;
          previousTickAt = tick.at;
          if (!firstTickTimestamp) firstTickTimestamp = tick.timestamp;
          lastTickTimestamp = tick.timestamp;
          const spread = tick.ask - tick.bid;
          spreadSum += spread;
          minSpread = Math.min(minSpread, spread);
          maxSpread = Math.max(maxSpread, spread);
          const mid = (tick.bid + tick.ask) / 2;
          const minuteStart = Math.floor(tick.at / MINUTE_MS) * MINUTE_MS;
          if (currentMinute && currentMinute.minuteStart !== minuteStart) {
            const completed = currentMinute;
            const time = new Date(completed.minuteStart).toISOString();
            if (firstCanonicalMinute === null) firstCanonicalMinute = time;
            lastCanonicalMinute = time;
            canonicalMinuteCount++;
            yield { time, open: completed.open, high: completed.high, low: completed.low, close: completed.close };
            currentMinute = null;
          }
          if (!currentMinute) currentMinute = { minuteStart, open: mid, high: mid, low: mid, close: mid };
          currentMinute.high = Math.max(currentMinute.high, mid);
          currentMinute.low = Math.min(currentMinute.low, mid);
          currentMinute.close = mid;
        }
        remainder = Buffer.from(data.subarray(completeLength));
      }

      await session.finish();
      if (remainder.length !== 0) throw new Error(`truncated BI5 artifact: decompressed bytes ${decompressedByteSize} are not divisible by ${DUKASCOPY_BI5_RECORD_SIZE}`);
      if (recordCount === 0) throw new Error("BI5 artifact contains no tick records");
      if (currentMinute) {
        const time = new Date(currentMinute.minuteStart).toISOString();
        if (firstCanonicalMinute === null) firstCanonicalMinute = time;
        lastCanonicalMinute = time;
        canonicalMinuteCount++;
        yield { time, open: currentMinute.open, high: currentMinute.high, low: currentMinute.low, close: currentMinute.close };
      }
      const rawHashAfterDecode = await hashRawFile(options.artifactPath);
      if (rawHashAfterDecode !== rawSha256) throw new Error("BI5 raw artifact changed between checksum and decode");
      receipt = {
        adapterVersion: DUKASCOPY_BI5_ADAPTER_VERSION,
        sourceName: DUKASCOPY_BI5_SOURCE_NAME,
        sourceMethod: "S3_BI5",
        bucket,
        region,
        objectKey,
        instrument: options.instrument,
        pair: "USD/JPY",
        sourceUtcDay: options.sourceUtcDay,
        rawSha256,
        rawByteSize,
        decompressedByteSize,
        recordCount,
        firstTickTimestamp,
        lastTickTimestamp,
        equalTimestampCount,
        timestampDecreaseCount,
        crossedQuoteCount,
        minSpread,
        maxSpread,
        meanSpread: spreadSum / recordCount,
        canonicalMinuteCount,
        firstCanonicalMinute,
        lastCanonicalMinute,
        priceType: "MID",
        priceTransform: "SAME_RECORD_BID_ASK_MID",
        pointValue: 1000,
        decoderFormat: DUKASCOPY_BI5_DECODER_FORMAT,
        recordSize: DUKASCOPY_BI5_RECORD_SIZE,
        compression: "LZMA_ALONE",
      };
    } finally {
      session.abort();
    }
  }

  const stream: AsyncIterable<Candle> = {
    [Symbol.asyncIterator]() {
      if (consumed) throw new Error("BI5 minute stream is single-use");
      consumed = true;
      return generate();
    },
  };
  return { ...stream, rawSha256, rawByteSize, getReceipt: () => receipt };
}

export async function prepareDukascopyBi5HistoricalDataset(artifacts: DukascopyBi5AdapterOptions[], preparation: DukascopyBi5Phase1Config, outputDirectory: string): Promise<DukascopyBi5PreparedDataset> {
  if (!artifacts.length) throw new Error("at least one BI5 artifact is required");
  if (new Set(artifacts.map((artifact) => artifact.instrument)).size !== 1) throw new Error("all BI5 artifacts must use the same instrument");
  if (artifacts.some((artifact) => artifact.instrument !== "USDJPY")) throw new Error("only verified USDJPY pointValue 1000 is currently supported");
  const streams: DukascopyBi5MinuteStream[] = [];
  for (const artifact of artifacts) streams.push(await createDukascopyBi5MidStream(artifact));
  const records = concatenateCanonicalMinuteChunks(streams);
  const sourceArtifactIds = artifacts.map((artifact) => artifact.objectKey ?? artifact.artifactPath.split(/[\\/]/).at(-1)!);
  const rawChecksums = Object.fromEntries(streams.map((stream, index) => [sourceArtifactIds[index]!, stream.rawSha256]));
  const phase1Config: HistoricalPreparationConfig = {
    ...preparation,
    pair: "USD/JPY",
    sourceName: DUKASCOPY_BI5_SOURCE_NAME,
    sourceArtifactIds,
    rawChecksums,
    priceType: "MID",
    originalTimeframe: "1m",
    originalTimezone: "UTC",
  };
  const prepared = await prepareHistoricalDataset(records, phase1Config, outputDirectory);
  const artifactReceipts = streams.map((stream) => stream.getReceipt()).filter((receipt): receipt is DukascopyBi5Receipt => receipt !== null);
  if (artifactReceipts.length !== streams.length) throw new Error("one or more BI5 streams did not complete their receipts");
  return { ...prepared, artifactReceipts, phase1Receipt: prepared.receipt };
}

export function compareCanonicalMinuteSeries(reference: readonly Candle[], candidate: readonly Candle[]): CanonicalMinuteMismatch[] {
  const mismatches: CanonicalMinuteMismatch[] = [];
  const count = Math.max(reference.length, candidate.length);
  for (let index = 0; index < count; index++) {
    const expected = reference[index] ?? null;
    const actual = candidate[index] ?? null;
    const fields: CanonicalMinuteMismatch["fields"] = [];
    if (!expected || !actual) fields.push("time", "open", "high", "low", "close");
    else {
      if (expected.time !== actual.time) fields.push("time");
      if (expected.open !== actual.open) fields.push("open");
      if (expected.high !== actual.high) fields.push("high");
      if (expected.low !== actual.low) fields.push("low");
      if (expected.close !== actual.close) fields.push("close");
    }
    if (fields.length) mismatches.push({ index, timestamp: expected?.time ?? actual?.time ?? null, reference: expected, candidate: actual, fields });
  }
  return mismatches;
}

export function assertCanonicalMinuteSeriesEqual(reference: readonly Candle[], candidate: readonly Candle[]): void {
  const mismatches = compareCanonicalMinuteSeries(reference, candidate);
  if (mismatches.length) throw new Error(`canonical minute series differ in ${mismatches.length} row(s): ${JSON.stringify(mismatches)}`);
}
