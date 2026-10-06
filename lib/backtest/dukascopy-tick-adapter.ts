import { createHash, type Hash } from "node:crypto";
import { createReadStream } from "node:fs";
import { createInterface, type Interface } from "node:readline";
import { basename } from "node:path";
import type { HistoricalPreparationConfig, HistoricalPreparationResult } from "./historical-dataset-preparation";
import { prepareHistoricalDataset, type HistoricalPreparationReceipt } from "./historical-dataset-preparation";
import { symbols, type Candle, type Symbol } from "../market/types";

export const DUKASCOPY_TICK_ADAPTER_VERSION = "DUKASCOPY_TICK_BID_ASK_MID_V1" as const;
export const DUKASCOPY_TICK_SOURCE_NAME = "Dukascopy Historical Data Export" as const;
export const DUKASCOPY_TICK_HEADER = "Etc/UTC,Open,High,Low,Close,Volume";

export interface DukascopyTickSourceOptions {
  bidFile: string;
  askFile: string;
  pair: Symbol;
  expectedSourceDate?: string;
  expectedSourceHourUtc?: number;
}

export interface DukascopyTickAdapterReceipt {
  adapterVersion: typeof DUKASCOPY_TICK_ADAPTER_VERSION;
  sourceName: typeof DUKASCOPY_TICK_SOURCE_NAME;
  sourceArtifactIds: string[];
  bidRawSha256: string;
  askRawSha256: string;
  pair: Symbol;
  sourcePeriod: "Tick";
  sourceTimezone: "Etc/UTC";
  priceType: "MID";
  priceTypeTransform: "SYNCHRONIZED_BID_ASK_TICK_MID";
  sourceDate: string | null;
  sourceHourUtc: number | null;
  firstTickTimestamp: string;
  lastTickTimestamp: string;
  firstMinuteTimestamp: string | null;
  lastMinuteTimestamp: string | null;
  tickCount: number;
  outputMinuteCount: number;
  minSpread: number;
  maxSpread: number;
  meanSpread: number;
}

export interface DukascopyTickMidStream extends AsyncIterable<Candle> {
  readonly rawChecksums: Record<string, string>;
  getReceipt(): DukascopyTickAdapterReceipt | null;
}

export interface DukascopyPhase1Config {
  datasetId: string;
  dataKind: HistoricalPreparationConfig["dataKind"];
  licenseProvenance: string;
  requestedStart?: string;
  requestedEnd?: string;
  generatedAt?: string;
}

export interface DukascopyPreparedDataset extends HistoricalPreparationResult {
  adapterReceipt: DukascopyTickAdapterReceipt;
  phase1Receipt: HistoricalPreparationReceipt;
}

interface SourceFilenameMetadata {
  pair: string;
  side: "BID" | "ASK";
  date: string;
  startHourUtc: number;
  endHourUtc: number;
  hourUtc: number | null;
}

interface Tick {
  time: string;
  at: number;
  price: number;
}

interface TickAccumulator {
  minuteStart: number;
  tickCount: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

interface HashedLineReader {
  iterator: AsyncIterator<string>;
  digest(): string;
  close(): Promise<void>;
}

const UTC_TICK_TIMESTAMP = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)\+00:00$/;
const MINUTE_MS = 60_000;
const FILENAME = /^([A-Z]{3})-([A-Z]{3})_1Tick_(BID|ASK)_(\d{4}-\d\d-\d\d)_(\d\d)_\d\d-(\d\d)_\d\d_Etc_UTC(?: \(\d+\))?\.csv$/i;

function sourceArtifactId(side: "BID" | "ASK", filePath: string): string {
  return `${side}:${basename(filePath)}`;
}

function fileChecksum(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk: Buffer | string) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", () => resolve(hash.digest("hex")));
  });
}

function openHashedLineReader(filePath: string): HashedLineReader {
  const hash: Hash = createHash("sha256");
  const stream = createReadStream(filePath);
  stream.on("data", (chunk: Buffer | string) => hash.update(chunk));
  const lines: Interface = createInterface({ input: stream, crlfDelay: Infinity });
  const iterator = lines[Symbol.asyncIterator]();
  let digested = false;
  let result = "";
  return {
    iterator,
    digest() {
      if (!digested) {
        result = hash.digest("hex");
        digested = true;
      }
      return result;
    },
    async close() {
      lines.close();
      if (!stream.destroyed) stream.destroy();
      await iterator.return?.();
    },
  };
}

