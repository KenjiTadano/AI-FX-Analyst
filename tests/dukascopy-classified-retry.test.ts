import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, existsSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { runInventoryOperatorCli } from "../lib/backtest/dukascopy-inventory-cli";
import { acquisitionHash, createFrozenDukascopyPlan, createInventorySnapshot, DukascopyS3Session, SimulatedInventoryCrash, type InventoryCrashBoundary, type AcquisitionApproval } from "../lib/backtest/dukascopy-s3-production";
import { runDukascopyInventory, runTask116ClassifiedErrorRetry } from "../lib/backtest/dukascopy-s3-runner";
import { assertTask116ClassifiedRetryScope, buildTask116CampaignChildren, DurableAcquisitionStore, DUKASCOPY_PRODUCTION_ROOT, type ClassifiedErrorRetryAuthorization, type ClassifiedErrorRetryPreparationInput, type AcquisitionLedger, type CampaignCapExpansionAuthorization } from "../lib/backtest/dukascopy-s3-durable";

let forbiddenNetworkCalls = 0;
let realBefore: string | undefined;
const realRoot = join(process.cwd(), DUKASCOPY_PRODUCTION_ROOT);
test.before(() => {
  if (existsSync(realRoot)) realBefore = fingerprint(realRoot);
  const forbidden = () => {
    forbiddenNetworkCalls++;
    throw Error("real network forbidden in retry tests");
  };
  test.mock.method(http, "request", forbidden);
  test.mock.method(https, "request", forbidden);
  test.mock.method(net.Socket.prototype, "connect", forbidden);
  test.mock.method(tls, "connect", forbidden);
  test.mock.method(globalThis, "fetch", forbidden);
});
test.after(() => {
  assert.equal(forbiddenNetworkCalls, 0);
  if (realBefore) assert.equal(fingerprint(realRoot), realBefore);
  test.mock.restoreAll();
});

function fingerprint(root: string): string {
  return acquisitionHash(
    readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name))
      .sort()
      .map((file) => [file.slice(root.length), acquisitionHash(readFileSync(file).toString("base64"))]),
  );
}

