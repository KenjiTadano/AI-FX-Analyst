import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { loadLocalHistoricalDataset } from "../lib/backtest/local-dataset";
import { DEFAULT_HISTORICAL_REQUESTED_END, DEFAULT_HISTORICAL_REQUESTED_START, HistoricalPreparationInputError, prepareHistoricalDataset, type HistoricalPreparationConfig } from "../lib/backtest/historical-dataset-preparation";
import type { HistoricalTimeframe } from "../lib/backtest/signal-replay";
import type { Candle } from "../lib/market/types";

const MINUTE = 60_000;
const SMALL_START = "2025-01-01T00:00:00.000Z";
const SMALL_END = "2025-01-03T00:00:00.000Z";
const RAW_HASH = "a".repeat(64);

function config(changes: Partial<HistoricalPreparationConfig> = {}): HistoricalPreparationConfig {
  return {
    datasetId: "usd-jpy-preparation-test",
    pair: "USD/JPY",
    dataKind: "OBSERVED",
    licenseProvenance: "test fixture; no redistribution claim",
    sourceName: "canonical-test-stream",
    sourceArtifactIds: ["raw-fixture-001"],
    rawChecksums: { "raw-fixture-001": RAW_HASH },
    priceType: "MID",
    originalTimeframe: "1m",
    originalTimezone: "UTC",
    requestedStart: SMALL_START,
    requestedEnd: SMALL_END,
    generatedAt: "2026-10-05T00:00:00.000Z",
    ...changes,
  };
}

function candleAt(time: string, open: number, high = open, low = open, close = open): Candle {
  return { time, open, high, low, close };
}

function minuteAt(time: string, values: [number, number, number, number] = [150, 150.1, 149.9, 150]): Candle {
  return candleAt(time, ...values);
}

function* minuteSequence(startAt: number, count: number): Generator<Candle> {
  for (let index = 0; index < count; index++) {
    const price = 150 + index / 100_000;
    yield candleAt(new Date(startAt + index * MINUTE).toISOString(), price, price + 0.01, price - 0.01, price + 0.001);
  }
}

async function runPreparation(records: Iterable<unknown> | AsyncIterable<unknown>, options: { config?: Partial<HistoricalPreparationConfig>; name?: string } = {}) {
  const parent = mkdtempSync(join(tmpdir(), "task116-preparation-test-"));
  const outputDirectory = join(parent, options.name ?? "prepared");
  try {
    const result = await prepareHistoricalDataset(records, config(options.config), outputDirectory);
    return { parent, outputDirectory, result };
  } catch (error) {
    rmSync(parent, { recursive: true, force: true });
    throw error;
  }
}

function csvRows(outputDirectory: string, timeframe: HistoricalTimeframe): string[][] {
  const prefix = timeframe;
  const text = readFileSync(join(outputDirectory, `USDJPY-${prefix}.csv`), "utf8");
  assert.equal(text.charCodeAt(0), 0x74);
  assert.equal(text.includes("\r"), false);
  assert.equal(text.endsWith("\n"), true);
  const [header, ...lines] = text.trimEnd().split("\n");
  assert.equal(header, "time,open,high,low,close");
  return lines.map((line) => line.split(","));
}

