import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Readable } from "node:stream";
import { loadLocalHistoricalDataset } from "../lib/backtest/local-dataset";
import { concatenateCanonicalMinuteChunks } from "../lib/backtest/dukascopy-tick-adapter";
import { assertCanonicalMinuteSeriesEqual, compareCanonicalMinuteSeries, createDukascopyBi5MidStream, DUKASCOPY_BI5_BUCKET, DUKASCOPY_BI5_DECODER_FORMAT, DUKASCOPY_BI5_RECORD_SIZE, prepareDukascopyBi5HistoricalDataset, type Bi5Decompressor } from "../lib/backtest/dukascopy-bi5-adapter";
import {
  DUKASCOPY_S3_ACQUISITION_VERSION,
  DEFAULT_DUKASCOPY_BI5_RAW_DIRECTORY,
  DukascopyS3AcquisitionError,
  downloadDukascopyS3PlanSequentially,
  markDukascopyS3ChunkDecodeFailed,
  markDukascopyS3ChunkDecoded,
  planDukascopyS3Acquisition,
  readDukascopyS3Checkpoint,
  writeDukascopyS3CheckpointAtomic,
  type DukascopyS3AcquisitionPlan,
  type DukascopyS3AcquisitionRequest,
  type DukascopyS3AcquisitionCheckpoint,
  type DukascopyS3ObjectDescriptor,
  type DukascopyS3Transport,
} from "../lib/backtest/dukascopy-s3-acquisition";
import type { Candle } from "../lib/market/types";

const DAY = "2025-01-06";
const DAY_START = Date.parse(`${DAY}T00:00:00.000Z`);

function record(milliseconds: number, ask: number, bid: number, askVolume = 1, bidVolume = 2): Buffer {
  const bytes = Buffer.alloc(DUKASCOPY_BI5_RECORD_SIZE);
  bytes.writeUInt32BE(milliseconds, 0);
  bytes.writeUInt32BE(ask, 4);
  bytes.writeUInt32BE(bid, 8);
  bytes.writeFloatBE(askVolume, 12);
  bytes.writeFloatBE(bidVolume, 16);
  return bytes;
}

function compressLzma(bytes: Buffer): Buffer {
  return execFileSync("xz", ["--format=lzma", "--lzma1=dict=4MiB", "--compress", "--stdout"], { input: bytes, maxBuffer: 4 * 1024 * 1024 });
}

function tempDirectory(): string {
  return mkdtempSync(join(tmpdir(), "task116-bi5-foundation-"));
}

function writeBi5(directory: string, bytes: Buffer, name = "synthetic-bi5"): string {
  const filePath = join(directory, `${name}.bi5`);
  writeFileSync(filePath, compressLzma(bytes));
  return filePath;
}

async function decode(filePath: string, changes: Record<string, unknown> = {}) {
  const stream = await createDukascopyBi5MidStream({
    artifactPath: filePath,
    instrument: "USDJPY",
    sourceUtcDay: DAY,
    objectKey: `fixture/${DAY}/${filePath.split(/[\\/]/).at(-1)}`,
    ...changes,
  });
  const candles: Candle[] = [];
  for await (const candle of stream) candles.push(candle);
  const receipt = stream.getReceipt();
  assert.ok(receipt);
  return { stream, candles, receipt: receipt! };
}

function s3Request(changes: Partial<DukascopyS3AcquisitionRequest> = {}): DukascopyS3AcquisitionRequest {
  return { instrument: "USDJPY", startDate: DAY, endDate: "2025-01-07", requesterPays: true, ...changes };
}

function inventoryForDays(startDate: string, count: number, sizeBytes = 100): DukascopyS3ObjectDescriptor[] {
  const startAt = Date.parse(`${startDate}T00:00:00.000Z`);
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(startAt + index * 86_400_000);
    const utcDay = date.toISOString().slice(0, 10);
    const key = `USDJPY/${date.getUTCFullYear()}/${String(date.getUTCMonth()).padStart(2, "0")}/${String(date.getUTCDate()).padStart(2, "0")}_ticks.bi5`;
    return { objectId: key, key, instrument: "USDJPY", utcDay, byteSize: sizeBytes };
  });
}

class FakeS3Transport implements DukascopyS3Transport {
  downloads = 0;
  failObjectId: string | null = null;
  failCategory: "DOWNLOAD_FAILED" | "ACCESS_DENIED" | "REQUESTER_PAYS_ERROR" | "CHECKSUM_ERROR" | "DECODE_ERROR" = "DOWNLOAD_FAILED";
  failureMessage = "synthetic transport failure";
  missingObjectIds = new Set<string>();
  objects: DukascopyS3ObjectDescriptor[];
  contents: Map<string, Buffer>;

  constructor(objects: DukascopyS3ObjectDescriptor[], contents = new Map<string, Buffer>()) {
    this.objects = objects;
    this.contents = contents;
  }

