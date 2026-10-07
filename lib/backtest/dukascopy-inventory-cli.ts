import { resolve, relative, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { performance } from "node:perf_hooks";
import { HeadObjectCommand } from "@aws-sdk/client-s3";
import { createFrozenDukascopyPlan, assertExactDukascopyKey, assertApproval, acquisitionHash, DukascopyS3Session, DUKASCOPY_PROFILE, AcquisitionSafetyError, type FrozenDukascopyPlan, type AcquisitionApproval, type OfflineS3Sender, type acquisitionBackoff } from "./dukascopy-s3-production";
import { DUKASCOPY_PRODUCTION_ROOT, DurableAcquisitionStore } from "./dukascopy-s3-durable";
import { runDukascopyInventory } from "./dukascopy-s3-runner";

export const INVENTORY_CLI_MAX_BATCH_KEYS = 7;
export const INVENTORY_APPROVAL_DIRECTORY = `${DUKASCOPY_PRODUCTION_ROOT}/approvals`;

export interface InventoryCliArguments {
  command: "plan" | "inventory";
  live: boolean;
  start: string;
  endExclusive: string;
  approvalPath: string | null;
}

export function parseInventoryCliArguments(argv: readonly string[]): InventoryCliArguments {
  const remaining = [...argv];
  let command: InventoryCliArguments["command"] = "inventory";
  if (remaining[0] && !remaining[0].startsWith("--")) {
    const selected = remaining.shift();
    if (selected !== "plan" && selected !== "inventory") throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
    command = selected;
  }
  const values = new Map<string, string>();
  for (let index = 0; index < remaining.length; index++) {
    const flag = remaining[index];
    if (!["--dry-run", "--live", "--start", "--end-exclusive", "--approval"].includes(flag) || values.has(flag)) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
    if (flag === "--dry-run" || flag === "--live") values.set(flag, "true");
    else {
      const value = remaining[++index];
      if (!value || value.startsWith("--")) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
      values.set(flag, value);
    }
  }
  const live = values.has("--live");
  if (live && (values.has("--dry-run") || command === "plan" || !values.has("--approval") || !values.has("--start") || !values.has("--end-exclusive"))) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
  if (values.has("--start") !== values.has("--end-exclusive") || (!live && values.has("--approval"))) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
  return { command, live, start: values.get("--start") ?? "2021-01-01", endExclusive: values.get("--end-exclusive") ?? "2021-01-08", approvalPath: values.get("--approval") ?? null };
}

export function selectInventoryCliBatch(plan: FrozenDukascopyPlan, args: InventoryCliArguments): readonly string[] {
  const dates = [args.start, args.endExclusive].map((value) => {
    if (!/^\d{4}-\d\d-\d\d$/.test(value)) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
    const date = Date.parse(`${value}T00:00:00.000Z`);
    if (!Number.isFinite(date) || new Date(date).toISOString().slice(0, 10) !== value) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
    return date;
  });
  if (dates[0] >= dates[1] || dates[0] < Date.parse(plan.requestedStart) || dates[1] > Date.parse(plan.requestedEnd)) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
  const keys = plan.keys.filter((key) => {
    const day = Date.parse(`${assertExactDukascopyKey(plan, key)}T00:00:00.000Z`);
    return day >= dates[0] && day < dates[1];
  });
  if (!keys.length || (args.live && keys.length > INVENTORY_CLI_MAX_BATCH_KEYS)) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
  return Object.freeze(keys);
}

export function inventoryCliLocations(projectRoot = process.cwd()): { storeRoot: string; approvalDirectory: string } {
  return { storeRoot: resolve(projectRoot, DUKASCOPY_PRODUCTION_ROOT), approvalDirectory: resolve(projectRoot, INVENTORY_APPROVAL_DIRECTORY) };
}

export function inventoryApprovalRelativePath(file: string, projectRoot = process.cwd()): string {
  if (file.includes("\\") || file.split("/").includes("..") || /%[0-9a-f]{2}/i.test(file)) throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
  const locations = inventoryCliLocations(projectRoot);
  const absolute = resolve(projectRoot, file);
  const approvalRelative = relative(locations.approvalDirectory, absolute);
  if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]*\.json$/.test(approvalRelative) || approvalRelative.includes(sep)) throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
  return relative(locations.storeRoot, absolute).split(sep).join("/");
}

