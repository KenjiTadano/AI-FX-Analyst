import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { performance } from "node:perf_hooks";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { DurableAcquisitionStore } from "../lib/backtest/dukascopy-s3-durable";
import { runDukascopyDownload, runDukascopyInventory, type DecodeEvidence } from "../lib/backtest/dukascopy-s3-runner";
import { DUKASCOPY_BI5_ADAPTER_VERSION } from "../lib/backtest/dukascopy-bi5-adapter";
import { HeadObjectCommand, GetObjectCommand, ListObjectsV2Command, type GetObjectCommandOutput } from "@aws-sdk/client-s3";
import {
  assertExactDukascopyKey,
  assertFrozenPlan,
  createDukascopySdkClient,
  createFrozenDukascopyPlan,
  DukascopyS3Session,
  DUKASCOPY_PLAN_HASH,
  collectDukascopyInventory,
  createInventorySnapshot,
  DukascopyGetTransport,
  assertApproval,
  type AcquisitionApproval,
  type AcquisitionRequestGate,
  type OfflineS3Sender,
  type FrozenDukascopyPlan,
  type InventoryEntry,
  type InventorySnapshot,
} from "../lib/backtest/dukascopy-s3-production";

const KEY = "USDJPY/2025/00/06_ticks.bi5";
const META = { $metadata: { httpStatusCode: 200 }, ContentLength: 3, ETag: '"test-etag"', RequestCharged: "requester" as const };
let blockedNetworkCalls = 0;
test.before(() => {
  const rejectNetwork = () => { blockedNetworkCalls++; throw new Error("non-fake network forbidden"); };
  test.mock.method(http, "request", rejectNetwork);
  test.mock.method(https, "request", rejectNetwork);
  test.mock.method(net.Socket.prototype, "connect", rejectNetwork);
  test.mock.method(tls, "connect", rejectNetwork);
  test.mock.method(globalThis, "fetch", rejectNetwork);
});
test.after(() => { assert.equal(blockedNetworkCalls, 0); test.mock.restoreAll(); });

function approval(plan: FrozenDukascopyPlan, operation: AcquisitionApproval["operation"] = "INVENTORY", revision: string | null = null, keys = [KEY]): AcquisitionApproval {
  const caps = { maxHeadAttempts: 5478, maxGetAttempts: 5478, maxNetworkBytes: 1_000_000, maxVerifiedBytes: 1_000_000, maxObjects: 1826, maxRetries: 2 };
  return { id: `approval-${operation}`, batchId: "batch-one", operation, planHash: plan.planHash, inventoryRevision: revision, batchStart: plan.requestedStart, batchEnd: plan.requestedEnd, keys, caps, globalCaps: { ...caps }, minimumFreeBytes: 0, expiresAt: "2100-01-01T00:00:00.000Z" };
}

function memoryGate(): AcquisitionRequestGate & { receivedBytes: number; calls: number } {
  return {
    receivedBytes: 0,
    calls: 0,
    async before() {
      this.calls++;
    },
    async received(_key, bytes) {
      this.receivedBytes += bytes;
    },
    async success() {},
    async failure() {},
  };
}

function awsError(name: string, status: number, region?: string) {
  return Object.assign(new Error("secret-do-not-persist"), { name, $metadata: { httpStatusCode: status }, $response: { headers: region ? { "x-amz-bucket-region": region } : {} } });
}

function presentEntry(key = KEY): InventoryEntry {
  const [, year, month, dayText] = key.split("/");
  return { key, utcDay: `${year}-${String(Number(month) + 1).padStart(2, "0")}-${dayText.slice(0, 2)}`, status: "PRESENT", metadata: { contentLength: 3, etag: META.ETag, lastModified: null, storageClass: null, checksumType: null, checksums: {}, requestCharged: "requester" }, attempts: 1, checkedAt: "2026-10-07T00:00:00.000Z", error: null };
}

async function transport(sender: OfflineS3Sender, timeoutMs = 1000) {
  const plan = await createFrozenDukascopyPlan();
  const entries = createInventorySnapshot(plan, []).entries.map((entry) => (entry.key === KEY ? presentEntry() : entry));
  const snapshot = createInventorySnapshot(plan, entries);
  const gate = memoryGate();
  return { gate, instance: new DukascopyGetTransport({ plan, snapshot, approval: approval(plan, "DOWNLOAD", snapshot.revision), gate, session: new DukascopyS3Session({ mode: "OFFLINE_TEST", fakeClient: sender }), timeoutMs }) };
}

async function consume(instance: DukascopyGetTransport): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of instance.downloadObject({ bucket: "cfg-public-proper-wallaby", region: "eu-west-1", requesterPays: true, key: KEY })) chunks.push(chunk);
  return Buffer.concat(chunks);
}