function parseFilenameMetadata(filePath: string, explicitSide: "BID" | "ASK"): SourceFilenameMetadata | null {
  const match = FILENAME.exec(basename(filePath));
  if (!match) return null;
  const [, base, quote, side, date, startHourText, endHourText] = match;
  if (side!.toUpperCase() !== explicitSide) throw new Error(`${explicitSide} file role conflicts with filename: ${basename(filePath)}`);
  const hourUtc = Number(startHourText);
  const endHourUtc = Number(endHourText);
  if (hourUtc > 23 || endHourUtc > 23 || endHourUtc < hourUtc) throw new Error(`unsupported Dukascopy filename hour range: ${basename(filePath)}`);
  return {
    pair: `${base!.toUpperCase()}/${quote!.toUpperCase()}`,
    side: explicitSide,
    date: date!,
    startHourUtc: hourUtc,
    endHourUtc,
    hourUtc: hourUtc === endHourUtc ? hourUtc : null,
  };
}

function validateSourceOptions(options: DukascopyTickSourceOptions): { bidId: string; askId: string; date: string | null; hourUtc: number | null } {
  if (!symbols.includes(options.pair)) throw new Error("unsupported canonical pair");
  if (!options.bidFile.trim() || !options.askFile.trim()) throw new Error("explicit bidFile and askFile are required");
  if (options.bidFile === options.askFile) throw new Error("BID and ASK must be separate source files");
  if (basename(options.bidFile) === basename(options.askFile)) throw new Error("BID and ASK source artifact identifiers must be distinct");
  if (options.expectedSourceDate !== undefined && !/^\d{4}-\d\d-\d\d$/.test(options.expectedSourceDate)) throw new Error("expectedSourceDate must be YYYY-MM-DD");
  if (options.expectedSourceHourUtc !== undefined && (!Number.isInteger(options.expectedSourceHourUtc) || options.expectedSourceHourUtc < 0 || options.expectedSourceHourUtc > 23)) {
    throw new Error("expectedSourceHourUtc must be an integer hour from 0 to 23");
  }

  const bidMetadata = parseFilenameMetadata(options.bidFile, "BID");
  const askMetadata = parseFilenameMetadata(options.askFile, "ASK");
  for (const metadata of [bidMetadata, askMetadata]) {
    if (!metadata) continue;
    if (metadata.pair !== options.pair) throw new Error(`source filename pair ${metadata.pair} does not match requested pair ${options.pair}`);
    if (options.expectedSourceDate && metadata.date !== options.expectedSourceDate) throw new Error(`source filename date ${metadata.date} does not match expected date ${options.expectedSourceDate}`);
    if (options.expectedSourceHourUtc !== undefined && metadata.hourUtc !== options.expectedSourceHourUtc) throw new Error(`source filename hour ${metadata.hourUtc} does not match expected hour ${options.expectedSourceHourUtc}`);
  }
  if (bidMetadata && askMetadata && (bidMetadata.pair !== askMetadata.pair || bidMetadata.date !== askMetadata.date || bidMetadata.startHourUtc !== askMetadata.startHourUtc || bidMetadata.endHourUtc !== askMetadata.endHourUtc)) {
    throw new Error("BID and ASK filename metadata do not match");
  }
  const date = bidMetadata?.date ?? askMetadata?.date ?? options.expectedSourceDate ?? null;
  const hourUtc = bidMetadata?.hourUtc ?? askMetadata?.hourUtc ?? options.expectedSourceHourUtc ?? null;
  if (options.expectedSourceDate && date && options.expectedSourceDate !== date) throw new Error("source date metadata mismatch");
  if (options.expectedSourceHourUtc !== undefined && hourUtc !== null && options.expectedSourceHourUtc !== hourUtc) throw new Error("source hour metadata mismatch");
  return { bidId: sourceArtifactId("BID", options.bidFile), askId: sourceArtifactId("ASK", options.askFile), date, hourUtc };
}

function parseTickTimestamp(value: string): { at: number; canonical: string } {
  const match = UTC_TICK_TIMESTAMP.exec(value);
  if (!match) throw new Error(`timestamp is not the observed Etc/UTC tick format: ${value}`);
  const [, year, month, day, hour, minute, second] = match;
  const canonical = `${year}-${month}-${day}T${hour}:${minute}:${second}.000Z`;
  const at = Date.parse(canonical);
  if (!Number.isFinite(at) || new Date(at).toISOString() !== canonical) throw new Error(`invalid Etc/UTC tick timestamp: ${value}`);
  return { at, canonical };
}