test("canonical 1m input produces Task116-importable UTC output and separated hashes", async () => {
  const start = Date.parse(SMALL_START);
  const fixture = await runPreparation(minuteSequence(start, 2 * 1440));
  try {
    const files = readdirSync(fixture.outputDirectory).toSorted();
    assert.deepEqual(files, ["USDJPY-15m.csv", "USDJPY-1day.csv", "USDJPY-1h.csv", "USDJPY-4h.csv", "manifest.json", "preparation-receipt.json"]);
    const imported = loadLocalHistoricalDataset(fixture.outputDirectory);
    assert.equal(imported.valid, true, imported.valid ? "" : imported.errors.join("; "));
    if (imported.valid) {
      assert.deepEqual(Object.keys(imported.imported.dataset.timeframes).toSorted(), ["15m", "1day", "1h", "4h"].toSorted());
      assert.equal(imported.imported.dataset.pair, "USD/JPY");
      assert.equal(imported.imported.provenance.dataKind, "OBSERVED");
    }
    for (const timeframe of ["15m", "1h", "4h", "1day"] as const) {
      const bytes = readFileSync(join(fixture.outputDirectory, `USDJPY-${timeframe}.csv`));
      assert.equal(fixture.result.manifest.files[timeframe]?.sha256, createHash("sha256").update(bytes).digest("hex"));
      assert.notEqual(fixture.result.manifest.files[timeframe]?.sha256, fixture.result.receipt.rawChecksums["raw-fixture-001"]);
    }
    assert.equal(fixture.result.receipt.priceType, "MID");
    assert.equal(fixture.result.receipt.originalTimezone, "UTC");
    assert.equal(fixture.result.receipt.requestedStart, SMALL_START);
    assert.equal(fixture.result.receipt.requestedEnd, SMALL_END);
  } finally {
    rmSync(fixture.parent, { recursive: true, force: true });
  }
});

test("15m OHLC uses first, max, min and last in exactly one UTC bucket", async () => {
  const fixture = await runPreparation([candleAt("2025-01-01T00:00:00.000Z", 10, 12, 9, 11), candleAt("2025-01-01T00:07:00.000Z", 11, 20, 8, 13), candleAt("2025-01-01T00:14:00.000Z", 13, 14, 7, 12), minuteAt("2025-01-01T00:15:00.000Z", [12, 15, 10, 14])]);
  try {
    assert.deepEqual(csvRows(fixture.outputDirectory, "15m").slice(0, 2), [
      ["2025-01-01T00:00:00.000Z", "10", "20", "7", "12"],
      ["2025-01-01T00:15:00.000Z", "12", "15", "10", "14"],
    ]);
  } finally {
    rmSync(fixture.parent, { recursive: true, force: true });
  }
});

test("1h OHLC stays within its UTC hour", async () => {
  const fixture = await runPreparation([candleAt("2025-01-01T00:00:00.000Z", 10, 11, 9, 10), candleAt("2025-01-01T00:59:00.000Z", 10, 18, 6, 15), candleAt("2025-01-01T01:00:00.000Z", 15, 16, 14, 15)]);
  try {
    assert.deepEqual(csvRows(fixture.outputDirectory, "1h").slice(0, 2), [
      ["2025-01-01T00:00:00.000Z", "10", "18", "6", "15"],
      ["2025-01-01T01:00:00.000Z", "15", "16", "14", "15"],
    ]);
  } finally {
    rmSync(fixture.parent, { recursive: true, force: true });
  }
});

test("4h buckets start only at 00, 04, 08, 12, 16 and 20 UTC", async () => {
  const fixture = await runPreparation([minuteAt("2025-01-01T00:00:00.000Z", [10, 11, 9, 10]), minuteAt("2025-01-01T03:59:00.000Z", [10, 20, 5, 15]), minuteAt("2025-01-01T04:00:00.000Z", [15, 16, 14, 15]), minuteAt("2025-01-01T08:00:00.000Z"), minuteAt("2025-01-01T12:00:00.000Z"), minuteAt("2025-01-01T16:00:00.000Z"), minuteAt("2025-01-01T20:00:00.000Z")]);
  try {
    const rows = csvRows(fixture.outputDirectory, "4h");
    assert.deepEqual(
      rows.map((row) => row[0]),
      ["2025-01-01T00:00:00.000Z", "2025-01-01T04:00:00.000Z", "2025-01-01T08:00:00.000Z", "2025-01-01T12:00:00.000Z", "2025-01-01T16:00:00.000Z", "2025-01-01T20:00:00.000Z"],
    );
    assert.deepEqual(rows[0], ["2025-01-01T00:00:00.000Z", "10", "20", "5", "15"]);
  } finally {
    rmSync(fixture.parent, { recursive: true, force: true });
  }
});

