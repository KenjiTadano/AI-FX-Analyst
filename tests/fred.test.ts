import test from "node:test";
import assert from "node:assert/strict";
import { FRED_SERIES, FRED_SERIES_COUNT } from "../lib/fundamental/fred-series";
import { createFred, pickLatestPrevious, toIndicator } from "../lib/fundamental/providers/fred";
import { ResourceCache } from "../lib/fundamental/cache";
import { unavailable } from "../lib/fundamental/resource";
import { assembleFundamentals } from "../lib/fundamental/service";
import { getCentralBanks } from "../lib/fundamental/central-banks";
import { getSentiment } from "../lib/fundamental/sentiment";
import { buildInput, macroeconomicQuality } from "../lib/ai/input";
import { systemPrompt } from "../lib/ai/openai";
import type { DataResource, EconomicIndicatorValue } from "../lib/fundamental/types";

const now = Date.parse("2026-09-11T12:00:00Z");
const secret = "synthetic-fred-secret-key";
const ok = <T>(data: T): DataResource<T> => ({ data, status: "ok", provider: "TEST", fetchedAt: new Date(now).toISOString(), error: null, warnings: [] });

function observations(values: Array<[string, string]>) {
  return { observations: values.map(([date, value]) => ({ date, value, realtime_start: date, realtime_end: date })) };
}

function indicator(partial: Partial<EconomicIndicatorValue> = {}): EconomicIndicatorValue {
  return {
    id: "us-cpi-yoy", name: "米CPI（前年比）", shortName: "米CPI", country: "US", currency: "USD", seriesId: "CPIAUCSL", seriesTitle: "Consumer Price Index",
    value: 2.8, previousValue: 2.7, unit: "% 前年比", frequency: "Monthly", observationDate: "2026-07-01", previousObservationDate: "2026-06-01",
    category: "inflation", seasonalAdjustment: "Seasonally Adjusted", transformation: "pc1", source: "FRED", updatedAt: new Date(now).toISOString(), stale: false, ageDays: 42,
    ...partial,
  };
}

test("pickLatestPrevious keeps valid numbers and skips missing dots", () => {
  const picked = pickLatestPrevious([
    { date: "2026-07-01", value: "2.8" },
    { date: "2026-06-01", value: "." },
    { date: "2026-05-01", value: "2.6" },
    { date: "bad", value: "9" },
    { date: "2026-04-01", value: "not-a-number" },
  ]);
  assert.equal(picked.value, 2.8);
  assert.equal(picked.observationDate, "2026-07-01");
  assert.equal(picked.previousValue, 2.6);
  assert.equal(picked.previousObservationDate, "2026-05-01");
});

test("empty or invalid observations never invent values", () => {
  assert.deepEqual(pickLatestPrevious([]), { value: null, previousValue: null, observationDate: null, previousObservationDate: null });
  assert.equal(pickLatestPrevious([{ date: "2026-07-01", value: "NaN" }]).value, null);
});

test("toIndicator preserves unit frequency observation dates and stale flag", () => {
  const def = FRED_SERIES.find(item => item.id === "us-cpi-yoy")!;
  const item = toIndicator(def, [{ date: "2026-08-15", value: "2.8" }, { date: "2026-07-15", value: "2.7" }], now, new Date(now).toISOString());
  assert.equal(item.unit, "% 前年比");
  assert.equal(item.frequency, "Monthly");
  assert.equal(item.observationDate, "2026-08-15");
  assert.equal(item.previousObservationDate, "2026-07-15");
  assert.equal(item.transformation, "pc1");
  assert.equal(item.stale, false);
  const stale = toIndicator(def, [{ date: "2026-01-01", value: "2.8" }, { date: "2025-12-01", value: "2.7" }], now, new Date(now).toISOString());
  assert.equal(stale.stale, true);
});

test("catalog covers required FX macro indicators with verified series ids", () => {
  assert.equal(FRED_SERIES_COUNT, 8);
  assert.deepEqual(FRED_SERIES.map(item => item.seriesId), ["CPIAUCSL", "CPILFESL", "PCEPI", "PCEPILFE", "PAYEMS", "UNRATE", "A191RL1Q225SBEA", "FEDFUNDS"]);
  assert.equal(FRED_SERIES.find(item => item.id === "us-nfp-change")?.transformation, "chg");
  assert.equal(FRED_SERIES.find(item => item.id === "us-effr")?.name, "米実効FF金利");
});

test("unconfigured FRED provider performs no requests", async () => {
  let calls = 0;
  const provider = createFred("", async () => { calls++; return Response.json({}); });
  assert.equal((await provider.macroeconomic()).error?.code, "not_configured");
  assert.equal(calls, 0);
});