function parseTickRow(line: string, rowNumber: number, side: "BID" | "ASK"): Tick {
  if (!line || line.includes('"')) throw new Error(`${side} row ${rowNumber} is blank or contains unsupported quoted fields`);
  const fields = line.split(",");
  if (fields.length !== 6) throw new Error(`${side} row ${rowNumber} must contain the observed six columns`);
  const { at, canonical } = parseTickTimestamp(fields[0]!);
  const values = fields.slice(1, 5).map((value) => (value === "" ? Number.NaN : Number(value)));
  if (!values.every((value) => Number.isFinite(value) && value > 0)) throw new Error(`${side} row ${rowNumber} has a non-positive or non-finite tick price`);
  if (!values.every((value) => value === values[0])) throw new Error(`${side} row ${rowNumber} violates observed Tick OHLC equality; source semantics are unknown`);
  return { at, time: canonical, price: values[0]! };
}

function validateTickDateHour(tick: Tick, metadata: { date: string | null; hourUtc: number | null; startHourUtc?: number; endHourUtc?: number }, expectedHour?: number): void {
  if (metadata.date && tick.time.slice(0, 10) !== metadata.date) throw new Error(`tick date ${tick.time.slice(0, 10)} conflicts with source date ${metadata.date}`);
  if (metadata.hourUtc !== null && Number(tick.time.slice(11, 13)) !== metadata.hourUtc) throw new Error(`tick hour conflicts with source hour ${metadata.hourUtc}`);
  const hour = Number(tick.time.slice(11, 13));
  if (metadata.startHourUtc !== undefined && metadata.endHourUtc !== undefined && (hour < metadata.startHourUtc || hour > metadata.endHourUtc)) throw new Error(`tick hour ${hour} is outside source filename range`);
  if (expectedHour !== undefined && hour !== expectedHour) throw new Error(`tick hour ${hour} does not match expected source hour ${expectedHour}`);
}

export async function createDukascopyTickMidStream(options: DukascopyTickSourceOptions): Promise<DukascopyTickMidStream> {
  const metadata = validateSourceOptions(options);
  const [bidRawSha256, askRawSha256] = await Promise.all([fileChecksum(options.bidFile), fileChecksum(options.askFile)]);
  const rawChecksums = { [metadata.bidId]: bidRawSha256, [metadata.askId]: askRawSha256 };
  let receipt: DukascopyTickAdapterReceipt | null = null;
  let consumed = false;

  async function* generate(): AsyncGenerator<Candle> {
    const bidSource = openHashedLineReader(options.bidFile);
    const askSource = openHashedLineReader(options.askFile);
    let bidPreviousAt = Number.NEGATIVE_INFINITY;
    let askPreviousAt = Number.NEGATIVE_INFINITY;
    let tickCount = 0;
    let outputMinuteCount = 0;
    let spreadSum = 0;
    let minSpread = Number.POSITIVE_INFINITY;
    let maxSpread = Number.NEGATIVE_INFINITY;
    let firstTickTimestamp = "";
    let lastTickTimestamp = "";
    let firstMinuteTimestamp: string | null = null;
    let lastMinuteTimestamp: string | null = null;
    let current: TickAccumulator | null = null;
    let bidRowNumber = 0;
    let askRowNumber = 0;

    const nextPair = async (): Promise<{ bid: IteratorResult<string>; ask: IteratorResult<string> }> => {
      const [bid, ask] = await Promise.all([bidSource.iterator.next(), askSource.iterator.next()]);
      return { bid, ask };
    };
    try {
      const header = await nextPair();
      if (header.bid.done || header.ask.done) throw new Error("BID and ASK files must both contain the observed CSV header");
      if (header.bid.value !== DUKASCOPY_TICK_HEADER || header.ask.value !== DUKASCOPY_TICK_HEADER) throw new Error(`unsupported Dukascopy Tick CSV header; expected ${DUKASCOPY_TICK_HEADER}`);

      while (true) {
        const pair = await nextPair();
        if (pair.bid.done || pair.ask.done) {
          if (pair.bid.done !== pair.ask.done) throw new Error("BID and ASK row counts differ");
          break;
        }
        bidRowNumber++;
        askRowNumber++;
        const bid = parseTickRow(pair.bid.value, bidRowNumber, "BID");
        const ask = parseTickRow(pair.ask.value, askRowNumber, "ASK");
        if (pair.bid.value.split(",")[0] !== pair.ask.value.split(",")[0]) throw new Error(`BID/ASK timestamp mismatch at synchronized row ${bidRowNumber}`);
        if (bid.at < bidPreviousAt || ask.at < askPreviousAt) throw new Error(`tick timestamp decreased at synchronized row ${bidRowNumber}`);
        validateTickDateHour(bid, metadata, options.expectedSourceHourUtc);
        validateTickDateHour(ask, metadata, options.expectedSourceHourUtc);
        if (ask.price < bid.price) throw new Error(`crossed BID/ASK quote at synchronized row ${bidRowNumber}`);

        bidPreviousAt = bid.at;
        askPreviousAt = ask.at;
        if (!firstTickTimestamp) firstTickTimestamp = bid.time;
        lastTickTimestamp = bid.time;
        tickCount++;
        const spread = ask.price - bid.price;
        spreadSum += spread;
        minSpread = Math.min(minSpread, spread);
        maxSpread = Math.max(maxSpread, spread);
        const mid = (bid.price + ask.price) / 2;
        const minuteStart = Math.floor(bid.at / MINUTE_MS) * MINUTE_MS;
        if (current && minuteStart !== current.minuteStart) {
          const completed = current;
          const time = new Date(completed.minuteStart).toISOString();
          if (firstMinuteTimestamp === null) firstMinuteTimestamp = time;
          lastMinuteTimestamp = time;
          outputMinuteCount++;
          yield { time, open: completed.open, high: completed.high, low: completed.low, close: completed.close };
          current = null;
        }
        if (!current) current = { minuteStart, tickCount: 0, open: mid, high: mid, low: mid, close: mid };
        current.high = Math.max(current.high, mid);
        current.low = Math.min(current.low, mid);
        current.close = mid;
        current.tickCount++;
      }

      if (current) {
        const time = new Date(current.minuteStart).toISOString();
        if (firstMinuteTimestamp === null) firstMinuteTimestamp = time;
        lastMinuteTimestamp = time;
        outputMinuteCount++;
        yield { time, open: current.open, high: current.high, low: current.low, close: current.close };
      }

      const actualBidHash = bidSource.digest();
      const actualAskHash = askSource.digest();
      if (actualBidHash !== bidRawSha256 || actualAskHash !== askRawSha256) throw new Error("BID/ASK source file changed between hashing and parsing");
      if (tickCount === 0) throw new Error("BID/ASK Tick files contain no synchronized data rows");
      receipt = {
        adapterVersion: DUKASCOPY_TICK_ADAPTER_VERSION,
        sourceName: DUKASCOPY_TICK_SOURCE_NAME,
        sourceArtifactIds: [metadata.bidId, metadata.askId],
        bidRawSha256: actualBidHash,
        askRawSha256: actualAskHash,
        pair: options.pair,
        sourcePeriod: "Tick",
        sourceTimezone: "Etc/UTC",
        priceType: "MID",
        priceTypeTransform: "SYNCHRONIZED_BID_ASK_TICK_MID",
        sourceDate: metadata.date,
        sourceHourUtc: metadata.hourUtc,
        firstTickTimestamp,
        lastTickTimestamp,
        firstMinuteTimestamp,
        lastMinuteTimestamp,
        tickCount,
        outputMinuteCount,
        minSpread,
        maxSpread,
        meanSpread: spreadSum / tickCount,
      };
    } finally {
      await Promise.all([bidSource.close(), askSource.close()]);
    }
  }

  const records: AsyncIterable<Candle> = {
    [Symbol.asyncIterator]() {
      if (consumed) throw new Error("Dukascopy tick stream is single-use");
      consumed = true;
      return generate();
    },
  };
  return { ...records, rawChecksums, getReceipt: () => receipt };
}