test("1day UTC candle uses the calendar day from 00:00 to next 00:00", async () => {
  const fixture = await runPreparation([minuteAt("2025-01-01T00:00:00.000Z", [10, 11, 9, 10]), minuteAt("2025-01-01T23:59:00.000Z", [10, 20, 5, 15]), minuteAt("2025-01-02T00:00:00.000Z", [15, 16, 14, 15])]);
  try {
    assert.deepEqual(csvRows(fixture.outputDirectory, "1day").slice(0, 2), [
      ["2025-01-01T00:00:00.000Z", "10", "20", "5", "15"],
      ["2025-01-02T00:00:00.000Z", "15", "16", "14", "15"],
    ]);
  } finally {
    rmSync(fixture.parent, { recursive: true, force: true });
  }
});

test("UTC boundaries handle before/exact/after, day, month, year and leap-day timestamps", async () => {
  const times = ["2024-02-28T00:00:00.000Z", "2024-02-29T00:00:00.000Z", "2024-03-01T00:00:00.000Z", "2025-01-01T00:00:00.000Z", "2025-01-01T00:14:00.000Z", "2025-01-01T00:15:00.000Z", "2025-01-01T00:16:00.000Z", "2025-01-01T00:30:00.000Z", "2025-12-31T00:00:00.000Z"];
  const records = times.map((time, index) => minuteAt(time, [100 + index, 101 + index, 99 + index, 100 + index]));
  const fixture = await runPreparation(records, { config: { requestedStart: "2024-02-28T00:00:00.000Z", requestedEnd: "2026-01-01T00:00:00.000Z" } });
  try {
    const daily = csvRows(fixture.outputDirectory, "1day").map((row) => row[0]);
    assert.deepEqual(daily, ["2024-02-28T00:00:00.000Z", "2024-02-29T00:00:00.000Z", "2024-03-01T00:00:00.000Z", "2025-01-01T00:00:00.000Z", "2025-12-31T00:00:00.000Z"]);
    const quarterHours = csvRows(fixture.outputDirectory, "15m").map((row) => row[0]);
    assert.ok(quarterHours.includes("2025-01-01T00:00:00.000Z"));
    assert.ok(quarterHours.includes("2025-01-01T00:15:00.000Z"));
    assert.ok(quarterHours.includes("2025-01-01T00:30:00.000Z"));
  } finally {
    rmSync(fixture.parent, { recursive: true, force: true });
  }
});

test("duplicate and unordered timestamps fail closed with distinct counters", async () => {
  await assert.rejects(
    () => runPreparation([minuteAt("2025-01-01T00:00:00.000Z"), minuteAt("2025-01-01T00:00:00.000Z")]),
    (error: unknown) => error instanceof HistoricalPreparationInputError && error.counts.duplicateCount === 1 && error.counts.rejectedRows === 1,
  );
  await assert.rejects(
    () => runPreparation([minuteAt("2025-01-01T00:01:00.000Z"), minuteAt("2025-01-01T00:00:00.000Z")]),
    (error: unknown) => error instanceof HistoricalPreparationInputError && error.counts.unorderedCount === 1 && error.counts.rejectedRows === 1,
  );
});

test("malformed OHLC, non-UTC, unaligned, non-finite, zero and negative inputs fail closed", async () => {
  const invalidRows: unknown[] = [
    { ...minuteAt("2025-01-01T00:00:00.000Z"), time: "2025-01-01T00:00:00+00:00" },
    { ...minuteAt("2025-01-01T00:00:00.000Z"), time: "2025-01-01T00:00:01.000Z" },
    minuteAt("2025-01-01T00:00:00.000Z", [10, 9, 8, 10]),
    minuteAt("2025-01-01T00:00:00.000Z", [Number.NaN, 11, 9, 10]),
    minuteAt("2025-01-01T00:00:00.000Z", [Number.POSITIVE_INFINITY, 11, 9, 10]),
    minuteAt("2025-01-01T00:00:00.000Z", [0, 11, 0, 10]),
    minuteAt("2025-01-01T00:00:00.000Z", [-1, 11, -2, 10]),
  ];
  for (const row of invalidRows) {
    await assert.rejects(
      () => runPreparation([row]),
      (error: unknown) => error instanceof HistoricalPreparationInputError && error.counts.invalidCount === 1 && error.counts.rejectedRows === 1,
    );
  }
});

