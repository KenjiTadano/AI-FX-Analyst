import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { performance } from "node:perf_hooks";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { DUKASCOPY_PRODUCTION_ROOT, buildTask116CampaignChildren, DurableAcquisitionStore, type AcquisitionLedger, type CampaignCapExpansionAuthorization, type CampaignChildCapPlan, type HeadAttemptJournalEvent } from "../lib/backtest/dukascopy-s3-durable";
import { runDukascopyDownload, runDukascopyInventory, type DecodeEvidence } from "../lib/backtest/dukascopy-s3-runner";
import { DUKASCOPY_BI5_ADAPTER_VERSION } from "../lib/backtest/dukascopy-bi5-adapter";
import { HeadObjectCommand, GetObjectCommand, ListObjectsV2Command, type GetObjectCommandOutput } from "@aws-sdk/client-s3";
import {
  assertExactDukascopyKey,
  assertFrozenPlan,
  acquisitionHash,
  createDukascopySdkClient,
  createFrozenDukascopyPlan,
  DukascopyS3Session,
  AcquisitionSafetyError,
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
  type InventoryCrashBoundary,
  SimulatedInventoryCrash,
} from "../lib/backtest/dukascopy-s3-production";

const KEY = "USDJPY/2025/00/06_ticks.bi5";
const META = { $metadata: { httpStatusCode: 200 }, ContentLength: 3, ETag: '"test-etag"', RequestCharged: "requester" as const };
let blockedNetworkCalls = 0;
test.before(() => {
  const rejectNetwork = () => {
    blockedNetworkCalls++;
    throw new Error("non-fake network forbidden");
  };
  test.mock.method(http, "request", rejectNetwork);
  test.mock.method(https, "request", rejectNetwork);
  test.mock.method(net.Socket.prototype, "connect", rejectNetwork);
  test.mock.method(tls, "connect", rejectNetwork);
  test.mock.method(globalThis, "fetch", rejectNetwork);
});
test.after(() => {
  assert.equal(blockedNetworkCalls, 0);
  test.mock.restoreAll();
});

function approval(plan: FrozenDukascopyPlan, operation: AcquisitionApproval["operation"] = "INVENTORY", revision: string | null = null, keys = [KEY]): AcquisitionApproval {
  const caps = { maxHeadAttempts: 5478, maxGetAttempts: 5478, maxNetworkBytes: 1_000_000, maxVerifiedBytes: 1_000_000, maxObjects: 1826, maxRetries: 2 };
  return { id: `approval-${operation}`, batchId: "batch-one", operation, planHash: plan.planHash, inventoryRevision: revision, batchStart: plan.requestedStart, batchEnd: plan.requestedEnd, keys, caps, globalCaps: { ...caps }, minimumFreeBytes: 0, expiresAt: "2100-01-01T00:00:00.000Z" };
}

function capExpansionAuthorization(plan: FrozenDukascopyPlan, ledger: AcquisitionLedger, initialInventoryRevision: string, overrides: Partial<CampaignCapExpansionAuthorization> = {}): CampaignCapExpansionAuthorization {
  const campaignId = "task116-usdjpy-20210108-20210207";
  const operatorApprovalReference = "OP-APPROVAL-TASK116-30DAY";
  const oldGlobalCaps = { ...ledger.globalCaps };
  return {
    version: 1,
    authorizationId: "task116-cap-expansion-test-01",
    campaignId,
    oldGlobalCaps,
    newGlobalCaps: { ...oldGlobalCaps, maxHeadAttempts: 44 },
    oldMaxHeadAttempts: 21,
    newMaxHeadAttempts: 44,
    normalHeadBudget: 30,
    recoveryHeadBudget: 5,
    campaignStart: "2021-01-08T00:00:00.000Z",
    campaignEnd: "2021-02-07T00:00:00.000Z",
    children: buildTask116CampaignChildren(plan),
    reason: "Reviewed 30-day metadata inventory campaign budget expansion.",
    authorizedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 45 * 60 * 1000).toISOString(),
    operatorApprovalReference,
    operatorApprovalHash: acquisitionHash({ operatorApprovalReference, campaignId }),
    priorLedgerHash: acquisitionHash(ledger),
    priorLedgerGeneration: ledger.ledgerGeneration ?? 0,
    masterPlanHash: plan.planHash,
    instrument: plan.instrument,
    bucket: plan.bucket,
    region: plan.region,
    requesterPays: true,
    initialInventoryRevision,
    ...overrides,
  };
}

function campaignTestApproval(plan: FrozenDukascopyPlan, child: CampaignChildCapPlan, revision: string, globalCaps: AcquisitionApproval["globalCaps"], id: string): AcquisitionApproval {
  return {
    id,
    batchId: child.batchId,
    campaignId: "task116-usdjpy-20210108-20210207",
    operation: "INVENTORY",
    planHash: plan.planHash,
    inventoryRevision: revision,
    batchStart: child.batchStart,
    batchEnd: child.batchEnd,
    keys: child.keys,
    caps: { maxHeadAttempts: child.keys.length + child.recoveryAllowance, maxGetAttempts: 0, maxNetworkBytes: 0, maxVerifiedBytes: 0, maxObjects: child.keys.length, maxRetries: 0 },
    globalCaps: { ...globalCaps },
    recoveryAllowance: { maxIndeterminateHeadRetries: child.recoveryAllowance },
    minimumFreeBytes: 0,
    expiresAt: "2100-01-01T00:00:00.000Z",
  };
}

async function preparedCampaignTestApproval(store: DurableAcquisitionStore, plan: FrozenDukascopyPlan, child: CampaignChildCapPlan, revision: string, id: string) {
  const ledger = (await store.ledger(plan))!;
  const campaign = ledger.campaignBudgets!["task116-usdjpy-20210108-20210207"];
  const root = store.root;
  const projectRoot = resolve(root, "../../..");
  await store.release();
  const result = await DurableAcquisitionStore.prepareTask116CampaignChildApproval(
    plan,
    {
      approvalId: id,
      campaignId: campaign.campaignId,
      childSequence: child.sequence,
      priorLedgerHash: acquisitionHash(ledger),
      priorLedgerGeneration: ledger.ledgerGeneration!,
      inventoryRevision: revision,
      masterPlanHash: plan.planHash,
      capAuthorizationId: campaign.authorizationId,
      capAuthorizationHash: campaign.authorizationHash,
      globalCaps: { ...ledger.globalCaps },
      childDescriptorHash: acquisitionHash(child),
      instrument: plan.instrument,
      bucket: plan.bucket,
      region: plan.region,
      requesterPays: true,
      authorizedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      operatorApprovalReference: "OP-CAMPAIGN-CHILD-REVIEW",
      operatorApprovalHash: acquisitionHash({ id, child }),
      reason: "Reviewed isolated campaign child inventory approval preparation.",
    },
    { projectRoot },
  );
  const approval = JSON.parse(readFileSync(join(projectRoot, result.approvalPath), "utf8")).data as AcquisitionApproval;
  return { approval, store: await DurableAcquisitionStore.acquire(root) };
}

async function capExpansionFixture(faultAt?: InventoryCrashBoundary | "CAP_AFTER_AUTHORIZATION_EVIDENCE" | "CAP_AFTER_LEDGER_COMMIT") {
  const projectRoot = temporaryRoot();
  execFileSync("git", ["init", "--quiet", projectRoot], { stdio: "ignore" });
  writeFileSync(join(projectRoot, ".gitignore"), "/tmp/dukascopy/\n");
  const root = join(projectRoot, DUKASCOPY_PRODUCTION_ROOT);
  const plan = await createFrozenDukascopyPlan();
  const seed = createInventorySnapshot(plan, []);
  const globalCaps = { maxHeadAttempts: 21, maxGetAttempts: 0, maxNetworkBytes: 0, maxVerifiedBytes: 0, maxObjects: 7, maxRetries: 2 };
  const priorApproval: AcquisitionApproval = { ...approval(plan, "INVENTORY", null, plan.keys.slice(0, 7)), id: "previous-seven-day-approval", batchId: "previous-seven-day-batch", caps: { ...globalCaps }, globalCaps: { ...globalCaps } };
  const counts = { headAttempts: 9, getAttempts: 0, successfulGets: 0, failedAttempts: 0, receivedBytes: 0, reservedBytes: 0, verifiedBytes: 0, retryCount: 0, objects: [] as string[] };
  const ledger: AcquisitionLedger = {
    version: "DUKASCOPY_DURABLE_V1",
    planHash: plan.planHash,
    inventoryRevision: null,
    approvalId: priorApproval.id,
    batchId: priorApproval.batchId,
    globalCaps: { ...globalCaps },
    totals: { ...counts },
    contexts: { [priorApproval.id]: { bindingHash: acquisitionHash(priorApproval), counters: { ...counts } } },
    attempts: Object.fromEntries(plan.keys.slice(0, 3).map((key) => [`HEAD:${key}`, 3])),
    completedGetKeys: [],
    verified: {},
    active: null,
    quarantineBytes: 0,
    partialBytes: 0,
    startedAt: "2026-10-07T00:00:00.000Z",
    updatedAt: "2026-10-07T00:00:00.000Z",
  };
  let store = await DurableAcquisitionStore.acquire(root);
  await store.saveSnapshot(plan, seed);
  await store.document("ledger.json", ledger);
  await store.release();
  const authorization = capExpansionAuthorization(plan, ledger, seed.revision);
  const preparationInput = Object.fromEntries(Object.entries(authorization).filter(([field]) => !["version", "oldMaxHeadAttempts", "newMaxHeadAttempts", "normalHeadBudget", "recoveryHeadBudget"].includes(field))) as Parameters<typeof DurableAcquisitionStore.prepareTask116CampaignCapExpansionAuthorization>[1];
  await DurableAcquisitionStore.prepareTask116CampaignCapExpansionAuthorization(plan, preparationInput, { projectRoot });
  store = await DurableAcquisitionStore.acquire(root, faultAt ? { faultAt } : {});
  const fixture = {
    root,
    plan,
    seed,
    ledger,
    store,
    authorization,
    cleanup: async () => {
      await fixture.store.release().catch(() => {});
      rmSync(projectRoot, { recursive: true, force: true });
    },
  };
  return fixture;
}

