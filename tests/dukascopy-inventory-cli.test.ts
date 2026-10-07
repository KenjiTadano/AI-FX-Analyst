import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Readable } from "node:stream";
import { createInterface } from "node:readline";
import { EventEmitter } from "node:events";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { HeadObjectCommand } from "@aws-sdk/client-s3";
import { createFrozenDukascopyPlan, acquisitionHash, DukascopyS3Session, type AcquisitionApproval, type OfflineS3Sender } from "../lib/backtest/dukascopy-s3-production";
import { runInventoryOperatorCli, parseInventoryCliArguments, selectInventoryCliBatch, inventoryConfirmationPhrase, inventoryCliLocations, INVENTORY_APPROVAL_DIRECTORY, type InventoryCliRuntime } from "../lib/backtest/dukascopy-inventory-cli";

let realNetworkCalls = 0;
test.before(() => {
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
  test.mock.restoreAll();
});

const HEAD_OK = { $metadata: { httpStatusCode: 200 }, ContentLength: 100, ETag: '"inventory-etag"', RequestCharged: "requester" as const };
const START = "2021-01-01";
const END = "2021-01-08";

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