test("missing minutes are counted without interpolation; empty buckets emit no candle", async () => {
  const fixture = await runPreparation([minuteAt("2025-01-01T00:00:00.000Z", [10, 11, 9, 10]), minuteAt("2025-01-01T00:02:00.000Z", [12, 13, 11, 12]), minuteAt("2025-01-02T00:00:00.000Z", [20, 21, 19, 20])]);
  try {
    const quality = fixture.result.receipt.quality["15m"];
    assert.equal(quality.observedMinuteCount, 3);
    assert.equal(quality.expectedCalendarMinuteCount, 2880);
    assert.equal(quality.missingCalendarMinuteCount, 2877);
    assert.equal(quality.unclassifiedMissingMinuteCount, 2877);
    assert.equal(quality.missingMinuteClassification, "UNCLASSIFIED_MISSING_MINUTES");
    assert.deepEqual(
      csvRows(fixture.outputDirectory, "1day").map((row) => row[0]),
      ["2025-01-01T00:00:00.000Z", "2025-01-02T00:00:00.000Z"],
    );
    assert.equal(fixture.result.receipt.quality["1day"].emptyBucketCount, 0);
    assert.ok(csvRows(fixture.outputDirectory, "15m").every((row) => row[0] !== "2025-01-01T00:15:00.000Z"));
  } finally {
    rmSync(fixture.parent, { recursive: true, force: true });
  }
});

test("empty whole UTC day is recorded as a gap and is never fabricated", async () => {
  const fixture = await runPreparation([minuteAt("2025-01-01T00:00:00.000Z"), minuteAt("2025-01-03T00:00:00.000Z")], { config: { requestedEnd: "2025-01-04T00:00:00.000Z" } });
  try {
    assert.deepEqual(
      csvRows(fixture.outputDirectory, "1day").map((row) => row[0]),
      ["2025-01-01T00:00:00.000Z", "2025-01-03T00:00:00.000Z"],
    );
    assert.equal(fixture.result.receipt.quality["1day"].emptyBucketCount, 1);
    assert.equal(fixture.result.receipt.quality["1day"].missingCalendarMinuteCount, 4318);
  } finally {
    rmSync(fixture.parent, { recursive: true, force: true });
  }
});

test("weekend-like gaps remain unclassified and do not create weekend candles", async () => {
  const fixture = await runPreparation([minuteAt("2025-01-03T21:00:00.000Z"), minuteAt("2025-01-06T00:00:00.000Z")], { config: { requestedStart: "2025-01-03T00:00:00.000Z", requestedEnd: "2025-01-07T00:00:00.000Z" } });
  try {
    assert.deepEqual(
      csvRows(fixture.outputDirectory, "1day").map((row) => row[0]),
      ["2025-01-03T00:00:00.000Z", "2025-01-06T00:00:00.000Z"],
    );
    assert.equal(fixture.result.receipt.quality["1day"].emptyBucketCount, 2);
    assert.equal(fixture.result.receipt.quality["1day"].missingMinuteClassification, "UNCLASSIFIED_MISSING_MINUTES");
  } finally {
    rmSync(fixture.parent, { recursive: true, force: true });
  }
});