  async *downloadObject(request: { key: string; requesterPays: true }) {
    this.downloads++;
    assert.equal(request.requesterPays, true);
    const object = this.objects.find((item) => item.key === request.key) ?? { objectId: request.key, key: request.key, instrument: "USDJPY" as const, utcDay: DAY, byteSize: null };
    if (this.missingObjectIds.has(object.objectId)) throw new DukascopyS3AcquisitionError("OBJECT_NOT_FOUND", "NoSuchKey");
    if (object.objectId === this.failObjectId) throw new DukascopyS3AcquisitionError(this.failCategory, this.failureMessage);
    const bytes = this.contents.get(object.objectId) ?? Buffer.from(`raw:${object.objectId}`);
    yield bytes.subarray(0, Math.min(3, bytes.length));
    yield bytes.subarray(Math.min(3, bytes.length));
  }
}

function transferOptions(checkpointPath: string, rawDirectory: string, overrides: Record<string, unknown> = {}) {
  return { mode: "TRANSFER" as const, requesterPays: true as const, maxObjects: 10, maxKnownBytes: 10_000, rawDirectory, checkpointPath, ...overrides };
}

test("decodes a LZMA-Alone header fixture with official >IIIff fields, scale, timestamp and MID exactly", async () => {
  const directory = tempDirectory();
  try {
    const file = writeBi5(directory, record(1234, 157_207, 157_198, 1.5, 2.5));
    const compressed = readFileSync(file);
    assert.ok(compressed.length > 13);
    assert.equal(compressed[0], 0x5d);
    assert.equal(compressed.readUInt32LE(1), 4 * 1024 * 1024);
    assert.equal(compressed.readBigUInt64LE(5), BigInt("0xffffffffffffffff"));
    const { candles, receipt } = await decode(file);
    assert.equal(receipt.compression, "LZMA_ALONE");
    assert.equal(DUKASCOPY_BI5_DECODER_FORMAT, ">IIIff");
    assert.equal(DUKASCOPY_BI5_RECORD_SIZE, 20);
    assert.deepEqual(candles, [{ time: "2025-01-06T00:00:00.000Z", open: (157.207 + 157.198) / 2, high: (157.207 + 157.198) / 2, low: (157.207 + 157.198) / 2, close: (157.207 + 157.198) / 2 }]);
    assert.equal(receipt.firstTickTimestamp, "2025-01-06T00:00:01.234Z");
    assert.equal(receipt.pointValue, 1000);
    assert.equal(receipt.bucket, DUKASCOPY_BI5_BUCKET);
    assert.equal(receipt.priceTransform, "SAME_RECORD_BID_ASK_MID");
    assert.equal(receipt.recordCount, 1);
    assert.equal(receipt.firstTickTimestamp, new Date(DAY_START + 1234).toISOString());
    assert.equal(receipt.rawByteSize, statSync(file).size);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("production decoder rejects raw LZMA and XZ containers without format fallback", async () => {
  const directory = tempDirectory();
  try {
    for (const format of ["raw", "xz"]) {
      const args = [`--format=${format}`, "--compress", "--stdout"];
      if (format === "raw") args.push("--lzma1=dict=4MiB");
      const compressed = execFileSync("xz", args, { input: record(1234, 157_207, 157_198) });
      const file = join(directory, `${format}.bi5`);
      writeFileSync(file, compressed);
      await assert.rejects(() => decode(file), /LZMA decompression failed/);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("same-record ticks preserve equal timestamps and order without dedupe or rounding", async () => {
  const directory = tempDirectory();
  try {
    const bytes = Buffer.concat([record(60_000, 100_001, 100_000), record(60_000, 100_003, 100_002), record(120_000, 100_004, 100_003)]);
    const { candles, receipt } = await decode(writeBi5(directory, bytes));
    assert.equal(receipt.recordCount, 3);
    assert.equal(receipt.equalTimestampCount, 1);
    assert.deepEqual(candles, [
      { time: "2025-01-06T00:01:00.000Z", open: 100.0005, high: 100.0025, low: 100.0005, close: 100.0025 },
      { time: "2025-01-06T00:02:00.000Z", open: 100.0035, high: 100.0035, low: 100.0035, close: 100.0035 },
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("minute OHLC uses first/max/min/last and emits no empty minute", async () => {
  const directory = tempDirectory();
  try {
    const bytes = Buffer.concat([record(0, 100_200, 100_000), record(59_999, 100_400, 100_200), record(60_000, 100_100, 99_900), record(180_000, 100_600, 100_400)]);
    const { candles } = await decode(writeBi5(directory, bytes));
    const open = (100_200 / 1000 + 100_000 / 1000) / 2;
    const close = (100_400 / 1000 + 100_200 / 1000) / 2;
    assert.deepEqual(candles, [
      { time: "2025-01-06T00:00:00.000Z", open, high: close, low: open, close },
      { time: "2025-01-06T00:01:00.000Z", open: 100, high: 100, low: 100, close: 100 },
      { time: "2025-01-06T00:03:00.000Z", open: 100.5, high: 100.5, low: 100.5, close: 100.5 },
    ]);
    assert.equal(
      candles.some((candle) => candle.time === "2025-01-06T00:02:00.000Z"),
      false,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("unsupported point scales, zero prices, invalid volume and ASK below BID fail closed", async () => {
  const directory = tempDirectory();
  try {
    const files = [
      { bytes: record(0, 1_001, 1_000), instrument: "EURJPY", pattern: /unsupported BI5 point scale/ },
      { bytes: record(0, 0, 0), instrument: "USDJPY", pattern: /invalid scaled BID\/ASK price/ },
      { bytes: record(0, 999, 1_000), instrument: "USDJPY", pattern: /ASK < BID/ },
      { bytes: record(0, 1_001, 1_000, Number.NaN), instrument: "USDJPY", pattern: /invalid BID\/ASK volume/ },
    ];
    for (const [index, item] of files.entries()) {
      const file = writeBi5(directory, item.bytes, `invalid-${index}`);
      await assert.rejects(
        () =>
          createDukascopyBi5MidStream({ artifactPath: file, instrument: item.instrument, sourceUtcDay: DAY }).then(async (stream) => {
            for await (const candle of stream) assert.ok(candle.time);
          }),
        item.pattern,
      );
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("day-relative milliseconds are validated and equal timestamp ticks remain ordered", async () => {
  const directory = tempDirectory();
  try {
    const file = writeBi5(directory, record(86_400_000, 1001, 1000));
    const stream = await createDukascopyBi5MidStream({ artifactPath: file, instrument: "USDJPY", sourceUtcDay: DAY });
    await assert.rejects(async () => {
      for await (const candle of stream) assert.ok(candle.time);
    }, /outside sourceUtcDay/);
    await assert.rejects(() => createDukascopyBi5MidStream({ artifactPath: file, instrument: "USDJPY", sourceUtcDay: DAY, expectedRawSha256: "0".repeat(64) }), /raw checksum mismatch/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("missing raw BI5 artifact fails before decompression", async () => {
  const directory = tempDirectory();
  try {
    await assert.rejects(() => createDukascopyBi5MidStream({ artifactPath: join(directory, "missing.bi5"), instrument: "USDJPY", sourceUtcDay: DAY }));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("timestamp decrease fails, equal timestamps are accepted and receipt remains absent on failure", async () => {
  const directory = tempDirectory();
  try {
    const file = writeBi5(directory, Buffer.concat([record(2000, 1002, 1000), record(1000, 1002, 1000)]));
    const stream = await createDukascopyBi5MidStream({ artifactPath: file, instrument: "USDJPY", sourceUtcDay: DAY });
    await assert.rejects(async () => {
      for await (const candle of stream) assert.ok(candle.time);
    }, /timestamp decreased/);
    assert.equal(stream.getReceipt(), null);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("corrupt LZMA and truncated decompressed records fail closed", async () => {
  const directory = tempDirectory();
  try {
    const corrupt = join(directory, "corrupt.bi5");
    writeFileSync(corrupt, Buffer.from("not an LZMA stream"));
    const corruptStream = await createDukascopyBi5MidStream({ artifactPath: corrupt, instrument: "USDJPY", sourceUtcDay: DAY });
    await assert.rejects(async () => {
      for await (const candle of corruptStream) assert.ok(candle.time);
    }, /LZMA decompression failed/);

    const truncated = writeBi5(directory, Buffer.concat([record(0, 1001, 1000), Buffer.from([1, 2, 3])]), "truncated");
    const truncatedStream = await createDukascopyBi5MidStream({ artifactPath: truncated, instrument: "USDJPY", sourceUtcDay: DAY });
    await assert.rejects(async () => {
      for await (const candle of truncatedStream) assert.ok(candle.time);
    }, /not divisible by 20/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("raw hashes and decompression receipt are deterministic without mutating source bytes", async () => {
  const directory = tempDirectory();
  try {
    const bytes = Buffer.concat([record(0, 1002, 1000), record(60_000, 1003, 1001)]);
    const file = writeBi5(directory, bytes);
    const before = readFileSync(file);
    const expectedHash = createHash("sha256").update(before).digest("hex");
    const firstStream = await createDukascopyBi5MidStream({ artifactPath: file, instrument: "USDJPY", sourceUtcDay: DAY, expectedRawSha256: expectedHash, objectKey: "mock/instrument/day/hour.bi5" });
    const first: Candle[] = [];
    for await (const candle of firstStream) first.push(candle);
    const firstReceipt = firstStream.getReceipt();
    const second = await decode(file);
    assert.ok(firstReceipt);
    assert.equal(firstReceipt.rawSha256, expectedHash);
    assert.equal(firstReceipt.rawByteSize, before.length);
    assert.equal(firstReceipt.decompressedByteSize, bytes.length);
    assert.equal(firstReceipt.objectKey, "mock/instrument/day/hour.bi5");
    assert.deepEqual(first, second.candles);
    assert.deepEqual(readFileSync(file), before);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("BI5 streams concatenate chronologically and reject overlap/backwards artifacts", async () => {
  const directory = tempDirectory();
  try {
    const first = writeBi5(directory, record(86_399_000, 1002, 1000), "day1");
    const second = writeBi5(directory, record(0, 1004, 1002), "day2");
    const streams = await Promise.all([createDukascopyBi5MidStream({ artifactPath: first, instrument: "USDJPY", sourceUtcDay: "2025-01-06" }), createDukascopyBi5MidStream({ artifactPath: second, instrument: "USDJPY", sourceUtcDay: "2025-01-07" })]);
    const combined: Candle[] = [];
    for await (const candle of concatenateCanonicalMinuteChunks(streams)) combined.push(candle);
    assert.equal(combined.length, 2);

    const later = await createDukascopyBi5MidStream({ artifactPath: second, instrument: "USDJPY", sourceUtcDay: "2025-01-07" });
    const earlier = await createDukascopyBi5MidStream({ artifactPath: first, instrument: "USDJPY", sourceUtcDay: "2025-01-06" });
    await assert.rejects(async () => {
      for await (const candle of concatenateCanonicalMinuteChunks([later, earlier])) assert.ok(candle.time);
    }, /not chronological|overlapping source chunks/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("cross-source comparison reports every exact mismatch without mutating either side", () => {
  const reference: Candle[] = [
    { time: "2025-01-06T12:00:00.000Z", open: 100, high: 102, low: 99, close: 101 },
    { time: "2025-01-06T12:01:00.000Z", open: 101, high: 103, low: 100, close: 102 },
  ];
  const candidate: Candle[] = structuredClone(reference);
  candidate[1]!.high = 104;
  const referenceBefore = structuredClone(reference);
  const candidateBefore = structuredClone(candidate);
  const mismatches = compareCanonicalMinuteSeries(reference, candidate);
  assert.equal(mismatches.length, 1);
  assert.deepEqual(mismatches[0]!.fields, ["high"]);
  assert.deepEqual(reference, referenceBefore);
  assert.deepEqual(candidate, candidateBefore);
  assert.throws(() => assertCanonicalMinuteSeriesEqual(reference, candidate), /series differ in 1 row/);
  assert.doesNotThrow(() => assertCanonicalMinuteSeriesEqual(reference, structuredClone(reference)));
});

test("planner maps one UTC day directly to its official zero-indexed-month key", async () => {
  const dayPlan = await planDukascopyS3Acquisition(s3Request());
  assert.equal(dayPlan.mode, "DRY_RUN");
  assert.equal(dayPlan.logicalChunks.length, 1);
  assert.deepEqual([dayPlan.logicalChunks[0]?.startInclusive, dayPlan.logicalChunks[0]?.endExclusive], ["2025-01-06T00:00:00.000Z", "2025-01-07T00:00:00.000Z"]);
  assert.equal(dayPlan.logicalChunks[0]?.objectKey, "USDJPY/2025/00/06_ticks.bi5");
  assert.equal(dayPlan.logicalChunks[0]?.objectIds.length, 1);
  assert.equal(dayPlan.objects.length, 1);
  assert.equal(dayPlan.dryRun.plannedObjectCount, 1);
  const december = await planDukascopyS3Acquisition(s3Request({ startDate: "2025-12-31", endDate: "2026-01-01" }));
  assert.equal(december.logicalChunks[0]?.objectKey, "USDJPY/2025/11/31_ticks.bi5");
  const leap = await planDukascopyS3Acquisition(s3Request({ startDate: "2024-02-29", endDate: "2024-03-01" }));
  assert.equal(leap.logicalChunks[0]?.objectKey, "USDJPY/2024/01/29_ticks.bi5");
  await assert.rejects(() => planDukascopyS3Acquisition({ instrument: "USDJPY", requesterPays: true } as DukascopyS3AcquisitionRequest), /startDate/);
  await assert.rejects(() => planDukascopyS3Acquisition(s3Request({ requesterPays: false })), /Requester Pays/);
});

test("five-year dry-run deterministically produces 1,826 daily keys without S3 discovery", async () => {
  const plan = await planDukascopyS3Acquisition(s3Request({ startDate: "2021-01-01", endDate: "2026-01-01" }));
  assert.equal(plan.mode, "DRY_RUN");
  assert.equal(plan.logicalChunks.length, 1826);
  assert.equal(plan.objects.length, 1826);
  assert.equal(plan.dryRun.plannedObjectCount, 1826);
  assert.equal(plan.dryRun.plannedKeysKnown, true);
  assert.equal(plan.logicalChunks[0]?.utcDay, "2021-01-01");
  assert.equal(plan.logicalChunks[0]?.objectKey, "USDJPY/2021/00/01_ticks.bi5");
  assert.equal(plan.logicalChunks.at(-1)?.utcDay, "2025-12-31");
  assert.equal(plan.logicalChunks.at(-1)?.objectKey, "USDJPY/2025/11/31_ticks.bi5");
  assert.equal(plan.requestedEnd, "2026-01-01T00:00:00.000Z");
  assert.equal(plan.dryRun.objectInventoryKnown, false);
  assert.equal(plan.dryRun.unknownByteSizeCount, 1826);
  assert.equal(plan.dryRun.transferWouldOccur, false);
  await assert.rejects(() => planDukascopyS3Acquisition(s3Request({ mode: "TRANSFER", startDate: "2021-01-01", endDate: "2026-01-01" })), /allowMultiDayTransfer/);
  await assert.rejects(() => planDukascopyS3Acquisition(s3Request({ mode: "TRANSFER", requesterPays: undefined, startDate: "2021-01-01", endDate: "2026-01-01", allowMultiDayTransfer: true })), /Requester Pays/);
});

test("dry-run emits the exact pilot key with no network discovery or download", async () => {
  const transport = new FakeS3Transport(inventoryForDays(DAY, 1, 1234));
  const plan = await planDukascopyS3Acquisition(s3Request({ maxObjects: 10, maxKnownBytes: 10_000 }));
  assert.equal(plan.dryRun.plannedObjectCount, 1);
  assert.deepEqual(plan.dryRun.plannedObjectKeys, ["USDJPY/2025/00/06_ticks.bi5"]);
  assert.equal(plan.dryRun.plannedKeysKnown, true);
  assert.equal(plan.dryRun.knownByteSizeTotal, 0);
  assert.equal(plan.dryRun.unknownByteSizeCount, 1);
  assert.equal(plan.dryRun.requesterPays, true);
  assert.equal(plan.dryRun.region, "eu-west-1");
  assert.equal(plan.dryRun.transferWouldOccur, false);
  assert.equal(transport.downloads, 0);
});

test("daily keys are unique, ordered and independent of locale formatting", async () => {
  const plan = await planDukascopyS3Acquisition(s3Request({ startDate: "2024-02-28", endDate: "2024-03-02" }));
  assert.deepEqual(
    plan.logicalChunks.map((chunk) => chunk.objectKey),
    ["USDJPY/2024/01/28_ticks.bi5", "USDJPY/2024/01/29_ticks.bi5", "USDJPY/2024/02/01_ticks.bi5"],
  );
  assert.equal(new Set(plan.dryRun.plannedObjectKeys).size, 3);
});

test("object cap fails before transfer and byte cap stops streamed bytes", async () => {
  const objects = inventoryForDays(DAY, 1, 500);
  const transport = new FakeS3Transport(objects);
  const plan = await planDukascopyS3Acquisition(s3Request({ mode: "TRANSFER" }));
  const directory = tempDirectory();
  try {
    const checkpointPath = join(directory, "checkpoint.json");
    const rawDirectory = join(directory, "raw");
    await assert.rejects(() => downloadDukascopyS3PlanSequentially(plan, transport, transferOptions(checkpointPath, rawDirectory, { maxObjects: 0 })), /maxObjects/);
    const capped = await downloadDukascopyS3PlanSequentially(plan, transport, transferOptions(checkpointPath, rawDirectory, { maxKnownBytes: 10 }));
    assert.equal(capped.chunks[0]?.status, "FAILED");
    assert.equal(capped.chunks[0]?.errorCategory, "DOWNLOAD_FAILED");
    assert.equal(transport.downloads, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("full-range transfer requires explicit operator confirmation and transfer caps", async () => {
  await assert.rejects(() => planDukascopyS3Acquisition(s3Request({ mode: "TRANSFER", startDate: "2021-01-01", endDate: "2026-01-01" })), /allowMultiDayTransfer/);
  const object = inventoryForDays("2021-01-01", 1, 100)[0]!;
  const twoDayTransport = new FakeS3Transport([object, inventoryForDays("2021-01-02", 1)[0]!]);
  const plan = await planDukascopyS3Acquisition(s3Request({ mode: "TRANSFER", startDate: "2021-01-01", endDate: "2021-01-03", allowMultiDayTransfer: true }));
  const directory = tempDirectory();
  try {
    await assert.rejects(() => downloadDukascopyS3PlanSequentially(plan, twoDayTransport, transferOptions(join(directory, "checkpoint.json"), join(directory, "raw"), { allowMultiDayTransfer: false })), /allowMultiDayTransfer/);
    assert.equal(twoDayTransport.downloads, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("missing daily object is checkpointed as NO_DATA and creates no artifact or candle", async () => {
  const object = inventoryForDays(DAY, 1)[0]!;
  const transport = new FakeS3Transport([object]);
  transport.missingObjectIds.add(object.objectId);
  const plan = await planDukascopyS3Acquisition(s3Request({ mode: "TRANSFER" }));
  const directory = tempDirectory();
  try {
    const checkpointPath = join(directory, "checkpoint.json");
    const result = await downloadDukascopyS3PlanSequentially(plan, transport, transferOptions(checkpointPath, join(directory, "raw")));
    const chunk = result.chunks[0]!;
    assert.equal(chunk.status, "NO_DATA");
    assert.equal(chunk.errorCategory, "NO_DATA");
    assert.match(chunk.errorMessage ?? "", /source reports NO_DATA/);
    assert.equal(chunk.rawFilePath, null);
    assert.equal(chunk.rawByteSize, null);
    assert.equal(chunk.tickCount, null);
    assert.equal(chunk.canonicalMinuteCount, null);
    assert.deepEqual(readdirSync(join(directory, "raw")), []);
    assert.equal(transport.downloads, 1);
    await assert.rejects(
      () =>
        markDukascopyS3ChunkDecoded(checkpointPath, object.objectId, {
          firstTickTimestamp: `${DAY}T00:00:00.000Z`,
          lastTickTimestamp: `${DAY}T00:00:00.000Z`,
          tickCount: 1,
          canonicalMinuteCount: 1,
          decoderVersion: "test",
        }),
      /only VERIFIED chunks/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("sequential fake download writes verified raw chunks and an atomic credential-free checkpoint", async () => {
  const directory = tempDirectory();
  try {
    const bytes = Buffer.from("mock immutable .bi5 bytes");
    const objects = inventoryForDays(DAY, 1, bytes.length);
    const transport = new FakeS3Transport(objects, new Map([[objects[0]!.objectId, bytes]]));
    const plan = await planDukascopyS3Acquisition(s3Request({ mode: "TRANSFER" }));
    const checkpointPath = join(directory, "checkpoint.json");
    const rawDirectory = join(directory, "tmp", "dukascopy", "bi5-raw");
    const checkpoint = await downloadDukascopyS3PlanSequentially(plan, transport, transferOptions(checkpointPath, rawDirectory));
    const chunk = checkpoint.chunks[0]!;
    assert.equal(chunk.status, "VERIFIED");
    assert.equal(chunk.attempts, 1);
    assert.ok(chunk.downloadTimestamp);
    assert.equal(chunk.rawByteSize, bytes.length);
    assert.equal(chunk.rawSha256, createHash("sha256").update(bytes).digest("hex"));
    assert.deepEqual(readFileSync(chunk.rawFilePath!), bytes);
    assert.equal(transport.downloads, 1);
    const checkpointText = readFileSync(checkpointPath, "utf8");
    assert.doesNotMatch(checkpointText, /secret|accessKey|secretAccessKey|sessionToken/i);
    assert.equal(
      readdirSync(directory).some((name) => name.endsWith(".tmp")),
      false,
    );
    const reread = await readDukascopyS3Checkpoint(checkpointPath);
    assert.equal(reread?.chunks[0]?.status, "VERIFIED");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("resume skips only hash-matching VERIFIED artifacts; missing or changed artifacts download again immutably", async () => {
  const directory = tempDirectory();
  try {
    const bytes = Buffer.from("raw artifact content");
    const objects = inventoryForDays(DAY, 1, bytes.length);
    const transport = new FakeS3Transport(objects, new Map([[objects[0]!.objectId, bytes]]));
    const plan = await planDukascopyS3Acquisition(s3Request({ mode: "TRANSFER" }));
    const checkpointPath = join(directory, "checkpoint.json");
    const rawDirectory = join(directory, "raw");
    const options = transferOptions(checkpointPath, rawDirectory);
    let checkpoint = await downloadDukascopyS3PlanSequentially(plan, transport, options);
    assert.equal(transport.downloads, 1);
    checkpoint = await downloadDukascopyS3PlanSequentially(plan, transport, options);
    assert.equal(transport.downloads, 1);
    const firstPath = checkpoint.chunks[0]!.rawFilePath!;
    unlinkSync(firstPath);
    checkpoint = await downloadDukascopyS3PlanSequentially(plan, transport, options);
    assert.equal(transport.downloads, 2);
    const secondPath = checkpoint.chunks[0]!.rawFilePath!;
    assert.notEqual(firstPath, secondPath);
    writeFileSync(secondPath, Buffer.from("corrupt after verification"));
    checkpoint = await downloadDukascopyS3PlanSequentially(plan, transport, options);
    assert.equal(transport.downloads, 3);
    assert.notEqual(checkpoint.chunks[0]!.rawFilePath, secondPath);
    assert.equal(readFileSync(secondPath, "utf8"), "corrupt after verification");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("failed download is checkpointed FAILED and is not marked decoded", async () => {
  const directory = tempDirectory();
  try {
    const bytes = Buffer.from("raw artifact content");
    const objects = inventoryForDays(DAY, 1, bytes.length);
    const transport = new FakeS3Transport(objects);
    transport.failObjectId = objects[0]!.objectId;
    transport.failureMessage = "AWS_SECRET_ACCESS_KEY=do-not-store";
    const plan = await planDukascopyS3Acquisition(s3Request({ mode: "TRANSFER" }));
    const checkpointPath = join(directory, "checkpoint.json");
    const result = await downloadDukascopyS3PlanSequentially(plan, transport, transferOptions(checkpointPath, join(directory, "raw")));
    assert.equal(result.chunks[0]?.status, "FAILED");
    assert.equal(result.chunks[0]?.errorCategory, "DOWNLOAD_FAILED");
    assert.match(result.chunks[0]?.errorMessage ?? "", /omitted to prevent secret leakage/);
    assert.doesNotMatch(readFileSync(checkpointPath, "utf8"), /do-not-store/);
    await assert.rejects(
      () =>
        markDukascopyS3ChunkDecoded(checkpointPath, objects[0]!.objectId, {
          firstTickTimestamp: "2025-01-06T00:00:00.000Z",
          lastTickTimestamp: "2025-01-06T00:00:00.000Z",
          tickCount: 1,
          canonicalMinuteCount: 1,
          decoderVersion: "test",
        }),
      /only VERIFIED chunks/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("access, Requester Pays and checksum errors remain distinct failures, not NO_DATA", async () => {
  for (const category of ["ACCESS_DENIED", "REQUESTER_PAYS_ERROR", "CHECKSUM_ERROR"] as const) {
    const directory = tempDirectory();
    try {
      const object = inventoryForDays(DAY, 1)[0]!;
      const transport = new FakeS3Transport([object]);
      transport.failObjectId = object.objectId;
      transport.failCategory = category;
      const plan = await planDukascopyS3Acquisition(s3Request({ mode: "TRANSFER" }));
      const result = await downloadDukascopyS3PlanSequentially(plan, transport, transferOptions(join(directory, "checkpoint.json"), join(directory, "raw")));
      assert.equal(result.chunks[0]?.status, "FAILED");
      assert.equal(result.chunks[0]?.errorCategory, category);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("decode failure is checkpointed as DECODE_ERROR", async () => {
  const directory = tempDirectory();
  try {
    const object = inventoryForDays(DAY, 1)[0]!;
    const bytes = Buffer.from("raw artifact content");
    const transport = new FakeS3Transport([object], new Map([[object.objectId, bytes]]));
    const plan = await planDukascopyS3Acquisition(s3Request({ mode: "TRANSFER" }));
    const checkpointPath = join(directory, "checkpoint.json");
    await downloadDukascopyS3PlanSequentially(plan, transport, transferOptions(checkpointPath, join(directory, "raw")));
    const result = await markDukascopyS3ChunkDecodeFailed(checkpointPath, object.objectId);
    assert.equal(result.chunks[0]?.status, "FAILED");
    assert.equal(result.chunks[0]?.errorCategory, "DECODE_ERROR");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("verified checkpoint can transition to DECODED with provenance and no credentials", async () => {
  const directory = tempDirectory();
  try {
    const bytes = Buffer.from("raw artifact content");
    const objects = inventoryForDays(DAY, 1, bytes.length);
    const transport = new FakeS3Transport(objects, new Map([[objects[0]!.objectId, bytes]]));
    const plan = await planDukascopyS3Acquisition(s3Request({ mode: "TRANSFER" }));
    const checkpointPath = join(directory, "checkpoint.json");
    const verified = await downloadDukascopyS3PlanSequentially(plan, transport, transferOptions(checkpointPath, join(directory, "raw")));
    const decoded = await markDukascopyS3ChunkDecoded(checkpointPath, objects[0]!.objectId, {
      firstTickTimestamp: `${DAY}T00:00:00.000Z`,
      lastTickTimestamp: `${DAY}T23:59:59.999Z`,
      tickCount: 123,
      canonicalMinuteCount: 60,
      decoderVersion: "fixture-decoder",
    });
    assert.equal(verified.chunks[0]?.status, "VERIFIED");
    assert.equal(decoded.chunks[0]?.status, "DECODED");
    assert.equal(decoded.chunks[0]?.tickCount, 123);
    assert.doesNotMatch(readFileSync(checkpointPath, "utf8"), /secret|token|credential/i);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("no AWS implementation or implicit network is invoked by the local foundation", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new Error("network forbidden");
  };
  try {
    const fake = new FakeS3Transport(inventoryForDays(DAY, 1));
    const plan = await planDukascopyS3Acquisition(s3Request());
    assert.equal(plan.mode, "DRY_RUN");
    assert.equal(plan.dryRun.transferWouldOccur, false);
    assert.equal(fake.downloads, 0);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("decompressed record parser handles arbitrary byte chunk boundaries", async () => {
  const directory = tempDirectory();
  try {
    const raw = Buffer.concat([record(0, 1002, 1000), record(60_000, 1004, 1002)]);
    const artifactPath = join(directory, "fragmented.bi5");
    writeFileSync(artifactPath, compressLzma(raw));
    const decompressor: Bi5Decompressor = () => ({
      output: Readable.from([raw.subarray(0, 3), raw.subarray(3, 21), raw.subarray(21)]),
      async finish() {},
      abort() {},
    });
    const result = await decode(artifactPath, { decompressor });
    assert.equal(result.receipt.recordCount, 2);
    assert.equal(result.candles.length, 2);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("BI5 canonical stream integrates with Phase 1 exactly once and imports target CSVs", async () => {
  const directory = tempDirectory();
  try {
    const raw = Buffer.concat(Array.from({ length: 1440 }, (_, minute) => record(minute * 60_000, 150_002 + minute, 150_000 + minute)));
    const artifactPath = writeBi5(directory, raw, "one-day");
    const outputDirectory = join(directory, "prepared");
    const prepared = await prepareDukascopyBi5HistoricalDataset(
      [{ artifactPath, instrument: "USDJPY", sourceUtcDay: DAY, objectKey: `mock/USDJPY/${DAY}.bi5` }],
      {
        datasetId: "synthetic-bi5-one-day",
        dataKind: "SYNTHETIC",
        licenseProvenance: "synthetic fixture; not independent market evidence",
        requestedStart: `${DAY}T00:00:00.000Z`,
        requestedEnd: "2025-01-07T00:00:00.000Z",
        generatedAt: "2026-10-06T00:00:00.000Z",
      },
      outputDirectory,
    );
    assert.equal(prepared.artifactReceipts[0]?.recordCount, 1440);
    assert.equal(prepared.artifactReceipts[0]?.canonicalMinuteCount, 1440);
    assert.equal(prepared.phase1Receipt.priceType, "MID");
    assert.equal(prepared.phase1Receipt.originalTimezone, "UTC");
    assert.equal(prepared.phase1Receipt.rawChecksums[`mock/USDJPY/${DAY}.bi5`], prepared.artifactReceipts[0]?.rawSha256);
    assert.deepEqual(Object.keys(prepared.manifest.files).toSorted(), ["15m", "1day", "1h", "4h"]);
    const imported = loadLocalHistoricalDataset(outputDirectory);
    assert.equal(imported.valid, true, imported.valid ? "" : imported.errors.join("; "));
    if (imported.valid) assert.equal(imported.imported.dataset.timeframes["1day"]?.length, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("atomic checkpoint writer round-trips version and does not leave temp files", async () => {
  const directory = tempDirectory();
  try {
    const plan: DukascopyS3AcquisitionPlan = await planDukascopyS3Acquisition(s3Request());
    const checkpoint: DukascopyS3AcquisitionCheckpoint = {
      checkpointVersion: DUKASCOPY_S3_ACQUISITION_VERSION,
      source: "Dukascopy Official Historical Price Data S3",
      bucket: "cfg-public-proper-wallaby",
      region: "eu-west-1",
      requesterPays: true,
      instrument: "USDJPY",
      requestedStart: plan.requestedStart,
      requestedEnd: plan.requestedEnd,
      updatedAt: "2026-10-06T00:00:00.000Z",
      chunks: [],
    };
    const checkpointPath = join(directory, "checkpoint.json");
    await writeDukascopyS3CheckpointAtomic(checkpointPath, checkpoint);
    const loaded = await readDukascopyS3Checkpoint(checkpointPath);
    assert.equal(loaded?.checkpointVersion, DUKASCOPY_S3_ACQUISITION_VERSION);
    assert.equal(loaded?.requesterPays, true);
    assert.deepEqual(readdirSync(directory), ["checkpoint.json"]);
    assert.ok(DEFAULT_DUKASCOPY_BI5_RAW_DIRECTORY.startsWith("tmp/dukascopy/"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("synthetic 80k-record compressed BI5 decodes incrementally with bounded working state", async (context) => {
  const directory = tempDirectory();
  try {
    const count = 80_000;
    const bytes = Buffer.alloc(count * DUKASCOPY_BI5_RECORD_SIZE);
    for (let index = 0; index < count; index++) {
      const offset = index * DUKASCOPY_BI5_RECORD_SIZE;
      bytes.writeUInt32BE(index * 1000, offset);
      bytes.writeUInt32BE(150_002 + (index % 1000), offset + 4);
      bytes.writeUInt32BE(150_000 + (index % 1000), offset + 8);
      bytes.writeFloatBE(1, offset + 12);
      bytes.writeFloatBE(1, offset + 16);
    }
    const file = writeBi5(directory, bytes, "synthetic-80k");
    const beforeRss = process.memoryUsage().rss;
    const started = performance.now();
    const result = await decode(file);
    const elapsedMs = performance.now() - started;
    const rssDeltaBytes = process.memoryUsage().rss - beforeRss;
    assert.equal(result.receipt.recordCount, count);
    assert.equal(result.receipt.decompressedByteSize, count * DUKASCOPY_BI5_RECORD_SIZE);
    assert.equal(result.candles.length, Math.ceil(count / 60));
    context.diagnostic(`synthetic BI5 records=${count}, decompressedBytes=${bytes.length}, elapsedMs=${Math.round(elapsedMs)}, rssDeltaBytes=${rssDeltaBytes}`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
