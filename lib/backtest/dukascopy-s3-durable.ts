import { constants } from "node:fs";
import { mkdir, lstat, open, rename, link, readdir, statfs } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { resolve, relative, dirname, join, sep, parse, basename } from "node:path";
import { safeArtifactPrefix, type S3TransferSafetyOptions } from "./dukascopy-s3-acquisition";
import {
  AcquisitionSafetyError,
  acquisitionHash,
  assertApproval,
  assertExactDukascopyKey,
  assertFrozenPlan,
  assertInventorySnapshot,
  type AcquisitionApproval,
  type AcquisitionCaps,
  type AcquisitionOperation,
  type AcquisitionRequestGate,
  type FrozenDukascopyPlan,
  type InventorySnapshot,
  type InventoryEntry,
} from "./dukascopy-s3-production";

export const DUKASCOPY_PRODUCTION_ROOT = "tmp/dukascopy/s3-production";
const DOCUMENT_LIMIT = 16 * 1024 * 1024;

export interface LedgerCounters {
  headAttempts: number;
  getAttempts: number;
  successfulGets: number;
  failedAttempts: number;
  receivedBytes: number;
  reservedBytes: number;
  verifiedBytes: number;
  retryCount: number;
  objects: string[];
}

export interface AcquisitionLedger {
  version: "DUKASCOPY_DURABLE_V1";
  planHash: string;
  inventoryRevision: string | null;
  approvalId: string;
  batchId: string;
  globalCaps: AcquisitionCaps;
  totals: LedgerCounters;
  contexts: Record<string, { bindingHash: string; counters: LedgerCounters }>;
  attempts: Record<string, number>;
  completedGetKeys: string[];
  verified: Record<string, { key: string; bytes: number; sha256: string }>;
  active: { operation: AcquisitionOperation; key: string; approvalId: string } | null;
  quarantineBytes: number;
  partialBytes: number;
  startedAt: string;
  updatedAt: string;
}

export interface RawJournal {
  key: string;
  planHash: string;
  inventoryRevision: string;
  partialPath: string;
  verifiedPath: string | null;
  phase: "WRITING" | "COMPLETE" | "PUBLISHED" | "QUARANTINED";
  bytes: number;
  sha256: string | null;
}

function counters(): LedgerCounters {
  return { headAttempts: 0, getAttempts: 0, successfulGets: 0, failedAttempts: 0, receivedBytes: 0, reservedBytes: 0, verifiedBytes: 0, retryCount: 0, objects: [] };
}

function safeDocumentName(value: string): boolean {
  return /^[a-zA-Z0-9._/-]+$/.test(value) && !value.split("/").some((part) => !part || part === "." || part === "..") && !value.includes("\\");
}

export class DurableAcquisitionStore {
  readonly root: string;
  private closed = false;
  private gateInitialized = false;
  private serial: Promise<unknown> = Promise.resolve();
  private constructor(
    root: string,
    private readonly lockToken: string,
    private readonly freeBytesOverride?: () => Promise<number>,
  ) {
    this.root = root;
  }