test("partial first and last range buckets are omitted and counted", async () => {
  const fixture = await runPreparation([minuteAt("2025-01-01T00:07:00.000Z"), minuteAt("2025-01-01T00:15:00.000Z"), minuteAt("2025-01-02T00:00:00.000Z"), minuteAt("2025-01-02T23:59:00.000Z"), minuteAt("2025-01-03T00:07:00.000Z")], { config: { requestedStart: "2025-01-01T00:07:00.000Z", requestedEnd: "2025-01-03T00:08:00.000Z" } });
  try {
    const fifteen = csvRows(fixture.outputDirectory, "15m").map((row) => row[0]);
    assert.ok(!fifteen.includes("2025-01-01T00:00:00.000Z"));
    assert.ok(!fifteen.includes("2025-01-03T00:00:00.000Z"));
    assert.ok(fifteen.includes("2025-01-01T00:15:00.000Z"));
    assert.equal(fixture.result.receipt.quality["15m"].partialRangeBucketCount, 2);
    assert.equal(fixture.result.receipt.quality["1day"].partialRangeBucketCount, 2);
    assert.deepEqual(
      csvRows(fixture.outputDirectory, "1day").map((row) => row[0]),
      ["2025-01-02T00:00:00.000Z"],
    );
  } finally {
    rmSync(fixture.parent, { recursive: true, force: true });
  }
});

test("future append cannot change a previously closed target candle", async () => {
  const base = [minuteAt("2025-01-01T00:00:00.000Z", [10, 12, 9, 11]), minuteAt("2025-01-01T00:14:00.000Z", [11, 14, 8, 13])];
  const extended = [...base, minuteAt("2025-01-01T00:15:00.000Z", [13, 15, 12, 14])];
  const first = await runPreparation(base);
  const second = await runPreparation(extended);
  try {
    assert.deepEqual(csvRows(first.outputDirectory, "15m")[0], csvRows(second.outputDirectory, "15m")[0]);
  } finally {
    rmSync(first.parent, { recursive: true, force: true });
    rmSync(second.parent, { recursive: true, force: true });
  }
});

test("resampling is invariant to async input chunk boundaries", async () => {
  const rows = [...minuteSequence(Date.parse(SMALL_START), 2 * 1440)];
  async function* chunks(): AsyncGenerator<Candle> {
    for (let offset = 0; offset < rows.length; offset += 37) {
      for (const row of rows.slice(offset, offset + 37)) yield row;
    }
  }
  const one = await runPreparation(rows);
  const chunked = await runPreparation(chunks());
  try {
    for (const timeframe of ["15m", "1h", "4h", "1day"] as const) {
      assert.deepEqual(readFileSync(join(one.outputDirectory, `USDJPY-${timeframe}.csv`)), readFileSync(join(chunked.outputDirectory, `USDJPY-${timeframe}.csv`)));
      assert.equal(one.result.manifest.files[timeframe]?.sha256, chunked.result.manifest.files[timeframe]?.sha256);
    }
  } finally {
    rmSync(one.parent, { recursive: true, force: true });
    rmSync(chunked.parent, { recursive: true, force: true });
  }
});

test("output bytes and target checksums are deterministic; MID is recorded, not synthesized", async () => {
  const rows = [minuteAt("2025-01-01T00:00:00.000Z", [149.123456, 149.2, 149.1, 149.15]), minuteAt("2025-01-01T00:01:00.000Z", [149.15, 149.3, 149.12, 149.25])];
  const one = await runPreparation(rows, { config: { rawChecksums: { "raw-fixture-001": RAW_HASH }, priceType: "MID" } });
  const two = await runPreparation(rows, { config: { rawChecksums: { "raw-fixture-001": RAW_HASH }, priceType: "MID" } });
  try {
    for (const timeframe of ["15m", "1h", "4h", "1day"] as const) {
      assert.deepEqual(readFileSync(join(one.outputDirectory, `USDJPY-${timeframe}.csv`)), readFileSync(join(two.outputDirectory, `USDJPY-${timeframe}.csv`)));
      assert.equal(one.result.manifest.files[timeframe]?.sha256, two.result.manifest.files[timeframe]?.sha256);
    }
    assert.equal(csvRows(one.outputDirectory, "15m")[0]?.[1], "149.123456");
    assert.equal(one.result.receipt.priceType, "MID");
    assert.equal(one.result.receipt.normalizationRules.priceTypeTransform, "NONE");
    assert.equal(one.result.receipt.rawChecksums["raw-fixture-001"], RAW_HASH);
  } finally {
    rmSync(one.parent, { recursive: true, force: true });
    rmSync(two.parent, { recursive: true, force: true });
  }
});