test("normal fetch returns latest and previous for every series", async () => {
  const calls: string[] = [];
  const provider = createFred(secret, async input => {
    const url = new URL(String(input));
    calls.push(url.searchParams.get("series_id")!);
    assert.equal(url.searchParams.get("api_key"), secret);
    const seriesId = url.searchParams.get("series_id")!;
    const units = url.searchParams.get("units");
    if (seriesId === "PAYEMS") assert.equal(units, "chg");
    if (seriesId === "CPIAUCSL") assert.equal(units, "pc1");
    if (seriesId === "UNRATE") assert.equal(units, null);
    return Response.json(observations([["2026-07-01", "2.8"], ["2026-06-01", "2.7"]]));
  }, new ResourceCache(() => now), () => now);
  const result = await provider.macroeconomic();
  assert.equal(result.status, "ok");
  assert.equal(result.data?.length, 8);
  assert.equal(result.data?.[0]?.value, 2.8);
  assert.equal(result.data?.[0]?.previousValue, 2.7);
  assert.equal(calls.length, 8);
  assert.ok(!JSON.stringify(result).includes(secret));
});

test("dot missing values and empty observations are rejected per series", async () => {
  let stage = 0;
  const provider = createFred(secret, async () => {
    stage++;
    if (stage === 1) return Response.json(observations([["2026-07-01", "."], ["2026-06-01", "."]]));
    if (stage === 2) return Response.json({ observations: [] });
    return Response.json(observations([["2026-07-01", "2.8"], ["2026-06-01", "2.7"]]));
  }, new ResourceCache(() => now), () => now);
  const result = await provider.macroeconomic();
  assert.equal(result.status, "ok");
  assert.equal(result.data?.length, 6);
  assert.equal(result.warnings.length, 2);
  assert.equal(macroeconomicQuality(result).status, "partial");
});

for (const [status, code] of [[400, "invalid_response"], [401, "unauthorized"], [403, "forbidden"], [429, "rate_limited"], [500, "network"]] as const) {
  test(`FRED HTTP ${status} maps to ${code} without leaking secrets`, async () => {
    const result = await createFred(secret, async () => new Response(secret, { status }), new ResourceCache(() => now), () => now).macroeconomic();
    assert.equal(result.data, null);
    assert.equal(result.error?.code, code);
    assert.ok(!JSON.stringify(result).includes(secret));
  });
}

test("timeout and invalid JSON become network or invalid_response", async () => {
  const timeout = await createFred(secret, async () => { const error = new Error("timeout"); error.name = "TimeoutError"; throw error; }, new ResourceCache(() => now), () => now).macroeconomic();
  assert.equal(timeout.error?.code, "network");
  const invalid = await createFred(secret, async () => new Response("{", { status: 200 }), new ResourceCache(() => now), () => now).macroeconomic();
  assert.equal(invalid.error?.code, "invalid_response");
});

test("all series failures become missing quality while calendar can remain independent", async () => {
  const result = await assembleFundamentals("USD/JPY", {
    news: async () => ({ ...ok([]), data: [] }),
    calendar: async () => ok([]),
    macroeconomic: async () => unavailable("FRED", "unauthorized"),
    centralBanks: getCentralBanks,
    sentiment: getSentiment,
  }, now);
  assert.equal(result.calendar.status, "empty");
  assert.equal(result.macroeconomic.status, "error");
  const input = buildInput("USD/JPY", null, result, now);
  assert.equal(input.dataAvailability.macroeconomicData.status, "missing");
  assert.equal(input.dataAvailability.categories.economic.status, "partial");
});

test("partial and full macro quality and AI evidence include FRED facts only", async () => {
  const partial = ok([indicator()]);
  assert.equal(macroeconomicQuality(partial).status, "partial");
  const full = ok(FRED_SERIES.map(def => indicator({ id: def.id, seriesId: def.seriesId, name: def.name, unit: def.displayUnit, transformation: def.transformation })));
  assert.equal(macroeconomicQuality(full).status, "ok");
  const data = await assembleFundamentals("EUR/JPY", {
    news: async () => ({ ...ok([]), data: [] }),
    calendar: async () => unavailable("EODHD", "unauthorized"),
    macroeconomic: async () => full,
    centralBanks: getCentralBanks,
    sentiment: getSentiment,
  }, now);
  const input = buildInput("EUR/JPY", null, data, now);
  assert.equal(input.dataAvailability.categories.economic.status, "missing");
  assert.equal(input.dataAvailability.macroeconomicData.status, "ok");
  const macro = input.fundamentalData.find(item => item.id === "macro:0");
  assert.ok(macro);
  assert.equal(macro.source, "FRED");
  const payload = macro.data as Record<string, unknown>;
  assert.equal(payload.latestValue, 2.8);
  assert.equal(payload.previousValue, 2.7);
  assert.equal(payload.observationDate, "2026-07-01");
  assert.equal(payload.kind, "released_macro_observation");
  assert.match(systemPrompt, /FRED由来のmacro証拠/);
  assert.ok(!JSON.stringify(input).includes("999"));
});

test("cache reuses FRED batch within TTL", async () => {
  let calls = 0;
  const cache = new ResourceCache(() => now);
  const provider = createFred(secret, async () => {
    calls++;
    return Response.json(observations([["2026-07-01", "2.8"], ["2026-06-01", "2.7"]]));
  }, cache, () => now);
  await Promise.all([provider.macroeconomic(), provider.macroeconomic()]);
  assert.equal(calls, 8);
  await provider.macroeconomic();
  assert.equal(calls, 8);
});