  static async acquire(root = resolve(DUKASCOPY_PRODUCTION_ROOT), options: { staleLockToken?: string; freeBytes?: () => Promise<number> } = {}): Promise<DurableAcquisitionStore> {
    const absolute = resolve(root);
    const token = randomUUID();
    const store = new DurableAcquisitionStore(absolute, token, options.freeBytes);
    await store.ensurePath(absolute, true);
    await mkdir(absolute, { recursive: true, mode: 0o700 });
    await store.ensurePath(absolute);
    for (const folder of ["raw", "journals", "inventories", "progress", "batches", "quarantine", "locks"]) {
      await store.ensurePath(join(absolute, folder), true);
      await mkdir(join(absolute, folder), { mode: 0o700, recursive: true });
    }
    const lockPath = join(absolute, "writer.lock");
    if (options.staleLockToken) {
      const lock = await store.readPlain<{ pid: number; token: string }>("writer.lock");
      if (!lock || lock.token !== options.staleLockToken || !Number.isSafeInteger(lock.pid) || lock.pid <= 0) throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
      let gone = false;
      try {
        process.kill(lock.pid, 0);
      } catch (error) {
        gone = (error as NodeJS.ErrnoException).code === "ESRCH";
      }
      if (!gone) throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
      await rename(lockPath, join(absolute, "locks", `stale-${token}.json`));
    }
    try {
      const handle = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() }));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await store.syncDirectory(absolute);
    } catch {
      throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
    }
    return store;
  }

  async ensurePath(path: string, allowMissing = false): Promise<void> {
    const absolute = resolve(path);
    const remainder = relative(this.root, absolute);
    if (remainder.startsWith(`..${sep}`) || remainder === ".." || remainder.startsWith(sep)) throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
    let cursor = parse(absolute).root;
    for (const part of absolute.slice(cursor.length).split(sep).filter(Boolean)) {
      cursor = join(cursor, part);
      try {
        if ((await lstat(cursor)).isSymbolicLink()) throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
      } catch (error) {
        if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
    }
  }

  path(name: string): string {
    if (!safeDocumentName(name)) throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
    return join(this.root, name);
  }

  private async assertOwner(): Promise<void> {
    if (this.closed) throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
    const lock = await this.readPlain<{ token: string }>("writer.lock");
    if (lock?.token !== this.lockToken) throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
  }

  private async syncDirectory(path: string): Promise<void> {
    let handle;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      await handle.sync();
    } catch (error) {
      if (!["EINVAL", "ENOTSUP", "EISDIR", "ENOSYS"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    } finally {
      await handle?.close();
    }
  }

  async readPlain<Value>(name: string): Promise<Value | null> {
    const path = this.path(name);
    try {
      await this.ensurePath(path);
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.size > DOCUMENT_LIMIT) throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
        return JSON.parse(await handle.readFile("utf8")) as Value;
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async atomicPlain(name: string, value: unknown, immutable = false): Promise<void> {
    await this.assertOwner();
    const path = this.path(name);
    await this.ensurePath(dirname(path));
    await this.ensurePath(path, true);
    const text = `${JSON.stringify(value)}\n`;
    if (Buffer.byteLength(text) > DOCUMENT_LIMIT) throw new AcquisitionSafetyError("CAP_EXCEEDED");
    if (immutable) {
      const existing = await this.readPlain(name);
      if (existing) {
        if (acquisitionHash(existing) !== acquisitionHash(value)) throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
        return;
      }
    }
    const temporary = `${path}.${randomUUID()}.tmp`;
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await handle.writeFile(text);
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (immutable) {
      try {
        await link(temporary, path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" || acquisitionHash(await this.readPlain(name)) !== acquisitionHash(value)) throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
      }
      await rename(temporary, this.path(`quarantine/document-${randomUUID()}.json`));
    } else await rename(temporary, path);
    await this.syncDirectory(dirname(path));
  }

  async readDocument<Value>(name: string): Promise<Value | null> {
    const wrapper = await this.readPlain<{ hash: string; data: Value }>(name);
    if (!wrapper) return null;
    if (wrapper.hash !== acquisitionHash(wrapper.data)) throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
    return wrapper.data;
  }

  async document(name: string, data: unknown, immutable = false): Promise<void> {
    await this.atomicPlain(name, { hash: acquisitionHash(data), data }, immutable);
  }

  async saveSnapshot(plan: FrozenDukascopyPlan, snapshot: InventorySnapshot): Promise<void> {
    assertInventorySnapshot(plan, snapshot);
    await this.document(`inventories/${snapshot.revision}.json`, snapshot, true);
  }

  async saveInventoryEntry(plan: FrozenDukascopyPlan, approval: AcquisitionApproval, entry: InventoryEntry): Promise<void> {
    await this.document(`progress/${acquisitionHash(`${approval.id}:${entry.key}`)}.json`, { planHash: plan.planHash, approvalHash: acquisitionHash(approval), entry });
  }

  async loadInventoryProgress(plan: FrozenDukascopyPlan, approval: AcquisitionApproval): Promise<InventoryEntry[]> {
    const result: InventoryEntry[] = [];
    for (const key of approval.keys) {
      const saved = await this.readDocument<{ planHash: string; approvalHash: string; entry: InventoryEntry }>(`progress/${acquisitionHash(`${approval.id}:${key}`)}.json`);
      if (saved) {
        if (saved.planHash !== plan.planHash || saved.approvalHash !== acquisitionHash(approval) || saved.entry.key !== key) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
        result.push(saved.entry);
      }
    }
    return result;
  }

  async freeBytes(): Promise<number> {
    const bytes = this.freeBytesOverride ? await this.freeBytesOverride() : await statfs(this.root).then((info) => info.bavail * info.bsize);
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new AcquisitionSafetyError("DISK_FULL");
    return bytes;
  }

  async ledger(plan: FrozenDukascopyPlan): Promise<AcquisitionLedger | null> {
    assertFrozenPlan(plan);
    const ledger = await this.readDocument<AcquisitionLedger>("ledger.json");
    if (!ledger) return null;
    if (ledger.version !== "DUKASCOPY_DURABLE_V1" || ledger.planHash !== plan.planHash || !ledger.contexts || !ledger.attempts || !ledger.verified || !Array.isArray(ledger.completedGetKeys)) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
    for (const count of [ledger.totals, ...Object.values(ledger.contexts).map((context) => context.counters)]) {
      if (!count || !Array.isArray(count.objects) || new Set(count.objects).size !== count.objects.length) throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
      for (const field of ["headAttempts", "getAttempts", "successfulGets", "failedAttempts", "receivedBytes", "reservedBytes", "verifiedBytes", "retryCount"] as const) if (!Number.isSafeInteger(count[field]) || count[field] < 0) throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
      for (const key of count.objects) assertExactDukascopyKey(plan, key);
    }
    for (const [identity, count] of Object.entries(ledger.attempts)) {
      if (!/^(HEAD|GET):/.test(identity) || !Number.isSafeInteger(count) || count < 1 || count > 3) throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
      assertExactDukascopyKey(plan, identity.slice(identity.indexOf(":") + 1));
    }
    for (const record of Object.values(ledger.verified)) if (!Number.isSafeInteger(record.bytes) || record.bytes < 0 || !/^[a-f0-9]{64}$/.test(record.sha256)) throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
    return ledger;
  }

  async gate(plan: FrozenDukascopyPlan, suppliedApproval: AcquisitionApproval, snapshot?: InventorySnapshot): Promise<AcquisitionRequestGate> {
    const approval = JSON.parse(JSON.stringify(suppliedApproval)) as AcquisitionApproval;
    assertApproval(plan, approval, approval.operation, approval.inventoryRevision);
    if (snapshot) {
      assertInventorySnapshot(plan, snapshot);
      if (snapshot.revision !== approval.inventoryRevision) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
    }
    const now = new Date().toISOString();
    let ledger = await this.ledger(plan);
    if (!ledger)
      ledger = {
        version: "DUKASCOPY_DURABLE_V1",
        planHash: plan.planHash,
        inventoryRevision: approval.operation === "DOWNLOAD" ? approval.inventoryRevision : null,
        approvalId: approval.id,
        batchId: approval.batchId,
        globalCaps: approval.globalCaps,
        totals: counters(),
        contexts: {},
        attempts: {},
        completedGetKeys: [],
        verified: {},
        active: null,
        quarantineBytes: 0,
        partialBytes: 0,
        startedAt: now,
        updatedAt: now,
      };
    if (acquisitionHash(ledger.globalCaps) !== acquisitionHash(approval.globalCaps) || (approval.operation === "DOWNLOAD" && ledger.inventoryRevision !== null && ledger.inventoryRevision !== approval.inventoryRevision)) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
    if (ledger.active) {
      if (this.gateInitialized) throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
      ledger.totals.failedAttempts++;
      const previous = ledger.contexts[ledger.active.approvalId];
      if (!previous) throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
      previous.counters.failedAttempts++;
      ledger.active = null;
    }
    const bindingHash = acquisitionHash(approval);
    if (Object.hasOwn(ledger.contexts, approval.id) && ledger.contexts[approval.id].bindingHash !== bindingHash) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
    ledger.contexts[approval.id] ??= { bindingHash, counters: counters() };
    this.gateInitialized = true;
    ledger.approvalId = approval.id;
    ledger.batchId = approval.batchId;
    if (approval.operation === "DOWNLOAD") ledger.inventoryRevision = approval.inventoryRevision;
    await this.document("ledger.json", ledger);
    let current = ledger;
    const reload = async () => {
      const saved = await this.ledger(plan);
      if (!saved) throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
      current = saved;
    };
    const serial = <Result>(work: () => Promise<Result>): Promise<Result> => {
      const next = this.serial.then(async () => {
        await reload();
        return work();
      });
      this.serial = next.catch(() => undefined);
      return next;
    };
    const save = async () => {
      current.updatedAt = new Date().toISOString();
      await this.document("ledger.json", current);
    };
    const assertScope = (operation: AcquisitionOperation, key: string) => {
      assertApproval(plan, approval, approval.operation, approval.inventoryRevision);
      assertExactDukascopyKey(plan, key);
      if (!approval.keys.includes(key) || (operation === "HEAD" ? "INVENTORY" : "DOWNLOAD") !== approval.operation) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
    };
    const checkCaps = (count: LedgerCounters, caps: AcquisitionCaps, operation: AcquisitionOperation, key: string, bytes: number) => {
      if (
        count.headAttempts + Number(operation === "HEAD") > caps.maxHeadAttempts ||
        count.getAttempts + Number(operation === "GET") > caps.maxGetAttempts ||
        count.receivedBytes > caps.maxNetworkBytes ||
        count.reservedBytes + bytes > caps.maxNetworkBytes ||
        count.verifiedBytes + bytes > caps.maxVerifiedBytes ||
        (operation === "GET" && !count.objects.includes(key) && count.objects.length + 1 > caps.maxObjects)
      )
        throw new AcquisitionSafetyError("CAP_EXCEEDED");
    };
    return {
      before: (operation, key, bytes) =>
        serial(async () => {
          assertScope(operation, key);
          if (current.active || !Number.isSafeInteger(bytes) || bytes < 0) throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
          if (operation === "GET") {
            const entry = snapshot?.entries[plan.keys.indexOf(key)];
            if (entry?.status !== "PRESENT" || entry.metadata?.contentLength !== bytes) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
            const remaining = approval.keys.reduce((sum, approvedKey) => sum + (snapshot!.entries[plan.keys.indexOf(approvedKey)].metadata?.contentLength ?? 0), 0);
            if ((await this.freeBytes()) < approval.minimumFreeBytes + remaining + bytes) throw new AcquisitionSafetyError("DISK_FULL");
          }
          const context = current.contexts[approval.id].counters;
          checkCaps(current.totals, current.globalCaps, operation, key, bytes);
          checkCaps(context, approval.caps, operation, key, bytes);
          const identity = `${operation}:${key}`;
          const attempts = current.attempts[identity] ?? 0;
          if (attempts >= Math.min(3, approval.caps.maxRetries + 1, current.globalCaps.maxRetries + 1)) throw new AcquisitionSafetyError("CAP_EXCEEDED");
          current.attempts[identity] = attempts + 1;
          for (const count of [current.totals, context]) {
            if (operation === "HEAD") count.headAttempts++;
            else {
              count.getAttempts++;
              count.reservedBytes += bytes;
              if (!count.objects.includes(key)) count.objects.push(key);
            }
            if (attempts > 0) count.retryCount++;
          }
          current.active = { operation, key, approvalId: approval.id };
          await save();
        }),
      received: (key, bytes) =>
        serial(async () => {
          assertScope("GET", key);
          if (current.active?.key !== key || current.active.operation !== "GET" || !Number.isSafeInteger(bytes) || bytes < 0) throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
          const context = current.contexts[approval.id].counters;
          current.totals.receivedBytes += bytes;
          context.receivedBytes += bytes;
          await save();
          if (current.totals.receivedBytes > current.globalCaps.maxNetworkBytes || context.receivedBytes > approval.caps.maxNetworkBytes) throw new AcquisitionSafetyError("CAP_EXCEEDED");
        }),
      success: (operation, key) =>
        serial(async () => {
          if (current.active?.key !== key || current.active.operation !== operation) throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
          if (operation === "GET") {
            current.totals.successfulGets++;
            current.contexts[approval.id].counters.successfulGets++;
            if (!current.completedGetKeys.includes(key)) current.completedGetKeys.push(key);
          }
          current.active = null;
          await save();
        }),
      failure: (operation, key) =>
        serial(async () => {
          if (current.active?.key === key && current.active.operation === operation) {
            current.totals.failedAttempts++;
            current.contexts[approval.id].counters.failedAttempts++;
            current.active = null;
            await save();
          }
        }),
    };
  }

  async recordVerified(plan: FrozenDukascopyPlan, approval: AcquisitionApproval, path: string, key: string, bytes: number, sha256: string): Promise<void> {
    await this.ensurePath(path);
    const ledger = await this.ledger(plan);
    if (!ledger || !ledger.completedGetKeys.includes(key) || ledger.inventoryRevision !== approval.inventoryRevision) throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
    const identity = relative(this.root, path);
    if (ledger.verified[identity]) {
      if (acquisitionHash(ledger.verified[identity]) !== acquisitionHash({ key, bytes, sha256 })) throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
      return;
    }
    const context = ledger.contexts[approval.id]?.counters;
    if (!context || ledger.totals.verifiedBytes + bytes > ledger.globalCaps.maxVerifiedBytes || context.verifiedBytes + bytes > approval.caps.maxVerifiedBytes) throw new AcquisitionSafetyError("CAP_EXCEEDED");
    ledger.verified[identity] = { key, bytes, sha256 };
    ledger.totals.verifiedBytes += bytes;
    context.verifiedBytes += bytes;
    await this.document("ledger.json", ledger);
  }

  async hashRaw(path: string): Promise<{ sha256: string; bytes: number }> {
    await this.ensurePath(path);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
      const hash = createHash("sha256");
      for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
      return { sha256: hash.digest("hex"), bytes: info.size };
    } finally {
      await handle.close();
    }
  }

  artifactWriter(plan: FrozenDukascopyPlan, snapshot: InventorySnapshot, key: string, fault?: (stage: "AFTER_DOWNLOAD" | "AFTER_PUBLICATION") => void): NonNullable<S3TransferSafetyOptions["artifactWriter"]> {
    assertInventorySnapshot(plan, snapshot);
    const entry = snapshot.entries[plan.keys.indexOf(key)];
    if (entry?.status !== "PRESENT" || !entry.metadata) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
    const expected = entry.metadata;
    let journalName: string;
    let journal: RawJournal;
    return {
      writePartial: async (path, source) => {
        await this.assertOwner();
        await this.ensurePath(path, true);
        const filename = relative(this.path("raw"), path);
        const match = /^[a-f0-9]{24}\.(\d+)\.[a-f0-9-]+\.partial$/.exec(filename);
        if (!match || !filename.startsWith(safeArtifactPrefix(key))) throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
        journalName = `journals/${acquisitionHash(relative(this.root, path))}.json`;
        journal = { key, planHash: plan.planHash, inventoryRevision: snapshot.revision, partialPath: path, verifiedPath: null, phase: "WRITING", bytes: 0, sha256: null };
        await this.document(journalName, journal);
        const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try {
          for await (const bytes of source) await handle.writeFile(bytes);
          await handle.sync();
        } finally {
          await handle.close();
        }
        const raw = await this.hashRaw(path);
        const sourceSha = expected.checksumType === "FULL_OBJECT" && expected.checksums.ChecksumSHA256 ? Buffer.from(expected.checksums.ChecksumSHA256, "base64").toString("hex") : null;
        if (raw.bytes !== expected.contentLength || (sourceSha && raw.sha256 !== sourceSha)) throw new AcquisitionSafetyError("SOURCE_CHANGED");
        journal = { ...journal, phase: "COMPLETE", ...raw, verifiedPath: this.path(`raw/${safeArtifactPrefix(key)}-${raw.sha256}-attempt-${match[1]}.bi5`) };
        await this.document(journalName, journal);
        await this.syncDirectory(this.path("raw"));
        fault?.("AFTER_DOWNLOAD");
      },
      publish: async (partialPath, verifiedPath) => {
        if (!journal || journal.partialPath !== partialPath || journal.verifiedPath !== verifiedPath || journal.phase !== "COMPLETE") throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
        await this.publishRaw(journal);
        journal.phase = "PUBLISHED";
        await this.document(journalName, journal);
        fault?.("AFTER_PUBLICATION");
      },
    };
  }

  async publishRaw(journal: RawJournal): Promise<void> {
    await this.assertOwner();
    if (!journal.verifiedPath || !journal.sha256 || journal.phase === "WRITING" || journal.phase === "QUARANTINED") throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
    const match = /^[a-f0-9]{24}\.(\d+)\.[a-f0-9-]+\.partial$/.exec(basename(journal.partialPath));
    if (!match || dirname(journal.partialPath) !== this.path("raw") || !basename(journal.partialPath).startsWith(safeArtifactPrefix(journal.key)) || journal.verifiedPath !== this.path(`raw/${safeArtifactPrefix(journal.key)}-${journal.sha256}-attempt-${match[1]}.bi5`)) throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
    await this.ensurePath(journal.partialPath);
    await this.ensurePath(journal.verifiedPath, true);
    const raw = await this.hashRaw(journal.partialPath);
    if (raw.sha256 !== journal.sha256 || raw.bytes !== journal.bytes) throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
    try {
      await link(journal.partialPath, journal.verifiedPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await this.hashRaw(journal.verifiedPath);
      if (existing.sha256 !== journal.sha256 || existing.bytes !== journal.bytes) throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
    }
    const handle = await open(journal.verifiedPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      await handle.chmod(0o400);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await this.syncDirectory(this.path("raw"));
  }

  async quarantineJournal(journal: RawJournal): Promise<void> {
    await this.ensurePath(journal.partialPath, true);
    try {
      await rename(journal.partialPath, this.path(`quarantine/incomplete-${randomUUID()}.partial`));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    journal.phase = "QUARANTINED";
    await this.document(`journals/${acquisitionHash(relative(this.root, journal.partialPath))}.json`, journal);
  }

  async journals(): Promise<RawJournal[]> {
    await this.ensurePath(this.path("journals"));
    const result: RawJournal[] = [];
    for (const name of await readdir(this.path("journals"))) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      const journal = await this.readDocument<RawJournal>(`journals/${name}`);
      if (journal) result.push(journal);
    }
    return result;
  }

  async quarantineOrphans(known: readonly string[]): Promise<void> {
    await this.ensurePath(this.path("raw"));
    for (const name of await readdir(this.path("raw"))) {
      const path = this.path(`raw/${name}`);
      await this.ensurePath(path);
      if (name.endsWith(".partial") && !known.includes(path)) await rename(path, this.path(`quarantine/orphan-${randomUUID()}.partial`));
    }
  }

  async refreshQuarantineBytes(plan: FrozenDukascopyPlan): Promise<void> {
    const ledger = await this.ledger(plan);
    if (!ledger) return;
    let bytes = 0;
    for (const name of await readdir(this.path("quarantine"))) {
      const path = this.path(`quarantine/${name}`);
      await this.ensurePath(path);
      const info = await lstat(path);
      if (info.isFile()) bytes += info.size;
    }
    ledger.quarantineBytes = bytes;
    ledger.partialBytes = 0;
    for (const journal of await this.journals()) {
      if (journal.phase !== "WRITING") continue;
      await this.ensurePath(journal.partialPath, true);
      try { ledger.partialBytes += (await lstat(journal.partialPath)).size; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    await this.document("ledger.json", ledger);
  }

  async release(): Promise<void> {
    await this.assertOwner();
    await rename(this.path("writer.lock"), this.path(`locks/released-${this.lockToken}.json`));
    await this.syncDirectory(this.root);
    this.closed = true;
  }
}