test("SDK construction is lazy; default session and live without explicit flag cannot request", async () => {
  let requests = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    requests++;
    throw new Error("forbidden network");
  };
  try {
    const client = createDukascopySdkClient();
    client.destroy();
    assert.equal(requests, 0);
    const session = new DukascopyS3Session();
    await assert.rejects(() => session.send(new HeadObjectCommand({ Bucket: "cfg-public-proper-wallaby", Key: "USDJPY/2025/00/06_ticks.bi5", RequestPayer: "requester" }), new AbortController().signal), /APPROVAL_VIOLATION/);
    assert.throws(() => new DukascopyS3Session({ mode: "LIVE" }), /APPROVAL_VIOLATION/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("frozen 1826-key whitelist matches preflight hash and rejects alternate/traversal keys", async () => {
  const plan = await createFrozenDukascopyPlan();
  assert.equal(plan.planHash, DUKASCOPY_PLAN_HASH);
  assert.equal(plan.keys.length, 1826);
  assert.ok(Object.isFrozen(plan.keys));
  assert.equal(assertExactDukascopyKey(plan, "USDJPY/2024/01/29_ticks.bi5"), "2024-02-29");
  for (const key of ["../USDJPY/2025/00/06_ticks.bi5", "%2e%2e/x", "EURUSD/2025/00/06_ticks.bi5", "USDJPY/2026/00/01_ticks.bi5", "USDJPY/2025/12/01_ticks.bi5"]) assert.throws(() => assertExactDukascopyKey(plan, key), /APPROVAL_VIOLATION/);
  for (const change of [{ region: "us-east-1" }, { bucket: "other" }, { instrument: "EURUSD" }]) assert.throws(() => assertFrozenPlan({ ...plan, ...change } as typeof plan), /APPROVAL_VIOLATION/);
  await assert.rejects(() => createFrozenDukascopyPlan("0".repeat(64)), /APPROVAL_VIOLATION/);
});

test("HEAD captures allowlisted metadata and leaves actual total UNKNOWN for partial inventory", async () => {
  const plan = await createFrozenDukascopyPlan();
  const snapshot = await collectDukascopyInventory({
    plan,
    approval: approval(plan),
    gate: memoryGate(),
    session: new DukascopyS3Session({
      mode: "OFFLINE_TEST",
      fakeClient: {
        async send(command) {
          assert.ok(command instanceof HeadObjectCommand);
          assert.equal(command.input.RequestPayer, "requester");
          return { ...META, Authorization: "secret-do-not-persist", RoleArn: "secret-role" };
        },
      },
    }),
  });
  assert.equal(snapshot.entries.find((entry) => entry.key === KEY)?.status, "PRESENT");
  assert.equal(snapshot.actualTotalBytes, null);
  assert.equal(snapshot.entries.filter((entry) => entry.status === "UNKNOWN").length, 1825);
  assert.doesNotMatch(JSON.stringify(snapshot), /secret|Authorization|RoleArn/);
});

for (const [name, status, expected, region] of [
  ["NoSuchKey", 404, "CONFIRMED_ABSENT"],
  ["AccessDenied", 403, "AMBIGUOUS_ACCESS"],
  ["InvalidPayer", 403, "ERROR"],
  ["ExpiredToken", 400, "ERROR"],
  ["PermanentRedirect", 301, "ERROR", "us-east-1"],
  ["Unknown", 418, "ERROR"],
] as const)
  test(`HEAD ${name} ${status} fails closed without guessed NO_DATA`, async () => {
    const plan = await createFrozenDukascopyPlan();
    const snapshot = await collectDukascopyInventory({
      plan,
      approval: approval(plan),
      gate: memoryGate(),
      session: new DukascopyS3Session({
        mode: "OFFLINE_TEST",
        fakeClient: {
          async send() {
            throw awsError(name, status, region);
          },
        },
      }),
    });
    assert.equal(snapshot.entries.find((entry) => entry.key === KEY)?.status, expected);
    assert.doesNotMatch(JSON.stringify(snapshot), /secret-do-not-persist/);
  });

test("HEAD transient retries are bounded and expired/duplicate/foreign approvals reject before send", async () => {
  const plan = await createFrozenDukascopyPlan();
  let calls = 0;
  const session = new DukascopyS3Session({
    mode: "OFFLINE_TEST",
    fakeClient: {
      async send() {
        if (++calls < 3) throw awsError("ServiceUnavailable", 503);
        return META;
      },
    },
  });
  const snapshot = await collectDukascopyInventory({ plan, approval: approval(plan), gate: memoryGate(), session, backoff: async () => {} });
  assert.equal(calls, 3);
  assert.equal(snapshot.entries.find((entry) => entry.key === KEY)?.attempts, 3);
  for (const change of [{ expiresAt: "2020-01-01T00:00:00.000Z" }, { keys: [KEY, KEY] }, { planHash: "0".repeat(64) }, { inventoryRevision: "wrong" }, { keys: ["USDJPY/2026/00/01_ticks.bi5"] }]) assert.throws(() => assertApproval(plan, { ...approval(plan), ...change }, "INVENTORY", null), /APPROVAL_VIOLATION/);
});

test("GET streams one chunk at a time with IfMatch and explicit payer", async () => {
  const { instance, gate } = await transport({
    async send(command) {
      assert.ok(command instanceof GetObjectCommand);
      assert.equal(command.input.IfMatch, META.ETag);
      assert.equal(command.input.RequestPayer, "requester");
      return { ...META, Body: Readable.from([Buffer.from("a"), Buffer.from("bc")]) as GetObjectCommandOutput["Body"] };
    },
  });
  assert.equal((await consume(instance)).toString(), "abc");
  assert.equal(gate.receivedBytes, 3);
});

for (const change of [{ ETag: '"changed"' }, { ContentLength: 4 }, { RequestCharged: undefined }, { body: "ab" }, { body: "abcd" }])
  test(`GET rejects metadata/body mismatch ${JSON.stringify(change)}`, async () => {
    const { instance } = await transport({
      async send() {
        return { ...META, ...change, Body: Readable.from([Buffer.from("body" in change ? change.body! : "abc")]) as GetObjectCommandOutput["Body"] };
      },
    });
    await assert.rejects(() => consume(instance), /SOURCE_CHANGED|UNEXPECTED_RESPONSE|REQUESTER_PAYS_ERROR/);
  });

for (const [name, status, expected] of [
  ["AccessDenied", 403, "AMBIGUOUS_ACCESS"],
  ["PreconditionFailed", 412, "SOURCE_CHANGED"],
  ["NoSuchKey", 404, "SOURCE_CHANGED"],
] as const)
  test(`GET ${status} stops, never turns into NO_DATA`, async () => {
    const { instance } = await transport({
      async send() {
        throw awsError(name, status);
      },
    });
    await assert.rejects(() => consume(instance), new RegExp(expected));
  });

test("GET finite timeout aborts even an uncooperative fake sender", async () => {
  const { instance } = await transport(
    {
      async send() {
        return new Promise(() => {});
      },
    },
    5,
  );
  await assert.rejects(() => consume(instance), /TRANSIENT/);
});

function temporaryRoot(): string {
  return mkdtempSync(join(realpathSync(tmpdir()), "task116-production-tests-"));
}

test("single writer, path containment, symlink escape and immutable snapshot publication", async () => {
  const root = temporaryRoot();
  const outside = temporaryRoot();
  const plan = await createFrozenDukascopyPlan();
  const store = await DurableAcquisitionStore.acquire(root);
  try {
    await assert.rejects(() => DurableAcquisitionStore.acquire(root), /FILESYSTEM_UNSAFE/);
    assert.throws(() => store.path("../outside.json"), /FILESYSTEM_UNSAFE/);
    symlinkSync(outside, join(root, "escape"));
    await assert.rejects(() => store.atomicPlain("escape/state.json", {}), /FILESYSTEM_UNSAFE/);
    const snapshot = createInventorySnapshot(plan, []);
    await store.saveSnapshot(plan, snapshot);
    await store.saveSnapshot(plan, snapshot);
    assert.equal((await store.readDocument<typeof snapshot>(`inventories/${snapshot.revision}.json`))?.revision, snapshot.revision);
  } finally {
    await store.release();
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("global attempt ledger survives restart and cannot reset retry count", async () => {
  const root = temporaryRoot();
  const plan = await createFrozenDukascopyPlan();
  let store = await DurableAcquisitionStore.acquire(root);
  try {
    let gate = await store.gate(plan, approval(plan));
    await gate.before("HEAD", KEY, 0);
    await gate.failure("HEAD", KEY, "TRANSIENT");
    await store.release();
    store = await DurableAcquisitionStore.acquire(root);
    gate = await store.gate(plan, approval(plan));
    for (let attempt = 0; attempt < 2; attempt++) {
      await gate.before("HEAD", KEY, 0);
      await gate.failure("HEAD", KEY, "TRANSIENT");
    }
    await assert.rejects(() => gate.before("HEAD", KEY, 0), /CAP_EXCEEDED/);
    const ledger = await store.ledger(plan);
    assert.equal(ledger?.totals.headAttempts, 3);
    assert.equal(ledger?.totals.retryCount, 2);
    assert.equal(ledger?.totals.failedAttempts, 3);
  } finally {
    await store.release();
    rmSync(root, { recursive: true, force: true });
  }
});

test("GET byte reservation and disk guard reject before any request is issued", async () => {
  for (const scenario of ["disk", "bytes"] as const) {
    const root = temporaryRoot();
    const plan = await createFrozenDukascopyPlan();
    const snapshot = createInventorySnapshot(
      plan,
      createInventorySnapshot(plan, []).entries.map((entry) => (entry.key === KEY ? presentEntry() : entry)),
    );
    const approved = approval(plan, "DOWNLOAD", snapshot.revision);
    if (scenario === "bytes") approved.caps.maxNetworkBytes = 2;
    const store = await DurableAcquisitionStore.acquire(root, { freeBytes: async () => (scenario === "disk" ? 0 : 1_000_000) });
    try {
      const gate = await store.gate(plan, approved, snapshot);
      let calls = 0;
      const instance = new DukascopyGetTransport({
        plan,
        snapshot,
        approval: approved,
        gate,
        session: new DukascopyS3Session({
          mode: "OFFLINE_TEST",
          fakeClient: {
            async send() {
              calls++;
              return META;
            },
          },
        }),
      });
      await assert.rejects(() => consume(instance), new RegExp(scenario === "disk" ? "DISK_FULL" : "CAP_EXCEEDED"));
      assert.equal(calls, 0);
      assert.equal((await store.ledger(plan))?.totals.getAttempts, 0);
    } finally {
      await store.release();
      rmSync(root, { recursive: true, force: true });
    }
  }
});

const FAKE_DECODE: DecodeEvidence = { firstTickTimestamp: "2025-01-06T00:00:00.001Z", lastTickTimestamp: "2025-01-06T00:00:00.001Z", tickCount: 1, canonicalMinuteCount: 1, decoderVersion: DUKASCOPY_BI5_ADAPTER_VERSION };

async function runnerFixture(absent = false) {
  const root = temporaryRoot();
  const plan = await createFrozenDukascopyPlan();
  const entry = absent ? { ...presentEntry(), status: "CONFIRMED_ABSENT" as const, metadata: null } : presentEntry();
  const snapshot = createInventorySnapshot(
    plan,
    createInventorySnapshot(plan, []).entries.map((candidate) => (candidate.key === KEY ? entry : candidate)),
  );
  const approved = approval(plan, "DOWNLOAD", snapshot.revision);
  const store = await DurableAcquisitionStore.acquire(root, { freeBytes: async () => 1_000_000 });
  let sends = 0;
  const session = new DukascopyS3Session({
    mode: "OFFLINE_TEST",
    fakeClient: {
      async send() {
        sends++;
        return { ...META, Body: Readable.from([Buffer.from("abc")]) as GetObjectCommandOutput["Body"] };
      },
    },
  });
  return { root, plan, snapshot, approval: approved, store, session, decode: async () => FAKE_DECODE, sends: () => sends };
}

test("default runner is dry-run and cannot send even with an inventory or download approval", async () => {
  const fixture = await runnerFixture();
  try {
    const result = await runDukascopyDownload({ ...fixture, session: undefined });
    assert.equal(result.mode, "DRY_RUN");
    assert.equal(result.checkpoint, null);
    assert.equal(fixture.sends(), 0);
    assert.equal(await fixture.store.ledger(fixture.plan), null);
  } finally {
    await fixture.store.release();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("Foundation writer publishes immutable raw and DECODED resume never requests again", async () => {
  const fixture = await runnerFixture();
  try {
    const first = await runDukascopyDownload(fixture);
    assert.equal(first.checkpoint?.chunks[0].status, "DECODED");
    assert.equal(fixture.sends(), 1);
    const path = first.checkpoint!.chunks[0].rawFilePath!;
    assert.equal(readFileSync(path).toString(), "abc");
    const ledger = await fixture.store.ledger(fixture.plan);
    assert.equal(ledger?.totals.verifiedBytes, 3);
    const second = await runDukascopyDownload(fixture);
    assert.equal(second.checkpoint?.chunks[0].status, "DECODED");
    assert.equal(fixture.sends(), 1);
    assert.equal((await fixture.store.ledger(fixture.plan))?.totals.verifiedBytes, 3);
  } finally {
    await fixture.store.release();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("DECODE_ERROR keeps raw and resume never turns it into another GET", async () => {
  const fixture = await runnerFixture();
  try {
    await assert.rejects(
      () =>
        runDukascopyDownload({
          ...fixture,
          decode: async () => {
            throw new Error("decoder-secret-details");
          },
        }),
      /DECODE_ERROR/,
    );
    assert.equal(fixture.sends(), 1);
    await assert.rejects(() => runDukascopyDownload(fixture), /DECODE_ERROR/);
    assert.equal(fixture.sends(), 1);
    assert.ok(readdirSync(join(fixture.root, "raw")).some((name) => name.endsWith(".bi5")));
  } finally {
    await fixture.store.release();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

for (const crash of ["AFTER_DOWNLOAD", "AFTER_PUBLICATION"] as const)
  test(`${crash} crash reconciles after process restart without re-download`, async () => {
    const fixture = await runnerFixture();
    let store = fixture.store;
    try {
      await assert.rejects(() =>
        runDukascopyDownload({
          ...fixture,
          fault: (stage) => {
            if (stage === crash) throw new Error("simulated crash");
          },
        }),
      );
      assert.equal(fixture.sends(), 1);
      await store.release();
      store = await DurableAcquisitionStore.acquire(fixture.root, { freeBytes: async () => 1_000_000 });
      const result = await runDukascopyDownload({ ...fixture, store });
      assert.equal(result.checkpoint?.chunks[0].status, "DECODED");
      assert.equal(fixture.sends(), 1);
      assert.equal((await store.ledger(fixture.plan))?.totals.verifiedBytes, 3);
    } finally {
      await store.release();
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

test("confirmed NO_DATA evidence is reused and orphan partial is preserved in quarantine", async () => {
  const fixture = await runnerFixture(true);
  try {
    writeFileSync(join(fixture.root, "raw", "orphan.partial"), "orphan");
    const first = await runDukascopyDownload(fixture);
    const second = await runDukascopyDownload(fixture);
    assert.equal(first.checkpoint?.chunks[0].status, "NO_DATA");
    assert.equal(second.checkpoint?.chunks[0].absentInventoryRevision, fixture.snapshot.revision);
    assert.equal(fixture.sends(), 0);
    assert.ok(readdirSync(join(fixture.root, "quarantine")).some((name) => name.startsWith("orphan-")));
  } finally {
    await fixture.store.release();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("runner transient GET retries create separate immutable attempts with persistent reservations", async () => {
  const fixture = await runnerFixture();
  let calls = 0;
  const session = new DukascopyS3Session({
    mode: "OFFLINE_TEST",
    fakeClient: {
      async send() {
        if (++calls < 3) throw awsError("ServiceUnavailable", 503);
        return { ...META, Body: Readable.from([Buffer.from("abc")]) as GetObjectCommandOutput["Body"] };
      },
    },
  });
  try {
    const result = await runDukascopyDownload({ ...fixture, session, backoff: async () => {} });
    assert.equal(result.checkpoint?.chunks[0].status, "DECODED");
    const ledger = await fixture.store.ledger(fixture.plan);
    assert.equal(calls, 3);
    assert.equal(ledger?.totals.getAttempts, 3);
    assert.equal(ledger?.totals.reservedBytes, 9);
    assert.equal(ledger?.totals.retryCount, 2);
  } finally {
    await fixture.store.release();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("runner GET retry cap survives invocation and does not issue a fourth request", async () => {
  const fixture = await runnerFixture();
  let calls = 0;
  const session = new DukascopyS3Session({
    mode: "OFFLINE_TEST",
    fakeClient: {
      async send() {
        calls++;
        throw awsError("ServiceUnavailable", 503);
      },
    },
  });
  try {
    await assert.rejects(() => runDukascopyDownload({ ...fixture, session, backoff: async () => {} }), /CAP_EXCEEDED/);
    assert.equal(calls, 3);
    await assert.rejects(() => runDukascopyDownload({ ...fixture, session, backoff: async () => {} }), /CAP_EXCEEDED/);
    assert.equal(calls, 3);
  } finally {
    await fixture.store.release();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("inventory runner persists immutable partial snapshot and no secret AWS fields", async () => {
  const root = temporaryRoot();
  const plan = await createFrozenDukascopyPlan();
  const store = await DurableAcquisitionStore.acquire(root);
  try {
    const snapshot = await runDukascopyInventory({
      plan,
      approval: approval(plan),
      store,
      session: new DukascopyS3Session({
        mode: "OFFLINE_TEST",
        fakeClient: {
          async send() {
            throw awsError("AccessDenied", 403);
          },
        },
      }),
    });
    assert.equal(snapshot.actualTotalBytes, null);
    const persisted = await store.readDocument<InventorySnapshot>(`inventories/${snapshot.revision}.json`);
    assert.equal(persisted?.revision, snapshot.revision);
    assert.doesNotMatch(JSON.stringify(persisted), /secret-do-not-persist/);
  } finally {
    await store.release();
    rmSync(root, { recursive: true, force: true });
  }
});

test("restricted SDK factory rejects LIST and cannot be injected as an offline fake", async () => {
  const client = createDukascopySdkClient();
  try {
    await assert.rejects(() => client.send(new HeadObjectCommand({Bucket:"cfg-public-proper-wallaby",Key:KEY,RequestPayer:"requester"}),{abortSignal:new AbortController().signal}),/APPROVAL_VIOLATION/);
    await assert.rejects(() => client.send(new ListObjectsV2Command({ Bucket: "cfg-public-proper-wallaby" }) as unknown as HeadObjectCommand, { abortSignal: new AbortController().signal }), /APPROVAL_VIOLATION/);
    assert.throws(() => new DukascopyS3Session({ mode: "OFFLINE_TEST", fakeClient: client }), /APPROVAL_VIOLATION/);
    assert.throws(() => new DukascopyS3Session({ endpoint: "http://elsewhere" } as never), /APPROVAL_VIOLATION/);
  } finally { client.destroy(); }
});

test("verified byte cap is visible to the next GET in the same Foundation batch", async () => {
  const root=temporaryRoot();
  const plan=await createFrozenDukascopyPlan();
  const nextKey="USDJPY/2025/00/07_ticks.bi5";
  const snapshot=createInventorySnapshot(plan,createInventorySnapshot(plan,[]).entries.map(entry=>[KEY,nextKey].includes(entry.key)?presentEntry(entry.key):entry));
  const approved=approval(plan,"DOWNLOAD",snapshot.revision,[KEY,nextKey]);
  approved.caps.maxVerifiedBytes=3;
  const store=await DurableAcquisitionStore.acquire(root,{freeBytes:async()=>1_000_000});
  let calls=0;
  const session=new DukascopyS3Session({mode:"OFFLINE_TEST",fakeClient:{async send(){calls++;return {...META,Body:Readable.from([Buffer.from("abc")]) as GetObjectCommandOutput["Body"]};}}});
  try {
    await assert.rejects(()=>runDukascopyDownload({plan,snapshot,approval:approved,store,session,decode:async()=>FAKE_DECODE}),/CAP_EXCEEDED/);
    assert.equal(calls,1);
    assert.equal((await store.ledger(plan))?.totals.verifiedBytes,3);
  } finally {await store.release();rmSync(root,{recursive:true,force:true});}
});

test("HEAD 200 wrong region and 404 wrong region remain unresolved errors", async () => {
  const plan = await createFrozenDukascopyPlan();
  for (const notFound of [false, true]) {
    const snapshot = await collectDukascopyInventory({ plan, approval: approval(plan), gate: memoryGate(), session: new DukascopyS3Session({ mode: "OFFLINE_TEST", fakeClient: { async send() { if (notFound) throw awsError("NoSuchKey",404,"us-east-1"); return { ...META, $response: { headers: { "x-amz-bucket-region": "us-east-1" } } }; } } }) });
    assert.equal(snapshot.entries.find(entry => entry.key === KEY)?.status, "ERROR");
  }
});

test("GET parent cancellation stops a pending body without retry", async () => {
  const plan = await createFrozenDukascopyPlan();
  const snapshot = createInventorySnapshot(plan, createInventorySnapshot(plan, []).entries.map(entry => entry.key === KEY ? presentEntry() : entry));
  const controller = new AbortController();
  const session = new DukascopyS3Session({ mode: "OFFLINE_TEST", fakeClient: { async send() {
    const body = Readable.from((async function* () { yield Buffer.from("a"); controller.abort(); yield Buffer.from("bc"); })());
    return { ...META, Body: body as GetObjectCommandOutput["Body"] };
  } } });
  const instance = new DukascopyGetTransport({ plan, snapshot, approval: approval(plan,"DOWNLOAD",snapshot.revision), gate: memoryGate(), session, signal: controller.signal });
  await assert.rejects(() => consume(instance), /CANCELLED/);
});

test("network interruption preserves received bytes and retries only the incomplete attempt", async () => {
  const fixture = await runnerFixture();
  let calls = 0;
  const session = new DukascopyS3Session({ mode: "OFFLINE_TEST", fakeClient: { async send() {
    const interrupt = ++calls === 1;
    const body = Readable.from((async function* () { yield Buffer.from("a"); if (interrupt) throw Object.assign(new Error("interrupted"), { code: "ECONNRESET" }); yield Buffer.from("bc"); })());
    return { ...META, Body: body as GetObjectCommandOutput["Body"] };
  } } });
  try {
    await runDukascopyDownload({ ...fixture, session, backoff: async () => {} });
    const ledger = await fixture.store.ledger(fixture.plan);
    assert.equal(calls,2);
    assert.equal(ledger?.totals.receivedBytes,4);
    assert.equal(ledger?.totals.reservedBytes,6);
  } finally { await fixture.store.release(); rmSync(fixture.root,{recursive:true,force:true}); }
});

test("global object and reservation caps apply across different approvals and restarts", async () => {
  for (const kind of ["objects", "bytes"] as const) {
    const root = temporaryRoot();
    const plan = await createFrozenDukascopyPlan();
    const nextKey = "USDJPY/2025/00/07_ticks.bi5";
    const snapshot = createInventorySnapshot(plan, createInventorySnapshot(plan, []).entries.map(entry => [KEY,nextKey].includes(entry.key) ? presentEntry(entry.key) : entry));
    const first = approval(plan,"DOWNLOAD",snapshot.revision);
    first.globalCaps.maxObjects = kind === "objects" ? 1 : 1826;
    first.globalCaps.maxNetworkBytes = kind === "bytes" ? 3 : 1_000_000;
    const second = { ...first, id:"second-approval", batchId:"second-batch", keys:[nextKey] };
    let store = await DurableAcquisitionStore.acquire(root,{freeBytes:async()=>1_000_000});
    try {
      const gate = await store.gate(plan,first,snapshot);
      await gate.before("GET",KEY,3);
      await gate.received(KEY,3);
      await gate.success("GET",KEY);
      await store.release();
      store = await DurableAcquisitionStore.acquire(root,{freeBytes:async()=>1_000_000});
      const resumed = await store.gate(plan,second,snapshot);
      await assert.rejects(()=>resumed.before("GET",nextKey,3),/CAP_EXCEEDED/);
      assert.equal((await store.ledger(plan))?.totals.getAttempts,1);
    } finally { await store.release(); rmSync(root,{recursive:true,force:true}); }
  }
});

test("inventory progress resumes without repeated HEAD under the same bound approval", async () => {
  const root = temporaryRoot();
  const plan = await createFrozenDukascopyPlan();
  let store = await DurableAcquisitionStore.acquire(root);
  let calls = 0;
  const session = new DukascopyS3Session({mode:"OFFLINE_TEST",fakeClient:{async send(){calls++;return META;}}});
  const approved = approval(plan);
  try {
    await runDukascopyInventory({plan,approval:approved,store,session});
    await store.release();
    store = await DurableAcquisitionStore.acquire(root);
    await runDukascopyInventory({plan,approval:approved,store,session});
    assert.equal(calls,1);
    await assert.rejects(()=>runDukascopyInventory({plan,approval:{...approved,keys:[KEY,KEY]},store,session}),/APPROVAL_VIOLATION/);
  } finally {await store.release();rmSync(root,{recursive:true,force:true});}
});

test("plan/revision mismatch and unapproved exact keys reject before GET", async () => {
  const fixture = await runnerFixture();
  try {
    await assert.rejects(()=>runDukascopyDownload({...fixture,approval:{...fixture.approval,inventoryRevision:"0".repeat(64)}}),/APPROVAL_VIOLATION/);
    await assert.rejects(()=>runDukascopyDownload({...fixture,snapshot:{...fixture.snapshot,revision:"0".repeat(64)}}),/APPROVAL_VIOLATION/);
    const gate = await fixture.store.gate(fixture.plan,fixture.approval,fixture.snapshot);
    await assert.rejects(()=>gate.before("GET","USDJPY/2025/00/07_ticks.bi5",3),/APPROVAL_VIOLATION/);
    assert.equal(fixture.sends(),0);
  } finally {await fixture.store.release();rmSync(fixture.root,{recursive:true,force:true});}
});

test("explicit stale-lock reclaim retains lock evidence and rejects a live owner", async () => {
  const root = temporaryRoot();
  writeFileSync(join(root,"writer.lock"),JSON.stringify({pid:2147483647,token:"dead-owner"}));
  await assert.rejects(()=>DurableAcquisitionStore.acquire(root),/FILESYSTEM_UNSAFE/);
  const store = await DurableAcquisitionStore.acquire(root,{staleLockToken:"dead-owner"});
  try {
    const lock = await store.readPlain<{token:string}>("writer.lock");
    await assert.rejects(()=>DurableAcquisitionStore.acquire(root,{staleLockToken:lock!.token}),/FILESYSTEM_UNSAFE/);
    assert.ok(readdirSync(join(root,"locks")).some(name=>name.startsWith("stale-")));
  } finally {await store.release();rmSync(root,{recursive:true,force:true});}
});

test("FULL_OBJECT checksum mismatch stops and retains raw without a second download", async () => {
  const fixture = await runnerFixture();
  const entry = presentEntry();
  entry.metadata!.checksumType="FULL_OBJECT";
  entry.metadata!.checksums.ChecksumSHA256=Buffer.alloc(32).toString("base64");
  const snapshot=createInventorySnapshot(fixture.plan,fixture.snapshot.entries.map(candidate=>candidate.key===KEY?entry:candidate));
  try {
    await assert.rejects(()=>runDukascopyDownload({...fixture,snapshot,approval:approval(fixture.plan,"DOWNLOAD",snapshot.revision)}),/SOURCE_CHANGED/);
    assert.equal(fixture.sends(),1);
  } finally {await fixture.store.release();rmSync(fixture.root,{recursive:true,force:true});}
});

test("runner default decoder validates synthetic LZMA-Alone through unchanged production parser", async () => {
  const fixture = await runnerFixture();
  const record = Buffer.alloc(20);
  record.writeUInt32BE(1,0);record.writeUInt32BE(157207,4);record.writeUInt32BE(157198,8);record.writeFloatBE(1,12);record.writeFloatBE(2,16);
  const bytes=execFileSync("xz",["--format=lzma","--compress","--stdout"],{input:record});
  const entry=presentEntry();entry.metadata!.contentLength=bytes.length;
  const snapshot=createInventorySnapshot(fixture.plan,fixture.snapshot.entries.map(candidate=>candidate.key===KEY?entry:candidate));
  const session=new DukascopyS3Session({mode:"OFFLINE_TEST",fakeClient:{async send(){return {...META,ContentLength:bytes.length,Body:Readable.from([bytes]) as GetObjectCommandOutput["Body"]};}}});
  try {
    const result=await runDukascopyDownload({...fixture,snapshot,approval:approval(fixture.plan,"DOWNLOAD",snapshot.revision),session,decode:undefined});
    assert.equal(result.checkpoint?.chunks[0].tickCount,1);
    assert.equal(result.checkpoint?.chunks[0].decoderVersion,DUKASCOPY_BI5_ADAPTER_VERSION);
  } finally {await fixture.store.release();rmSync(fixture.root,{recursive:true,force:true});}
});

test("synthetic 1826 inventory entries, 60 batch checkpoints and persistent ledger resume scale", {timeout:120_000}, async context => {
  const root=temporaryRoot();
  const plan=await createFrozenDukascopyPlan();
  const approved=approval(plan,"INVENTORY",null,[...plan.keys]);
  let store=await DurableAcquisitionStore.acquire(root);
  const started=performance.now();const rssBefore=process.memoryUsage().rss;
  try {
    const gate=memoryGate();
    const snapshot=await collectDukascopyInventory({plan,approval:approved,gate,session:new DukascopyS3Session({mode:"OFFLINE_TEST",fakeClient:{async send(){return META;}}})});
    assert.equal(snapshot.entries.length,1826);assert.equal(snapshot.actualTotalBytes,5478);assert.equal(gate.calls,1826);
    await store.saveSnapshot(plan,snapshot);
    const months=new Map<string,string[]>();
    for(const entry of snapshot.entries){const month=entry.utcDay.slice(0,7);const keys=months.get(month)??[];keys.push(entry.key);months.set(month,keys);}
    for(const [month,keys] of months) await store.atomicPlain(`batches/${month}.json`,{planHash:plan.planHash,inventoryRevision:snapshot.revision,keys});
    await store.gate(plan,approved);
    const ledger=(await store.ledger(plan))!;
    ledger.totals.headAttempts=1826;ledger.contexts[approved.id].counters.headAttempts=1826;
    for(const key of plan.keys) ledger.attempts[`HEAD:${key}`]=1;
    await store.document("ledger.json",ledger);
    await store.release();store=await DurableAcquisitionStore.acquire(root);
    assert.equal((await store.ledger(plan))?.totals.headAttempts,1826);
    let resumedKeys=0;
    for(const month of months.keys()) resumedKeys+=(await store.readPlain<{keys:string[]}>(`batches/${month}.json`))!.keys.length;
    assert.equal(resumedKeys,1826);assert.equal(months.size,60);
    const elapsed=performance.now()-started;const rssAfter=process.memoryUsage().rss;
    context.diagnostic(`SYNTHETIC_SCALE entries=1826 batches=60 elapsedMs=${Math.round(elapsed)} rssBefore=${rssBefore} rssAfter=${rssAfter} peakRssKiB=${process.resourceUsage().maxRSS}`);
    assert.ok(rssAfter-rssBefore<256*1024*1024);
    assert.equal(createHash("sha256").update(JSON.stringify(plan.keys)).digest("hex"),DUKASCOPY_PLAN_HASH);
  } finally {await store.release();rmSync(root,{recursive:true,force:true});}
});
