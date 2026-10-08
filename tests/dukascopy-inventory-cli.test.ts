import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { Readable } from "node:stream";
import { createInterface } from "node:readline";
import { EventEmitter } from "node:events";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { HeadObjectCommand } from "@aws-sdk/client-s3";
import { buildTask116CampaignChildren, DurableAcquisitionStore, type CampaignCapAuthorizationPreparationInput, type CampaignChildApprovalPreparationInput, type AcquisitionLedger } from "../lib/backtest/dukascopy-s3-durable";
import { createFrozenDukascopyPlan, assertExactDukascopyKey, acquisitionHash, DukascopyS3Session, createInventorySnapshot, mergeInventoryProgress, type AcquisitionErrorCode, type InventoryEntry, type AcquisitionApproval, type AcquisitionRequestGate, type FrozenDukascopyPlan, type OfflineS3Sender } from "../lib/backtest/dukascopy-s3-production";
import { runInventoryOperatorCli, parseInventoryCliArguments, selectInventoryCliBatch, inventoryConfirmationPhrase, inventoryCliLocations, INVENTORY_APPROVAL_DIRECTORY, type InventoryCliRuntime } from "../lib/backtest/dukascopy-inventory-cli";

let realNetworkCalls = 0;
let realStoreBefore: string | undefined;
const realStorePath = join(process.cwd(), "tmp/dukascopy/s3-production");

function storeFingerprint(root: string, excluded?: string): string {
  const files = readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((file) => file !== excluded)
    .sort();
  return acquisitionHash(files.map((file) => [file.slice(root.length), acquisitionHash(readFileSync(file).toString("base64"))]));
}

test.before(() => {
  if (existsSync(realStorePath)) realStoreBefore = storeFingerprint(realStorePath);
  const forbidden = () => {
    realNetworkCalls++;
    throw new Error("real network forbidden");
  };
  test.mock.method(http, "request", forbidden);
  test.mock.method(https, "request", forbidden);
  test.mock.method(net.Socket.prototype, "connect", forbidden);
  test.mock.method(tls, "connect", forbidden);
  test.mock.method(globalThis, "fetch", forbidden);
});
test.after(() => {
  assert.equal(realNetworkCalls, 0);
  if (realStoreBefore) assert.equal(storeFingerprint(realStorePath), realStoreBefore, "real production store must remain unchanged");
  test.mock.restoreAll();
});

const HEAD_OK = { $metadata: { httpStatusCode: 200 }, ContentLength: 100, ETag: '"inventory-etag"', RequestCharged: "requester" as const };
const START = "2021-01-01";
const END = "2021-01-08";

async function persistFailedHead(gate: AcquisitionRequestGate, plan: FrozenDukascopyPlan, key: string, code: AcquisitionErrorCode, sequence: number): Promise<void> {
  const reservation = await gate.before("HEAD", key, 0);
  assert.ok(reservation);
  await gate.markHeadMayHaveBeenSent(reservation.attemptId);
  const entry: InventoryEntry = { key, utcDay: assertExactDukascopyKey(plan, key), status: code === "AMBIGUOUS_ACCESS" ? "AMBIGUOUS_ACCESS" : "ERROR", metadata: null, checkedAt: "2026-10-07T06:00:00.000Z", attempts: sequence, error: code };
  await gate.classifyHead(reservation.attemptId, entry);
  await gate.failure("HEAD", key, code);
}

test("snapshot progress merge preserves terminal state and rejects downgrade/conflict", async () => {
  const plan = await createFrozenDukascopyPlan();
  const empty = createInventorySnapshot(plan, []);
  const resolved: InventoryEntry = { ...empty.entries[0], status: "CONFIRMED_ABSENT", attempts: 2, checkedAt: "2026-10-07T06:00:00.000Z" };
  const entries = [...empty.entries];
  entries[0] = resolved;
  const seed = createInventorySnapshot(plan, entries);
  assert.deepEqual(mergeInventoryProgress(plan, seed, [{ ...resolved, attempts: 1, checkedAt: "2026-10-07T05:00:00.000Z" }]).entries[0], seed.entries[0]);
  assert.throws(() => mergeInventoryProgress(plan, seed, [empty.entries[0]]), /APPROVAL_VIOLATION/);
  const present: InventoryEntry = { ...resolved, status: "PRESENT", metadata: { contentLength: 100, etag: '"seed"', lastModified: null, storageClass: null, checksumType: null, checksums: {}, requestCharged: "requester" } };
  assert.throws(() => mergeInventoryProgress(plan, seed, [present]), /APPROVAL_VIOLATION/);
  entries[0] = present;
  const presentSeed = createInventorySnapshot(plan, entries);
  assert.throws(() => mergeInventoryProgress(plan, presentSeed, [empty.entries[0]]), /APPROVAL_VIOLATION/);
  assert.deepEqual(mergeInventoryProgress(plan, presentSeed, [present]).entries[0], presentSeed.entries[0]);
  assert.throws(() => mergeInventoryProgress(plan, presentSeed, [{ ...present, metadata: { ...present.metadata!, etag: '"different"' } }]), /APPROVAL_VIOLATION/);
  assert.throws(() => mergeInventoryProgress(plan, seed, [resolved, resolved]), /APPROVAL_VIOLATION/);
});

async function fakeStdin(value: string | null): Promise<string | null> {
  const reader = createInterface({ input: Readable.from(value === null ? [] : [`${value}\n`]), crlfDelay: Infinity });
  try {
    for await (const line of reader) return line;
    return null;
  } finally {
    reader.close();
  }
}

