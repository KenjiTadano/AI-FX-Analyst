import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createWriteStream, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { loadLocalHistoricalDataset } from "../lib/backtest/local-dataset";
import { concatenateCanonicalMinuteChunks, createDukascopyTickMidStream, DUKASCOPY_TICK_HEADER, prepareDukascopyHistoricalDataset } from "../lib/backtest/dukascopy-tick-adapter";
import type { Candle, Symbol } from "../lib/market/types";

function sourceNames(options: { pair?: string; date?: string; startHour?: number; endHour?: number; bidSuffix?: string; askSuffix?: string } = {}) {
  const pair = options.pair ?? "USD-JPY";
  const date = options.date ?? "2025-01-06";
  const startHour = String(options.startHour ?? 12).padStart(2, "0");
  const endHour = String(options.endHour ?? options.startHour ?? 12).padStart(2, "0");
  const stem = `${pair}_1Tick`;
  return {
    bid: `${stem}_BID_${date}_${startHour}_00-${endHour}_59_Etc_UTC${options.bidSuffix ?? ""}.csv`,
    ask: `${stem}_ASK_${date}_${startHour}_00-${endHour}_59_Etc_UTC${options.askSuffix ?? ""}.csv`,
  };
}

function row(time: string, price: number | string, changes: { open?: number | string; high?: number | string; low?: number | string; close?: number | string; volume?: number | string } = {}): string {
  const open = changes.open ?? price;
  const high = changes.high ?? price;
  const low = changes.low ?? price;
  const close = changes.close ?? price;
  const volume = changes.volume ?? 1_200_000;
  return `${time},${open},${high},${low},${close},${volume}\n`;
}

function fixtureDirectory(): string {
  return mkdtempSync(join(tmpdir(), "dukascopy-tick-adapter-test-"));
}

function writePair(directory: string, bidRows: string[], askRows: string[], names = sourceNames()) {
  const bidFile = join(directory, names.bid);
  const askFile = join(directory, names.ask);
  writeFileSync(bidFile, `${DUKASCOPY_TICK_HEADER}\n${bidRows.join("")}`, { encoding: "utf8" });
  writeFileSync(askFile, `${DUKASCOPY_TICK_HEADER}\n${askRows.join("")}`, { encoding: "utf8" });
  return { bidFile, askFile };
}

async function collect(files: { bidFile: string; askFile: string }, pair: Symbol = "USD/JPY", expectedSourceDate?: string, expectedSourceHourUtc?: number) {
  const stream = await createDukascopyTickMidStream({ bidFile: files.bidFile, askFile: files.askFile, pair, expectedSourceDate, expectedSourceHourUtc });
  const records: Candle[] = [];
  for await (const candle of stream) records.push(candle);
  const receipt = stream.getReceipt();
  assert.ok(receipt, "complete consumption should create the adapter receipt");
  return { records, receipt: receipt!, rawChecksums: stream.rawChecksums };
}

async function drain(stream: AsyncIterable<Candle>): Promise<void> {
  for await (const candle of stream) assert.ok(candle.time.length > 0);
}