export function inventoryDryRunSummary(plan: FrozenDukascopyPlan, args: InventoryCliArguments, keys: readonly string[]) {
  return {
    operation: args.command === "plan" ? "PLAN" : "HEAD INVENTORY ONLY",
    mode: "DRY_RUN",
    instrument: plan.instrument,
    bucket: plan.bucket,
    region: plan.region,
    profile: DUKASCOPY_PROFILE,
    requesterPays: "requester",
    masterKeyCount: plan.keys.length,
    planHash: plan.planHash,
    firstKey: plan.keys[0],
    lastKey: plan.keys.at(-1),
    batchStart: args.start,
    batchEndExclusive: args.endExclusive,
    batchKeyCount: keys.length,
    liveBatchLimit: INVENTORY_CLI_MAX_BATCH_KEYS,
    maxHeadAttempts: Math.min(keys.length, INVENTORY_CLI_MAX_BATCH_KEYS) * 3,
    approvalRequiredForLive: true,
    exactInteractiveConfirmationRequired: true,
    storeRoot: DUKASCOPY_PRODUCTION_ROOT,
    approvalDirectory: INVENTORY_APPROVAL_DIRECTORY,
    liveRequests: 0,
    GET: "disabled",
    LIST: "disabled",
    download: "disabled",
    metadataInventoryAuthorization: "NOT AUTHORIZED",
    bulkDownloadAuthorization: "NOT AUTHORIZED",
  };
}

export interface InventoryCliRuntime {
  projectRoot?: string;
  inputIsTTY?: boolean;
  outputIsTTY?: boolean;
  ci?: boolean;
  confirm?: (prompt: string, signal: AbortSignal) => Promise<string | null>;
  signals?: { on(signal: "SIGINT" | "SIGTERM", handler: () => void): unknown; off(signal: "SIGINT" | "SIGTERM", handler: () => void): unknown };
  fakeClient?: OfflineS3Sender;
  timeoutMs?: number;
  backoff?: typeof acquisitionBackoff;
}

export function inventoryConfirmationPhrase(args: InventoryCliArguments, keyCount: number): string {
  return `HEAD INVENTORY USDJPY ${args.start} ${args.endExclusive} ${keyCount}`;
}

async function terminalConfirmation(prompt: string, signal: AbortSignal): Promise<string | null> {
  const reader = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  return new Promise((resolve) => {
    const finish = (value: string | null) => {
      signal.removeEventListener("abort", abort);
      reader.removeAllListeners();
      reader.close();
      resolve(value);
    };
    const abort = () => finish(null);
    reader.once("line", (line) => finish(line));
    reader.once("close", () => finish(null));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) finish(null);
    else {
      reader.setPrompt(`${prompt}\nExact confirmation phrase: `);
      reader.prompt();
    }
  });
}

function assertIgnoredApproval(projectRoot: string, relativePath: string): void {
  const path = `${DUKASCOPY_PRODUCTION_ROOT}/${relativePath}`;
  const ignored = spawnSync("git", ["check-ignore", "--quiet", "--no-index", "--", path], { cwd: projectRoot, stdio: "ignore" });
  const tracked = spawnSync("git", ["ls-files", "--error-unmatch", "--", path], { cwd: projectRoot, stdio: "ignore" });
  if (ignored.status !== 0 || tracked.status !== 1) throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
}

function validateInventoryApproval(plan: FrozenDukascopyPlan, args: InventoryCliArguments, keys: readonly string[], approval: AcquisitionApproval): void {
  assertApproval(plan, approval, "INVENTORY", null);
  if (approval.batchStart !== `${args.start}T00:00:00.000Z` || approval.batchEnd !== `${args.endExclusive}T00:00:00.000Z` || acquisitionHash(approval.keys) !== acquisitionHash(keys)) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
  for (const caps of [approval.caps, approval.globalCaps]) {
    if (caps.maxObjects > INVENTORY_CLI_MAX_BATCH_KEYS || caps.maxHeadAttempts <= 0 || caps.maxHeadAttempts > INVENTORY_CLI_MAX_BATCH_KEYS * 3 || caps.maxGetAttempts !== 0 || caps.maxNetworkBytes !== 0 || caps.maxVerifiedBytes !== 0) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
  }
}

class InventoryOnlySession extends DukascopyS3Session {
  constructor(
    options: ConstructorParameters<typeof DukascopyS3Session>[0],
    private readonly verifyApproval: () => Promise<void>,
  ) {
    super(options);
  }
  override async send(command: Parameters<DukascopyS3Session["send"]>[0], signal: AbortSignal, approval?: AcquisitionApproval) {
    if (!(command instanceof HeadObjectCommand)) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
    await this.verifyApproval();
    return super.send(command, signal, approval);
  }
}