test("config requires explicit source timezone, price type and valid provenance", async () => {
  const record = [minuteAt("2025-01-01T00:00:00.000Z")];
  await assert.rejects(() => runPreparation(record, { config: { priceType: "" as never } }), /priceType/);
  await assert.rejects(() => runPreparation(record, { config: { originalTimezone: "" } }), /originalTimezone/);
  await assert.rejects(() => runPreparation(record, { config: { rawChecksums: {} } }), /raw checksum/);
  await assert.rejects(() => runPreparation(record, { config: { requestedStart: "2025-01-01T00:00:01.000Z" } }), /minute boundaries/);
  await assert.rejects(() => runPreparation(record, { config: { requestedStart: SMALL_END } }), /earlier than/);
});

test("existing output directory is never overwritten", async () => {
  const parent = mkdtempSync(join(tmpdir(), "task116-existing-output-"));
  const outputDirectory = join(parent, "prepared");
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(outputDirectory);
  await writeFile(join(outputDirectory, "keep.txt"), "untouched");
  try {
    await assert.rejects(() => prepareHistoricalDataset([minuteAt("2025-01-01T00:00:00.000Z")], config(), outputDirectory), /already exists/);
    assert.equal(readFileSync(join(outputDirectory, "keep.txt"), "utf8"), "untouched");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("five-year-equivalent stream stays incremental and reports runtime, rows and RSS", async (context) => {
  const start = Date.parse(DEFAULT_HISTORICAL_REQUESTED_START);
  const end = Date.parse(DEFAULT_HISTORICAL_REQUESTED_END);
  const inputCount = (end - start) / MINUTE;
  assert.equal(inputCount, 2_629_440);
  const beforeRss = process.memoryUsage().rss;
  const beforePeakRss = process.resourceUsage().maxRSS;
  const started = performance.now();
  const fixture = await runPreparation(minuteSequence(start, inputCount), {
    config: { requestedStart: DEFAULT_HISTORICAL_REQUESTED_START, requestedEnd: DEFAULT_HISTORICAL_REQUESTED_END },
    name: "five-year",
  });
  const elapsedMs = performance.now() - started;
  const afterRss = process.memoryUsage().rss;
  const afterPeakRss = process.resourceUsage().maxRSS;
  try {
    assert.equal(fixture.result.receipt.inputRows, inputCount);
    assert.equal(fixture.result.receipt.acceptedRows, inputCount);
    assert.equal(fixture.result.receipt.rejectedRows, 0);
    assert.equal(fixture.result.receipt.quality["15m"].outputRows, 175_296);
    assert.equal(fixture.result.receipt.quality["1h"].outputRows, 43_824);
    assert.equal(fixture.result.receipt.quality["4h"].outputRows, 10_956);
    assert.equal(fixture.result.receipt.quality["1day"].outputRows, 1_826);
    assert.equal(fixture.result.receipt.quality["1day"].missingCalendarMinuteCount, 0);
    assert.ok(elapsedMs > 0);
    assert.ok(afterRss > 0 && beforeRss > 0);
    assert.ok(afterPeakRss >= beforePeakRss);
    context.diagnostic(`five-year 1m stream rows=${inputCount}, elapsedMs=${Math.round(elapsedMs)}, rssDeltaBytes=${afterRss - beforeRss}, maxRssDeltaNative=${afterPeakRss - beforePeakRss}`);
  } finally {
    rmSync(fixture.parent, { recursive: true, force: true });
  }
});

test("offline engine makes zero network fetches", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount++;
    throw new Error("network access forbidden");
  };
  const fixture = await runPreparation([minuteAt("2025-01-01T00:00:00.000Z")]);
  try {
    assert.equal(fetchCount, 0);
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(fixture.parent, { recursive: true, force: true });
  }
});