test("observed BID and ASK schema parses and retains the explicit file roles", async () => {
  const directory = fixtureDirectory();
  try {
    const files = writePair(directory, [row("2025-01-06T12:00:00+00:00", 157.198)], [row("2025-01-06T12:00:00+00:00", 157.207)]);
    const result = await collect(files);
    assert.equal(result.receipt.sourceTimezone, "Etc/UTC");
    assert.equal(result.receipt.sourcePeriod, "Tick");
    assert.equal(result.receipt.sourceName, "Dukascopy Historical Data Export");
    assert.deepEqual(
      result.receipt.sourceArtifactIds.map((id) => id.split(":")[0]),
      ["BID", "ASK"],
    );
    assert.equal(result.receipt.priceType, "MID");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Tick source OHLC equality is required and unequal OHLC fails closed", async () => {
  const directory = fixtureDirectory();
  try {
    const files = writePair(directory, [row("2025-01-06T12:00:00+00:00", 100, { high: 101 })], [row("2025-01-06T12:00:00+00:00", 102)]);
    const stream = await createDukascopyTickMidStream({ ...files, pair: "USD/JPY" });
    await assert.rejects(() => drain(stream), /violates observed Tick OHLC equality/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("same-second timestamps remain positional, repeated and undeduplicated", async () => {
  const directory = fixtureDirectory();
  try {
    const time = "2025-01-06T12:00:00+00:00";
    const files = writePair(directory, [row(time, 100), row(time, 101), row(time, 99)], [row(time, 102), row(time, 103), row(time, 101)]);
    const result = await collect(files);
    assert.equal(result.receipt.tickCount, 3);
    assert.equal(result.records.length, 1);
    assert.deepEqual(result.records[0], { time: "2025-01-06T12:00:00.000Z", open: 101, high: 102, low: 100, close: 100 });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("BID/ASK timestamp mismatch fails without nearest-time matching", async () => {
  const directory = fixtureDirectory();
  try {
    const files = writePair(directory, [row("2025-01-06T12:00:00+00:00", 100)], [row("2025-01-06T12:00:01+00:00", 101)]);
    const stream = await createDukascopyTickMidStream({ ...files, pair: "USD/JPY" });
    await assert.rejects(() => drain(stream), /timestamp mismatch/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("BID ending before ASK and ASK ending before BID both fail", async () => {
  for (const [bidRows, askRows] of [
    [[row("2025-01-06T12:00:00+00:00", 100)], [row("2025-01-06T12:00:00+00:00", 101), row("2025-01-06T12:00:01+00:00", 102)]],
    [[row("2025-01-06T12:00:00+00:00", 100), row("2025-01-06T12:00:01+00:00", 101)], [row("2025-01-06T12:00:00+00:00", 101)]],
  ] as const) {
    const directory = fixtureDirectory();
    try {
      const files = writePair(directory, [...bidRows], [...askRows]);
      const stream = await createDukascopyTickMidStream({ ...files, pair: "USD/JPY" });
      await assert.rejects(() => drain(stream), /row counts differ/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("ASK below BID and invalid/non-positive prices fail closed", async () => {
  for (const [bidPrice, askPrice, pattern] of [
    [100, 99, /crossed BID\/ASK/],
    ["NaN", 101, /non-positive or non-finite/],
    ["Infinity", 101, /non-positive or non-finite/],
    [0, 101, /non-positive or non-finite/],
    [-1, 101, /non-positive or non-finite/],
  ] as const) {
    const directory = fixtureDirectory();
    try {
      const files = writePair(directory, [row("2025-01-06T12:00:00+00:00", bidPrice)], [row("2025-01-06T12:00:00+00:00", askPrice)]);
      const stream = await createDukascopyTickMidStream({ ...files, pair: "USD/JPY" });
      await assert.rejects(() => drain(stream), pattern);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("timestamp decrease is rejected while equal timestamps remain valid", async () => {
  const directory = fixtureDirectory();
  try {
    const files = writePair(directory, [row("2025-01-06T12:00:02+00:00", 100), row("2025-01-06T12:00:01+00:00", 100)], [row("2025-01-06T12:00:02+00:00", 101), row("2025-01-06T12:00:01+00:00", 101)]);
    const stream = await createDukascopyTickMidStream({ ...files, pair: "USD/JPY" });
    await assert.rejects(() => drain(stream), /timestamp decreased/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("source header must identify Etc/UTC and the observed columns", async () => {
  const directory = fixtureDirectory();
  try {
    const files = writePair(directory, [row("2025-01-06T12:00:00+00:00", 100)], [row("2025-01-06T12:00:00+00:00", 101)]);
    writeFileSync(files.askFile, `UTC,Open,High,Low,Close,Volume\n${row("2025-01-06T12:00:00+00:00", 101)}`);
    const stream = await createDukascopyTickMidStream({ ...files, pair: "USD/JPY" });
    await assert.rejects(() => drain(stream), /unsupported Dukascopy Tick CSV header/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("timestamp format is validated from observed +00:00 source and normalized to canonical UTC", async () => {
  const directory = fixtureDirectory();
  try {
    const files = writePair(directory, [row("2025-01-06T12:00:00Z", 100)], [row("2025-01-06T12:00:00Z", 101)]);
    const stream = await createDukascopyTickMidStream({ ...files, pair: "USD/JPY" });
    await assert.rejects(() => drain(stream), /not the observed Etc\/UTC tick format/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("recognized filename metadata validates pair, role, date and hour", async () => {
  const directory = fixtureDirectory();
  try {
    const badPair = writePair(directory, [row("2025-01-06T12:00:00+00:00", 100)], [row("2025-01-06T12:00:00+00:00", 101)], sourceNames({ pair: "USD-CHF" }));
    await assert.rejects(() => createDukascopyTickMidStream({ ...badPair, pair: "USD/JPY" }), /does not match requested pair/);
    const good = writePair(directory, [row("2025-01-06T12:00:00+00:00", 100)], [row("2025-01-06T12:00:00+00:00", 101)]);
    await assert.rejects(() => createDukascopyTickMidStream({ ...good, pair: "USD/JPY", expectedSourceDate: "2025-01-07" }), /does not match expected date/);
    await assert.rejects(() => createDukascopyTickMidStream({ ...good, pair: "USD/JPY", expectedSourceHourUtc: 13 }), /does not match expected hour/);
    await assert.rejects(() => createDukascopyTickMidStream({ bidFile: good.askFile, askFile: good.bidFile, pair: "USD/JPY" }), /role conflicts with filename/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("MID is the exact synchronized arithmetic midpoint without rounding", async () => {
  const directory = fixtureDirectory();
  try {
    const files = writePair(directory, [row("2025-01-06T12:00:00+00:00", 157.198), row("2025-01-06T12:00:00+00:00", 157.2)], [row("2025-01-06T12:00:00+00:00", 157.207), row("2025-01-06T12:00:00+00:00", 157.207)]);
    const result = await collect(files);
    assert.deepEqual(result.records[0], { time: "2025-01-06T12:00:00.000Z", open: (157.198 + 157.207) / 2, high: (157.2 + 157.207) / 2, low: (157.198 + 157.207) / 2, close: (157.2 + 157.207) / 2 });
    assert.equal(result.receipt.priceTypeTransform, "SYNCHRONIZED_BID_ASK_TICK_MID");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("minute, hour and UTC day boundaries aggregate only observed ticks", async () => {
  const directory = fixtureDirectory();
  try {
    const bidRows = [row("2025-01-06T12:00:00+00:00", 100), row("2025-01-06T12:00:59+00:00", 101), row("2025-01-06T12:01:00+00:00", 99), row("2025-01-06T12:59:59+00:00", 102)];
    const askRows = [row("2025-01-06T12:00:00+00:00", 102), row("2025-01-06T12:00:59+00:00", 103), row("2025-01-06T12:01:00+00:00", 101), row("2025-01-06T12:59:59+00:00", 104)];
    const result = await collect(writePair(directory, bidRows, askRows));
    assert.deepEqual(
      result.records.map((record) => record.time),
      ["2025-01-06T12:00:00.000Z", "2025-01-06T12:01:00.000Z", "2025-01-06T12:59:00.000Z"],
    );
    assert.deepEqual(result.records[0], { time: "2025-01-06T12:00:00.000Z", open: 101, high: 102, low: 101, close: 102 });
    assert.deepEqual(result.records[2], { time: "2025-01-06T12:59:00.000Z", open: 103, high: 103, low: 103, close: 103 });
    assert.equal(result.receipt.outputMinuteCount, 3);
    assert.equal(
      result.records.some((record) => record.time === "2025-01-06T12:02:00.000Z"),
      false,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("raw BID/ASK hashes cover exact source bytes and remain separate from target hashes", async () => {
  const directory = fixtureDirectory();
  try {
    const files = writePair(directory, [row("2025-01-06T12:00:00+00:00", 100)], [row("2025-01-06T12:00:00+00:00", 101)]);
    const result = await collect(files);
    const bidBytes = readFileSync(files.bidFile);
    const askBytes = readFileSync(files.askFile);
    assert.equal(result.receipt.bidRawSha256, createHash("sha256").update(bidBytes).digest("hex"));
    assert.equal(result.receipt.askRawSha256, createHash("sha256").update(askBytes).digest("hex"));
    assert.deepEqual(result.rawChecksums, {
      [`BID:${basenameFor(files.bidFile)}`]: result.receipt.bidRawSha256,
      [`ASK:${basenameFor(files.askFile)}`]: result.receipt.askRawSha256,
    });
    assert.notEqual(result.receipt.bidRawSha256, result.receipt.askRawSha256);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function basenameFor(filePath: string): string {
  return filePath.split(/[\\/]/).at(-1)!;
}

test("future ticks appended after a closed minute do not change that minute", async () => {
  const directory = fixtureDirectory();
  try {
    const base = writePair(directory, [row("2025-01-06T12:00:00+00:00", 100), row("2025-01-06T12:00:59+00:00", 101)], [row("2025-01-06T12:00:00+00:00", 102), row("2025-01-06T12:00:59+00:00", 103)]);
    const extended = writePair(directory, [row("2025-01-06T12:00:00+00:00", 100), row("2025-01-06T12:00:59+00:00", 101), row("2025-01-06T12:01:00+00:00", 1000)], [row("2025-01-06T12:00:00+00:00", 102), row("2025-01-06T12:00:59+00:00", 103), row("2025-01-06T12:01:00+00:00", 1002)]);
    const first = await collect(base);
    const second = await collect(extended);
    assert.deepEqual(first.records[0], second.records[0]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("chronological chunks concatenate and backward/overlapping chunks fail closed", async () => {
  const record = (time: string): Candle => ({ time, open: 100, high: 100, low: 100, close: 100 });
  async function* one(value: Candle) {
    yield value;
  }
  const chronological: Candle[] = [];
  for await (const value of concatenateCanonicalMinuteChunks([one(record("2025-01-06T12:00:00.000Z")), one(record("2025-01-06T12:01:00.000Z"))])) chronological.push(value);
  assert.equal(chronological.length, 2);
  await assert.rejects(async () => {
    for await (const value of concatenateCanonicalMinuteChunks([one(record("2025-01-06T12:02:00.000Z")), one(record("2025-01-06T12:01:00.000Z"))])) assert.ok(value.time);
  }, /not chronological/);
  await assert.rejects(async () => {
    for await (const value of concatenateCanonicalMinuteChunks([one(record("2025-01-06T12:02:00.000Z")), one(record("2025-01-06T12:02:00.000Z"))])) assert.ok(value.time);
  }, /overlapping source chunks/);
});

test("adapter MID minutes feed Phase 1 and produce all four Task116 CSVs", async () => {
  const directory = fixtureDirectory();
  try {
    const bidRows: string[] = [];
    const askRows: string[] = [];
    const start = Date.parse("2025-01-06T00:00:00.000Z");
    for (let minute = 0; minute < 1440; minute++) {
      const time = new Date(start + minute * 60_000).toISOString().replace(".000Z", "+00:00");
      const price = 150 + minute / 1_000_000;
      bidRows.push(row(time, price));
      askRows.push(row(time, price + 0.002));
    }
    const names = sourceNames({ startHour: 0, endHour: 23 });
    const source = writePair(directory, bidRows, askRows, names);
    const output = join(directory, "prepared");
    const prepared = await prepareDukascopyHistoricalDataset(
      { ...source, pair: "USD/JPY" },
      {
        datasetId: "dukascopy-synthetic-schema-fixture",
        dataKind: "SYNTHETIC",
        licenseProvenance: "synthetic rows matching observed Dukascopy schema; not independent market evidence",
        requestedStart: "2025-01-06T00:00:00.000Z",
        requestedEnd: "2025-01-07T00:00:00.000Z",
        generatedAt: "2026-10-06T00:00:00.000Z",
      },
      output,
    );
    assert.equal(prepared.adapterReceipt.tickCount, 1440);
    assert.equal(prepared.adapterReceipt.outputMinuteCount, 1440);
    assert.equal(prepared.adapterReceipt.priceType, "MID");
    assert.equal(prepared.phase1Receipt.priceType, "MID");
    assert.equal(prepared.phase1Receipt.originalTimezone, "Etc/UTC");
    assert.equal(prepared.phase1Receipt.rawChecksums[prepared.adapterReceipt.sourceArtifactIds[0]!], prepared.adapterReceipt.bidRawSha256);
    assert.equal(prepared.phase1Receipt.rawChecksums[prepared.adapterReceipt.sourceArtifactIds[1]!], prepared.adapterReceipt.askRawSha256);
    assert.deepEqual(Object.keys(prepared.manifest.files).toSorted(), ["15m", "1day", "1h", "4h"]);
    const targetBytes = readFileSync(join(output, "USDJPY-15m.csv"));
    const targetSha256 = createHash("sha256").update(targetBytes).digest("hex");
    assert.equal(prepared.manifest.files["15m"]?.sha256, targetSha256);
    assert.notEqual(targetSha256, prepared.adapterReceipt.bidRawSha256);
    assert.notEqual(targetSha256, prepared.adapterReceipt.askRawSha256);
    const imported = loadLocalHistoricalDataset(output);
    assert.equal(imported.valid, true, imported.valid ? "" : imported.errors.join("; "));
    if (imported.valid) assert.equal(imported.imported.dataset.timeframes["1day"]?.length, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("offline adapter makes zero fetches and does not mutate raw artifacts", async () => {
  const directory = fixtureDirectory();
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  try {
    const files = writePair(directory, [row("2025-01-06T12:00:00+00:00", 100)], [row("2025-01-06T12:00:00+00:00", 101)]);
    const beforeBid = readFileSync(files.bidFile);
    const beforeAsk = readFileSync(files.askFile);
    globalThis.fetch = async () => {
      fetchCount++;
      throw new Error("network access forbidden");
    };
    await collect(files);
    assert.deepEqual(readFileSync(files.bidFile), beforeBid);
    assert.deepEqual(readFileSync(files.askFile), beforeAsk);
    assert.equal(fetchCount, 0);
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("generated synthetic tick stream processes practical row counts incrementally", async (context) => {
  const directory = fixtureDirectory();
  try {
    const names = sourceNames({ startHour: 0, endHour: 23 });
    const bidFile = join(directory, names.bid);
    const askFile = join(directory, names.ask);
    const bid = createWriteStream(bidFile, { encoding: "utf8" });
    const ask = createWriteStream(askFile, { encoding: "utf8" });
    bid.write(`${DUKASCOPY_TICK_HEADER}\n`);
    ask.write(`${DUKASCOPY_TICK_HEADER}\n`);
    const count = 80_000;
    const start = Date.parse("2025-01-06T00:00:00.000Z");
    for (let index = 0; index < count; index++) {
      const time = new Date(start + index * 1000).toISOString().replace(".000Z", "+00:00");
      const price = 150 + (index % 1000) / 100_000;
      const bidLine = row(time, price);
      const askLine = row(time, price + 0.001);
      if (!bid.write(bidLine)) await once(bid, "drain");
      if (!ask.write(askLine)) await once(ask, "drain");
    }
    bid.end();
    ask.end();
    await Promise.all([once(bid, "finish"), once(ask, "finish")]);
    const beforeRss = process.memoryUsage().rss;
    const started = performance.now();
    const result = await collect({ bidFile, askFile });
    const elapsedMs = performance.now() - started;
    const rssDeltaBytes = process.memoryUsage().rss - beforeRss;
    assert.equal(result.receipt.tickCount, count);
    assert.equal(result.records.length, Math.ceil(count / 60));
    context.diagnostic(`synthetic Dukascopy ticks=${count}, elapsedMs=${Math.round(elapsedMs)}, rssDeltaBytes=${rssDeltaBytes}`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