export async function runInventoryOperatorCli(argv: readonly string[], output: (summary: unknown) => void, runtime: InventoryCliRuntime = {}): Promise<number> {
  let store: DurableAcquisitionStore | undefined;
  let session: InventoryOnlySession | undefined;
  const controller = new AbortController();
  const signals = runtime.signals ?? process;
  const abort = () => controller.abort();
  let signalHandlers = false;
  let exitCode = 1;
  try {
    const args = parseInventoryCliArguments(argv);
    const plan = await createFrozenDukascopyPlan();
    const keys = selectInventoryCliBatch(plan, args);
    if (!args.live) {
      output(inventoryDryRunSummary(plan, args, keys));
      return 0;
    }
    if (!(runtime.inputIsTTY ?? process.stdin.isTTY) || !(runtime.outputIsTTY ?? process.stdout.isTTY) || (runtime.ci ?? Boolean(process.env.CI))) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
    const projectRoot = resolve(runtime.projectRoot ?? process.cwd());
    const relativeApproval = inventoryApprovalRelativePath(args.approvalPath!, projectRoot);
    assertIgnoredApproval(projectRoot, relativeApproval);
    signals.on("SIGINT", abort);
    signals.on("SIGTERM", abort);
    signalHandlers = true;
    store = await DurableAcquisitionStore.acquire(inventoryCliLocations(projectRoot).storeRoot);
    const readApproval = async () => {
      const value = await store!.readDocument<AcquisitionApproval>(relativeApproval);
      if (!value) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
      validateInventoryApproval(plan, args, keys, value);
      return value;
    };
    const approval = await readApproval();
    const approvalHash = acquisitionHash(approval);
    const verifyApproval = async () => {
      assertIgnoredApproval(projectRoot, relativeApproval);
      if (acquisitionHash(await readApproval()) !== approvalHash) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
    };
    const phrase = inventoryConfirmationPhrase(args, keys.length);
    const prompt = [
      "operation = HEAD INVENTORY ONLY",
      "pair = USDJPY",
      `bucket = ${plan.bucket}`,
      `region = ${plan.region}`,
      `batch = [${args.start}, ${args.endExclusive})`,
      `exact key count = ${keys.length}`,
      `max HEAD attempts = ${approval.caps.maxHeadAttempts}`,
      "Requester Pays = enabled",
      "GET = disabled",
      "LIST = disabled",
      "Download = disabled",
      `Type exactly: ${phrase}`,
    ].join("\n");
    const confirmation = await (runtime.confirm ?? terminalConfirmation)(prompt, controller.signal);
    if (confirmation !== phrase || controller.signal.aborted) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
    await verifyApproval();
    session = new InventoryOnlySession(runtime.fakeClient ? { mode: "OFFLINE_TEST", fakeClient: runtime.fakeClient } : { mode: "LIVE", allowLiveRequests: true }, verifyApproval);
    const started = performance.now();
    const snapshot = await runDukascopyInventory({ plan, approval, store, session, signal: controller.signal, timeoutMs: runtime.timeoutMs, backoff: runtime.backoff });
    const selected = snapshot.entries.filter((entry) => keys.includes(entry.key));
    const counts = {
      PRESENT: selected.filter((entry) => entry.status === "PRESENT").length,
      CONFIRMED_ABSENT: selected.filter((entry) => entry.status === "CONFIRMED_ABSENT").length,
      UNKNOWN: selected.filter((entry) => entry.status === "UNKNOWN").length,
      ERROR: selected.filter((entry) => entry.status === "ERROR" || entry.status === "AMBIGUOUS_ACCESS").length,
    };
    const complete = selected.every((entry) => entry.status === "PRESENT" || entry.status === "CONFIRMED_ABSENT") && !controller.signal.aborted;
    const ledger = await store.ledger(plan);
    output({
      operation: "HEAD INVENTORY ONLY",
      mode: session.mode,
      outcome: complete ? "COMPLETED_BATCH" : "PARTIAL",
      approvalId: approval.id,
      batchStart: args.start,
      batchEndExclusive: args.endExclusive,
      plannedKeyCount: keys.length,
      masterKeyCount: plan.keys.length,
      counts,
      batchBytesIfComplete: complete ? selected.reduce((total, entry) => total + (entry.metadata?.contentLength ?? 0), 0) : null,
      actualFiveYearBytes: snapshot.actualTotalBytes,
      masterUnknownCount: snapshot.entries.filter((entry) => entry.status === "UNKNOWN").length,
      snapshotRevision: snapshot.revision,
      elapsedMs: Math.round(performance.now() - started),
      headAttempts: ledger?.contexts[approval.id]?.counters.headAttempts ?? 0,
      GET: "disabled",
      LIST: "disabled",
      download: "disabled",
    });
    exitCode = complete ? 0 : 2;
  } catch (error) {
    output({ outcome: "BLOCKED", error: error instanceof AcquisitionSafetyError ? error.code : "OPERATOR_ERROR" });
  } finally {
    try {
      await store?.release();
    } catch {
      output({ outcome: "BLOCKED", error: "STORE_RELEASE_FAILED" });
      exitCode = 1;
    } finally {
      session?.destroy();
      if (signalHandlers) {
        signals.off("SIGINT", abort);
        signals.off("SIGTERM", abort);
      }
    }
  }
  return exitCode;
}