export async function prepareDukascopyHistoricalDataset(source: DukascopyTickSourceOptions, preparation: DukascopyPhase1Config, outputDirectory: string): Promise<DukascopyPreparedDataset> {
  const stream = await createDukascopyTickMidStream(source);
  const phase1Config: HistoricalPreparationConfig = {
    ...preparation,
    pair: source.pair,
    sourceName: DUKASCOPY_TICK_SOURCE_NAME,
    sourceArtifactIds: Object.keys(stream.rawChecksums),
    rawChecksums: stream.rawChecksums,
    priceType: "MID",
    originalTimeframe: "1m",
    originalTimezone: "Etc/UTC",
  };
  const prepared = await prepareHistoricalDataset(stream, phase1Config, outputDirectory);
  const adapterReceipt = stream.getReceipt();
  if (!adapterReceipt) throw new Error("Dukascopy tick stream did not complete its adapter receipt");
  return { ...prepared, adapterReceipt, phase1Receipt: prepared.receipt };
}

export async function* concatenateCanonicalMinuteChunks(chunks: Iterable<AsyncIterable<Candle>> | AsyncIterable<AsyncIterable<Candle>>): AsyncGenerator<Candle> {
  let previousAt = Number.NEGATIVE_INFINITY;
  for await (const chunk of chunks) {
    for await (const candle of chunk) {
      const at = Date.parse(candle.time);
      if (!Number.isFinite(at)) throw new Error(`invalid canonical minute timestamp in chunk: ${candle.time}`);
      if (at <= previousAt) throw new Error(at === previousAt ? `overlapping source chunks at ${candle.time}` : `source chunks are not chronological at ${candle.time}`);
      previousAt = at;
      yield candle;
    }
  }
}