function memoryGate(): AcquisitionRequestGate & { receivedBytes: number; calls: number } {
  return {
    receivedBytes: 0,
    calls: 0,
    async before() {
      this.calls++;
      return null;
    },
    async markHeadMayHaveBeenSent() {},
    async classifyHead() {},
    fault() {},
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

test("HEAD attempt journal persists unique append-only monotonic states", async () => {
  const root = temporaryRoot();
  const plan = await createFrozenDukascopyPlan();
  const approved = approval(plan, "INVENTORY", null, [KEY]);
  const store = await DurableAcquisitionStore.acquire(root);
  try {
    const first = await store.reserveHeadAttempt(plan, approved, KEY, 1, "INITIAL");
    const second = await store.reserveHeadAttempt(plan, approved, KEY, 2, "RETRY");
    assert.notEqual(first.attemptId, second.attemptId);
    assert.equal((await store.readDocument<HeadAttemptJournalEvent>(`head-attempts/${first.attemptId}/RESERVED.json`))?.state, "RESERVED");
    await assert.rejects(() => store.classifyHeadAttempt(plan, first.attemptId, presentEntry()), /FILESYSTEM_UNSAFE/);
    const sent = await store.markHeadAttemptMayHaveBeenSent(first.attemptId);
    assert.equal(sent.state, "MAY_HAVE_BEEN_SENT");
    await assert.rejects(() => store.markHeadAttemptMayHaveBeenSent(first.attemptId), /FILESYSTEM_UNSAFE/);
    const classified = await store.classifyHeadAttempt(plan, first.attemptId, presentEntry());
    assert.equal(classified.state, "CLASSIFIED");
    assert.equal(classified.classification?.status, "PRESENT");
    await assert.rejects(() => store.markHeadAttemptMayHaveBeenSent(first.attemptId), /FILESYSTEM_UNSAFE/);
    const events = await store.headAttemptJournal();
    assert.equal(events.length, 2);
    assert.deepEqual(
      events.map((event) => event.attemptId),
      [first.attemptId, second.attemptId],
    );
    assert.equal((await store.readDocument<HeadAttemptJournalEvent>(`head-attempts/${first.attemptId}/CLASSIFIED.json`))?.classification?.metadata?.etag, META.ETag);
  } finally {
    await store.release();
    rmSync(root, { recursive: true, force: true });
  }
});

for (const boundary of ["A_BEFORE_RESERVATION", "B_AFTER_RESERVED", "C_AFTER_MAY_HAVE_BEEN_SENT", "D_AFTER_RESPONSE", "E_AFTER_CLASSIFIED", "F_AFTER_PROGRESS", "G_AFTER_SNAPSHOT"] as const)
  test(`inventory crash boundary ${boundary} reconciles without double accounting`, async () => {
    const root = temporaryRoot();
    const plan = await createFrozenDukascopyPlan();
    const seed = createInventorySnapshot(plan, []);
    const approved = approval(plan, "INVENTORY", seed.revision, [KEY]);
    approved.caps.maxHeadAttempts = 2;
    approved.caps.maxRetries = 0;
    approved.globalCaps = { ...approved.caps };
    if (boundary === "B_AFTER_RESERVED") {
      approved.caps.maxHeadAttempts = 1;
      approved.globalCaps = { ...approved.caps };
    }
    const sends = { count: 0 };
    const session = new DukascopyS3Session({
      mode: "OFFLINE_TEST",
      fakeClient: {
        async send() {
          sends.count++;
          return META;
        },
      },
    });
    let store = await DurableAcquisitionStore.acquire(root);
    await store.saveSnapshot(plan, seed);
    await store.release();
    store = await DurableAcquisitionStore.acquire(root, { faultAt: boundary as InventoryCrashBoundary });
    const run = () => runDukascopyInventory({ plan, approval: approved, previous: seed, store, session });
    try {
      await assert.rejects(run, (error) => error instanceof SimulatedInventoryCrash && error.boundary === boundary);
      const firstLedger = (await store.ledger(plan))!;
      const firstEvent = (await store.headAttemptJournal())[0];
      const firstProgress = await store.readDocument<{ entry: InventoryEntry }>(
        `progress/${createHash("sha256")
          .update(JSON.stringify(`${approved.id}:${KEY}`))
          .digest("hex")}.json`,
      );
      const snapshotFilesBeforeResume = readdirSync(join(root, "inventories")).filter((name) => name.endsWith(".json"));
      const attemptsAfterCrash = boundary === "A_BEFORE_RESERVATION" ? 0 : 1;
      assert.equal(firstLedger.attempts[`HEAD:${KEY}`] ?? 0, attemptsAfterCrash);
      assert.equal(firstLedger.totals.headAttempts, attemptsAfterCrash);
      assert.equal(firstEvent?.state, boundary === "A_BEFORE_RESERVATION" ? undefined : boundary === "B_AFTER_RESERVED" ? "RESERVED" : boundary === "C_AFTER_MAY_HAVE_BEEN_SENT" || boundary === "D_AFTER_RESPONSE" ? "MAY_HAVE_BEEN_SENT" : "CLASSIFIED");
      assert.equal(Boolean(firstProgress), boundary === "F_AFTER_PROGRESS" || boundary === "G_AFTER_SNAPSHOT");
      assert.equal(snapshotFilesBeforeResume.length, boundary === "G_AFTER_SNAPSHOT" ? 2 : 1);
      if (boundary === "A_BEFORE_RESERVATION" || boundary === "B_AFTER_RESERVED") assert.equal(sends.count, 0);
      if (boundary === "C_AFTER_MAY_HAVE_BEEN_SENT") assert.equal(sends.count, 0);
      if (["D_AFTER_RESPONSE", "E_AFTER_CLASSIFIED", "F_AFTER_PROGRESS", "G_AFTER_SNAPSHOT"].includes(boundary)) assert.equal(sends.count, 1);
      await store.release();
      store = await DurableAcquisitionStore.acquire(root);
      if (boundary === "C_AFTER_MAY_HAVE_BEEN_SENT" || boundary === "D_AFTER_RESPONSE") {
        const stopped = await run();
        assert.equal(stopped.entries.find((entry) => entry.key === KEY)?.error, "INDETERMINATE");
        assert.equal(sends.count, boundary === "C_AFTER_MAY_HAVE_BEEN_SENT" ? 0 : 1);
        const blockedLedger = (await store.ledger(plan))!;
        assert.equal(blockedLedger.attempts[`HEAD:${KEY}`], 1);
        assert.equal(blockedLedger.contexts[approved.id].counters.recoveryHeadAttempts ?? 0, 0);
      } else {
        const resumed = await run();
        assert.equal(resumed.entries.find((entry) => entry.key === KEY)?.status, "PRESENT");
        assert.equal(sends.count, boundary === "A_BEFORE_RESERVATION" || boundary === "B_AFTER_RESERVED" ? 1 : 1);
        const resumedLedger = (await store.ledger(plan))!;
        assert.equal(resumedLedger.attempts[`HEAD:${KEY}`], 1);
        assert.equal(resumedLedger.totals.headAttempts, 1);
        assert.equal(resumedLedger.contexts[approved.id].counters.headAttempts, 1);
        assert.equal(resumedLedger.headAttemptAccounting && Object.keys(resumedLedger.headAttemptAccounting).length, 1);
        if (boundary === "G_AFTER_SNAPSHOT") {
          const published = snapshotFilesBeforeResume.filter((name) => name !== `${seed.revision}.json`);
          assert.equal(published.length, 1);
          const publishedSnapshot = await store.readDocument<InventorySnapshot>(`inventories/${published[0]}`);
          assert.equal(publishedSnapshot?.entries.find((entry) => entry.key === KEY)?.status, "PRESENT");
        }
      }
    } finally {
      await store.release();
      session.destroy();
      rmSync(root, { recursive: true, force: true });
    }
  });

test("crash after attempt directory sync but before RESERVED proves no dispatch", async () => {
  const root = temporaryRoot();
  const plan = await createFrozenDukascopyPlan();
  const seed = createInventorySnapshot(plan, []);
  const approved = approval(plan, "INVENTORY", seed.revision, [KEY]);
  const sends = { count: 0 };
  const session = new DukascopyS3Session({
    mode: "OFFLINE_TEST",
    fakeClient: {
      async send() {
        sends.count++;
        return META;
      },
    },
  });
  let store = await DurableAcquisitionStore.acquire(root);
  await store.saveSnapshot(plan, seed);
  await store.release();
  store = await DurableAcquisitionStore.acquire(root, { faultAt: "A_AFTER_ATTEMPT_DIRECTORY" });
  const run = () => runDukascopyInventory({ plan, approval: approved, previous: seed, store, session });
  try {
    await assert.rejects(run, (error) => error instanceof SimulatedInventoryCrash && error.boundary === "A_AFTER_ATTEMPT_DIRECTORY");
    assert.equal(sends.count, 0);
    assert.deepEqual(await store.headAttemptJournal(), []);
    await store.release();
    store = await DurableAcquisitionStore.acquire(root);
    const resumed = await run();
    assert.equal(resumed.entries.find((entry) => entry.key === KEY)?.status, "PRESENT");
    assert.equal(sends.count, 1);
    assert.equal((await store.ledger(plan))?.totals.headAttempts, 1);
  } finally {
    await store.release();
    session.destroy();
    rmSync(root, { recursive: true, force: true });
  }
});

test("crash after fake SDK send begins but before response remains indeterminate", async () => {
  const root = temporaryRoot();
  const plan = await createFrozenDukascopyPlan();
  const seed = createInventorySnapshot(plan, []);
  const approved = approval(plan, "INVENTORY", seed.revision, [KEY]);
  approved.caps.maxRetries = 0;
  const calls = { count: 0 };
  const session = new DukascopyS3Session({
    mode: "OFFLINE_TEST",
    fakeClient: {
      async send() {
        calls.count++;
        throw new SimulatedInventoryCrash("C_AFTER_MAY_HAVE_BEEN_SENT");
      },
    },
  });
  let store = await DurableAcquisitionStore.acquire(root);
  try {
    await store.saveSnapshot(plan, seed);
    const run = () => runDukascopyInventory({ plan, approval: approved, previous: seed, store, session });
    await assert.rejects(run, (error) => error instanceof SimulatedInventoryCrash && error.boundary === "C_AFTER_MAY_HAVE_BEEN_SENT");
    assert.equal(calls.count, 1);
    await store.release();
    store = await DurableAcquisitionStore.acquire(root);
    const stopped = await run();
    assert.equal(stopped.entries.find((entry) => entry.key === KEY)?.error, "INDETERMINATE");
    assert.equal(calls.count, 1);
    assert.equal((await store.ledger(plan))?.attempts[`HEAD:${KEY}`], 1);
  } finally {
    await store.release();
    session.destroy();
    rmSync(root, { recursive: true, force: true });
  }
});

test("retry-zero indeterminate persists a safe partial snapshot without another attempt", async () => {
  const root = temporaryRoot();
  const plan = await createFrozenDukascopyPlan();
  const seed = createInventorySnapshot(plan, []);
  const approved = approval(plan, "INVENTORY", seed.revision, [KEY]);
  approved.caps.maxRetries = 0;
  const sends = { count: 0 };
  const session = new DukascopyS3Session({
    mode: "OFFLINE_TEST",
    fakeClient: {
      async send() {
        sends.count++;
        return META;
      },
    },
  });
  let store = await DurableAcquisitionStore.acquire(root, { faultAt: "C_AFTER_MAY_HAVE_BEEN_SENT" });
  try {
    await store.saveSnapshot(plan, seed);
    await assert.rejects(
      () => runDukascopyInventory({ plan, approval: approved, previous: seed, store, session }),
      (error) => error instanceof SimulatedInventoryCrash,
    );
    await store.release();
    store = await DurableAcquisitionStore.acquire(root);
    const partial = await runDukascopyInventory({ plan, approval: approved, previous: seed, store, session });
    const entry = partial.entries.find((candidate) => candidate.key === KEY)!;
    assert.equal(entry.status, "ERROR");
    assert.equal(entry.error, "INDETERMINATE");
    assert.equal(sends.count, 0);
    assert.equal((await store.ledger(plan))?.totals.headAttempts, 1);
    const repeated = await runDukascopyInventory({ plan, approval: approved, previous: seed, store, session });
    assert.equal(repeated.entries.find((candidate) => candidate.key === KEY)?.error, "INDETERMINATE");
    assert.equal(sends.count, 0);
    assert.equal((await store.ledger(plan))?.totals.headAttempts, 1);
  } finally {
    await store.release();
    session.destroy();
    rmSync(root, { recursive: true, force: true });
  }
});

test("indeterminate retry requires finite allowance and is charged as a new attempt", async () => {
  const root = temporaryRoot();
  const plan = await createFrozenDukascopyPlan();
  const seed = createInventorySnapshot(plan, []);
  const approved = approval(plan, "INVENTORY", seed.revision, [KEY]);
  approved.caps.maxHeadAttempts = 3;
  approved.caps.maxRetries = 0;
  approved.globalCaps = { ...approved.caps };
  approved.recoveryAllowance = { maxIndeterminateHeadRetries: 1 };
  const sends = { count: 0 };
  const session = new DukascopyS3Session({
    mode: "OFFLINE_TEST",
    fakeClient: {
      async send() {
        sends.count++;
        return META;
      },
    },
  });
  let store = await DurableAcquisitionStore.acquire(root);
  await store.saveSnapshot(plan, seed);
  await store.release();
  store = await DurableAcquisitionStore.acquire(root, { faultAt: "C_AFTER_MAY_HAVE_BEEN_SENT" });
  const run = () => runDukascopyInventory({ plan, approval: approved, previous: seed, store, session });
  try {
    await assert.rejects(run, (error) => error instanceof SimulatedInventoryCrash && error.boundary === "C_AFTER_MAY_HAVE_BEEN_SENT");
    await store.release();
    store = await DurableAcquisitionStore.acquire(root, { faultAt: "D_AFTER_RESPONSE" });
    await assert.rejects(run, (error) => error instanceof SimulatedInventoryCrash && error.boundary === "D_AFTER_RESPONSE");
    assert.equal(sends.count, 1);
    let ledger = (await store.ledger(plan))!;
    assert.equal(ledger.totals.headAttempts, 2);
    assert.equal(ledger.attempts[`HEAD:${KEY}`], 2);
    assert.equal(ledger.contexts[approved.id].counters.recoveryHeadAttempts, 1);
    const events = await store.headAttemptJournal();
    assert.equal(events.length, 2);
    assert.notEqual(events[0].attemptId, events[1].attemptId);
    assert.equal(events[1].kind, "INDETERMINATE_RECOVERY");
    await store.release();
    store = await DurableAcquisitionStore.acquire(root);
    const restartEvents = await store.headAttemptJournal();
    assert.deepEqual(
      restartEvents.map((event) => event.state),
      ["MAY_HAVE_BEEN_SENT", "MAY_HAVE_BEEN_SENT"],
    );
    assert.equal((await store.ledger(plan))?.contexts[approved.id].counters.recoveryHeadAttempts, 1);
    const recoveryGate = await store.gate(plan, approved, seed);
    const gateOutcome = await recoveryGate.before("HEAD", KEY, 0).then(
      () => "RESERVED",
      (error) => (error instanceof AcquisitionSafetyError ? error.code : error.name),
    );
    assert.equal(gateOutcome, "INDETERMINATE");
    const recoverySnapshot = await run();
    assert.equal(recoverySnapshot.entries.find((entry) => entry.key === KEY)?.error, "INDETERMINATE");
    ledger = (await store.ledger(plan))!;
    assert.equal(ledger.totals.headAttempts, 2);
    assert.equal(ledger.contexts[approved.id].counters.recoveryHeadAttempts, 1);
    assert.equal(sends.count, 1);
  } finally {
    await store.release();
    session.destroy();
    rmSync(root, { recursive: true, force: true });
  }
});

test("transient indeterminate recovery stops after its one charged recovery attempt", async () => {
  const root = temporaryRoot();
  const plan = await createFrozenDukascopyPlan();
  const seed = createInventorySnapshot(plan, []);
  const approved = approval(plan, "INVENTORY", seed.revision, [KEY]);
  approved.caps.maxHeadAttempts = 2;
  approved.caps.maxRetries = 0;
  approved.globalCaps = { ...approved.caps };
  approved.recoveryAllowance = { maxIndeterminateHeadRetries: 1 };
  let sends = 0;
  const session = new DukascopyS3Session({
    mode: "OFFLINE_TEST",
    fakeClient: {
      async send() {
        sends++;
        throw awsError("ServiceUnavailable", 503);
      },
    },
  });
  let store = await DurableAcquisitionStore.acquire(root);
  await store.saveSnapshot(plan, seed);
  await store.release();
  store = await DurableAcquisitionStore.acquire(root, { faultAt: "C_AFTER_MAY_HAVE_BEEN_SENT" });
  const run = () => runDukascopyInventory({ plan, approval: approved, previous: seed, store, session, backoff: async () => {} });
  try {
    await assert.rejects(run, (error) => error instanceof SimulatedInventoryCrash && error.boundary === "C_AFTER_MAY_HAVE_BEEN_SENT");
    await store.release();
    store = await DurableAcquisitionStore.acquire(root);
    const snapshot = await run();
    assert.equal(sends, 1);
    assert.equal(snapshot.entries.find((entry) => entry.key === KEY)?.error, "TRANSIENT");
    const ledger = (await store.ledger(plan))!;
    assert.equal(ledger.totals.headAttempts, 2);
    assert.equal(ledger.attempts[`HEAD:${KEY}`], 2);
    assert.equal(ledger.contexts[approved.id].counters.recoveryHeadAttempts, 1);
  } finally {
    await store.release();
    session.destroy();
    rmSync(root, { recursive: true, force: true });
  }
});

test("recovery RESERVED journal replay charges once if ledger projection crashed", async () => {
  const root = temporaryRoot();
  const plan = await createFrozenDukascopyPlan();
  const seed = createInventorySnapshot(plan, []);
  const approved = approval(plan, "INVENTORY", seed.revision, [KEY]);
  approved.caps.maxHeadAttempts = 3;
  approved.caps.maxRetries = 0;
  approved.globalCaps = { ...approved.caps };
  approved.recoveryAllowance = { maxIndeterminateHeadRetries: 1 };
  let sends = 0;
  const session = new DukascopyS3Session({
    mode: "OFFLINE_TEST",
    fakeClient: {
      async send() {
        sends++;
        return META;
      },
    },
  });
  let store = await DurableAcquisitionStore.acquire(root);
  await store.saveSnapshot(plan, seed);
  await store.release();
  store = await DurableAcquisitionStore.acquire(root, { faultAt: "C_AFTER_MAY_HAVE_BEEN_SENT" });
  const run = () => runDukascopyInventory({ plan, approval: approved, previous: seed, store, session });
  try {
    await assert.rejects(run, (error) => error instanceof SimulatedInventoryCrash && error.boundary === "C_AFTER_MAY_HAVE_BEEN_SENT");
    await store.release();
    store = await DurableAcquisitionStore.acquire(root, { faultAt: "B_AFTER_RESERVED_EVENT" });
    await assert.rejects(run, (error) => error instanceof SimulatedInventoryCrash && error.boundary === "B_AFTER_RESERVED_EVENT");
    assert.equal(sends, 0);
    assert.equal((await store.ledger(plan))?.totals.headAttempts, 1);
    assert.equal((await store.headAttemptJournal()).length, 2);
    await store.release();
    store = await DurableAcquisitionStore.acquire(root);
    const snapshot = await run();
    assert.equal(snapshot.entries.find((entry) => entry.key === KEY)?.status, "PRESENT");
    assert.equal(sends, 1);
    const ledger = (await store.ledger(plan))!;
    assert.equal(ledger.totals.headAttempts, 2);
    assert.equal(ledger.attempts[`HEAD:${KEY}`], 2);
    assert.equal(ledger.contexts[approved.id].counters.recoveryHeadAttempts, 1);
    assert.equal(Object.keys(ledger.headAttemptAccounting ?? {}).length, 2);
  } finally {
    await store.release();
    session.destroy();
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLASSIFIED reconciliation is idempotent and terminal conflicts fail closed", async () => {
  const root = temporaryRoot();
  const plan = await createFrozenDukascopyPlan();
  const seed = createInventorySnapshot(plan, []);
  const approved = approval(plan, "INVENTORY", seed.revision, [KEY]);
  const sends = { count: 0 };
  const session = new DukascopyS3Session({
    mode: "OFFLINE_TEST",
    fakeClient: {
      async send() {
        sends.count++;
        return META;
      },
    },
  });
  let store = await DurableAcquisitionStore.acquire(root, { faultAt: "E_AFTER_CLASSIFIED" });
  try {
    await store.saveSnapshot(plan, seed);
    const run = () => runDukascopyInventory({ plan, approval: approved, previous: seed, store, session });
    await assert.rejects(run, (error) => error instanceof SimulatedInventoryCrash && error.boundary === "E_AFTER_CLASSIFIED");
    await store.release();
    store = await DurableAcquisitionStore.acquire(root);
    await store.reconcileHeadAttempts(plan, approved, seed);
    const ledgerAfterFirst = (await store.ledger(plan))!;
    const progressPath = `progress/${createHash("sha256")
      .update(JSON.stringify(`${approved.id}:${KEY}`))
      .digest("hex")}.json`;
    const firstProgress = await store.readDocument<{ entry: InventoryEntry }>(progressPath);
    await store.reconcileHeadAttempts(plan, approved, seed);
    assert.deepEqual(await store.readDocument(progressPath), firstProgress);
    const ledgerAfterSecond = (await store.ledger(plan))!;
    assert.equal(ledgerAfterSecond.totals.headAttempts, ledgerAfterFirst.totals.headAttempts);
    assert.equal(ledgerAfterSecond.totals.failedAttempts, ledgerAfterFirst.totals.failedAttempts);
    assert.deepEqual((await store.headAttemptJournal())[0].classification, firstProgress?.entry);
    const resumed = await run();
    assert.equal(resumed.entries.find((entry) => entry.key === KEY)?.status, "PRESENT");
    assert.equal(sends.count, 1);

    const terminalEntries = [...seed.entries];
    terminalEntries[plan.keys.indexOf(KEY)] = { ...seed.entries[plan.keys.indexOf(KEY)], status: "CONFIRMED_ABSENT", checkedAt: "2026-10-07T00:00:00.000Z", attempts: 1 };
    const terminalSeed = createInventorySnapshot(plan, terminalEntries);
    const conflictingApproval: AcquisitionApproval = { ...approval(plan, "INVENTORY", terminalSeed.revision, [KEY]), id: "approval-INVENTORY-terminal-conflict", batchId: "batch-terminal-conflict" };
    await assert.rejects(
      () => store.gate(plan, conflictingApproval, terminalSeed),
      (error) => error instanceof AcquisitionSafetyError && error.code === "APPROVAL_VIOLATION",
    );
    assert.equal(sends.count, 1);
  } finally {
    await store.release();
    session.destroy();
    rmSync(root, { recursive: true, force: true });
  }
});

test("child approval must bind the exact snapshot containing prior child terminal results", async () => {
  const root = temporaryRoot();
  const plan = await createFrozenDukascopyPlan();
  const seed = createInventorySnapshot(plan, []);
  const firstApproval: AcquisitionApproval = { ...approval(plan, "INVENTORY", seed.revision, [KEY]), id: "campaign-child-one", batchId: "campaign-child-one" };
  const store = await DurableAcquisitionStore.acquire(root);
  try {
    await store.saveSnapshot(plan, seed);
    const firstGate = await store.gate(plan, firstApproval, seed);
    const reservation = await firstGate.before("HEAD", KEY, 0);
    assert.ok(reservation);
    await firstGate.markHeadMayHaveBeenSent(reservation.attemptId);
    await firstGate.classifyHead(reservation.attemptId, presentEntry());
    await firstGate.success("HEAD", KEY);
    await store.saveInventoryEntry(plan, firstApproval, presentEntry());

    const childTwoWithoutBoundResult: AcquisitionApproval = { ...approval(plan, "INVENTORY", null, [KEY]), id: "campaign-child-two-unbound", batchId: "campaign-child-two" };
    await assert.rejects(
      () => store.gate(plan, childTwoWithoutBoundResult),
      (error) => error instanceof AcquisitionSafetyError && error.code === "APPROVAL_VIOLATION",
    );

    const resolvedEntries = [...seed.entries];
    resolvedEntries[plan.keys.indexOf(KEY)] = presentEntry();
    const revisionOne = createInventorySnapshot(plan, resolvedEntries);
    await store.saveSnapshot(plan, revisionOne);
    const childTwo: AcquisitionApproval = { ...childTwoWithoutBoundResult, id: "campaign-child-two-bound", inventoryRevision: revisionOne.revision };
    const childGate = await store.gate(plan, childTwo, revisionOne);
    const attemptsBefore = (await store.ledger(plan))!.totals.headAttempts;
    await assert.rejects(
      () => childGate.before("HEAD", KEY, 0),
      (error) => error instanceof AcquisitionSafetyError && error.code === "APPROVAL_VIOLATION",
    );
    assert.equal((await store.ledger(plan))!.totals.headAttempts, attemptsBefore);
    assert.equal(revisionOne.entries[plan.keys.indexOf(KEY)].status, "PRESENT");
  } finally {
    await store.release();
    rmSync(root, { recursive: true, force: true });
  }
});

test("child approval reconciles prior indeterminate attempt before explicit recovery retry", async () => {
  const root = temporaryRoot();
  const plan = await createFrozenDukascopyPlan();
  const seed = createInventorySnapshot(plan, []);
  const caps = { maxHeadAttempts: 2, maxGetAttempts: 0, maxNetworkBytes: 0, maxVerifiedBytes: 0, maxObjects: 1, maxRetries: 0 };
  const childOne: AcquisitionApproval = { ...approval(plan, "INVENTORY", seed.revision, [KEY]), id: "campaign-crash-child-one", batchId: "campaign-crash-child-one", caps: { ...caps }, globalCaps: { ...caps } };
  const childTwo: AcquisitionApproval = { ...childOne, id: "campaign-crash-child-two", batchId: "campaign-crash-child-two", recoveryAllowance: { maxIndeterminateHeadRetries: 1 } };
  let store = await DurableAcquisitionStore.acquire(root);
  try {
    await store.saveSnapshot(plan, seed);
    const firstGate = await store.gate(plan, childOne, seed);
    const first = await firstGate.before("HEAD", KEY, 0);
    assert.equal(first?.kind, "INITIAL");
    await firstGate.markHeadMayHaveBeenSent(first!.attemptId);
    await store.release();
    store = await DurableAcquisitionStore.acquire(root);
    const recoveryGate = await store.gate(plan, childTwo, seed);
    const recovery = await recoveryGate.before("HEAD", KEY, 0);
    assert.equal(recovery?.kind, "INDETERMINATE_RECOVERY");
    assert.equal((await store.ledger(plan))?.totals.headAttempts, 2);
    await recoveryGate.markHeadMayHaveBeenSent(recovery!.attemptId);
    await recoveryGate.classifyHead(recovery!.attemptId, presentEntry());
    await recoveryGate.success("HEAD", KEY);
    await store.saveInventoryEntry(plan, childTwo, presentEntry());
    const ledger = (await store.ledger(plan))!;
    assert.equal(ledger.contexts[childOne.id].counters.headAttempts, 1);
    assert.equal(ledger.contexts[childTwo.id].counters.recoveryHeadAttempts, 1);
    assert.equal(ledger.attempts[`HEAD:${KEY}`], 2);
    assert.equal(ledger.totals.headAttempts, 2);
  } finally {
    await store.release();
    rmSync(root, { recursive: true, force: true });
  }
});

test("V1 ledger without journal extensions loads without resetting accounting", async () => {
  const root = temporaryRoot();
  const plan = await createFrozenDukascopyPlan();
  const approved = approval(plan);
  const store = await DurableAcquisitionStore.acquire(root);
  try {
    const gate = await store.gate(plan, approved);
    const reservation = await gate.before("HEAD", KEY, 0);
    assert.ok(reservation);
    await gate.markHeadMayHaveBeenSent(reservation.attemptId);
    await gate.classifyHead(reservation.attemptId, { key: KEY, utcDay: "2025-01-06", status: "ERROR", metadata: null, checkedAt: "2026-10-07T00:00:00.000Z", attempts: 1, error: "TRANSIENT" });
    await gate.failure("HEAD", KEY, "TRANSIENT");
    await store.release();
    const wrapper = JSON.parse(readFileSync(join(root, "ledger.json"), "utf8"));
    delete wrapper.data.headAttemptAccounting;
    delete wrapper.data.campaignHeadAttempts;
    delete wrapper.data.totals.recoveryHeadAttempts;
    delete wrapper.data.contexts[approved.id].counters.recoveryHeadAttempts;
    rmSync(join(root, "head-attempts"), { recursive: true, force: true });
    writeFileSync(join(root, "ledger.json"), JSON.stringify({ hash: createHash("sha256").update(JSON.stringify(wrapper.data)).digest("hex"), data: wrapper.data }));
    const resumedStore = await DurableAcquisitionStore.acquire(root);
    try {
      const loaded = await resumedStore.ledger(plan);
      assert.equal(loaded?.version, "DUKASCOPY_DURABLE_V1");
      assert.equal(loaded?.totals.headAttempts, 1);
      assert.equal(loaded?.attempts[`HEAD:${KEY}`], 1);
      await resumedStore.gate(plan, approved);
      const reconciled = await resumedStore.ledger(plan);
      assert.equal(reconciled?.totals.headAttempts, 1);
      assert.equal(reconciled?.globalCaps.maxHeadAttempts, approved.globalCaps.maxHeadAttempts);
    } finally {
      await resumedStore.release();
    }
  } finally {
    await store.release().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
});

test("V1 active HEAD migrates to indeterminate and consumes explicit recovery allowance", async () => {
  const root = temporaryRoot();
  const plan = await createFrozenDukascopyPlan();
  const approved = approval(plan, "INVENTORY", null, [KEY]);
  approved.caps.maxHeadAttempts = 3;
  approved.caps.maxRetries = 0;
  approved.globalCaps = { ...approved.caps };
  approved.recoveryAllowance = { maxIndeterminateHeadRetries: 1 };
  let store = await DurableAcquisitionStore.acquire(root);
  try {
    await store.gate(plan, approved);
    await store.release();
    const wrapper = JSON.parse(readFileSync(join(root, "ledger.json"), "utf8"));
    delete wrapper.data.headAttemptAccounting;
    delete wrapper.data.campaignHeadAttempts;
    delete wrapper.data.legacyIndeterminateHeadKeys;
    delete wrapper.data.totals.recoveryHeadAttempts;
    delete wrapper.data.contexts[approved.id].counters.recoveryHeadAttempts;
    wrapper.data.attempts[`HEAD:${KEY}`] = 1;
    wrapper.data.totals.headAttempts = 1;
    wrapper.data.contexts[approved.id].counters.headAttempts = 1;
    wrapper.data.active = { operation: "HEAD", key: KEY, approvalId: approved.id };
    writeFileSync(join(root, "ledger.json"), JSON.stringify({ hash: createHash("sha256").update(JSON.stringify(wrapper.data)).digest("hex"), data: wrapper.data }));
    store = await DurableAcquisitionStore.acquire(root);
    const gate = await store.gate(plan, approved);
    const migrated = (await store.ledger(plan))!;
    assert.equal(migrated.active, null);
    assert.equal(migrated.attempts[`HEAD:${KEY}`], 1);
    assert.equal(migrated.totals.headAttempts, 1);
    assert.equal(migrated.legacyIndeterminateHeadKeys?.[KEY]?.sequence, 1);
    const noRecoveryApproval: AcquisitionApproval = { ...approved, id: "approval-no-recovery", batchId: "batch-no-recovery" };
    delete noRecoveryApproval.recoveryAllowance;
    const noRecoveryGate = await store.gate(plan, noRecoveryApproval);
    await assert.rejects(
      () => noRecoveryGate.before("HEAD", KEY, 0),
      (error) => error instanceof AcquisitionSafetyError && error.code === "INDETERMINATE",
    );
    assert.equal((await store.ledger(plan))?.totals.headAttempts, 1);
    const reservation = await gate.before("HEAD", KEY, 0);
    assert.equal(reservation?.kind, "INDETERMINATE_RECOVERY");
    assert.equal((await store.ledger(plan))?.totals.headAttempts, 2);
    await gate.markHeadMayHaveBeenSent(reservation!.attemptId);
    await gate.classifyHead(reservation!.attemptId, presentEntry());
    await gate.success("HEAD", KEY);
    await store.saveInventoryEntry(plan, approved, presentEntry());
    const settled = (await store.ledger(plan))!;
    assert.equal(settled.attempts[`HEAD:${KEY}`], 2);
    assert.equal(settled.contexts[approved.id].counters.recoveryHeadAttempts, 1);
    assert.equal(settled.legacyIndeterminateHeadKeys?.[KEY], undefined);
    await assert.rejects(() => gate.before("HEAD", KEY, 0), /APPROVAL_VIOLATION/);
  } finally {
    await store.release().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
});

test("global attempt ledger survives restart and cannot reset retry count", async () => {
  const root = temporaryRoot();
  const plan = await createFrozenDukascopyPlan();
  let store = await DurableAcquisitionStore.acquire(root);
  try {
    let gate = await store.gate(plan, approval(plan));
    const runFailedHead = async () => {
      const reservation = await gate.before("HEAD", KEY, 0);
      assert.ok(reservation);
      await gate.markHeadMayHaveBeenSent(reservation.attemptId);
      await gate.classifyHead(reservation.attemptId, { key: KEY, utcDay: "2025-01-06", status: "ERROR", metadata: null, checkedAt: "2026-10-07T00:00:00.000Z", attempts: reservation.sequence, error: "TRANSIENT" });
      await gate.failure("HEAD", KEY, "TRANSIENT");
    };
    await runFailedHead();
    await store.release();
    store = await DurableAcquisitionStore.acquire(root);
    gate = await store.gate(plan, approval(plan));
    for (let attempt = 0; attempt < 2; attempt++) await runFailedHead();
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
    await assert.rejects(() => client.send(new HeadObjectCommand({ Bucket: "cfg-public-proper-wallaby", Key: KEY, RequestPayer: "requester" }), { abortSignal: new AbortController().signal }), /APPROVAL_VIOLATION/);
    await assert.rejects(() => client.send(new ListObjectsV2Command({ Bucket: "cfg-public-proper-wallaby" }) as unknown as HeadObjectCommand, { abortSignal: new AbortController().signal }), /APPROVAL_VIOLATION/);
    assert.throws(() => new DukascopyS3Session({ mode: "OFFLINE_TEST", fakeClient: client }), /APPROVAL_VIOLATION/);
    assert.throws(() => new DukascopyS3Session({ endpoint: "http://elsewhere" } as never), /APPROVAL_VIOLATION/);
  } finally {
    client.destroy();
  }
});

test("verified byte cap is visible to the next GET in the same Foundation batch", async () => {
  const root = temporaryRoot();
  const plan = await createFrozenDukascopyPlan();
  const nextKey = "USDJPY/2025/00/07_ticks.bi5";
  const snapshot = createInventorySnapshot(
    plan,
    createInventorySnapshot(plan, []).entries.map((entry) => ([KEY, nextKey].includes(entry.key) ? presentEntry(entry.key) : entry)),
  );
  const approved = approval(plan, "DOWNLOAD", snapshot.revision, [KEY, nextKey]);
  approved.caps.maxVerifiedBytes = 3;
  const store = await DurableAcquisitionStore.acquire(root, { freeBytes: async () => 1_000_000 });
  let calls = 0;
  const session = new DukascopyS3Session({
    mode: "OFFLINE_TEST",
    fakeClient: {
      async send() {
        calls++;
        return { ...META, Body: Readable.from([Buffer.from("abc")]) as GetObjectCommandOutput["Body"] };
      },
    },
  });
  try {
    await assert.rejects(() => runDukascopyDownload({ plan, snapshot, approval: approved, store, session, decode: async () => FAKE_DECODE }), /CAP_EXCEEDED/);
    assert.equal(calls, 1);
    assert.equal((await store.ledger(plan))?.totals.verifiedBytes, 3);
  } finally {
    await store.release();
    rmSync(root, { recursive: true, force: true });
  }
});

test("HEAD 200 wrong region and 404 wrong region remain unresolved errors", async () => {
  const plan = await createFrozenDukascopyPlan();
  for (const notFound of [false, true]) {
    const snapshot = await collectDukascopyInventory({
      plan,
      approval: approval(plan),
      gate: memoryGate(),
      session: new DukascopyS3Session({
        mode: "OFFLINE_TEST",
        fakeClient: {
          async send() {
            if (notFound) throw awsError("NoSuchKey", 404, "us-east-1");
            return { ...META, $response: { headers: { "x-amz-bucket-region": "us-east-1" } } };
          },
        },
      }),
    });
    assert.equal(snapshot.entries.find((entry) => entry.key === KEY)?.status, "ERROR");
  }
});

test("GET parent cancellation stops a pending body without retry", async () => {
  const plan = await createFrozenDukascopyPlan();
  const snapshot = createInventorySnapshot(
    plan,
    createInventorySnapshot(plan, []).entries.map((entry) => (entry.key === KEY ? presentEntry() : entry)),
  );
  const controller = new AbortController();
  const session = new DukascopyS3Session({
    mode: "OFFLINE_TEST",
    fakeClient: {
      async send() {
        const body = Readable.from(
          (async function* () {
            yield Buffer.from("a");
            controller.abort();
            yield Buffer.from("bc");
          })(),
        );
        return { ...META, Body: body as GetObjectCommandOutput["Body"] };
      },
    },
  });
  const instance = new DukascopyGetTransport({ plan, snapshot, approval: approval(plan, "DOWNLOAD", snapshot.revision), gate: memoryGate(), session, signal: controller.signal });
  await assert.rejects(() => consume(instance), /CANCELLED/);
});

test("network interruption preserves received bytes and retries only the incomplete attempt", async () => {
  const fixture = await runnerFixture();
  let calls = 0;
  const session = new DukascopyS3Session({
    mode: "OFFLINE_TEST",
    fakeClient: {
      async send() {
        const interrupt = ++calls === 1;
        const body = Readable.from(
          (async function* () {
            yield Buffer.from("a");
            if (interrupt) throw Object.assign(new Error("interrupted"), { code: "ECONNRESET" });
            yield Buffer.from("bc");
          })(),
        );
        return { ...META, Body: body as GetObjectCommandOutput["Body"] };
      },
    },
  });
  try {
    await runDukascopyDownload({ ...fixture, session, backoff: async () => {} });
    const ledger = await fixture.store.ledger(fixture.plan);
    assert.equal(calls, 2);
    assert.equal(ledger?.totals.receivedBytes, 4);
    assert.equal(ledger?.totals.reservedBytes, 6);
  } finally {
    await fixture.store.release();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("global object and reservation caps apply across different approvals and restarts", async () => {
  for (const kind of ["objects", "bytes"] as const) {
    const root = temporaryRoot();
    const plan = await createFrozenDukascopyPlan();
    const nextKey = "USDJPY/2025/00/07_ticks.bi5";
    const snapshot = createInventorySnapshot(
      plan,
      createInventorySnapshot(plan, []).entries.map((entry) => ([KEY, nextKey].includes(entry.key) ? presentEntry(entry.key) : entry)),
    );
    const first = approval(plan, "DOWNLOAD", snapshot.revision);
    first.globalCaps.maxObjects = kind === "objects" ? 1 : 1826;
    first.globalCaps.maxNetworkBytes = kind === "bytes" ? 3 : 1_000_000;
    const second = { ...first, id: "second-approval", batchId: "second-batch", keys: [nextKey] };
    let store = await DurableAcquisitionStore.acquire(root, { freeBytes: async () => 1_000_000 });
    try {
      const gate = await store.gate(plan, first, snapshot);
      await gate.before("GET", KEY, 3);
      await gate.received(KEY, 3);
      await gate.success("GET", KEY);
      await store.release();
      store = await DurableAcquisitionStore.acquire(root, { freeBytes: async () => 1_000_000 });
      const resumed = await store.gate(plan, second, snapshot);
      await assert.rejects(() => resumed.before("GET", nextKey, 3), /CAP_EXCEEDED/);
      assert.equal((await store.ledger(plan))?.totals.getAttempts, 1);
    } finally {
      await store.release();
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("inventory progress resumes without repeated HEAD under the same bound approval", async () => {
  const root = temporaryRoot();
  const plan = await createFrozenDukascopyPlan();
  let store = await DurableAcquisitionStore.acquire(root);
  let calls = 0;
  const session = new DukascopyS3Session({
    mode: "OFFLINE_TEST",
    fakeClient: {
      async send() {
        calls++;
        return META;
      },
    },
  });
  const approved = approval(plan);
  try {
    await runDukascopyInventory({ plan, approval: approved, store, session });
    await store.release();
    store = await DurableAcquisitionStore.acquire(root);
    await runDukascopyInventory({ plan, approval: approved, store, session });
    assert.equal(calls, 1);
    await assert.rejects(() => runDukascopyInventory({ plan, approval: { ...approved, keys: [KEY, KEY] }, store, session }), /APPROVAL_VIOLATION/);
  } finally {
    await store.release();
    rmSync(root, { recursive: true, force: true });
  }
});

test("plan/revision mismatch and unapproved exact keys reject before GET", async () => {
  const fixture = await runnerFixture();
  try {
    await assert.rejects(() => runDukascopyDownload({ ...fixture, approval: { ...fixture.approval, inventoryRevision: "0".repeat(64) } }), /APPROVAL_VIOLATION/);
    await assert.rejects(() => runDukascopyDownload({ ...fixture, snapshot: { ...fixture.snapshot, revision: "0".repeat(64) } }), /APPROVAL_VIOLATION/);
    const gate = await fixture.store.gate(fixture.plan, fixture.approval, fixture.snapshot);
    await assert.rejects(() => gate.before("GET", "USDJPY/2025/00/07_ticks.bi5", 3), /APPROVAL_VIOLATION/);
    assert.equal(fixture.sends(), 0);
  } finally {
    await fixture.store.release();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("explicit stale-lock reclaim retains lock evidence and rejects a live owner", async () => {
  const root = temporaryRoot();
  writeFileSync(join(root, "writer.lock"), JSON.stringify({ version: 2, pid: 2147483647, token: "dead-owner-12345678", createdAt: "2026-10-07T00:00:00.000Z", processStartedAt: "Tue Jan 1 00:00:00 2000", identityHash: "a".repeat(64) }));
  const lockBeforeInspect = readFileSync(join(root, "writer.lock"));
  assert.equal((await DurableAcquisitionStore.inspectStaleWriterLock(root)).token, "dead-owner-12345678");
  assert.ok(lockBeforeInspect.equals(readFileSync(join(root, "writer.lock"))));
  await assert.rejects(() => DurableAcquisitionStore.acquire(root), /FILESYSTEM_UNSAFE/);
  const store = await DurableAcquisitionStore.acquire(root, { staleLockToken: "dead-owner-12345678" });
  try {
    const lock = await store.readPlain<{ token: string }>("writer.lock");
    await assert.rejects(() => DurableAcquisitionStore.acquire(root, { staleLockToken: lock!.token }), /FILESYSTEM_UNSAFE/);
    assert.ok(readdirSync(join(root, "locks")).some((name) => name.startsWith("stale-")));
    const recoveryFile = readdirSync(join(root, "locks")).find((name) => name.startsWith("recovery-"));
    assert.ok(recoveryFile);
    const recovery = JSON.parse(readFileSync(join(root, "locks", recoveryFile!), "utf8"));
    assert.equal(recovery.data.previousLock.token, "dead-owner-12345678");
    assert.equal(recovery.data.reclaimedByPid, process.pid);
  } finally {
    await store.release();
    rmSync(root, { recursive: true, force: true });
  }
});

test("campaign cap expansion validates prepared immutable evidence before ledger and replays idempotently", async () => {
  const fixture = await capExpansionFixture("CAP_AFTER_AUTHORIZATION_EVIDENCE");
  let replayStore: DurableAcquisitionStore | undefined;
  try {
    const priorHash = acquisitionHash(fixture.ledger);
    await assert.rejects(
      () => fixture.store.applyTask116CampaignCapExpansion(fixture.plan, fixture.authorization),
      (error) => error instanceof SimulatedInventoryCrash && error.boundary === "CAP_AFTER_AUTHORIZATION_EVIDENCE",
    );
    const evidencePath = `cap-expansions/${fixture.authorization.authorizationId}.json`;
    assert.deepEqual(await fixture.store.readDocument(evidencePath), fixture.authorization);
    const beforeReplay = (await fixture.store.ledger(fixture.plan))!;
    assert.equal(beforeReplay.globalCaps.maxHeadAttempts, 21);
    assert.equal(beforeReplay.totals.headAttempts, 9);
    assert.deepEqual(beforeReplay.attempts, fixture.ledger.attempts);
    await fixture.store.release();
    replayStore = await DurableAcquisitionStore.acquire(fixture.root);
    assert.equal(await replayStore.applyTask116CampaignCapExpansion(fixture.plan, fixture.authorization), "APPLIED");
    const expanded = (await replayStore.ledger(fixture.plan))!;
    assert.equal(expanded.globalCaps.maxHeadAttempts, 44);
    assert.equal(expanded.ledgerGeneration, 1);
    assert.equal(expanded.totals.headAttempts, 9);
    assert.deepEqual(expanded.attempts, fixture.ledger.attempts);
    assert.deepEqual(expanded.globalCaps, fixture.authorization.newGlobalCaps);
    assert.equal(expanded.campaignBudgets?.[fixture.authorization.campaignId].normalHeadBudget, 30);
    assert.equal(expanded.campaignBudgets?.[fixture.authorization.campaignId].recoveryHeadBudget, 5);
    assert.equal(acquisitionHash(fixture.ledger), priorHash);
    const committedHash = acquisitionHash(expanded);
    assert.equal(await replayStore.applyTask116CampaignCapExpansion(fixture.plan, fixture.authorization), "ALREADY_APPLIED");
    assert.equal(acquisitionHash((await replayStore.ledger(fixture.plan))!), committedHash);
    const evidenceWrapper = JSON.parse(readFileSync(join(fixture.root, evidencePath), "utf8"));
    assert.equal(evidenceWrapper.hash, acquisitionHash(fixture.authorization));
  } finally {
    await replayStore?.release();
    await fixture.cleanup();
  }
});

test("cap expansion rejects missing, mismatched and non-monotonic authorizations", async () => {
  const fixture = await capExpansionFixture();
  try {
    await assert.rejects(
      () => fixture.store.applyTask116CampaignCapExpansion(fixture.plan, undefined),
      (error) => error instanceof AcquisitionSafetyError && error.code === "APPROVAL_VIOLATION",
    );
    const invalid = [
      { authorizationId: "../unsafe" },
      { campaignId: "other-campaign" },
      { priorLedgerHash: "0".repeat(64) },
      { oldMaxHeadAttempts: 20 },
      { oldGlobalCaps: { ...fixture.ledger.globalCaps, maxHeadAttempts: 20 } },
      { newMaxHeadAttempts: 43, newGlobalCaps: { ...fixture.authorization.newGlobalCaps, maxHeadAttempts: 43 } },
      { newGlobalCaps: { ...fixture.authorization.newGlobalCaps, maxGetAttempts: 1 } },
      { operatorApprovalHash: "bad" },
      { expiresAt: "2020-01-01T00:00:00.000Z" },
      { masterPlanHash: "0".repeat(64) },
      { instrument: "EURUSD" },
      { bucket: "other-bucket" },
      { region: "us-east-1" },
      { requesterPays: false },
      { children: fixture.authorization.children.slice(1) },
    ];
    for (const change of invalid)
      await assert.rejects(
        () => fixture.store.applyTask116CampaignCapExpansion(fixture.plan, { ...fixture.authorization, ...change } as CampaignCapExpansionAuthorization),
        (error) => error instanceof AcquisitionSafetyError,
      );
    const ledger = (await fixture.store.ledger(fixture.plan))!;
    assert.equal(ledger.globalCaps.maxHeadAttempts, 21);
    assert.equal(ledger.ledgerGeneration ?? 0, 0);
    assert.equal(readdirSync(join(fixture.root, "cap-expansions")).length, 1);
  } finally {
    await fixture.cleanup();
  }
});

test("cap expansion refuses to apply an authorization without prepared immutable evidence", async () => {
  const fixture = await capExpansionFixture();
  try {
    unlinkSync(join(fixture.root, "cap-expansions", `${fixture.authorization.authorizationId}.json`));
    const before = readFileSync(join(fixture.root, "ledger.json"));
    await assert.rejects(() => fixture.store.applyTask116CampaignCapExpansion(fixture.plan, fixture.authorization), /APPROVAL_VIOLATION/);
    assert.ok(before.equals(readFileSync(join(fixture.root, "ledger.json"))));
    assert.equal(readdirSync(join(fixture.root, "cap-expansions")).length, 0);
  } finally {
    await fixture.cleanup();
  }
});

test("campaign child rejects campaign/global caps/full-key/revision/operation-scope mismatch", async () => {
  const fixture = await capExpansionFixture();
  try {
    await fixture.store.applyTask116CampaignCapExpansion(fixture.plan, fixture.authorization);
    const ledger = (await fixture.store.ledger(fixture.plan))!;
    const child = fixture.authorization.children[0];
    const prepared = await preparedCampaignTestApproval(fixture.store, fixture.plan, child, fixture.seed.revision, "campaign-child-validation");
    fixture.store = prepared.store;
    const valid = prepared.approval;
    const invalid = [{ campaignId: "other-campaign" }, { globalCaps: { ...ledger.globalCaps, maxHeadAttempts: 43 } }, { keys: child.keys.slice(1) }, { inventoryRevision: "0".repeat(64) }, { caps: { ...valid.caps, maxObjects: 6 } }, { caps: { ...valid.caps, maxRetries: 1 } }, { caps: { ...valid.caps, maxGetAttempts: 1 } }];
    for (const change of invalid) {
      const candidate = { ...valid, ...change, id: `campaign-child-invalid-${invalid.indexOf(change)}` } as AcquisitionApproval;
      await assert.rejects(
        () => fixture.store.gate(fixture.plan, candidate, fixture.seed),
        (error) => error instanceof AcquisitionSafetyError,
      );
    }
    const after = (await fixture.store.ledger(fixture.plan))!;
    assert.equal(after.campaignBudgets?.[fixture.authorization.campaignId].normalHeadAttempts, 0);
    assert.equal(after.totals.headAttempts, 9);
  } finally {
    await fixture.cleanup();
  }
});

test("cap expansion replay after ledger commit is a no-op", async () => {
  const fixture = await capExpansionFixture("CAP_AFTER_LEDGER_COMMIT");
  let replayStore: DurableAcquisitionStore | undefined;
  try {
    await assert.rejects(
      () => fixture.store.applyTask116CampaignCapExpansion(fixture.plan, fixture.authorization),
      (error) => error instanceof SimulatedInventoryCrash && error.boundary === "CAP_AFTER_LEDGER_COMMIT",
    );
    const afterCommit = (await fixture.store.ledger(fixture.plan))!;
    assert.equal(afterCommit.globalCaps.maxHeadAttempts, 44);
    assert.equal(afterCommit.ledgerGeneration, 1);
    assert.equal(afterCommit.totals.headAttempts, 9);
    const commitHash = acquisitionHash(afterCommit);
    await fixture.store.release();
    replayStore = await DurableAcquisitionStore.acquire(fixture.root);
    assert.equal(await replayStore.applyTask116CampaignCapExpansion(fixture.plan, fixture.authorization), "ALREADY_APPLIED");
    const afterReplay = (await replayStore.ledger(fixture.plan))!;
    assert.equal(acquisitionHash(afterReplay), commitHash);
    assert.deepEqual(afterReplay.attempts, fixture.ledger.attempts);
  } finally {
    await replayStore?.release();
    await fixture.cleanup();
  }
});

test("campaign rejects a 31st normal HEAD without reserving it", async () => {
  const fixture = await capExpansionFixture();
  try {
    assert.equal(await fixture.store.applyTask116CampaignCapExpansion(fixture.plan, fixture.authorization), "APPLIED");
    const child = fixture.authorization.children[0];
    const prepared = await preparedCampaignTestApproval(fixture.store, fixture.plan, child, fixture.seed.revision, "campaign-normal-budget-31");
    fixture.store = prepared.store;
    const gate = await fixture.store.gate(fixture.plan, prepared.approval, fixture.seed);
    const ledger = (await fixture.store.ledger(fixture.plan))!;
    const campaign = ledger.campaignBudgets![fixture.authorization.campaignId];
    campaign.normalHeadAttempts = 30;
    ledger.totals.headAttempts = 39;
    ledger.campaignHeadAttempts ??= {};
    ledger.campaignHeadAttempts![fixture.authorization.campaignId] = 30;
    await fixture.store.document("ledger.json", ledger);
    const priorKeyAttempts = ledger.attempts[`HEAD:${child.keys[0]}`] ?? 0;
    await assert.rejects(
      () => gate.before("HEAD", child.keys[0], 0),
      (error) => error instanceof AcquisitionSafetyError && error.code === "CAP_EXCEEDED",
    );
    const stopped = (await fixture.store.ledger(fixture.plan))!;
    assert.equal(stopped.campaignBudgets?.[fixture.authorization.campaignId].status, "STOPPED");
    assert.equal(stopped.totals.headAttempts, 39);
    assert.equal(stopped.attempts[`HEAD:${child.keys[0]}`] ?? 0, priorKeyAttempts);
    assert.equal((await fixture.store.headAttemptJournal()).length, 0);
  } finally {
    await fixture.cleanup();
  }
});

test("campaign rejects a sixth recovery HEAD without borrowing normal budget", async () => {
  const fixture = await capExpansionFixture();
  let store = fixture.store;
  try {
    await store.applyTask116CampaignCapExpansion(fixture.plan, fixture.authorization);
    const child = fixture.authorization.children[0];
    const prepared = await preparedCampaignTestApproval(store, fixture.plan, child, fixture.seed.revision, "campaign-recovery-budget-six");
    store = prepared.store;
    const approval = prepared.approval;
    let gate = await store.gate(fixture.plan, approval, fixture.seed);
    const initial = await gate.before("HEAD", child.keys[0], 0);
    assert.equal(initial?.kind, "INITIAL");
    await gate.markHeadMayHaveBeenSent(initial!.attemptId);
    await store.release();
    store = await DurableAcquisitionStore.acquire(fixture.root);
    const ledger = (await store.ledger(fixture.plan))!;
    const campaign = ledger.campaignBudgets![fixture.authorization.campaignId];
    campaign.normalHeadAttempts = 1;
    campaign.recoveryHeadAttempts = 5;
    ledger.totals.headAttempts = 15;
    ledger.totals.recoveryHeadAttempts = 5;
    ledger.campaignHeadAttempts![fixture.authorization.campaignId] = 6;
    await store.document("ledger.json", ledger);
    gate = await store.gate(fixture.plan, approval, fixture.seed);
    await assert.rejects(
      () => gate.before("HEAD", child.keys[0], 0),
      (error) => error instanceof AcquisitionSafetyError && error.code === "CAP_EXCEEDED",
    );
    const stopped = (await store.ledger(fixture.plan))!;
    assert.equal(stopped.campaignBudgets?.[fixture.authorization.campaignId].status, "STOPPED");
    assert.equal(stopped.campaignBudgets?.[fixture.authorization.campaignId].normalHeadAttempts, 1);
    assert.equal(stopped.campaignBudgets?.[fixture.authorization.campaignId].recoveryHeadAttempts, 5);
    assert.equal(stopped.attempts[`HEAD:${child.keys[0]}`], 1);
    assert.equal((await store.headAttemptJournal()).length, 1);
  } finally {
    await store.release().catch(() => {});
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("isolated 21-to-44 campaign runs five explicitly bound children within 30+5 allocation", async () => {
  const fixture = await capExpansionFixture();
  let store = fixture.store;
  let snapshot = fixture.seed;
  let sends = 0;
  const session = new DukascopyS3Session({
    mode: "OFFLINE_TEST",
    fakeClient: {
      async send(command) {
        assert.ok(command instanceof HeadObjectCommand);
        sends++;
        return META;
      },
    },
  });
  try {
    assert.equal(await store.applyTask116CampaignCapExpansion(fixture.plan, fixture.authorization), "APPLIED");
    const authChildren = fixture.authorization.children;
    for (const child of authChildren) {
      const prepared = await preparedCampaignTestApproval(store, fixture.plan, child, snapshot.revision, `approval-child-${child.sequence}`);
      store = prepared.store;
      const childApproval = prepared.approval;
      assert.equal(childApproval.keys.length <= 7, true);
      assert.equal(childApproval.caps.maxObjects, childApproval.keys.length);
      assert.equal(childApproval.caps.maxRetries, 0);
      assert.equal(childApproval.recoveryAllowance?.maxIndeterminateHeadRetries, 1);
      assert.equal(childApproval.caps.maxGetAttempts + childApproval.caps.maxNetworkBytes + childApproval.caps.maxVerifiedBytes, 0);
      await store.release();
      store = await DurableAcquisitionStore.acquire(fixture.root, { faultAt: "C_AFTER_MAY_HAVE_BEEN_SENT" });
      const run = () => runDukascopyInventory({ plan: fixture.plan, approval: childApproval, previous: snapshot, store, session, backoff: async () => {} });
      await assert.rejects(run, (error) => error instanceof SimulatedInventoryCrash && error.boundary === "C_AFTER_MAY_HAVE_BEEN_SENT");
      await store.release();
      store = await DurableAcquisitionStore.acquire(fixture.root);
      snapshot = await run();
      assert.ok(snapshot.entries.filter((entry) => child.keys.includes(entry.key)).every((entry) => entry.status === "PRESENT" || entry.status === "CONFIRMED_ABSENT"));
      const campaign = (await store.ledger(fixture.plan))!.campaignBudgets![fixture.authorization.campaignId];
      assert.equal(
        campaign.normalHeadAttempts,
        authChildren.slice(0, child.sequence).reduce((sum, item) => sum + item.keys.length, 0),
      );
      assert.equal(campaign.recoveryHeadAttempts, child.sequence);
      assert.equal(campaign.currentInventoryRevision, snapshot.revision);
      assert.equal(campaign.children[child.sequence - 1].status, "COMPLETED");
    }
    const expanded = (await store.ledger(fixture.plan))!;
    const campaign = expanded.campaignBudgets![fixture.authorization.campaignId];
    assert.equal(campaign.status, "COMPLETED");
    assert.equal(campaign.normalHeadAttempts, 30);
    assert.equal(campaign.recoveryHeadAttempts, 5);
    assert.equal(expanded.totals.headAttempts, 44);
    assert.equal(expanded.campaignHeadAttempts?.[fixture.authorization.campaignId], 35);
    assert.equal(expanded.globalCaps.maxHeadAttempts, 44);
    assert.equal(sends, 30);
    for (const child of campaign.children) assert.equal(child.status, "COMPLETED");
  } finally {
    await store.release();
    session.destroy();
    await fixture.cleanup();
  }
});

test("campaign ERROR stops progression and rejects the following child", async () => {
  const fixture = await capExpansionFixture();
  let store = fixture.store;
  const session = new DukascopyS3Session({
    mode: "OFFLINE_TEST",
    fakeClient: {
      async send() {
        throw awsError("AccessDenied", 403);
      },
    },
  });
  try {
    await store.applyTask116CampaignCapExpansion(fixture.plan, fixture.authorization);
    const child1 = fixture.authorization.children[0];
    const prepared = await preparedCampaignTestApproval(store, fixture.plan, child1, fixture.seed.revision, "campaign-error-child-one");
    store = prepared.store;
    const approval1 = prepared.approval;
    const snapshot = await runDukascopyInventory({ plan: fixture.plan, approval: approval1, previous: fixture.seed, store, session });
    assert.equal(snapshot.entries[fixture.plan.keys.indexOf(child1.keys[0])].status, "AMBIGUOUS_ACCESS");
    let campaign = (await store.ledger(fixture.plan))!.campaignBudgets![fixture.authorization.campaignId];
    assert.equal(campaign.status, "STOPPED");
    assert.equal(campaign.stopReason, "ERROR");
    assert.equal(campaign.currentChildSequence, 1);
    const child2 = fixture.authorization.children[1];
    const approval2 = campaignTestApproval(fixture.plan, child2, snapshot.revision, (await store.ledger(fixture.plan))!.globalCaps, "campaign-error-child-two");
    await assert.rejects(
      () => store.gate(fixture.plan, approval2, snapshot),
      (error) => error instanceof AcquisitionSafetyError && error.code === "APPROVAL_VIOLATION",
    );
    campaign = (await store.ledger(fixture.plan))!.campaignBudgets![fixture.authorization.campaignId];
    assert.equal(campaign.currentChildSequence, 1);
    assert.equal(campaign.children[1].status, "PENDING");
  } finally {
    await store.release();
    session.destroy();
    await fixture.cleanup();
  }
});

test("exhausted indeterminate recovery stops campaign before following child", async () => {
  const fixture = await capExpansionFixture();
  let store = fixture.store;
  const session = new DukascopyS3Session({
    mode: "OFFLINE_TEST",
    fakeClient: {
      async send() {
        return META;
      },
    },
  });
  try {
    await store.applyTask116CampaignCapExpansion(fixture.plan, fixture.authorization);
    const child1 = fixture.authorization.children[0];
    const prepared = await preparedCampaignTestApproval(store, fixture.plan, child1, fixture.seed.revision, "campaign-indeterminate-child-one");
    store = prepared.store;
    const approval1 = prepared.approval;
    const run = () => runDukascopyInventory({ plan: fixture.plan, approval: approval1, previous: fixture.seed, store, session });
    await store.release();
    store = await DurableAcquisitionStore.acquire(fixture.root, { faultAt: "C_AFTER_MAY_HAVE_BEEN_SENT" });
    await assert.rejects(run, (error) => error instanceof SimulatedInventoryCrash && error.boundary === "C_AFTER_MAY_HAVE_BEEN_SENT");
    await store.release();
    store = await DurableAcquisitionStore.acquire(fixture.root, { faultAt: "C_AFTER_MAY_HAVE_BEEN_SENT" });
    await assert.rejects(run, (error) => error instanceof SimulatedInventoryCrash && error.boundary === "C_AFTER_MAY_HAVE_BEEN_SENT");
    await store.release();
    store = await DurableAcquisitionStore.acquire(fixture.root);
    const stoppedSnapshot = await run();
    assert.equal(stoppedSnapshot.entries[fixture.plan.keys.indexOf(child1.keys[0])].error, "INDETERMINATE");
    const ledger = (await store.ledger(fixture.plan))!;
    const campaign = ledger.campaignBudgets![fixture.authorization.campaignId];
    assert.equal(campaign.status, "STOPPED");
    assert.equal(campaign.stopReason, "INDETERMINATE");
    assert.equal(campaign.currentChildSequence, 1);
    assert.equal(ledger.totals.headAttempts, 11);
    const child2 = fixture.authorization.children[1];
    const approval2 = campaignTestApproval(fixture.plan, child2, fixture.seed.revision, ledger.globalCaps, "campaign-indeterminate-child-two");
    await assert.rejects(
      () => store.gate(fixture.plan, approval2, fixture.seed),
      (error) => error instanceof AcquisitionSafetyError && error.code === "APPROVAL_VIOLATION",
    );
    assert.equal((await store.ledger(fixture.plan))!.totals.headAttempts, 11);
  } finally {
    await store.release().catch(() => {});
    session.destroy();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("stale-lock recovery rejects PID reuse or unverifiable live process identity", async () => {
  const root = temporaryRoot();
  writeFileSync(join(root, "writer.lock"), JSON.stringify({ version: 2, pid: process.pid, token: "reused-pid", createdAt: new Date().toISOString(), processStartedAt: "Tue Jan 1 00:00:00 2000", identityHash: "0".repeat(64) }));
  try {
    await assert.rejects(() => DurableAcquisitionStore.acquire(root, { staleLockToken: "reused-pid" }), /FILESYSTEM_UNSAFE/);
    assert.ok(readdirSync(root).includes("writer.lock"));
    assert.deepEqual(readdirSync(join(root, "locks")), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("FULL_OBJECT checksum mismatch stops and retains raw without a second download", async () => {
  const fixture = await runnerFixture();
  const entry = presentEntry();
  entry.metadata!.checksumType = "FULL_OBJECT";
  entry.metadata!.checksums.ChecksumSHA256 = Buffer.alloc(32).toString("base64");
  const snapshot = createInventorySnapshot(
    fixture.plan,
    fixture.snapshot.entries.map((candidate) => (candidate.key === KEY ? entry : candidate)),
  );
  try {
    await assert.rejects(() => runDukascopyDownload({ ...fixture, snapshot, approval: approval(fixture.plan, "DOWNLOAD", snapshot.revision) }), /SOURCE_CHANGED/);
    assert.equal(fixture.sends(), 1);
  } finally {
    await fixture.store.release();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("runner default decoder validates synthetic LZMA-Alone through unchanged production parser", async () => {
  const fixture = await runnerFixture();
  const record = Buffer.alloc(20);
  record.writeUInt32BE(1, 0);
  record.writeUInt32BE(157207, 4);
  record.writeUInt32BE(157198, 8);
  record.writeFloatBE(1, 12);
  record.writeFloatBE(2, 16);
  const bytes = execFileSync("xz", ["--format=lzma", "--compress", "--stdout"], { input: record });
  const entry = presentEntry();
  entry.metadata!.contentLength = bytes.length;
  const snapshot = createInventorySnapshot(
    fixture.plan,
    fixture.snapshot.entries.map((candidate) => (candidate.key === KEY ? entry : candidate)),
  );
  const session = new DukascopyS3Session({
    mode: "OFFLINE_TEST",
    fakeClient: {
      async send() {
        return { ...META, ContentLength: bytes.length, Body: Readable.from([bytes]) as GetObjectCommandOutput["Body"] };
      },
    },
  });
  try {
    const result = await runDukascopyDownload({ ...fixture, snapshot, approval: approval(fixture.plan, "DOWNLOAD", snapshot.revision), session, decode: undefined });
    assert.equal(result.checkpoint?.chunks[0].tickCount, 1);
    assert.equal(result.checkpoint?.chunks[0].decoderVersion, DUKASCOPY_BI5_ADAPTER_VERSION);
  } finally {
    await fixture.store.release();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("synthetic 1826 inventory entries, 60 batch checkpoints and persistent ledger resume scale", { timeout: 120_000 }, async (context) => {
  const root = temporaryRoot();
  const plan = await createFrozenDukascopyPlan();
  const approved = approval(plan, "INVENTORY", null, [...plan.keys]);
  let store = await DurableAcquisitionStore.acquire(root);
  const started = performance.now();
  const rssBefore = process.memoryUsage().rss;
  try {
    const gate = memoryGate();
    const snapshot = await collectDukascopyInventory({
      plan,
      approval: approved,
      gate,
      session: new DukascopyS3Session({
        mode: "OFFLINE_TEST",
        fakeClient: {
          async send() {
            return META;
          },
        },
      }),
    });
    assert.equal(snapshot.entries.length, 1826);
    assert.equal(snapshot.actualTotalBytes, 5478);
    assert.equal(gate.calls, 1826);
    await store.saveSnapshot(plan, snapshot);
    const months = new Map<string, string[]>();
    for (const entry of snapshot.entries) {
      const month = entry.utcDay.slice(0, 7);
      const keys = months.get(month) ?? [];
      keys.push(entry.key);
      months.set(month, keys);
    }
    for (const [month, keys] of months) await store.atomicPlain(`batches/${month}.json`, { planHash: plan.planHash, inventoryRevision: snapshot.revision, keys });
    await store.gate(plan, approved);
    const ledger = (await store.ledger(plan))!;
    ledger.totals.headAttempts = 1826;
    ledger.contexts[approved.id].counters.headAttempts = 1826;
    for (const key of plan.keys) ledger.attempts[`HEAD:${key}`] = 1;
    await store.document("ledger.json", ledger);
    await store.release();
    store = await DurableAcquisitionStore.acquire(root);
    assert.equal((await store.ledger(plan))?.totals.headAttempts, 1826);
    let resumedKeys = 0;
    for (const month of months.keys()) resumedKeys += (await store.readPlain<{ keys: string[] }>(`batches/${month}.json`))!.keys.length;
    assert.equal(resumedKeys, 1826);
    assert.equal(months.size, 60);
    const elapsed = performance.now() - started;
    const rssAfter = process.memoryUsage().rss;
    context.diagnostic(`SYNTHETIC_SCALE entries=1826 batches=60 elapsedMs=${Math.round(elapsed)} rssBefore=${rssBefore} rssAfter=${rssAfter} peakRssKiB=${process.resourceUsage().maxRSS}`);
    assert.ok(rssAfter - rssBefore < 256 * 1024 * 1024);
    assert.equal(createHash("sha256").update(JSON.stringify(plan.keys)).digest("hex"), DUKASCOPY_PLAN_HASH);
  } finally {
    await store.release();
    rmSync(root, { recursive: true, force: true });
  }
});