async function fixture() {
  const projectRoot = realpathSync(mkdtempSync(join(tmpdir(), "task116-classified-retry-")));
  execFileSync("git", ["init", "--quiet", projectRoot], { stdio: "ignore" });
  writeFileSync(join(projectRoot, ".gitignore"), "/tmp/dukascopy/\n");
  const root = join(projectRoot, DUKASCOPY_PRODUCTION_ROOT);
  const plan = await createFrozenDukascopyPlan();
  const seed = createInventorySnapshot(plan, []);
  const caps = { maxHeadAttempts: 21, maxGetAttempts: 0, maxNetworkBytes: 0, maxVerifiedBytes: 0, maxObjects: 7, maxRetries: 2 };
  const legacy: AcquisitionApproval = { id: "legacy-seven", batchId: "legacy-seven", operation: "INVENTORY", planHash: plan.planHash, inventoryRevision: null, batchStart: plan.requestedStart, batchEnd: plan.requestedEnd, keys: plan.keys.slice(0, 7), caps, globalCaps: caps, minimumFreeBytes: 0, expiresAt: "2100-01-01T00:00:00.000Z" };
  const totals = { headAttempts: 9, getAttempts: 0, successfulGets: 0, failedAttempts: 0, receivedBytes: 0, reservedBytes: 0, verifiedBytes: 0, retryCount: 0, objects: [] as string[] };
  const ledger: AcquisitionLedger = {
    version: "DUKASCOPY_DURABLE_V1",
    planHash: plan.planHash,
    inventoryRevision: null,
    approvalId: legacy.id,
    batchId: legacy.batchId,
    globalCaps: caps,
    totals,
    contexts: { [legacy.id]: { bindingHash: acquisitionHash(legacy), counters: structuredClone(totals) } },
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
  const capInput = {
    authorizationId: "isolated-reviewed-cap",
    campaignId: "task116-usdjpy-20210108-20210207",
    oldGlobalCaps: caps,
    newGlobalCaps: { ...caps, maxHeadAttempts: 44 },
    campaignStart: "2021-01-08T00:00:00.000Z" as const,
    campaignEnd: "2021-02-07T00:00:00.000Z" as const,
    children: buildTask116CampaignChildren(plan),
    reason: "Reviewed isolated campaign allocation preparation.",
    authorizedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    operatorApprovalReference: "OP-CAMPAIGN-REVIEW",
    operatorApprovalHash: acquisitionHash("isolated cap evidence"),
    priorLedgerHash: acquisitionHash(ledger),
    priorLedgerGeneration: 0,
    masterPlanHash: plan.planHash,
    instrument: plan.instrument,
    bucket: plan.bucket,
    region: plan.region,
    requesterPays: true as const,
    initialInventoryRevision: seed.revision,
  };
  const preparedCap = await DurableAcquisitionStore.prepareTask116CampaignCapExpansionAuthorization(plan, capInput, { projectRoot });
  store = await DurableAcquisitionStore.acquire(root);
  await store.applyTask116CampaignCapExpansion(plan, JSON.parse(readFileSync(join(projectRoot, preparedCap.authorizationPath), "utf8")).data as CampaignCapExpansionAuthorization);
  const expanded = (await store.ledger(plan))!;
  await store.release();
  const child = buildTask116CampaignChildren(plan)[0];
  const childPrepared = await DurableAcquisitionStore.prepareTask116CampaignChildApproval(
    plan,
    {
      approvalId: "isolated-original-child",
      campaignId: capInput.campaignId,
      childSequence: 1,
      priorLedgerHash: acquisitionHash(expanded),
      priorLedgerGeneration: 1,
      inventoryRevision: seed.revision,
      masterPlanHash: plan.planHash,
      capAuthorizationId: preparedCap.authorizationId,
      capAuthorizationHash: preparedCap.authorizationHash,
      globalCaps: expanded.globalCaps,
      childDescriptorHash: acquisitionHash(child),
      instrument: plan.instrument,
      bucket: plan.bucket,
      region: plan.region,
      requesterPays: true,
      authorizedAt: capInput.authorizedAt,
      expiresAt: capInput.expiresAt,
      operatorApprovalReference: "OP-CHILD-REVIEW",
      operatorApprovalHash: acquisitionHash("isolated child evidence"),
      reason: "Reviewed isolated child approval preparation only.",
    },
    { projectRoot },
  );
  const original = JSON.parse(readFileSync(join(projectRoot, childPrepared.approvalPath), "utf8")).data as AcquisitionApproval;
  store = await DurableAcquisitionStore.acquire(root);
  const session = new DukascopyS3Session({
    mode: "OFFLINE_TEST",
    fakeClient: {
      async send() {
        throw Object.assign(new Error("sanitized fake failure"), { name: "ExpiredToken" });
      },
    },
  });
  const partial = await runDukascopyInventory({ plan, approval: original, previous: seed, store, session });
  const stopped = (await store.ledger(plan))!;
  const event = (await store.headAttemptJournal()).find((event) => event.approvalId === original.id)!;
  const progressPath = `progress/${acquisitionHash(`${original.id}:${event.key}`)}.json`;
  const progress = await store.readDocument(progressPath);
  await store.release();
  session.destroy();
  const input: ClassifiedErrorRetryPreparationInput = {
    authorizationId: "isolated-classified-replacement",
    campaignId: capInput.campaignId,
    childSequence: 1,
    failedKey: event.key,
    failedAttemptId: event.attemptId,
    failedClassifiedHash: acquisitionHash(event),
    originalApprovalId: original.id,
    originalApprovalHash: childPrepared.approvalHash,
    originalProgressHash: acquisitionHash(progress),
    priorLedgerHash: acquisitionHash(stopped),
    priorLedgerGeneration: 1,
    partialRevision: partial.revision,
    partialSnapshotHash: acquisitionHash(partial),
    currentInventoryRevision: seed.revision,
    masterPlanHash: plan.planHash,
    capAuthorizationId: preparedCap.authorizationId,
    capAuthorizationHash: preparedCap.authorizationHash,
    authorizedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    operatorApprovalReference: "OP-CLASSIFIED-RETRY-REVIEW",
    operatorApprovalHash: acquisitionHash("explicit isolated single replacement"),
    reason: "Reviewed isolated classified failure replacement only.",
  };
  return { projectRoot, root, plan, seed, partial, original, event, stopped, input, cleanup: () => rmSync(projectRoot, { recursive: true, force: true }) };
}

async function executionFixture() {
  const sample = await fixture();
  const prepared = await DurableAcquisitionStore.prepareTask116ClassifiedErrorRetryAuthorization(sample.plan, sample.input, { projectRoot: sample.projectRoot });
  let store = await DurableAcquisitionStore.acquire(sample.root);
  await store.applyTask116RetryCapAmendment(sample.plan, prepared.authorizationId, prepared.authorizationHash);
  await store.applyTask116ClassifiedErrorRetryAuthorization(sample.plan, prepared.authorizationId, prepared.authorizationHash);
  const ledger = (await store.ledger(sample.plan))!;
  await store.release();
  const approvalInput = {
    authorizationId: prepared.authorizationId,
    authorizationHash: prepared.authorizationHash,
    phase: "REPLACEMENT" as const,
    priorLedgerHash: acquisitionHash(ledger),
    priorLedgerGeneration: ledger.ledgerGeneration!,
    inventoryRevision: sample.partial.revision,
    capRevisionId: ledger.retryCapRevision!.revisionId,
    capRevisionHash: ledger.retryCapRevision!.revisionHash,
    authorizedAt: sample.input.authorizedAt,
    expiresAt: sample.input.expiresAt,
    operatorApprovalReference: "OP-REPLACEMENT-EXECUTION-REVIEW",
    operatorApprovalHash: acquisitionHash("explicit isolated replacement execution"),
    reason: "Reviewed isolated exact-key replacement execution approval.",
  };
  const checked = await DurableAcquisitionStore.prepareTask116RetryExecutionApproval(sample.plan, approvalInput, { projectRoot: sample.projectRoot, validateOnly: true });
  const approvalPrepared = await DurableAcquisitionStore.prepareTask116RetryExecutionApproval(sample.plan, approvalInput, { projectRoot: sample.projectRoot });
  assert.equal(checked.approvalHash, approvalPrepared.approvalHash);
  store = await DurableAcquisitionStore.acquire(sample.root);
  const execution = {
    approvalId: approvalPrepared.approvalId,
    approvalHash: approvalPrepared.approvalHash,
    authorizationId: prepared.authorizationId,
    authorizationHash: prepared.authorizationHash,
    inventoryRevision: sample.partial.revision,
    capRevisionId: ledger.retryCapRevision!.revisionId,
    capRevisionHash: ledger.retryCapRevision!.revisionHash,
    phase: "REPLACEMENT" as const,
  };
  return { ...sample, prepared, approvalInput, execution, store };
}

for (const result of ["PRESENT", "CONFIRMED_ABSENT", "ERROR"] as const)
  test(`classified retry replacement ${result} debits only its pool and never executes continuation`, async () => {
    const sample = await executionFixture();
    const originalBytes = readFileSync(join(sample.root, `head-attempts/${sample.event.attemptId}/CLASSIFIED.json`));
    const partialBytes = readFileSync(join(sample.root, `inventories/${sample.partial.revision}.json`));
    let calls = 0;
    const session = new DukascopyS3Session({
      mode: "OFFLINE_TEST",
      fakeClient: {
        async send() {
          calls++;
          if (result === "CONFIRMED_ABSENT") throw Object.assign(new Error("fake absent"), { name: "NoSuchKey", $metadata: { httpStatusCode: 404 } });
          if (result === "ERROR") throw Object.assign(new Error("fake failure"), { name: "ExpiredToken" });
          return { $metadata: { httpStatusCode: 200 }, ContentLength: 100, ETag: '"isolated"', RequestCharged: "requester" as const };
        },
      },
    });
    try {
      const snapshot = await runTask116ClassifiedErrorRetry({ ...sample.execution, plan: sample.plan, store: sample.store, session });
      assert.equal(calls, 1);
      assert.equal(snapshot.entries[sample.plan.keys.indexOf(sample.input.failedKey)].status, result);
      const ledger = (await sample.store.ledger(sample.plan))!;
      const campaign = ledger.campaignBudgets![sample.input.campaignId];
      const pool = campaign.classifiedErrorRetry!;
      assert.equal(ledger.totals.headAttempts, 11);
      assert.equal(ledger.totals.classifiedErrorRetryAttempts, 1);
      assert.equal(campaign.normalHeadAttempts, 1);
      assert.equal(campaign.recoveryHeadAttempts, 0);
      assert.equal(pool.consumed, 1);
      const retry = (await sample.store.headAttemptJournal()).find((event) => event.kind === "CLASSIFIED_ERROR_RETRY")!;
      assert.ok(retry);
      assert.notEqual(retry.attemptId, sample.event.attemptId);
      assert.equal(retry.sequence, 2);
      assert.equal(retry.predecessorAttemptId, sample.event.attemptId);
      assert.equal(retry.retryAuthorizationId, sample.prepared.authorizationId);
      assert.equal(retry.retryAuthorizationHash, sample.prepared.authorizationHash);
      assert.equal(retry.capRevisionHash, sample.execution.capRevisionHash);
      assert.equal(ledger.attempts[`HEAD:${sample.input.failedKey}`], 2);
      assert.equal(pool.stage, result === "ERROR" ? "STOPPED" : "ACTIVE_CONTINUATION");
      assert.equal(campaign.children[1].status, "PENDING");
      assert.equal(campaign.currentChildSequence, 1);
      assert.equal(snapshot.entries.filter((entry) => sample.original.keys.includes(entry.key) && entry.status === "UNKNOWN").length, 6);
      const beforeReplay = fingerprint(sample.root);
      await runTask116ClassifiedErrorRetry({ ...sample.execution, plan: sample.plan, store: sample.store, session });
      assert.equal(calls, 1);
      assert.equal(fingerprint(sample.root), beforeReplay);
      const approval = await sample.store.readDocument<AcquisitionApproval>(`retry-approvals/${sample.execution.approvalId}.json`);
      if (result !== "ERROR") await assert.rejects(() => sample.store.gate(sample.plan, approval!, sample.partial), /APPROVAL_VIOLATION/);
      assert.ok(originalBytes.equals(readFileSync(join(sample.root, `head-attempts/${sample.event.attemptId}/CLASSIFIED.json`))));
      assert.ok(partialBytes.equals(readFileSync(join(sample.root, `inventories/${sample.partial.revision}.json`))));
    } finally {
      await sample.store.release();
      session.destroy();
      sample.cleanup();
    }
  });

test("classified retry preparation and separate cap/state apply are immutable and idempotent", async () => {
  const sample = await fixture();
  const before = fingerprint(sample.root);
  const failureBytes = readFileSync(join(sample.root, `head-attempts/${sample.event.attemptId}/CLASSIFIED.json`));
  const partialBytes = readFileSync(join(sample.root, `inventories/${sample.partial.revision}.json`));
  let store: DurableAcquisitionStore | undefined;
  try {
    const checked = await DurableAcquisitionStore.prepareTask116ClassifiedErrorRetryAuthorization(sample.plan, sample.input, { projectRoot: sample.projectRoot, validateOnly: true });
    assert.equal(checked.mode, "VALIDATE_ONLY");
    assert.equal(fingerprint(sample.root), before);
    const prepared = await DurableAcquisitionStore.prepareTask116ClassifiedErrorRetryAuthorization(sample.plan, sample.input, { projectRoot: sample.projectRoot });
    assert.equal(prepared.authorizationHash, checked.authorizationHash);
    const bytes = readFileSync(join(sample.projectRoot, prepared.authorizationPath));
    const wrapper = JSON.parse(bytes.toString());
    assert.equal(wrapper.hash, acquisitionHash(wrapper.data));
    assert.equal((await DurableAcquisitionStore.prepareTask116ClassifiedErrorRetryAuthorization(sample.plan, sample.input, { projectRoot: sample.projectRoot })).mode, "EXISTING");
    await assert.rejects(() => DurableAcquisitionStore.prepareTask116ClassifiedErrorRetryAuthorization(sample.plan, { ...sample.input, reason: "Conflicting immutable authorization must reject replay." }, { projectRoot: sample.projectRoot }), /APPROVAL_VIOLATION/);
    store = await DurableAcquisitionStore.acquire(sample.root);
    await assert.rejects(() => store!.applyTask116ClassifiedErrorRetryAuthorization(sample.plan, prepared.authorizationId, prepared.authorizationHash), /APPROVAL_VIOLATION/);
    assert.equal(await store.applyTask116RetryCapAmendment(sample.plan, prepared.authorizationId, prepared.authorizationHash), "APPLIED");
    assert.equal(await store.applyTask116RetryCapAmendment(sample.plan, prepared.authorizationId, prepared.authorizationHash), "ALREADY_APPLIED");
    assert.equal((await store.ledger(sample.plan))!.globalCaps.maxHeadAttempts, 45);
    assert.equal(await store.applyTask116ClassifiedErrorRetryAuthorization(sample.plan, prepared.authorizationId, prepared.authorizationHash), "APPLIED");
    const after = (await store.ledger(sample.plan))!;
    assert.equal(after.ledgerGeneration, 3);
    assert.equal(after.totals.headAttempts, 10);
    const campaign = after.campaignBudgets![sample.input.campaignId];
    assert.equal(campaign.normalHeadAttempts, 1);
    assert.equal(campaign.recoveryHeadAttempts, 0);
    assert.equal(campaign.classifiedErrorRetry!.allocation, 1);
    assert.equal(campaign.classifiedErrorRetry!.consumed, 0);
    assert.equal(campaign.classifiedErrorRetry!.stage, "RETRY_AUTHORIZED");
    assert.equal(campaign.status, "ACTIVE");
    assert.equal(campaign.children[0].stopReason, "ERROR");
    const hash = acquisitionHash(after);
    assert.equal(await store.applyTask116ClassifiedErrorRetryAuthorization(sample.plan, prepared.authorizationId, prepared.authorizationHash), "ALREADY_APPLIED");
    assert.equal(acquisitionHash((await store.ledger(sample.plan))!), hash);
    assert.ok(failureBytes.equals(readFileSync(join(sample.root, `head-attempts/${sample.event.attemptId}/CLASSIFIED.json`))));
    assert.ok(partialBytes.equals(readFileSync(join(sample.root, `inventories/${sample.partial.revision}.json`))));
  } finally {
    await store?.release();
    sample.cleanup();
  }
});

test("classified retry preparation rejects mismatched evidence and state without writes", async (context) => {
  const sample = await fixture();
  const before = fingerprint(sample.root);
  try {
    const changes: Array<Partial<ClassifiedErrorRetryPreparationInput>> = [
      { failedKey: sample.plan.keys[0] },
      { failedAttemptId: "00000000-0000-0000-0000-000000000000" },
      { failedClassifiedHash: "0".repeat(64) },
      { originalApprovalId: "other-approval" },
      { originalApprovalHash: "0".repeat(64) },
      { originalProgressHash: "0".repeat(64) },
      { partialRevision: sample.seed.revision },
      { partialSnapshotHash: "0".repeat(64) },
      { priorLedgerHash: "0".repeat(64) },
      { priorLedgerGeneration: 2 },
      { currentInventoryRevision: sample.partial.revision },
      { masterPlanHash: "0".repeat(64) },
      { capAuthorizationHash: "0".repeat(64) },
      { campaignId: "other-campaign" },
      { expiresAt: "2020-01-01T00:00:00.000Z" },
      { operatorApprovalReference: "" },
      { operatorApprovalHash: "bad" },
      { reason: "Bearer credential must not be persisted anywhere." },
      { authorizationId: "../escape" },
    ];
    for (const [index, change] of changes.entries())
      await context.test(`binding rejection ${index}`, async () => {
        await assert.rejects(() => DurableAcquisitionStore.prepareTask116ClassifiedErrorRetryAuthorization(sample.plan, { ...sample.input, ...change }, { projectRoot: sample.projectRoot }));
        assert.equal(fingerprint(sample.root), before);
      });
    const classPath = join(sample.root, `head-attempts/${sample.event.attemptId}/CLASSIFIED.json`);
    const original = readFileSync(classPath);
    const event = structuredClone(sample.event);
    event.classification!.error = "TRANSIENT";
    writeFileSync(classPath, JSON.stringify({ hash: acquisitionHash(event), data: event }));
    await assert.rejects(() => DurableAcquisitionStore.prepareTask116ClassifiedErrorRetryAuthorization(sample.plan, { ...sample.input, failedClassifiedHash: acquisitionHash(event) }, { projectRoot: sample.projectRoot }), /APPROVAL_VIOLATION/);
    rmSync(classPath);
    await assert.rejects(() => DurableAcquisitionStore.prepareTask116ClassifiedErrorRetryAuthorization(sample.plan, sample.input, { projectRoot: sample.projectRoot }), /APPROVAL_VIOLATION/);
    writeFileSync(classPath, original);
    for (const status of ["ACTIVE", "COMPLETED"] as const) {
      const ledger = structuredClone(sample.stopped);
      ledger.campaignBudgets![sample.input.campaignId].status = status;
      writeFileSync(join(sample.root, "ledger.json"), JSON.stringify({ hash: acquisitionHash(ledger), data: ledger }));
      await assert.rejects(() => DurableAcquisitionStore.prepareTask116ClassifiedErrorRetryAuthorization(sample.plan, { ...sample.input, priorLedgerHash: acquisitionHash(ledger) }, { projectRoot: sample.projectRoot }), /APPROVAL_VIOLATION/);
    }
  } finally {
    sample.cleanup();
  }
});

for (const boundary of ["A_BEFORE_RESERVATION", "B_AFTER_RESERVED_EVENT", "B_AFTER_RESERVED", "C_AFTER_MAY_HAVE_BEEN_SENT", "D_AFTER_RESPONSE", "E_AFTER_CLASSIFIED", "F_AFTER_PROGRESS", "G_AFTER_SNAPSHOT", "RETRY_AFTER_TRANSITION_EVIDENCE"] as InventoryCrashBoundary[])
  test(`classified retry crash ${boundary} preserves one debit and never duplicates a send`, async () => {
    const sample = await executionFixture();
    let store = sample.store;
    let calls = 0;
    const session = new DukascopyS3Session({
      mode: "OFFLINE_TEST",
      fakeClient: {
        async send() {
          calls++;
          return { $metadata: { httpStatusCode: 200 }, ContentLength: 100, ETag: '"isolated"', RequestCharged: "requester" as const };
        },
      },
    });
    try {
      await store.release();
      store = await DurableAcquisitionStore.acquire(sample.root, { faultAt: boundary });
      await assert.rejects(
        () => runTask116ClassifiedErrorRetry({ ...sample.execution, plan: sample.plan, store, session }),
        (error) => error instanceof SimulatedInventoryCrash && error.boundary === boundary,
      );
      await store.release();
      store = await DurableAcquisitionStore.acquire(sample.root);
      const snapshot = await runTask116ClassifiedErrorRetry({ ...sample.execution, plan: sample.plan, store, session });
      const ledger = (await store.ledger(sample.plan))!;
      const campaign = ledger.campaignBudgets![sample.input.campaignId];
      const pool = campaign.classifiedErrorRetry!;
      assert.equal(ledger.totals.headAttempts, 11);
      assert.equal(campaign.normalHeadAttempts, 1);
      assert.equal(campaign.recoveryHeadAttempts, 0);
      assert.equal(pool.consumed, 1);
      assert.equal((await store.headAttemptJournal()).filter((event) => event.kind === "CLASSIFIED_ERROR_RETRY").length, 1);
      if (["C_AFTER_MAY_HAVE_BEEN_SENT", "D_AFTER_RESPONSE"].includes(boundary)) {
        assert.equal(snapshot.entries[sample.plan.keys.indexOf(sample.input.failedKey)].error, "INDETERMINATE");
        assert.equal(pool.stage, "STOPPED");
        assert.equal(calls, boundary === "C_AFTER_MAY_HAVE_BEEN_SENT" ? 0 : 1);
      } else {
        assert.equal(snapshot.entries[sample.plan.keys.indexOf(sample.input.failedKey)].status, "PRESENT");
        assert.equal(pool.stage, "ACTIVE_CONTINUATION");
        assert.equal(calls, 1);
      }
    } finally {
      await store.release();
      session.destroy();
      sample.cleanup();
    }
  });

test("classified retry continuation is explicitly prepared and runs only the remaining six keys", async () => {
  const sample = await executionFixture();
  let store = sample.store;
  let calls = 0;
  const session = new DukascopyS3Session({
    mode: "OFFLINE_TEST",
    fakeClient: {
      async send() {
        calls++;
        return { $metadata: { httpStatusCode: 200 }, ContentLength: 100, ETag: '"isolated"', RequestCharged: "requester" as const };
      },
    },
  });
  try {
    const retrySnapshot = await runTask116ClassifiedErrorRetry({ ...sample.execution, plan: sample.plan, store, session });
    assert.equal(calls, 1);
    const ledger = (await store.ledger(sample.plan))!;
    await store.release();
    const input = { ...sample.approvalInput, phase: "CONTINUATION" as const, priorLedgerHash: acquisitionHash(ledger), inventoryRevision: retrySnapshot.revision };
    const before = fingerprint(sample.root);
    await DurableAcquisitionStore.prepareTask116RetryExecutionApproval(sample.plan, input, { projectRoot: sample.projectRoot, validateOnly: true });
    assert.equal(fingerprint(sample.root), before);
    const prepared = await DurableAcquisitionStore.prepareTask116RetryExecutionApproval(sample.plan, input, { projectRoot: sample.projectRoot });
    store = await DurableAcquisitionStore.acquire(sample.root);
    const final = await runTask116ClassifiedErrorRetry({ ...sample.execution, phase: "CONTINUATION", approvalId: prepared.approvalId, approvalHash: prepared.approvalHash, inventoryRevision: retrySnapshot.revision, plan: sample.plan, store, session });
    assert.equal(calls, 7);
    const after = (await store.ledger(sample.plan))!;
    const campaign = after.campaignBudgets![sample.input.campaignId];
    assert.equal(after.totals.headAttempts, 17);
    assert.equal(campaign.normalHeadAttempts, 7);
    assert.equal(campaign.recoveryHeadAttempts, 0);
    assert.equal(campaign.classifiedErrorRetry!.consumed, 1);
    assert.equal(campaign.currentChildSequence, 2);
    assert.equal(campaign.children[0].status, "COMPLETED");
    assert.equal(campaign.children[1].status, "PENDING");
    assert.ok(sample.original.keys.every((key) => final.entries[sample.plan.keys.indexOf(key)].status === "PRESENT"));
  } finally {
    await store.release().catch(() => {});
    session.destroy();
    sample.cleanup();
  }
});

function preparationArguments(input: ClassifiedErrorRetryPreparationInput): string[] {
  return [
    "classified-error-retry-authorize-prepare",
    "--authorization-id",
    input.authorizationId,
    "--campaign",
    input.campaignId,
    "--child-sequence",
    "1",
    "--failed-key",
    input.failedKey,
    "--failed-attempt-id",
    input.failedAttemptId,
    "--failed-classified-hash",
    input.failedClassifiedHash,
    "--original-approval-id",
    input.originalApprovalId,
    "--original-approval-hash",
    input.originalApprovalHash,
    "--original-progress-hash",
    input.originalProgressHash,
    "--prior-ledger-hash",
    input.priorLedgerHash,
    "--prior-ledger-generation",
    String(input.priorLedgerGeneration),
    "--partial-revision",
    input.partialRevision,
    "--partial-snapshot-hash",
    input.partialSnapshotHash,
    "--inventory-revision",
    input.currentInventoryRevision,
    "--master-plan-hash",
    input.masterPlanHash,
    "--cap-authorization-id",
    input.capAuthorizationId,
    "--cap-authorization-hash",
    input.capAuthorizationHash,
    "--authorized-at",
    input.authorizedAt,
    "--expires-at",
    input.expiresAt,
    "--operator-approval-reference",
    input.operatorApprovalReference,
    "--operator-approval-hash",
    input.operatorApprovalHash,
    "--reason",
    input.reason,
  ];
}

test("classified retry CLI is offline preparation-only and refuses execution options", async () => {
  const sample = await fixture();
  const summaries: Array<Record<string, unknown>> = [];
  const output = (value: unknown) => summaries.push(value as Record<string, unknown>);
  try {
    assert.equal(await runInventoryOperatorCli(["classified-error-retry-authorize-prepare", "--help"], output, { projectRoot: sample.projectRoot }), 0);
    assert.equal(summaries.at(-1)!.operation, "PREPARE CLASSIFIED ERROR RETRY AUTHORIZATION ONLY - DOES NOT APPLY OR EXECUTE");
    const args = preparationArguments(sample.input);
    const before = fingerprint(sample.root);
    assert.equal(await runInventoryOperatorCli([...args, "--validate-only"], output, { projectRoot: sample.projectRoot }), 0);
    assert.equal(fingerprint(sample.root), before);
    for (const flag of ["--live", "--apply", "--execute", "--new-cap", "--output", "--recovery-allowance"]) assert.equal(await runInventoryOperatorCli([...args, flag, "anything"], output, { projectRoot: sample.projectRoot }), 1);
    assert.equal(await runInventoryOperatorCli(args, output, { projectRoot: sample.projectRoot }), 0);
    assert.equal(summaries.at(-1)!.mode, "PREPARED");
    const path = summaries.at(-1)!.authorizationPath as string;
    execFileSync("git", ["check-ignore", "--quiet", "--", path], { cwd: sample.projectRoot });
    assert.equal(execFileSync("git", ["ls-files", "--", path], { cwd: sample.projectRoot, encoding: "utf8" }), "");
  } finally {
    sample.cleanup();
  }
});

test("classified retry preparation cannot acquire writer execute or reach SDK credentials", async () => {
  const sample = await fixture();
  try {
    const script = `const Module=require('node:module'); const original=Module._load; const forbidden=()=>{throw Error('PREPARATION_EXECUTION_FORBIDDEN');}; Module._load=function(name,...args){const loaded=original.call(this,name,...args); if(name==='@aws-sdk/client-s3')return {...loaded,S3Client:class{constructor(){forbidden();}}}; if(name==='@aws-sdk/credential-providers')return new Proxy(loaded,{get(target,property){return String(property).startsWith('from')?forbidden:target[property];}}); return loaded;}; require('node:http').request=require('node:https').request=require('node:tls').connect=forbidden;require('node:net').Socket.prototype.connect=globalThis.fetch=forbidden; const durable=require(${JSON.stringify(require.resolve("../lib/backtest/dukascopy-s3-durable"))}); durable.DurableAcquisitionStore.acquire=durable.DurableAcquisitionStore.prototype.gate=durable.DurableAcquisitionStore.prototype.applyTask116RetryCapAmendment=durable.DurableAcquisitionStore.prototype.applyTask116ClassifiedErrorRetryAuthorization=forbidden; const runner=require(${JSON.stringify(require.resolve("../lib/backtest/dukascopy-s3-runner"))}); runner.runTask116ClassifiedErrorRetry=runner.runDukascopyInventory=runner.runDukascopyDownload=forbidden; require(${JSON.stringify(require.resolve("../lib/backtest/dukascopy-inventory-cli"))}).runInventoryOperatorCli(${JSON.stringify(preparationArguments(sample.input))}, value=>console.log(JSON.stringify(value)), {projectRoot:${JSON.stringify(sample.projectRoot)}}).then(code=>{process.exitCode=code;});`;
    const result = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", env: process.env });
    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(result.stdout.trim());
    assert.equal(summary.mode, "PREPARED");
    assert.equal(summary.awsRequests, 0);
    assert.equal(summary.credentialResolution, 0);
  } finally {
    sample.cleanup();
  }
});

for (const method of ["applyTask116RetryCapAmendment", "applyTask116ClassifiedErrorRetryAuthorization"] as const)
  for (const boundary of ["CAP_AFTER_AUTHORIZATION_EVIDENCE", "CAP_AFTER_LEDGER_COMMIT"] as const)
    test(`classified retry ${method} crash ${boundary} applies once`, async () => {
      const sample = await fixture();
      let store: DurableAcquisitionStore | undefined;
      try {
        const prepared = await DurableAcquisitionStore.prepareTask116ClassifiedErrorRetryAuthorization(sample.plan, sample.input, { projectRoot: sample.projectRoot });
        if (method === "applyTask116ClassifiedErrorRetryAuthorization") {
          store = await DurableAcquisitionStore.acquire(sample.root);
          await store.applyTask116RetryCapAmendment(sample.plan, prepared.authorizationId, prepared.authorizationHash);
          await store.release();
        }
        store = await DurableAcquisitionStore.acquire(sample.root, { faultAt: boundary });
        await assert.rejects(
          () => store![method](sample.plan, prepared.authorizationId, prepared.authorizationHash),
          (error) => error instanceof SimulatedInventoryCrash && error.boundary === boundary,
        );
        await store.release();
        store = await DurableAcquisitionStore.acquire(sample.root);
        assert.equal(await store[method](sample.plan, prepared.authorizationId, prepared.authorizationHash), boundary === "CAP_AFTER_LEDGER_COMMIT" ? "ALREADY_APPLIED" : "APPLIED");
        const after = (await store.ledger(sample.plan))!;
        assert.equal(after.totals.headAttempts, 10);
        assert.equal(after.globalCaps.maxHeadAttempts, 45);
        assert.equal(after.ledgerGeneration, method === "applyTask116RetryCapAmendment" ? 2 : 3);
        assert.equal(after.campaignBudgets![sample.input.campaignId].normalHeadAttempts, 1);
        const hash = acquisitionHash(after);
        assert.equal(await store[method](sample.plan, prepared.authorizationId, prepared.authorizationHash), "ALREADY_APPLIED");
        assert.equal(acquisitionHash((await store.ledger(sample.plan))!), hash);
      } finally {
        await store?.release();
        sample.cleanup();
      }
    });

test("classified retry requires a proven cap revision and rejects a second reservation", async () => {
  const sample = await executionFixture();
  try {
    const approval = await sample.store.readDocument<AcquisitionApproval>(`retry-approvals/${sample.execution.approvalId}.json`);
    const before = await sample.store.ledger(sample.plan);
    const forged = structuredClone(before!);
    delete forged.retryCapRevision;
    await sample.store.document("ledger.json", forged);
    await assert.rejects(() => sample.store.ledger(sample.plan), /APPROVAL_VIOLATION/);
    await sample.store.document("ledger.json", before);
    forged.globalCaps.maxHeadAttempts = 46;
    await sample.store.document("ledger.json", forged);
    await assert.rejects(() => sample.store.ledger(sample.plan), /APPROVAL_VIOLATION/);
    await sample.store.document("ledger.json", before);
    await assert.rejects(() => sample.store.reserveHeadAttempt(sample.plan, approval!, sample.input.failedKey, 2, "CLASSIFIED_ERROR_RETRY"), /APPROVAL_VIOLATION/);
    const gate = await sample.store.gate(sample.plan, approval!, sample.partial);
    await assert.rejects(() => gate.before("HEAD", sample.original.keys[1], 0), /APPROVAL_VIOLATION/);
    const reserved = await gate.before("HEAD", sample.input.failedKey, 0);
    assert.equal(reserved?.kind, "CLASSIFIED_ERROR_RETRY");
    const ledger = (await sample.store.ledger(sample.plan))!;
    assert.equal(ledger.campaignBudgets![sample.input.campaignId].classifiedErrorRetry!.consumed, 1);
    await assert.rejects(() => sample.store.reserveHeadAttempt(sample.plan, approval!, sample.input.failedKey, 2, "CLASSIFIED_ERROR_RETRY"), /APPROVAL_VIOLATION/);
    await assert.rejects(() => gate.before("HEAD", sample.input.failedKey, 0), /FILESYSTEM_UNSAFE/);
    assert.equal((await sample.store.headAttemptJournal()).filter((event) => event.kind === "CLASSIFIED_ERROR_RETRY").length, 1);
    assert.equal((await sample.store.ledger(sample.plan))!.campaignBudgets![sample.input.campaignId].normalHeadAttempts, 1);
  } finally {
    await sample.store.release();
    sample.cleanup();
  }
});

test("classified retry cannot publish success or activate continuation without CLASSIFIED success evidence", async () => {
  const sample = await executionFixture();
  try {
    const approval = (await sample.store.readDocument<AcquisitionApproval>(`retry-approvals/${sample.execution.approvalId}.json`))!;
    const gate = await sample.store.gate(sample.plan, approval, sample.partial);
    const reservation = (await gate.before("HEAD", sample.input.failedKey, 0))!;
    await gate.markHeadMayHaveBeenSent(reservation.attemptId);
    const entries = [...sample.partial.entries];
    const index = sample.plan.keys.indexOf(sample.input.failedKey);
    entries[index] = { ...entries[index], status: "PRESENT", metadata: { contentLength: 100, etag: '"forged"', lastModified: null, storageClass: null, checksumType: null, checksums: {}, requestCharged: "requester" }, checkedAt: new Date().toISOString(), attempts: 2, error: null };
    const forged = createInventorySnapshot(sample.plan, entries);
    await sample.store.saveSnapshot(sample.plan, forged);
    const before = acquisitionHash((await sample.store.ledger(sample.plan))!);
    await assert.rejects(() => sample.store.completeCampaignChild(sample.plan, approval, forged), /APPROVAL_VIOLATION/);
    const after = (await sample.store.ledger(sample.plan))!;
    assert.equal(acquisitionHash(after), before);
    assert.equal(after.campaignBudgets![sample.input.campaignId].classifiedErrorRetry!.stage, "RETRY_IN_PROGRESS");
    assert.equal(after.campaignBudgets![sample.input.campaignId].classifiedErrorRetry!.consumed, 1);
  } finally {
    await sample.store.release();
    sample.cleanup();
  }
});

test("classified retry extended counter validation rejects negative debit evidence", async () => {
  const sample = await executionFixture();
  try {
    const ledger = (await sample.store.ledger(sample.plan))!;
    ledger.totals.classifiedErrorRetryAttempts = -1;
    await sample.store.document("ledger.json", ledger);
    await assert.rejects(() => sample.store.ledger(sample.plan), /FILESYSTEM_UNSAFE/);
  } finally {
    await sample.store.release();
    sample.cleanup();
  }
});

test("classified retry scope is fixed to SESSION_EXPIRED sequence2 and a separate allocation1", async () => {
  const plan = await createFrozenDukascopyPlan();
  const caps = { maxHeadAttempts: 44, maxGetAttempts: 0, maxNetworkBytes: 0, maxVerifiedBytes: 0, maxObjects: 7, maxRetries: 2 };
  const hash = acquisitionHash("isolated scope evidence");
  const authorization: ClassifiedErrorRetryAuthorization = {
    version: 1,
    authorizationId: "retry-scope-isolated",
    campaignId: "task116-usdjpy-20210108-20210207",
    childSequence: 1,
    descriptor: buildTask116CampaignChildren(plan)[0],
    masterPlanHash: plan.planHash,
    instrument: plan.instrument,
    bucket: plan.bucket,
    region: plan.region,
    requesterPays: true,
    failedKey: "USDJPY/2021/00/08_ticks.bi5",
    failedAttemptId: "a9c06341-7832-47f0-896f-8e2395d15b3d",
    failedKind: "INITIAL",
    failedSequence: 1,
    failedStatus: "ERROR",
    failedError: "SESSION_EXPIRED",
    failedClassifiedHash: hash,
    accountingHash: hash,
    originalApprovalId: "original-child",
    originalApprovalHash: hash,
    originalProgressHash: hash,
    priorLedgerHash: hash,
    priorLedgerGeneration: 1,
    countersHash: hash,
    partialRevision: hash,
    partialSnapshotHash: hash,
    currentInventoryRevision: hash,
    capAuthorizationId: "original-cap",
    capAuthorizationHash: hash,
    oldGlobalCaps: caps,
    newGlobalCaps: { ...caps, maxHeadAttempts: 45 },
    allocation: 1,
    nextSequence: 2,
    indeterminateRecoveryAllowance: 0,
    authorizedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    operatorApprovalReference: "OP-RETRY-REVIEW",
    operatorApprovalHash: hash,
    reason: "Reviewed isolated classified failure replacement only.",
  };
  assert.doesNotThrow(() => assertTask116ClassifiedRetryScope(plan, authorization));
  for (const change of [{ failedError: "TRANSIENT" }, { failedKey: plan.keys[0] }, { failedKind: "RETRY" }, { nextSequence: 3 }, { allocation: 2 }, { indeterminateRecoveryAllowance: 1 }, { newGlobalCaps: { ...caps, maxHeadAttempts: 46 } }])
    assert.throws(() => assertTask116ClassifiedRetryScope(plan, { ...authorization, ...change } as ClassifiedErrorRetryAuthorization), /APPROVAL_VIOLATION/);
});