async function fixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "task116-cli-tests-"));
  execFileSync("git", ["init", "--quiet", root], { stdio: "ignore" });
  writeFileSync(join(root, ".gitignore"), "/tmp/dukascopy/\n");
  const plan = await createFrozenDukascopyPlan();
  const relativeApproval = `${INVENTORY_APPROVAL_DIRECTORY}/initial.json`;
  const path = join(root, relativeApproval);
  mkdirSync(join(root, INVENTORY_APPROVAL_DIRECTORY), { recursive: true });
  const args = ["inventory", "--live", "--approval", relativeApproval, "--start", START, "--end-exclusive", END];
  const keys = selectInventoryCliBatch(plan, parseInventoryCliArguments(args));
  const caps = { maxHeadAttempts: 21, maxGetAttempts: 0, maxNetworkBytes: 0, maxVerifiedBytes: 0, maxObjects: 7, maxRetries: 2 };
  const approval: AcquisitionApproval = { id: "initial-inventory", batchId: "first-seven", operation: "INVENTORY", planHash: plan.planHash, inventoryRevision: null, batchStart: `${START}T00:00:00.000Z`, batchEnd: `${END}T00:00:00.000Z`, keys, caps, globalCaps: { ...caps }, minimumFreeBytes: 0, expiresAt: "2100-01-01T00:00:00.000Z" };
  const save = (value = approval) => writeFileSync(path, JSON.stringify({ hash: acquisitionHash(value), data: value }));
  save();
  const output: Array<Record<string, unknown>> = [];
  const signals = new EventEmitter();
  let calls = 0;
  const runtime: InventoryCliRuntime = {
    projectRoot: root,
    inputIsTTY: true,
    outputIsTTY: true,
    ci: false,
    signals,
    confirm: async (prompt) => {
      assert.ok(prompt.includes("GET = disabled"));
      assert.ok(prompt.includes("LIST = disabled"));
      return fakeStdin(inventoryConfirmationPhrase(parseInventoryCliArguments(args), keys.length));
    },
    fakeClient: {
      async send(command) {
        assert.ok(command instanceof HeadObjectCommand);
        assert.equal(command.input.RequestPayer, "requester");
        calls++;
        return HEAD_OK;
      },
    },
    backoff: async () => {},
  };
  return { root, plan, approval, args, path, runtime, output, signals, save, calls: () => calls, emit: (value: unknown) => output.push(value as Record<string, unknown>), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function awsError(name: string, httpStatusCode: number) {
  return Object.assign(new Error("credential-secret-do-not-print"), { name, $metadata: { httpStatusCode } });
}

async function capPreparationFixture() {
  const sample = await fixture();
  const rootStore = inventoryCliLocations(sample.root).storeRoot;
  const seed = createInventorySnapshot(sample.plan, []);
  const counts = { headAttempts: 9, getAttempts: 0, successfulGets: 0, failedAttempts: 0, receivedBytes: 0, reservedBytes: 0, verifiedBytes: 0, retryCount: 0, objects: [] as string[] };
  const ledger: AcquisitionLedger = {
    version: "DUKASCOPY_DURABLE_V1",
    planHash: sample.plan.planHash,
    inventoryRevision: null,
    approvalId: sample.approval.id,
    batchId: sample.approval.batchId,
    globalCaps: { ...sample.approval.globalCaps },
    totals: { ...counts },
    contexts: { [sample.approval.id]: { bindingHash: acquisitionHash(sample.approval), counters: { ...counts } } },
    attempts: Object.fromEntries(sample.plan.keys.slice(0, 3).map((key) => [`HEAD:${key}`, 3])),
    completedGetKeys: [],
    verified: {},
    active: null,
    quarantineBytes: 0,
    partialBytes: 0,
    startedAt: "2026-10-07T00:00:00.000Z",
    updatedAt: "2026-10-07T00:00:00.000Z",
  };
  const store = await DurableAcquisitionStore.acquire(rootStore);
  try {
    await store.saveSnapshot(sample.plan, seed);
    await store.document("ledger.json", ledger);
  } finally {
    await store.release();
  }
  const input: CampaignCapAuthorizationPreparationInput = {
    authorizationId: "task116-cap-preparation-isolated",
    campaignId: "task116-usdjpy-20210108-20210207",
    oldGlobalCaps: { ...ledger.globalCaps },
    newGlobalCaps: { ...ledger.globalCaps, maxHeadAttempts: 44 },
    campaignStart: "2021-01-08T00:00:00.000Z",
    campaignEnd: "2021-02-07T00:00:00.000Z",
    children: buildTask116CampaignChildren(sample.plan),
    reason: "Reviewed 30-day metadata inventory campaign cap preparation.",
    authorizedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    operatorApprovalReference: "OP-APPROVAL-TASK116-30DAY",
    operatorApprovalHash: acquisitionHash("isolated explicit operator evidence"),
    priorLedgerHash: acquisitionHash(ledger),
    priorLedgerGeneration: 0,
    masterPlanHash: sample.plan.planHash,
    instrument: sample.plan.instrument,
    bucket: sample.plan.bucket,
    region: sample.plan.region,
    requesterPays: true,
    initialInventoryRevision: seed.revision,
  };
  return { ...sample, rootStore, seed, ledger, input };
}

test("cap preparation validate-only and immutable replay preserve V1 state without apply or session", async () => {
  const sample = await capPreparationFixture();
  rmSync(join(sample.rootStore, "cap-expansions"), { recursive: true });
  const ledgerBefore = readFileSync(join(sample.rootStore, "ledger.json"));
  const seedBefore = readFileSync(join(sample.rootStore, "inventories", `${sample.seed.revision}.json`));
  const before = readdirSync(sample.rootStore, { recursive: true }).sort();
  const originalFingerprint = storeFingerprint(sample.rootStore);
  const forbid = () => {
    throw Error("preparation must not activate execution");
  };
  const acquire = test.mock.method(DurableAcquisitionStore, "acquire", forbid);
  const apply = test.mock.method(DurableAcquisitionStore.prototype, "applyTask116CampaignCapExpansion", forbid);
  const send = test.mock.method(DukascopyS3Session.prototype, "send", forbid);
  try {
    const options = { projectRoot: sample.root, validateOnly: true };
    const checked = await DurableAcquisitionStore.prepareTask116CampaignCapExpansionAuthorization(sample.plan, sample.input, options);
    assert.equal(checked.mode, "VALIDATE_ONLY");
    assert.deepEqual(checked.validation.childSizes, [7, 7, 7, 7, 2]);
    assert.deepEqual(readdirSync(sample.rootStore, { recursive: true }).sort(), before);
    assert.equal(storeFingerprint(sample.rootStore), originalFingerprint);
    const prepared = await DurableAcquisitionStore.prepareTask116CampaignCapExpansionAuthorization(sample.plan, sample.input, { projectRoot: sample.root });
    assert.equal(prepared.mode, "PREPARED");
    assert.equal(prepared.authorizationHash, checked.authorizationHash);
    const file = join(sample.root, prepared.authorizationPath);
    const bytes = readFileSync(file);
    const wrapper = JSON.parse(bytes.toString());
    assert.equal(wrapper.hash, acquisitionHash(wrapper.data));
    assert.equal(wrapper.hash, prepared.authorizationHash);
    assert.equal(wrapper.data.normalHeadBudget, 30);
    assert.equal(wrapper.data.recoveryHeadBudget, 5);
    assert.equal((await DurableAcquisitionStore.prepareTask116CampaignCapExpansionAuthorization(sample.plan, sample.input, { projectRoot: sample.root })).mode, "EXISTING");
    assert.ok(bytes.equals(readFileSync(file)));
    await assert.rejects(() => DurableAcquisitionStore.prepareTask116CampaignCapExpansionAuthorization(sample.plan, { ...sample.input, reason: "Different reviewed reason for the same authorization identifier." }, { projectRoot: sample.root }), /APPROVAL_VIOLATION/);
    assert.equal(readdirSync(join(sample.rootStore, "cap-expansions")).length, 1);
    assert.equal(storeFingerprint(sample.rootStore, file), originalFingerprint);
    assert.ok(ledgerBefore.equals(readFileSync(join(sample.rootStore, "ledger.json"))));
    assert.ok(seedBefore.equals(readFileSync(join(sample.rootStore, "inventories", `${sample.seed.revision}.json`))));
    assert.equal(existsSync(join(sample.rootStore, "writer.lock")), false);
    execFileSync("git", ["check-ignore", "--quiet", "--", prepared.authorizationPath], { cwd: sample.root });
    assert.equal(execFileSync("git", ["ls-files", "--", prepared.authorizationPath], { cwd: sample.root, encoding: "utf8" }), "");
    assert.equal(acquire.mock.callCount(), 0);
    assert.equal(apply.mock.callCount(), 0);
    assert.equal(send.mock.callCount(), 0);
  } finally {
    acquire.mock.restore();
    apply.mock.restore();
    send.mock.restore();
    sample.cleanup();
  }
});

function capPreparationCliArguments(input: CampaignCapAuthorizationPreparationInput): string[] {
  return [
    "cap-authorize-prepare",
    "--authorization-id",
    input.authorizationId,
    "--campaign",
    input.campaignId,
    "--inventory-revision",
    input.initialInventoryRevision,
    "--prior-ledger-hash",
    input.priorLedgerHash,
    "--prior-ledger-generation",
    String(input.priorLedgerGeneration),
    "--master-plan-hash",
    input.masterPlanHash,
    "--operator-approval-reference",
    input.operatorApprovalReference,
    "--operator-approval-hash",
    input.operatorApprovalHash,
    "--authorized-at",
    input.authorizedAt,
    "--expires-at",
    input.expiresAt,
    "--reason",
    input.reason,
  ];
}

async function childPreparationFixture() {
  const sample = await capPreparationFixture();
  const prepared = await DurableAcquisitionStore.prepareTask116CampaignCapExpansionAuthorization(sample.plan, sample.input, { projectRoot: sample.root });
  const authorization = JSON.parse(readFileSync(join(sample.root, prepared.authorizationPath), "utf8")).data;
  const store = await DurableAcquisitionStore.acquire(sample.rootStore);
  let ledger: AcquisitionLedger;
  try {
    await store.applyTask116CampaignCapExpansion(sample.plan, authorization);
    ledger = (await store.ledger(sample.plan))!;
  } finally {
    await store.release();
  }
  const childInput: CampaignChildApprovalPreparationInput = {
    approvalId: "isolated-child-one",
    campaignId: sample.input.campaignId,
    childSequence: 1,
    priorLedgerHash: acquisitionHash(ledger!),
    priorLedgerGeneration: 1,
    inventoryRevision: sample.seed.revision,
    masterPlanHash: sample.plan.planHash,
    capAuthorizationId: authorization.authorizationId,
    capAuthorizationHash: prepared.authorizationHash,
    globalCaps: { ...ledger!.globalCaps },
    childDescriptorHash: acquisitionHash(buildTask116CampaignChildren(sample.plan)[0]),
    instrument: sample.plan.instrument,
    bucket: sample.plan.bucket,
    region: sample.plan.region,
    requesterPays: true,
    authorizedAt: sample.input.authorizedAt,
    expiresAt: sample.input.expiresAt,
    operatorApprovalReference: "OP-CHILD-ONE-APPROVAL",
    operatorApprovalHash: acquisitionHash("isolated reviewed child approval evidence"),
    reason: "Reviewed child one inventory preparation only with no execution.",
  };
  return { ...sample, expandedLedger: ledger!, childInput };
}

test("child preparation validates without writes and persists one immutable derived approval", async () => {
  const sample = await childPreparationFixture();
  const before = storeFingerprint(sample.rootStore);
  const forbidden = () => {
    throw Error("execution unreachable from child preparation");
  };
  const acquire = test.mock.method(DurableAcquisitionStore, "acquire", forbidden);
  const gate = test.mock.method(DurableAcquisitionStore.prototype, "gate", forbidden);
  const send = test.mock.method(DukascopyS3Session.prototype, "send", forbidden);
  try {
    const options = { projectRoot: sample.root, validateOnly: true };
    const checked = await DurableAcquisitionStore.prepareTask116CampaignChildApproval(sample.plan, sample.childInput, options);
    assert.equal(checked.mode, "VALIDATE_ONLY");
    assert.equal(storeFingerprint(sample.rootStore), before);
    assert.equal(existsSync(join(sample.rootStore, "child-approvals")), false);
    const prepared = await DurableAcquisitionStore.prepareTask116CampaignChildApproval(sample.plan, sample.childInput, { projectRoot: sample.root });
    assert.equal(prepared.mode, "PREPARED");
    assert.equal(prepared.approvalHash, checked.approvalHash);
    const file = join(sample.root, prepared.approvalPath);
    const bytes = readFileSync(file);
    const wrapper = JSON.parse(bytes.toString());
    assert.equal(wrapper.hash, acquisitionHash(wrapper.data));
    assert.equal(wrapper.hash, prepared.approvalHash);
    assert.deepEqual(wrapper.data.keys, buildTask116CampaignChildren(sample.plan)[0].keys);
    assert.deepEqual(wrapper.data.caps, { maxHeadAttempts: 8, maxObjects: 7, maxRetries: 0, maxGetAttempts: 0, maxNetworkBytes: 0, maxVerifiedBytes: 0 });
    assert.equal(wrapper.data.globalCaps.maxHeadAttempts, 44);
    assert.equal(wrapper.data.recoveryAllowance.maxIndeterminateHeadRetries, 1);
    assert.equal(wrapper.data.campaignPreparation.childSequence, 1);
    assert.equal((await DurableAcquisitionStore.prepareTask116CampaignChildApproval(sample.plan, sample.childInput, { projectRoot: sample.root })).mode, "EXISTING");
    assert.ok(bytes.equals(readFileSync(file)));
    await assert.rejects(() => DurableAcquisitionStore.prepareTask116CampaignChildApproval(sample.plan, { ...sample.childInput, reason: "Conflicting approval under the same identifier must reject." }, { projectRoot: sample.root }), /APPROVAL_VIOLATION/);
    assert.equal(storeFingerprint(sample.rootStore, file), before);
    assert.equal(readdirSync(join(sample.rootStore, "child-approvals")).length, 1);
    const ledger = JSON.parse(readFileSync(join(sample.rootStore, "ledger.json"), "utf8")).data;
    assert.equal(ledger.campaignBudgets[sample.childInput.campaignId].children[0].status, "PENDING");
    assert.equal(ledger.totals.headAttempts, 9);
    assert.equal(ledger.ledgerGeneration, 1);
    assert.equal(acquire.mock.callCount() + gate.mock.callCount() + send.mock.callCount(), 0);
  } finally {
    acquire.mock.restore();
    gate.mock.restore();
    send.mock.restore();
    sample.cleanup();
  }
});

function childPreparationCliArguments(input: CampaignChildApprovalPreparationInput): string[] {
  return [
    "child-authorize-prepare",
    "--approval-id",
    input.approvalId,
    "--campaign",
    input.campaignId,
    "--child-sequence",
    String(input.childSequence),
    "--inventory-revision",
    input.inventoryRevision,
    "--prior-ledger-hash",
    input.priorLedgerHash,
    "--prior-ledger-generation",
    String(input.priorLedgerGeneration),
    "--master-plan-hash",
    input.masterPlanHash,
    "--cap-authorization-id",
    input.capAuthorizationId,
    "--cap-authorization-hash",
    input.capAuthorizationHash,
    "--operator-approval-reference",
    input.operatorApprovalReference,
    "--operator-approval-hash",
    input.operatorApprovalHash,
    "--authorized-at",
    input.authorizedAt,
    "--expires-at",
    input.expiresAt,
    "--reason",
    input.reason,
  ];
}

const invalidChildPreparationInputs: Array<[string, (input: CampaignChildApprovalPreparationInput) => Partial<CampaignChildApprovalPreparationInput>]> = [
  ["wrong campaign", () => ({ campaignId: "other-campaign" })],
  ["wrong child sequence", () => ({ childSequence: 2 })],
  ["out of range child", () => ({ childSequence: 6 })],
  ["stale ledger hash", () => ({ priorLedgerHash: "0".repeat(64) })],
  ["stale ledger generation", () => ({ priorLedgerGeneration: 2 })],
  ["stale inventory revision", () => ({ inventoryRevision: "0".repeat(64) })],
  ["wrong master plan", () => ({ masterPlanHash: "0".repeat(64) })],
  ["wrong cap authorization ID", () => ({ capAuthorizationId: "other-authorization" })],
  ["wrong cap authorization hash", () => ({ capAuthorizationHash: "0".repeat(64) })],
  ["global caps mismatch", (input) => ({ globalCaps: { ...input.globalCaps, maxHeadAttempts: 45 } })],
  ["descriptor mismatch", () => ({ childDescriptorHash: "0".repeat(64) })],
  ["missing operator evidence", () => ({ operatorApprovalReference: "" })],
  ["malformed operator hash", () => ({ operatorApprovalHash: "bad-hash" })],
  ["placeholder operator evidence", () => ({ operatorApprovalReference: "PLACEHOLDER", operatorApprovalHash: "0".repeat(64) })],
  ["expired evidence", () => ({ expiresAt: "2020-01-01T00:00:00.000Z" })],
  ["expiry ordering", (input) => ({ expiresAt: input.authorizedAt })],
  ["nonfinite expiry", () => ({ expiresAt: "Infinity" })],
  ["unbounded lifetime", () => ({ expiresAt: "9999-01-01T00:00:00.000Z" })],
  ["future authorized time", () => ({ authorizedAt: new Date(Date.now() + 7_200_000).toISOString() })],
  ["empty reason", () => ({ reason: "" })],
  ["secret-like evidence", () => ({ reason: "Bearer credential must never be written to durable state." })],
  ["unsafe output ID", () => ({ approvalId: "../outside" })],
  ["prototype output ID", () => ({ approvalId: "__proto__" })],
];

for (const [name, change] of invalidChildPreparationInputs)
  test(`child preparation rejects ${name} without writes`, async () => {
    const sample = await childPreparationFixture();
    const before = storeFingerprint(sample.rootStore);
    try {
      await assert.rejects(() => DurableAcquisitionStore.prepareTask116CampaignChildApproval(sample.plan, { ...sample.childInput, ...change(sample.childInput) }, { projectRoot: sample.root }));
      assert.equal(storeFingerprint(sample.rootStore), before);
      assert.equal(existsSync(join(sample.rootStore, "child-approvals")), false);
    } finally {
      sample.cleanup();
    }
  });

test("child preparation derives scope and rejects caller-controlled ranges keys caps and allocations", async () => {
  const sample = await childPreparationFixture();
  const before = storeFingerprint(sample.rootStore);
  try {
    for (const extra of [{ batchStart: sample.plan.requestedStart }, { keys: sample.plan.keys }, { caps: { maxHeadAttempts: 999 } }, { maxObjects: 99 }, { maxRetries: 2 }, { recoveryAllowance: 99 }, { normalHeadBudget: 999 }, { outputPath: "outside.json" }]) {
      await assert.rejects(() => DurableAcquisitionStore.prepareTask116CampaignChildApproval(sample.plan, { ...sample.childInput, ...extra }, { projectRoot: sample.root }), /APPROVAL_VIOLATION/);
    }
    assert.equal(storeFingerprint(sample.rootStore), before);
  } finally {
    sample.cleanup();
  }
});

test("child preparation rejects non-PENDING, stopped, active or stale durable state", async () => {
  const sample = await childPreparationFixture();
  try {
    for (const status of ["IN_PROGRESS", "COMPLETED", "STOPPED"] as const) {
      const ledger = structuredClone(sample.expandedLedger);
      ledger.campaignBudgets![sample.childInput.campaignId].children[0].status = status;
      writeFileSync(join(sample.rootStore, "ledger.json"), JSON.stringify({ hash: acquisitionHash(ledger), data: ledger }));
      const before = storeFingerprint(sample.rootStore);
      await assert.rejects(() => DurableAcquisitionStore.prepareTask116CampaignChildApproval(sample.plan, { ...sample.childInput, priorLedgerHash: acquisitionHash(ledger) }, { projectRoot: sample.root }), /APPROVAL_VIOLATION/);
      assert.equal(storeFingerprint(sample.rootStore), before);
    }
    const stopped = structuredClone(sample.expandedLedger);
    stopped.campaignBudgets![sample.childInput.campaignId].status = "STOPPED";
    writeFileSync(join(sample.rootStore, "ledger.json"), JSON.stringify({ hash: acquisitionHash(stopped), data: stopped }));
    await assert.rejects(() => DurableAcquisitionStore.prepareTask116CampaignChildApproval(sample.plan, { ...sample.childInput, priorLedgerHash: acquisitionHash(stopped) }, { projectRoot: sample.root }), /APPROVAL_VIOLATION/);
    const active = { ...sample.expandedLedger, active: { operation: "HEAD", key: sample.plan.keys[0], approvalId: "other-approval" } };
    writeFileSync(join(sample.rootStore, "ledger.json"), JSON.stringify({ hash: acquisitionHash(active), data: active }));
    await assert.rejects(() => DurableAcquisitionStore.prepareTask116CampaignChildApproval(sample.plan, { ...sample.childInput, priorLedgerHash: acquisitionHash(active) }, { projectRoot: sample.root }), /APPROVAL_VIOLATION/);
    writeFileSync(join(sample.rootStore, "ledger.json"), JSON.stringify({ hash: acquisitionHash(sample.expandedLedger), data: sample.expandedLedger }));
    writeFileSync(join(sample.rootStore, "writer.lock"), JSON.stringify({ token: "another-writer" }));
    await assert.rejects(() => DurableAcquisitionStore.prepareTask116CampaignChildApproval(sample.plan, sample.childInput, { projectRoot: sample.root, validateOnly: true }), /FILESYSTEM_UNSAFE/);
    assert.equal(existsSync(join(sample.rootStore, "child-approvals")), false);
  } finally {
    sample.cleanup();
  }
});

test("child preparation enforces completed predecessor revisions for children 2 through 5", async () => {
  const sample = await childPreparationFixture();
  const ledger = structuredClone(sample.expandedLedger);
  let snapshot = sample.seed;
  try {
    for (let sequence = 1; sequence <= 5; sequence++) {
      const descriptor = buildTask116CampaignChildren(sample.plan)[sequence - 1];
      const input = { ...sample.childInput, approvalId: `isolated-sequential-child-${sequence}`, childSequence: sequence, priorLedgerHash: acquisitionHash(ledger), inventoryRevision: snapshot.revision, childDescriptorHash: acquisitionHash(descriptor) };
      if (sequence === 1) {
        const second = { ...input, childSequence: 2, childDescriptorHash: acquisitionHash(buildTask116CampaignChildren(sample.plan)[1]) };
        await assert.rejects(() => DurableAcquisitionStore.prepareTask116CampaignChildApproval(sample.plan, second, { projectRoot: sample.root }), /APPROVAL_VIOLATION/);
      }
      if (sequence > 1) {
        const wrong = structuredClone(ledger);
        wrong.campaignBudgets![input.campaignId].currentInventoryRevision = sample.seed.revision;
        writeFileSync(join(sample.rootStore, "ledger.json"), JSON.stringify({ hash: acquisitionHash(wrong), data: wrong }));
        await assert.rejects(() => DurableAcquisitionStore.prepareTask116CampaignChildApproval(sample.plan, { ...input, priorLedgerHash: acquisitionHash(wrong), inventoryRevision: sample.seed.revision }, { projectRoot: sample.root }), /APPROVAL_VIOLATION/);
        writeFileSync(join(sample.rootStore, "ledger.json"), JSON.stringify({ hash: acquisitionHash(ledger), data: ledger }));
      }
      const before = storeFingerprint(sample.rootStore);
      const checked = await DurableAcquisitionStore.prepareTask116CampaignChildApproval(sample.plan, input, { projectRoot: sample.root, validateOnly: true });
      assert.equal(storeFingerprint(sample.rootStore), before);
      assert.equal(checked.validation.keyCount, sequence === 5 ? 2 : 7);
      assert.equal(checked.validation.caps.maxHeadAttempts, sequence === 5 ? 3 : 8);
      const prepared = await DurableAcquisitionStore.prepareTask116CampaignChildApproval(sample.plan, input, { projectRoot: sample.root });
      const evidence = JSON.parse(readFileSync(join(sample.root, prepared.approvalPath), "utf8")).data;
      assert.deepEqual(evidence.keys, descriptor.keys);
      const entries = snapshot.entries.map((entry) => (descriptor.keys.includes(entry.key) ? { ...entry, status: "CONFIRMED_ABSENT" as const, checkedAt: new Date().toISOString(), attempts: 1 } : entry));
      snapshot = createInventorySnapshot(sample.plan, entries);
      const campaign = ledger.campaignBudgets![input.campaignId];
      const child = campaign.children[sequence - 1];
      child.status = "COMPLETED";
      child.approvalId = evidence.id;
      child.approvalHash = prepared.approvalHash;
      child.outputRevision = snapshot.revision;
      campaign.currentChildSequence = sequence + 1;
      campaign.currentInventoryRevision = snapshot.revision;
      campaign.normalHeadAttempts += descriptor.keys.length;
      ledger.totals.headAttempts += descriptor.keys.length;
      for (const key of descriptor.keys) ledger.attempts[`HEAD:${key}`] = 1;
      if (sequence === 5) campaign.status = "COMPLETED";
      writeFileSync(join(sample.rootStore, "inventories", `${snapshot.revision}.json`), JSON.stringify({ hash: acquisitionHash(snapshot), data: snapshot }));
      writeFileSync(join(sample.rootStore, "ledger.json"), JSON.stringify({ hash: acquisitionHash(ledger), data: ledger }));
    }
    assert.equal(readdirSync(join(sample.rootStore, "child-approvals")).length, 5);
    assert.equal(sample.calls(), 0);
  } finally {
    sample.cleanup();
  }
});

test("child preparation rejects nonignored tracked symlink and corrupted outputs", async () => {
  const sample = await childPreparationFixture();
  const relativeFile = `tmp/dukascopy/s3-production/child-approvals/${sample.childInput.approvalId}.json`;
  const file = join(sample.root, relativeFile);
  try {
    writeFileSync(join(sample.root, ".gitignore"), "");
    await assert.rejects(() => DurableAcquisitionStore.prepareTask116CampaignChildApproval(sample.plan, sample.childInput, { projectRoot: sample.root }), /FILESYSTEM_UNSAFE/);
    writeFileSync(join(sample.root, ".gitignore"), "/tmp/dukascopy/\n");
    mkdirSync(join(sample.rootStore, "child-approvals"));
    writeFileSync(file, JSON.stringify({ hash: "0".repeat(64), data: {} }));
    await assert.rejects(() => DurableAcquisitionStore.prepareTask116CampaignChildApproval(sample.plan, sample.childInput, { projectRoot: sample.root }), /FILESYSTEM_UNSAFE/);
    execFileSync("git", ["add", "--force", "--", relativeFile], { cwd: sample.root });
    await assert.rejects(() => DurableAcquisitionStore.prepareTask116CampaignChildApproval(sample.plan, sample.childInput, { projectRoot: sample.root }), /FILESYSTEM_UNSAFE/);
    execFileSync("git", ["rm", "--cached", "--force", "--", relativeFile], { cwd: sample.root, stdio: "ignore" });
    rmSync(file);
    symlinkSync(join(sample.rootStore, "ledger.json"), file);
    await assert.rejects(() => DurableAcquisitionStore.prepareTask116CampaignChildApproval(sample.plan, sample.childInput, { projectRoot: sample.root }), /FILESYSTEM_UNSAFE/);
    rmSync(file);
    rmSync(join(sample.rootStore, "child-approvals"), { recursive: true });
    symlinkSync(join(sample.rootStore, "progress"), join(sample.rootStore, "child-approvals"));
    await assert.rejects(() => DurableAcquisitionStore.prepareTask116CampaignChildApproval(sample.plan, sample.childInput, { projectRoot: sample.root }), /FILESYSTEM_UNSAFE/);
    await assert.rejects(() => DurableAcquisitionStore.prepareTask116CampaignChildApproval(sample.plan, sample.childInput, { projectRoot: sample.rootStore }));
  } finally {
    sample.cleanup();
  }
});

test("child preparation CLI is offline-only explicit and never executes inventory", async () => {
  const sample = await childPreparationFixture();
  sample.runtime.confirm = async () => {
    throw Error("inventory confirmation unreachable");
  };
  try {
    for (const argv of [["child-authorize-prepare"], ["child-authorize-prepare", "--help"]]) {
      assert.equal(await runInventoryOperatorCli(argv, sample.emit, sample.runtime), 0);
      assert.equal(sample.output.at(-1)!.operation, "PREPARE CHILD APPROVAL ONLY - DOES NOT EXECUTE INVENTORY");
    }
    const args = childPreparationCliArguments(sample.childInput);
    const before = storeFingerprint(sample.rootStore);
    assert.equal(await runInventoryOperatorCli([...args, "--validate-only"], sample.emit, sample.runtime), 0);
    assert.equal(sample.output.at(-1)!.mode, "VALIDATE_ONLY");
    assert.equal(storeFingerprint(sample.rootStore), before);
    for (const flag of ["--live", "--execute", "--start", "--keys", "--caps", "--output", "--download"]) assert.equal(await runInventoryOperatorCli([...args, flag, "anything"], sample.emit, sample.runtime), 1);
    assert.equal(await runInventoryOperatorCli(args.slice(0, -2), sample.emit, sample.runtime), 1);
    assert.equal(await runInventoryOperatorCli([...args, "--child-sequence", "2"], sample.emit, sample.runtime), 1);
    assert.equal(await runInventoryOperatorCli(args, sample.emit, sample.runtime), 0);
    assert.equal(sample.output.at(-1)!.mode, "PREPARED");
    assert.equal(sample.output.at(-1)!.inventoryExecuted, false);
    assert.equal(sample.calls(), 0);
    const preparedPath = sample.output.at(-1)!.approvalPath as string;
    execFileSync("git", ["check-ignore", "--quiet", "--", preparedPath], { cwd: sample.root });
    assert.equal(execFileSync("git", ["ls-files", "--", preparedPath], { cwd: sample.root, encoding: "utf8" }), "");
  } finally {
    sample.cleanup();
  }
});

test("child preparation cannot construct SDK resolve credentials call transport gate or runners", async () => {
  const sample = await childPreparationFixture();
  try {
    const script = `
      const Module = require('node:module'); const original = Module._load;
      const forbidden = () => { throw Error('CHILD_PREPARATION_EXECUTION_FORBIDDEN'); };
      Module._load = function(name, ...args) {
        const loaded = original.call(this, name, ...args);
        if (name === '@aws-sdk/client-s3') return { ...loaded, S3Client: class { constructor() { forbidden(); } } };
        if (name === '@aws-sdk/credential-providers') return new Proxy(loaded, { get(target, property) { return String(property).startsWith('from') ? forbidden : target[property]; } });
        return loaded;
      };
      require('node:http').request = require('node:https').request = require('node:tls').connect = forbidden;
      require('node:net').Socket.prototype.connect = globalThis.fetch = forbidden;
      const durable = require(${JSON.stringify(require.resolve("../lib/backtest/dukascopy-s3-durable"))});
      durable.DurableAcquisitionStore.acquire = durable.DurableAcquisitionStore.prototype.gate = durable.DurableAcquisitionStore.prototype.applyTask116CampaignCapExpansion = forbidden;
      const runner = require(${JSON.stringify(require.resolve("../lib/backtest/dukascopy-s3-runner"))});
      runner.runDukascopyInventory = runner.runDukascopyDownload = forbidden;
      const cli = require(${JSON.stringify(require.resolve("../lib/backtest/dukascopy-inventory-cli"))});
      cli.runInventoryOperatorCli(${JSON.stringify(childPreparationCliArguments(sample.childInput))}, value => console.log(JSON.stringify(value)), { projectRoot: ${JSON.stringify(sample.root)} }).then(code => { process.exitCode = code; });
    `;
    const result = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", env: process.env });
    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(result.stdout.trim());
    assert.equal(summary.mode, "PREPARED");
    assert.equal(summary.awsRequests, 0);
    assert.equal(summary.credentialResolution, 0);
    assert.equal(summary.inventoryExecuted, false);
  } finally {
    sample.cleanup();
  }
});

test("child preparation evidence is mandatory and execution rejects missing tampered or stale approval", async () => {
  const sample = await childPreparationFixture();
  const prepared = await DurableAcquisitionStore.prepareTask116CampaignChildApproval(sample.plan, sample.childInput, { projectRoot: sample.root });
  const file = join(sample.root, prepared.approvalPath);
  const bytes = readFileSync(file);
  const approval = JSON.parse(bytes.toString()).data as AcquisitionApproval;
  const store = await DurableAcquisitionStore.acquire(sample.rootStore);
  try {
    const before = readFileSync(join(sample.rootStore, "ledger.json"));
    rmSync(file);
    await assert.rejects(() => store.gate(sample.plan, approval, sample.seed), /APPROVAL_VIOLATION/);
    assert.ok(before.equals(readFileSync(join(sample.rootStore, "ledger.json"))));
    writeFileSync(file, bytes);
    await assert.rejects(() => store.gate(sample.plan, { ...approval, caps: { ...approval.caps, maxHeadAttempts: 9 } }, sample.seed), /APPROVAL_VIOLATION/);
    assert.ok(before.equals(readFileSync(join(sample.rootStore, "ledger.json"))));
    const changed = { ...sample.expandedLedger, updatedAt: new Date().toISOString() };
    await store.document("ledger.json", changed);
    const staleBefore = readFileSync(join(sample.rootStore, "ledger.json"));
    await assert.rejects(() => store.gate(sample.plan, approval, sample.seed), /APPROVAL_VIOLATION/);
    assert.ok(staleBefore.equals(readFileSync(join(sample.rootStore, "ledger.json"))));
    assert.equal(sample.calls(), 0);
  } finally {
    await store.release();
    sample.cleanup();
  }
});

test("child preparation approval works only through a separately confirmed isolated inventory invocation", async () => {
  const sample = await childPreparationFixture();
  try {
    const prepared = await DurableAcquisitionStore.prepareTask116CampaignChildApproval(sample.plan, sample.childInput, { projectRoot: sample.root });
    assert.equal(sample.calls(), 0);
    const args = ["inventory", "--live", "--approval", prepared.approvalPath, "--start", "2021-01-08", "--end-exclusive", "2021-01-15"];
    sample.runtime.confirm = async () => inventoryConfirmationPhrase(parseInventoryCliArguments(args), 7);
    assert.equal(await runInventoryOperatorCli(args, sample.emit, sample.runtime), 0);
    assert.equal(sample.calls(), 7);
    const ledger = JSON.parse(readFileSync(join(sample.rootStore, "ledger.json"), "utf8")).data;
    const campaign = ledger.campaignBudgets[sample.childInput.campaignId];
    assert.equal(ledger.globalCaps.maxHeadAttempts, 44);
    assert.equal(ledger.ledgerGeneration, 1);
    assert.equal(ledger.totals.headAttempts, 16);
    assert.equal(campaign.normalHeadAttempts, 7);
    assert.equal(campaign.recoveryHeadAttempts, 0);
    assert.equal(campaign.children[0].status, "COMPLETED");
    assert.equal(campaign.children[1].status, "PENDING");
    assert.equal(readdirSync(join(sample.rootStore, "child-approvals")).length, 1);
  } finally {
    sample.cleanup();
  }
});

test("cap preparation CLI help, validate-only and prepare never activate live inventory", async () => {
  const sample = await capPreparationFixture();
  const ledgerBefore = readFileSync(join(sample.rootStore, "ledger.json"));
  const before = readdirSync(sample.rootStore, { recursive: true }).sort();
  sample.runtime.confirm = async () => {
    throw Error("interactive inventory unreachable");
  };
  try {
    for (const args of [["cap-authorize-prepare"], ["cap-authorize-prepare", "--help"]]) {
      assert.equal(await runInventoryOperatorCli(args, sample.emit, sample.runtime), 0);
      assert.equal(sample.output.at(-1)!.operation, "PREPARE AUTHORIZATION ONLY - DOES NOT APPLY CAP EXPANSION");
    }
    const args = capPreparationCliArguments(sample.input);
    assert.equal(await runInventoryOperatorCli([...args, "--validate-only"], sample.emit, sample.runtime), 0);
    assert.equal(sample.output.at(-1)!.mode, "VALIDATE_ONLY");
    assert.deepEqual(readdirSync(sample.rootStore, { recursive: true }).sort(), before);
    assert.equal(await runInventoryOperatorCli(args, sample.emit, sample.runtime), 0);
    assert.equal(sample.output.at(-1)!.mode, "PREPARED");
    assert.equal(sample.output.at(-1)!.capExpansionApplied, false);
    assert.equal(sample.output.at(-1)!.inventoryAuthorized, false);
    assert.equal(await runInventoryOperatorCli(args, sample.emit, sample.runtime), 0);
    assert.equal(sample.output.at(-1)!.mode, "EXISTING");
    for (const forbidden of ["--live", "--apply", "--new-cap", "--output", "--approval", "--download"]) {
      assert.equal(await runInventoryOperatorCli([...args, forbidden, "45"], sample.emit, sample.runtime), 1);
    }
    assert.equal(await runInventoryOperatorCli(args.slice(0, -2), sample.emit, sample.runtime), 1);
    assert.equal(await runInventoryOperatorCli([...args, "--validate-only", "--validate-only"], sample.emit, sample.runtime), 1);
    assert.equal(sample.calls(), 0);
    assert.ok(ledgerBefore.equals(readFileSync(join(sample.rootStore, "ledger.json"))));
    assert.equal(existsSync(join(sample.rootStore, "writer.lock")), false);
    assert.equal(readdirSync(join(sample.rootStore, "cap-expansions")).length, 1);
  } finally {
    sample.cleanup();
  }
});

test("cap preparation CLI makes SDK construction, credentials, apply and all runners unreachable", async () => {
  const sample = await capPreparationFixture();
  try {
    const script = `
      const Module = require('node:module');
      const original = Module._load;
      Module._load = function(name, ...args) {
        const loaded = original.call(this, name, ...args);
        if (name === '@aws-sdk/client-s3') return { ...loaded, S3Client: class { constructor() { throw Error('SDK_CONSTRUCTION_FORBIDDEN'); } } };
        if (name === '@aws-sdk/credential-providers') return new Proxy(loaded, { get(target, property) { if (String(property).startsWith('from')) return () => { throw Error('CREDENTIAL_RESOLUTION_FORBIDDEN'); }; return target[property]; } });
        return loaded;
      };
      const durable = require(${JSON.stringify(require.resolve("../lib/backtest/dukascopy-s3-durable"))});
      durable.DurableAcquisitionStore.acquire = () => { throw Error('WRITER_LOCK_FORBIDDEN'); };
      durable.DurableAcquisitionStore.prototype.applyTask116CampaignCapExpansion = () => { throw Error('APPLY_FORBIDDEN'); };
      const runners = require(${JSON.stringify(require.resolve("../lib/backtest/dukascopy-s3-runner"))});
      runners.runDukascopyInventory = runners.runDukascopyDownload = () => { throw Error('RUNNER_FORBIDDEN'); };
      const cli = require(${JSON.stringify(require.resolve("../lib/backtest/dukascopy-inventory-cli"))});
      cli.runInventoryOperatorCli(${JSON.stringify(capPreparationCliArguments(sample.input))}, value => console.log(JSON.stringify(value)), { projectRoot: ${JSON.stringify(sample.root)} }).then(code => { process.exitCode = code; });
    `;
    const result = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", env: process.env });
    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(result.stdout.trim());
    assert.equal(summary.mode, "PREPARED");
    assert.equal(summary.awsRequests, 0);
    assert.equal(summary.credentialResolution, 0);
    assert.equal(summary.capExpansionApplied, false);
  } finally {
    sample.cleanup();
  }
});

const invalidPreparationInputs: Array<[string, (input: CampaignCapAuthorizationPreparationInput) => Partial<CampaignCapAuthorizationPreparationInput>]> = [
  ["missing operator reference", () => ({ operatorApprovalReference: "" })],
  ["missing operator hash", () => ({ operatorApprovalHash: "" })],
  ["placeholder evidence", () => ({ operatorApprovalReference: "PLACEHOLDER", operatorApprovalHash: "0".repeat(64) })],
  ["malformed operator hash", () => ({ operatorApprovalHash: "not-a-hash" })],
  ["expired", () => ({ expiresAt: "2020-01-01T00:00:00.000Z" })],
  ["invalid expiry ordering", (input) => ({ expiresAt: input.authorizedAt })],
  ["future approval", () => ({ authorizedAt: new Date(Date.now() + 3_600_000).toISOString() })],
  ["nonfinite expiry", () => ({ expiresAt: "Infinity" })],
  ["unreasonable expiry", () => ({ expiresAt: "9999-01-01T00:00:00.000Z" })],
  ["missing reason", () => ({ reason: "" })],
  ["secret-like reason", () => ({ reason: "Bearer private credential must not be persisted." })],
  ["prior ledger hash", () => ({ priorLedgerHash: "0".repeat(64) })],
  ["prior ledger generation", () => ({ priorLedgerGeneration: 1 })],
  ["snapshot revision", () => ({ initialInventoryRevision: "0".repeat(64) })],
  ["master plan", () => ({ masterPlanHash: "0".repeat(64) })],
  ["campaign", () => ({ campaignId: "other-campaign" })],
  ["window", () => ({ campaignEnd: "2021-02-08T00:00:00.000Z" as CampaignCapAuthorizationPreparationInput["campaignEnd"] })],
  ["child descriptors", (input) => ({ children: input.children.slice(1) })],
  ["child key order", (input) => ({ children: input.children.map((child) => ({ ...child, keys: [...child.keys].reverse() })) })],
  ["child recovery", (input) => ({ children: input.children.map((child) => ({ ...child, recoveryAllowance: 2 })) })],
  ["old cap", (input) => ({ oldGlobalCaps: { ...input.oldGlobalCaps, maxHeadAttempts: 20 } })],
  ["proposed cap", (input) => ({ newGlobalCaps: { ...input.newGlobalCaps, maxHeadAttempts: 45 } })],
  ["unrelated global caps", (input) => ({ newGlobalCaps: { ...input.newGlobalCaps, maxGetAttempts: 1 } })],
  ["source", () => ({ bucket: "wrong-bucket" as CampaignCapAuthorizationPreparationInput["bucket"] })],
  ["pair", () => ({ instrument: "EURUSD" as CampaignCapAuthorizationPreparationInput["instrument"] })],
  ["unsafe output ID", () => ({ authorizationId: "../escape" })],
];

for (const [name, change] of invalidPreparationInputs)
  test(`cap preparation rejects ${name} without writing`, async () => {
    const sample = await capPreparationFixture();
    const before = readdirSync(sample.rootStore, { recursive: true }).sort();
    const ledgerBefore = readFileSync(join(sample.rootStore, "ledger.json"));
    try {
      await assert.rejects(() => DurableAcquisitionStore.prepareTask116CampaignCapExpansionAuthorization(sample.plan, { ...sample.input, ...change(sample.input) }, { projectRoot: sample.root }));
      assert.deepEqual(readdirSync(sample.rootStore, { recursive: true }).sort(), before);
      assert.ok(ledgerBefore.equals(readFileSync(join(sample.rootStore, "ledger.json"))));
    } finally {
      sample.cleanup();
    }
  });

test("cap preparation rejects arbitrary fields, writer lock, active HEAD and stale ledger", async () => {
  const sample = await capPreparationFixture();
  try {
    await assert.rejects(() => DurableAcquisitionStore.prepareTask116CampaignCapExpansionAuthorization(sample.plan, { ...sample.input, outputPath: "outside.json" } as CampaignCapAuthorizationPreparationInput, { projectRoot: sample.root }), /APPROVAL_VIOLATION/);
    await assert.rejects(() => DurableAcquisitionStore.prepareTask116CampaignCapExpansionAuthorization(sample.plan, sample.input, { projectRoot: sample.rootStore }));
    writeFileSync(join(sample.rootStore, "writer.lock"), JSON.stringify({ token: "existing-writer" }));
    await assert.rejects(() => DurableAcquisitionStore.prepareTask116CampaignCapExpansionAuthorization(sample.plan, sample.input, { projectRoot: sample.root, validateOnly: true }), /FILESYSTEM_UNSAFE/);
    rmSync(join(sample.rootStore, "writer.lock"));
    const active = { ...sample.ledger, active: { operation: "HEAD", key: sample.plan.keys[0], approvalId: sample.approval.id } };
    writeFileSync(join(sample.rootStore, "ledger.json"), JSON.stringify({ hash: acquisitionHash(active), data: active }));
    await assert.rejects(() => DurableAcquisitionStore.prepareTask116CampaignCapExpansionAuthorization(sample.plan, sample.input, { projectRoot: sample.root }), /APPROVAL_VIOLATION/);
    const changed = { ...sample.ledger, updatedAt: new Date().toISOString() };
    writeFileSync(join(sample.rootStore, "ledger.json"), JSON.stringify({ hash: acquisitionHash(changed), data: changed }));
    await assert.rejects(() => DurableAcquisitionStore.prepareTask116CampaignCapExpansionAuthorization(sample.plan, sample.input, { projectRoot: sample.root }), /APPROVAL_VIOLATION/);
    assert.equal(readdirSync(join(sample.rootStore, "cap-expansions")).length, 0);
  } finally {
    sample.cleanup();
  }
});

test("cap preparation rejects nonignored, tracked and symlink authorization outputs", async () => {
  const sample = await capPreparationFixture();
  const relativeFile = `tmp/dukascopy/s3-production/cap-expansions/${sample.input.authorizationId}.json`;
  try {
    writeFileSync(join(sample.root, ".gitignore"), "");
    await assert.rejects(() => DurableAcquisitionStore.prepareTask116CampaignCapExpansionAuthorization(sample.plan, sample.input, { projectRoot: sample.root }), /FILESYSTEM_UNSAFE/);
    writeFileSync(join(sample.root, ".gitignore"), "/tmp/dukascopy/\n");
    const file = join(sample.root, relativeFile);
    writeFileSync(file, "{}");
    execFileSync("git", ["add", "--force", "--", relativeFile], { cwd: sample.root });
    await assert.rejects(() => DurableAcquisitionStore.prepareTask116CampaignCapExpansionAuthorization(sample.plan, sample.input, { projectRoot: sample.root }), /FILESYSTEM_UNSAFE/);
    execFileSync("git", ["rm", "--cached", "--force", "--", relativeFile], { cwd: sample.root, stdio: "ignore" });
    rmSync(file);
    symlinkSync(join(sample.rootStore, "ledger.json"), file);
    await assert.rejects(() => DurableAcquisitionStore.prepareTask116CampaignCapExpansionAuthorization(sample.plan, sample.input, { projectRoot: sample.root }), /FILESYSTEM_UNSAFE/);
    rmSync(file);
    rmSync(join(sample.rootStore, "cap-expansions"), { recursive: true });
    symlinkSync(join(sample.rootStore, "progress"), join(sample.rootStore, "cap-expansions"));
    await assert.rejects(() => DurableAcquisitionStore.prepareTask116CampaignCapExpansionAuthorization(sample.plan, sample.input, { projectRoot: sample.root }), /FILESYSTEM_UNSAFE/);
  } finally {
    sample.cleanup();
  }
});

async function resumeFixture(status: "CONFIRMED_ABSENT" | "PRESENT" = "CONFIRMED_ABSENT") {
  const sample = await fixture();
  const empty = createInventorySnapshot(sample.plan, []);
  const entries = [...empty.entries];
  entries[0] = { ...entries[0], status, checkedAt: "2026-10-07T06:00:00.000Z", attempts: 2, metadata: status === "PRESENT" ? { contentLength: 100, etag: '"prior-approval-etag"', lastModified: null, storageClass: null, checksumType: null, checksums: {}, requestCharged: "requester" } : null };
  const seed = createInventorySnapshot(sample.plan, entries);
  const root = inventoryCliLocations(sample.root).storeRoot;
  const store = await DurableAcquisitionStore.acquire(root);
  await store.saveSnapshot(sample.plan, seed);
  const oldApproval = { ...sample.approval, id: "prior-diagnostic", batchId: "prior-one", keys: [sample.approval.keys[0]] };
  const oldGate = await store.gate(sample.plan, oldApproval);
  for (let attempt = 0; attempt < 2; attempt++) {
    await persistFailedHead(oldGate, sample.plan, sample.approval.keys[0], "AMBIGUOUS_ACCESS", attempt + 1);
  }
  await store.release();
  const approval: AcquisitionApproval = { ...sample.approval, id: "resume-seven", inventoryRevision: seed.revision, caps: { ...sample.approval.caps, maxObjects: 7, maxHeadAttempts: 6, maxRetries: 0 } };
  sample.save(approval);
  return { ...sample, rootStore: root, seed, approval, seedPath: join(root, "inventories", `${seed.revision}.json`) };
}

for (const status of ["CONFIRMED_ABSENT", "PRESENT"] as const)
  test(`revision-bound ${status} crosses approvals: full seven scope, only six HEADs`, async () => {
    const sample = await resumeFixture(status);
    const seedBefore = readFileSync(sample.seedPath);
    const sent: string[] = [];
    try {
      sample.runtime.fakeClient = {
        async send(command) {
          assert.ok(command instanceof HeadObjectCommand);
          sent.push(command.input.Key!);
          return HEAD_OK;
        },
      };
      assert.equal(await runInventoryOperatorCli(sample.args, sample.emit, sample.runtime), 0);
      assert.deepEqual(sent, sample.approval.keys.slice(1));
      assert.equal(sent.filter((key) => key === sample.approval.keys[0]).length, 0);
      const ledger = JSON.parse(readFileSync(join(sample.rootStore, "ledger.json"), "utf8")).data;
      assert.equal(ledger.attempts[`HEAD:${sample.approval.keys[0]}`], 2);
      assert.equal(ledger.contexts[sample.approval.id].counters.headAttempts, 6);
      const summary = sample.output.at(-1)!;
      assert.equal(summary.plannedKeyCount, 7);
      const snapshot = JSON.parse(readFileSync(join(sample.rootStore, "inventories", `${summary.snapshotRevision}.json`), "utf8")).data;
      assert.deepEqual(snapshot.entries[0], sample.seed.entries[0]);
      assert.ok(seedBefore.equals(readFileSync(sample.seedPath)));
      const store = await DurableAcquisitionStore.acquire(sample.rootStore);
      try {
        const gate = await store.gate(sample.plan, sample.approval, sample.seed);
        await assert.rejects(() => gate.before("HEAD", sample.approval.keys[0], 0), /APPROVAL_VIOLATION/);
        await assert.rejects(() => gate.before("HEAD", sample.approval.keys[1], 0), /APPROVAL_VIOLATION/);
        const unknownKey = "USDJPY/2021/00/08_ticks.bi5";
        await assert.rejects(() => gate.before("HEAD", unknownKey, 0), /APPROVAL_VIOLATION/);
        assert.equal((await store.ledger(sample.plan))!.totals.headAttempts, 8);
      } finally {
        await store.release();
      }
    } finally {
      sample.cleanup();
    }
  });

test("three new resolved keys survive interruption/restart; attempts and caps are not spent twice", async () => {
  const sample = await resumeFixture();
  const sent: string[] = [];
  try {
    sample.runtime.fakeClient = {
      async send(command) {
        assert.ok(command instanceof HeadObjectCommand);
        sent.push(command.input.Key!);
        if (sent.length === 3) setImmediate(() => sample.signals.emit("SIGINT"));
        return HEAD_OK;
      },
    };
    assert.equal(await runInventoryOperatorCli(sample.args, sample.emit, sample.runtime), 2);
    assert.equal(sent.length, 3);
    sample.runtime.fakeClient = {
      async send(command) {
        assert.ok(command instanceof HeadObjectCommand);
        sent.push(command.input.Key!);
        return HEAD_OK;
      },
    };
    assert.equal(await runInventoryOperatorCli(sample.args, sample.emit, sample.runtime), 0);
    assert.deepEqual(sent, sample.approval.keys.slice(1));
    assert.equal(new Set(sent).size, 6);
    const ledger = JSON.parse(readFileSync(join(sample.rootStore, "ledger.json"), "utf8")).data;
    assert.equal(ledger.contexts[sample.approval.id].counters.headAttempts, 6);
    assert.equal(ledger.attempts[`HEAD:${sample.approval.keys[0]}`], 2);
  } finally {
    sample.cleanup();
  }
});

for (const defect of ["missing", "hash", "revision", "plan", "range", "keys", "source", "master-range", "master-keys", "malformed-revision", "objects-six", "global-caps"] as const)
  test(`invalid resume snapshot ${defect} fails before fake HEAD`, async () => {
    const sample = await resumeFixture();
    try {
      if (defect === "missing") sample.save({ ...sample.approval, inventoryRevision: "0".repeat(64) });
      else {
        const wrapper = JSON.parse(readFileSync(sample.seedPath, "utf8"));
        if (defect === "hash") wrapper.hash = "0".repeat(64);
        if (defect === "revision") {
          wrapper.data.revision = "0".repeat(64);
          wrapper.hash = acquisitionHash(wrapper.data);
        }
        if (defect === "plan") {
          wrapper.data.planHash = "0".repeat(64);
          wrapper.hash = acquisitionHash(wrapper.data);
        }
        if (["source", "master-range", "master-keys"].includes(defect)) {
          if (defect === "source") wrapper.data.bucket = "other-source";
          if (defect === "master-range") wrapper.data.requestedStart = "2021-01-02T00:00:00.000Z";
          if (defect === "master-keys") wrapper.data.keys.reverse();
          const content = { ...wrapper.data };
          delete content.revision;
          wrapper.data.revision = acquisitionHash(content);
          wrapper.hash = acquisitionHash(wrapper.data);
          writeFileSync(join(sample.rootStore, "inventories", `${wrapper.data.revision}.json`), JSON.stringify(wrapper));
          sample.save({ ...sample.approval, inventoryRevision: wrapper.data.revision });
        }
        writeFileSync(sample.seedPath, JSON.stringify(wrapper));
        if (defect === "range") sample.save({ ...sample.approval, batchEnd: "2021-01-09T00:00:00.000Z" });
        if (defect === "keys") sample.save({ ...sample.approval, keys: sample.approval.keys.slice(1) });
        if (defect === "malformed-revision") sample.save({ ...sample.approval, inventoryRevision: "../inventories" });
        if (defect === "objects-six") sample.save({ ...sample.approval, caps: { ...sample.approval.caps, maxObjects: 6 } });
        if (defect === "global-caps") sample.save({ ...sample.approval, globalCaps: { ...sample.approval.globalCaps, maxHeadAttempts: 6 } });
      }
      assert.equal(await runInventoryOperatorCli(sample.args, sample.emit, sample.runtime), 1);
      assert.equal(sample.calls(), 0);
    } finally {
      sample.cleanup();
    }
  });

test("snapshot changed during confirmation is rejected before session activation", async () => {
  const sample = await resumeFixture();
  try {
    sample.runtime.confirm = async () => {
      const wrapper = JSON.parse(readFileSync(sample.seedPath, "utf8"));
      wrapper.hash = "0".repeat(64);
      writeFileSync(sample.seedPath, JSON.stringify(wrapper));
      return inventoryConfirmationPhrase(parseInventoryCliArguments(sample.args), 7);
    };
    assert.equal(await runInventoryOperatorCli(sample.args, sample.emit, sample.runtime), 1);
    assert.equal(sample.calls(), 0);
  } finally {
    sample.cleanup();
  }
});

for (const conflict of ["downgrade", "terminal-conflict"] as const)
  test(`bound progress ${conflict} cannot replace confirmed seed`, async () => {
    const sample = await resumeFixture();
    try {
      const store = await DurableAcquisitionStore.acquire(sample.rootStore);
      const empty = createInventorySnapshot(sample.plan, []).entries[0];
      const progress: InventoryEntry = conflict === "downgrade" ? empty : { ...sample.seed.entries[0], status: "PRESENT", metadata: { contentLength: 100, etag: '"conflict"', lastModified: null, storageClass: null, checksumType: null, checksums: {}, requestCharged: "requester" } };
      await store.saveInventoryEntry(sample.plan, sample.approval, progress);
      await store.release();
      assert.equal(await runInventoryOperatorCli(sample.args, sample.emit, sample.runtime), 1);
      assert.equal(sample.calls(), 0);
      assert.equal(JSON.parse(readFileSync(sample.seedPath, "utf8")).data.entries[0].status, "CONFIRMED_ABSENT");
    } finally {
      sample.cleanup();
    }
  });

test("unresolved HEAD cap is six even under caller misuse; no seventh operation", async () => {
  const sample = await resumeFixture();
  const store = await DurableAcquisitionStore.acquire(sample.rootStore);
  try {
    const gate = await store.gate(sample.plan, sample.approval, sample.seed);
    await assert.rejects(() => gate.before("HEAD", sample.approval.keys[0], 0), /APPROVAL_VIOLATION/);
    for (const key of sample.approval.keys.slice(1)) {
      await persistFailedHead(gate, sample.plan, key, "TRANSIENT", 1);
    }
    await assert.rejects(() => gate.before("HEAD", sample.approval.keys[1], 0), /CAP_EXCEEDED/);
    await assert.rejects(() => gate.before("GET", sample.approval.keys[1], 100), /APPROVAL_VIOLATION/);
    assert.equal((await store.ledger(sample.plan))!.contexts[sample.approval.id].counters.headAttempts, 6);
  } finally {
    await store.release();
    sample.cleanup();
  }
});

test("inventory operator defaults to DRY_RUN with frozen 1826 master and seven selected keys", async () => {
  for (const argv of [[], ["--dry-run"], ["plan"]]) {
    const output: unknown[] = [];
    assert.equal(await runInventoryOperatorCli(argv, (summary) => output.push(summary)), 0);
    const summary = output[0] as { mode: string; masterKeyCount: number; batchKeyCount: number; liveRequests: number };
    assert.equal(summary.mode, "DRY_RUN");
    assert.equal(summary.masterKeyCount, 1826);
    assert.equal(summary.batchKeyCount, 7);
    assert.equal(summary.liveRequests, 0);
  }
});

test("CLI stale-lock recovery is explicit, separately confirmed and keeps evidence", async () => {
  const sample = await fixture();
  const storeRoot = inventoryCliLocations(sample.root).storeRoot;
  mkdirSync(storeRoot, { recursive: true });
  const lock = { version: 2, pid: 2147483647, token: "dead-owner-cli-123456", createdAt: "2026-10-07T00:00:00.000Z", processStartedAt: "Tue Jan 1 00:00:00 2000", identityHash: "a".repeat(64) };
  writeFileSync(join(storeRoot, "writer.lock"), JSON.stringify(lock));
  const liveArgs = [...sample.args, "--recover-stale-lock"];
  const confirmations: string[] = [];
  sample.runtime.confirm = async (prompt) => {
    confirmations.push(prompt);
    if (prompt.includes("STALE WRITER LOCK RECOVERY ONLY")) return `RECLAIM STALE INVENTORY LOCK ${lock.pid} ${lock.createdAt}`;
    return inventoryConfirmationPhrase(parseInventoryCliArguments(liveArgs), 7);
  };
  try {
    assert.equal(await runInventoryOperatorCli(liveArgs, sample.emit, sample.runtime), 0);
    assert.equal(confirmations.length, 2);
    assert.match(confirmations[0], /STALE WRITER LOCK RECOVERY ONLY/);
    assert.match(confirmations[1], /HEAD INVENTORY USDJPY/);
    assert.equal(sample.calls(), 7);
    const recoveryFile = readdirSync(join(storeRoot, "locks")).find((name) => name.startsWith("recovery-"));
    assert.ok(recoveryFile);
    const evidence = JSON.parse(readFileSync(join(storeRoot, "locks", recoveryFile!), "utf8"));
    assert.equal(evidence.data.previousLock.token, lock.token);
  } finally {
    sample.cleanup();
  }
});

test("fake HEAD seven-key completion cleans store/session and prints only allowlisted summary", async () => {
  const sample = await fixture();
  let destroyed = 0;
  const original = DukascopyS3Session.prototype.destroy;
  const mock = test.mock.method(DukascopyS3Session.prototype, "destroy", function (this: DukascopyS3Session) {
    destroyed++;
    original.call(this);
  });
  try {
    assert.equal(await runInventoryOperatorCli(sample.args, sample.emit, sample.runtime), 0);
    assert.equal(sample.calls(), 7);
    assert.equal(destroyed, 1);
    assert.deepEqual(sample.output.at(-1)?.counts, { PRESENT: 7, CONFIRMED_ABSENT: 0, UNKNOWN: 0, ERROR: 0 });
    assert.equal(sample.output.at(-1)?.actualFiveYearBytes, null);
    assert.equal(sample.output.at(-1)?.batchBytesIfComplete, 700);
    assert.equal(sample.output.at(-1)?.GET, "disabled");
    assert.ok(!existsSync(join(inventoryCliLocations(sample.root).storeRoot, "writer.lock")));
    assert.equal(sample.signals.listenerCount("SIGINT"), 0);
    assert.equal(sample.signals.listenerCount("SIGTERM"), 0);
  } finally {
    mock.mock.restore();
    sample.cleanup();
  }
});

for (const reason of ["missing", "expired", "modified", "plan", "keys", "duplicates", "range", "over-cap"] as const)
  test(`approval ${reason} blocks before fake request`, async () => {
    const sample = await fixture();
    try {
      if (reason === "missing") sample.args[sample.args.indexOf("--approval") + 1] = `${INVENTORY_APPROVAL_DIRECTORY}/missing.json`;
      if (reason === "expired") sample.save({ ...sample.approval, expiresAt: "2020-01-01T00:00:00.000Z" });
      if (reason === "modified") {
        const changed = JSON.parse(readFileSync(sample.path, "utf8"));
        changed.data.caps.maxHeadAttempts = 20;
        writeFileSync(sample.path, JSON.stringify(changed));
      }
      if (reason === "plan") sample.save({ ...sample.approval, planHash: "0".repeat(64) });
      if (reason === "keys") sample.save({ ...sample.approval, keys: sample.approval.keys.slice(1) });
      if (reason === "duplicates") sample.save({ ...sample.approval, keys: [sample.approval.keys[0], sample.approval.keys[0]] });
      if (reason === "range") sample.save({ ...sample.approval, batchEnd: "2021-01-09T00:00:00.000Z" });
      if (reason === "over-cap") sample.save({ ...sample.approval, caps: { ...sample.approval.caps, maxObjects: 8 } });
      assert.equal(await runInventoryOperatorCli(sample.args, sample.emit, sample.runtime), 1);
      assert.equal(sample.calls(), 0);
      assert.ok(!existsSync(join(inventoryCliLocations(sample.root).storeRoot, "writer.lock")));
    } finally {
      sample.cleanup();
    }
  });

for (const value of ["incorrect confirmation", null])
  test(`confirmation ${value === null ? "EOF" : "mismatch"} requests nothing`, async () => {
    const sample = await fixture();
    try {
      sample.runtime.confirm = async () => fakeStdin(value);
      assert.equal(await runInventoryOperatorCli(sample.args, sample.emit, sample.runtime), 1);
      assert.equal(sample.calls(), 0);
    } finally {
      sample.cleanup();
    }
  });

test("approval changed during confirmation is re-read before SDK activation", async () => {
  const sample = await fixture();
  try {
    sample.runtime.confirm = async () => {
      sample.save({ ...sample.approval, id: "changed-approval" });
      return fakeStdin(inventoryConfirmationPhrase(parseInventoryCliArguments(sample.args), 7));
    };
    assert.equal(await runInventoryOperatorCli(sample.args, sample.emit, sample.runtime), 1);
    assert.equal(sample.calls(), 0);
  } finally {
    sample.cleanup();
  }
});

test("noninteractive and CI live activation fail closed", async () => {
  const sample = await fixture();
  try {
    for (const changes of [{ inputIsTTY: false }, { outputIsTTY: false }, { ci: true }]) assert.equal(await runInventoryOperatorCli(sample.args, sample.emit, { ...sample.runtime, ...changes }), 1);
    assert.equal(sample.calls(), 0);
  } finally {
    sample.cleanup();
  }
});

for (const [name, status] of [
  ["AccessDenied", 403],
  ["InvalidPayer", 403],
  ["ExpiredToken", 400],
  ["Unknown", 418],
] as const)
  test(`fake HEAD ${name} saves partial and returns nonzero`, async () => {
    const sample = await fixture();
    let calls = 0;
    try {
      sample.runtime.fakeClient = {
        async send() {
          if (++calls === 1) return { ...HEAD_OK, Authorization: "credential-secret-do-not-print" };
          throw awsError(name, status);
        },
      } as OfflineS3Sender;
      assert.equal(await runInventoryOperatorCli(sample.args, sample.emit, sample.runtime), 2);
      assert.equal(calls, 2);
      assert.deepEqual(sample.output.at(-1)?.counts, { PRESENT: 1, CONFIRMED_ABSENT: 0, UNKNOWN: 5, ERROR: 1 });
      assert.doesNotMatch(JSON.stringify(sample.output), /credential-secret|Authorization|RoleArn|accountId|sessionToken/);
      const root = inventoryCliLocations(sample.root).storeRoot;
      assert.ok(readdirSync(join(root, "inventories")).some((file) => file.endsWith(".json")));
      assert.ok(existsSync(join(root, "ledger.json")));
    } finally {
      sample.cleanup();
    }
  });

test("transient HEAD retry uses existing runner and maximum attempt ledger", async () => {
  const sample = await fixture();
  let calls = 0;
  try {
    sample.runtime.fakeClient = {
      async send() {
        if (++calls === 1) throw awsError("ServiceUnavailable", 503);
        return HEAD_OK;
      },
    };
    assert.equal(await runInventoryOperatorCli(sample.args, sample.emit, sample.runtime), 0);
    assert.equal(calls, 8);
    assert.equal(sample.output.at(-1)?.headAttempts, 8);
  } finally {
    sample.cleanup();
  }
});

test("resume skips both known PRESENT and confirmed 404 absence", async () => {
  const sample = await fixture();
  let calls = 0;
  try {
    sample.runtime.fakeClient = {
      async send() {
        if (++calls === 1) throw awsError("NoSuchKey", 404);
        return HEAD_OK;
      },
    };
    assert.equal(await runInventoryOperatorCli(sample.args, sample.emit, sample.runtime), 0);
    assert.equal(await runInventoryOperatorCli(sample.args, sample.emit, sample.runtime), 0);
    assert.equal(calls, 7);
    assert.deepEqual(sample.output.at(-1)?.counts, { PRESENT: 6, CONFIRMED_ABSENT: 1, UNKNOWN: 0, ERROR: 0 });
  } finally {
    sample.cleanup();
  }
});

for (const signal of ["SIGINT", "SIGTERM"] as const)
  test(`${signal} aborts HEAD, persists partial and always releases/destroys`, async () => {
    const sample = await fixture();
    let destroyed = 0;
    const original = DukascopyS3Session.prototype.destroy;
    const mock = test.mock.method(DukascopyS3Session.prototype, "destroy", function (this: DukascopyS3Session) {
      destroyed++;
      original.call(this);
    });
    try {
      sample.runtime.fakeClient = {
        async send() {
          sample.signals.emit(signal);
          return new Promise(() => {});
        },
      };
      assert.equal(await runInventoryOperatorCli(sample.args, sample.emit, sample.runtime), 2);
      assert.equal(destroyed, 1);
      assert.ok(!existsSync(join(inventoryCliLocations(sample.root).storeRoot, "writer.lock")));
      assert.equal(sample.signals.listenerCount(signal), 0);
    } finally {
      mock.mock.restore();
      sample.cleanup();
    }
  });

test("GET/LIST/download/decode/Phase1/import have no CLI path", async () => {
  for (const command of ["GET", "download", "decode", "phase1", "import", "LIST", "ListObjects", "ListObjectsV2", "sync"]) assert.equal(await runInventoryOperatorCli([command], () => {}), 1);
  const source = readFileSync(join(process.cwd(), "lib/backtest/dukascopy-inventory-cli.ts"), "utf8");
  assert.doesNotMatch(source, /runDukascopyDownload|downloadDukascopyS3PlanSequentially|GetObjectCommand|ListObjectsCommand|ListObjectsV2Command/);
  assert.match(source, /command instanceof HeadObjectCommand/);
});

test("tracked approval and approval symlink are rejected before a request", async () => {
  const sample = await fixture();
  try {
    execFileSync("git", ["-C", sample.root, "add", "-f", sample.path], { stdio: "ignore" });
    assert.equal(await runInventoryOperatorCli(sample.args, sample.emit, sample.runtime), 1);
    execFileSync("git", ["-C", sample.root, "rm", "--cached", "-f", sample.path], { stdio: "ignore" });
    const link = join(sample.root, INVENTORY_APPROVAL_DIRECTORY, "link.json");
    symlinkSync(sample.path, link);
    const args = [...sample.args];
    args[args.indexOf("--approval") + 1] = link;
    assert.equal(await runInventoryOperatorCli(args, sample.emit, sample.runtime), 1);
    assert.equal(sample.calls(), 0);
  } finally {
    sample.cleanup();
  }
});

test("corrupt ledger blocks before HEAD without printing local exception details", async () => {
  const sample = await fixture();
  try {
    const root = inventoryCliLocations(sample.root).storeRoot;
    writeFileSync(join(root, "ledger.json"), '{"hash":"incorrect","data":{"credential":"do-not-print"}}');
    assert.equal(await runInventoryOperatorCli(sample.args, sample.emit, sample.runtime), 1);
    assert.equal(sample.calls(), 0);
    assert.doesNotMatch(JSON.stringify(sample.output), /do-not-print|credential|Authorization/);
    assert.ok(!existsSync(join(root, "writer.lock")));
  } finally {
    sample.cleanup();
  }
});

for (const wrong of ["redirect", "region"] as const)
  test(`CLI ${wrong} stops and returns partial nonzero`, async () => {
    const sample = await fixture();
    let calls = 0;
    try {
      sample.runtime.fakeClient = {
        async send() {
          calls++;
          if (wrong === "redirect") throw awsError("PermanentRedirect", 301);
          return { ...HEAD_OK, $response: { headers: { "x-amz-bucket-region": "us-east-1" } } };
        },
      } as OfflineS3Sender;
      assert.equal(await runInventoryOperatorCli(sample.args, sample.emit, sample.runtime), 2);
      assert.equal(calls, 1);
      assert.deepEqual(sample.output.at(-1)?.counts, { PRESENT: 0, CONFIRMED_ABSENT: 0, UNKNOWN: 6, ERROR: 1 });
    } finally {
      sample.cleanup();
    }
  });

test("eight-key live batch, master expansion and unsupported commands/options reject", async () => {
  const plan = await createFrozenDukascopyPlan();
  const args = parseInventoryCliArguments(["--live", "--approval", "tmp/dukascopy/s3-production/approvals/test.json", "--start", "2021-01-01", "--end-exclusive", "2021-01-09"]);
  assert.throws(() => selectInventoryCliBatch(plan, args), /APPROVAL_VIOLATION/);
  for (const argv of [["download"], ["get"], ["list"], ["--bucket", "other"], ["--profile", "other"], ["--live"], ["--start", "2020-12-31", "--end-exclusive", "2021-01-08"]]) {
    assert.equal(await runInventoryOperatorCli(argv, () => {}), 1);
  }
});
