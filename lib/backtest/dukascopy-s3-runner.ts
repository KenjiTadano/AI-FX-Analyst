import {
  createInventorySnapshot,
  mergeInventoryProgress,
  assertInventorySnapshot,
  assertApproval,
  assertExactDukascopyKey,
  acquisitionHash,
  acquisitionBackoff,
  AcquisitionSafetyError,
  DukascopyGetTransport,
  DukascopyS3Session,
  collectDukascopyInventory,
  type AcquisitionApproval,
  type FrozenDukascopyPlan,
  type InventorySnapshot,
} from "./dukascopy-s3-production";
import { DurableAcquisitionStore } from "./dukascopy-s3-durable";
import { planDukascopyS3Acquisition, downloadDukascopyS3PlanSequentially, DUKASCOPY_S3_ACQUISITION_VERSION, type DukascopyS3AcquisitionCheckpoint, type S3AcquisitionChunkCheckpoint } from "./dukascopy-s3-acquisition";
import { createDukascopyBi5MidStream, DUKASCOPY_BI5_ADAPTER_VERSION } from "./dukascopy-bi5-adapter";
import { relative } from "node:path";

interface RunnerOptions {
  plan: FrozenDukascopyPlan;
  approval: AcquisitionApproval;
  session?: DukascopyS3Session;
  store?: DurableAcquisitionStore;
  signal?: AbortSignal;
  timeoutMs?: number;
  backoff?: typeof acquisitionBackoff;
}

export async function runTask116ClassifiedErrorRetry(options: {
  plan: FrozenDukascopyPlan;
  store: DurableAcquisitionStore;
  session: DukascopyS3Session;
  approvalId: string;
  approvalHash: string;
  authorizationId: string;
  authorizationHash: string;
  inventoryRevision: string;
  capRevisionId: string;
  capRevisionHash: string;
  phase: "REPLACEMENT" | "CONTINUATION";
  signal?: AbortSignal;
}) {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(options.approvalId)) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
  const approval = await options.store.readDocument<AcquisitionApproval>(`retry-approvals/${options.approvalId}.json`);
  const metadata = approval?.classifiedErrorRetry;
  if (
    !approval ||
    !metadata ||
    acquisitionHash(approval) !== options.approvalHash ||
    metadata.authorizationId !== options.authorizationId ||
    metadata.authorizationHash !== options.authorizationHash ||
    metadata.capRevisionId !== options.capRevisionId ||
    metadata.capRevisionHash !== options.capRevisionHash ||
    metadata.phase !== options.phase ||
    approval.inventoryRevision !== options.inventoryRevision
  )
    throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
  const seed = await options.store.loadInventorySnapshot(options.plan, options.inventoryRevision);
  if (options.phase === "CONTINUATION") return runDukascopyInventory({ plan: options.plan, approval, previous: seed, session: options.session, store: options.store, signal: options.signal });
  let event = (await options.store.headAttemptJournal()).find((event) => event.approvalId === approval.id && event.kind === "CLASSIFIED_ERROR_RETRY");
  let entries: InventorySnapshot["entries"];
  if (event && event.state !== "RESERVED") {
    await options.store.validateTask116RetryExecutionApproval(options.plan, approval, seed, true);
    await options.store.reconcileHeadAttempts(options.plan, approval, seed);
    const entry = event.classification ?? { key: event.key, utcDay: assertExactDukascopyKey(options.plan, event.key), status: "ERROR" as const, metadata: null, checkedAt: event.mayHaveBeenSentAt!, attempts: event.sequence, error: "INDETERMINATE" as const };
    if (!event.classification) await options.store.saveInventoryEntry(options.plan, approval, entry);
    entries = mergeInventoryProgress(options.plan, seed, [entry]).entries;
  } else {
    const gate = await options.store.gate(options.plan, approval, seed);
    const collected = await collectDukascopyInventory({ plan: options.plan, approval, previous: seed, session: options.session, gate, resumedEntries: await options.store.loadInventoryProgress(options.plan, approval), signal: options.signal, persistEntry: (entry) => options.store.saveInventoryEntry(options.plan, approval, entry) });
    entries = collected.entries;
    event = (await options.store.headAttemptJournal()).find((candidate) => candidate.approvalId === approval.id && candidate.kind === "CLASSIFIED_ERROR_RETRY");
  }
  if (!event) throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
  const snapshot = createInventorySnapshot(options.plan, entries, event.classifiedAt ?? event.mayHaveBeenSentAt ?? event.reservedAt);
  await options.store.saveSnapshot(options.plan, snapshot);
  await options.store.completeCampaignChild(options.plan, approval, snapshot);
  return snapshot;
}

export async function runDukascopyInventory(options: RunnerOptions & { previous?: InventorySnapshot }): Promise<InventorySnapshot> {
  if (options.approval.classifiedErrorRetry?.phase === "REPLACEMENT") throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
  const session = options.session ?? new DukascopyS3Session();
  if (options.previous) assertInventorySnapshot(options.plan, options.previous);
  assertApproval(options.plan, options.approval, "INVENTORY", options.previous?.revision ?? null);
  if (session.mode === "DRY_RUN") return options.previous ?? createInventorySnapshot(options.plan, []);
  if (!options.store) throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
  if (options.approval.inventoryRevision !== null) {
    const stored = await options.store.loadInventorySnapshot(options.plan, options.approval.inventoryRevision);
    if (!options.previous || acquisitionHash(stored) !== acquisitionHash(options.previous)) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
  }
  const gate = await options.store.gate(options.plan, options.approval, options.previous);
  const resumedEntries = await options.store.loadInventoryProgress(options.plan, options.approval);
  const snapshot = await collectDukascopyInventory({ ...options, session, gate, resumedEntries, persistEntry: (entry) => options.store!.saveInventoryEntry(options.plan, options.approval, entry) });
  await options.store.saveSnapshot(options.plan, snapshot);
  await options.store.completeCampaignChild(options.plan, options.approval, snapshot);
  return snapshot;
}

export interface DecodeEvidence {
  firstTickTimestamp: string;
  lastTickTimestamp: string;
  tickCount: number;
  canonicalMinuteCount: number;
  decoderVersion: string;
}

async function decodeRaw(path: string, key: string, day: string, rawSha256: string): Promise<DecodeEvidence> {
  const stream = await createDukascopyBi5MidStream({ artifactPath: path, objectKey: key, instrument: "USDJPY", sourceUtcDay: day, expectedRawSha256: rawSha256 });
  for await (const candle of stream) if (!candle.time) throw new AcquisitionSafetyError("DECODE_ERROR");
  const receipt = stream.getReceipt();
  if (!receipt) throw new AcquisitionSafetyError("DECODE_ERROR");
  return { firstTickTimestamp: receipt.firstTickTimestamp, lastTickTimestamp: receipt.lastTickTimestamp, tickCount: receipt.recordCount, canonicalMinuteCount: receipt.canonicalMinuteCount, decoderVersion: receipt.adapterVersion };
}

function newChunk(key: string, plan: FrozenDukascopyPlan, snapshot: InventorySnapshot): S3AcquisitionChunkCheckpoint {
  const entry = snapshot.entries[plan.keys.indexOf(key)];
  if (entry.status !== "PRESENT" && entry.status !== "CONFIRMED_ABSENT") throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
  return {
    objectId: key,
    objectKey: key,
    utcDay: assertExactDukascopyKey(plan, key),
    status: entry.status === "CONFIRMED_ABSENT" ? "NO_DATA" : "PLANNED",
    attempts: 0,
    rawFilePath: null,
    rawByteSize: entry.metadata?.contentLength ?? null,
    rawSha256: null,
    downloadTimestamp: null,
    firstTickTimestamp: null,
    lastTickTimestamp: null,
    tickCount: null,
    canonicalMinuteCount: null,
    decoderVersion: null,
    errorCategory: entry.status === "CONFIRMED_ABSENT" ? "NO_DATA" : null,
    errorMessage: null,
    ...(entry.status === "CONFIRMED_ABSENT" ? { absentInventoryRevision: snapshot.revision } : {}),
  };
}

type DurableCheckpoint = DukascopyS3AcquisitionCheckpoint & { durableHash?: string };

function plainCheckpoint(checkpoint: DurableCheckpoint): DukascopyS3AcquisitionCheckpoint {
  const { durableHash, ...plain } = checkpoint;
  if (durableHash && durableHash !== acquisitionHash(plain)) throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
  return plain;
}

export async function runDukascopyDownload(options: RunnerOptions & { snapshot: InventorySnapshot; decode?: typeof decodeRaw; fault?: (stage: "AFTER_DOWNLOAD" | "AFTER_PUBLICATION") => void }): Promise<{ mode: DukascopyS3Session["mode"]; checkpoint: DukascopyS3AcquisitionCheckpoint | null }> {
  const { plan, approval, snapshot } = options;
  const session = options.session ?? new DukascopyS3Session();
  assertInventorySnapshot(plan, snapshot);
  assertApproval(plan, approval, "DOWNLOAD", snapshot.revision);
  if (session.mode === "DRY_RUN") return { mode: "DRY_RUN", checkpoint: null };
  if (!options.store || (session.mode === "LIVE" && (options.decode || options.fault))) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
  const store = options.store;
  await store.saveSnapshot(plan, snapshot);
  const gate = await store.gate(plan, approval, snapshot);
  const plannedBytes = approval.keys.reduce((sum, key) => sum + (snapshot.entries[plan.keys.indexOf(key)].metadata?.contentLength ?? 0), 0);
  if ((await store.freeBytes()) < approval.minimumFreeBytes + plannedBytes) throw new AcquisitionSafetyError("DISK_FULL");
  const checkpointName = `batches/${acquisitionHash(approval.batchId)}.json`;
  const checkpointPath = store.path(checkpointName);
  const saved = await store.readPlain<DurableCheckpoint>(checkpointName);
  if (saved && !saved.durableHash) throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
  let checkpoint: DukascopyS3AcquisitionCheckpoint = saved
    ? plainCheckpoint(saved)
    : {
        checkpointVersion: DUKASCOPY_S3_ACQUISITION_VERSION,
        source: "Dukascopy Official Historical Price Data S3",
        bucket: plan.bucket,
        region: plan.region,
        requesterPays: true,
        instrument: "USDJPY",
        requestedStart: approval.batchStart,
        requestedEnd: approval.batchEnd,
        updatedAt: new Date().toISOString(),
        chunks: approval.keys.map((key) => newChunk(key, plan, snapshot)),
      };
  if (
    checkpoint.checkpointVersion !== DUKASCOPY_S3_ACQUISITION_VERSION ||
    checkpoint.bucket !== plan.bucket ||
    checkpoint.region !== plan.region ||
    checkpoint.requesterPays !== true ||
    checkpoint.instrument !== "USDJPY" ||
    checkpoint.requestedStart !== approval.batchStart ||
    checkpoint.requestedEnd !== approval.batchEnd ||
    checkpoint.chunks.length !== approval.keys.length ||
    new Set(checkpoint.chunks.map((chunk) => chunk.objectKey)).size !== approval.keys.length
  )
    throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
  const persist = async (_path: string, value: DukascopyS3AcquisitionCheckpoint) => {
    const plain = plainCheckpoint({ ...value, durableHash: undefined });
    await store.atomicPlain(checkpointName, { ...plain, durableHash: acquisitionHash(plain) });
  };
  for (const chunk of checkpoint.chunks) {
    if (!approval.keys.includes(chunk.objectKey) || chunk.objectId !== chunk.objectKey || chunk.utcDay !== assertExactDukascopyKey(plan, chunk.objectKey) || !Number.isSafeInteger(chunk.attempts) || chunk.attempts < 0 || !["PLANNED", "DOWNLOADING", "DOWNLOADED", "VERIFIED", "DECODED", "NO_DATA", "FAILED"].includes(chunk.status))
      throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
    if (chunk.rawFilePath) await store.ensurePath(chunk.rawFilePath, true);
    if (chunk.status === "NO_DATA" && (chunk.absentInventoryRevision !== snapshot.revision || snapshot.entries[plan.keys.indexOf(chunk.objectKey)].status !== "CONFIRMED_ABSENT")) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
  }
  const journals = await store.journals();
  for (const journal of journals) {
    if (!approval.keys.includes(journal.key)) continue;
    if (journal.planHash !== plan.planHash || journal.inventoryRevision !== snapshot.revision) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
    if (journal.phase === "WRITING") {
      await store.quarantineJournal(journal);
      continue;
    }
    if (journal.phase === "QUARANTINED") continue;
    const entry = snapshot.entries[plan.keys.indexOf(journal.key)];
    const ledger = await store.ledger(plan);
    if (entry.status !== "PRESENT" || journal.bytes !== entry.metadata?.contentLength || !journal.sha256 || !/^[a-f0-9]{64}$/.test(journal.sha256) || !ledger?.completedGetKeys.includes(journal.key)) throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
    await store.publishRaw(journal);
    const chunk = checkpoint.chunks.find((chunk) => chunk.objectKey === journal.key)!;
    if (chunk.rawSha256 !== journal.sha256 || !["DECODED", "VERIFIED", "FAILED"].includes(chunk.status)) chunk.status = "VERIFIED";
    if (chunk.status === "FAILED" && chunk.errorCategory !== "DECODE_ERROR") chunk.status = "VERIFIED";
    Object.assign(chunk, { rawFilePath: journal.verifiedPath, rawSha256: journal.sha256, rawByteSize: journal.bytes, downloadTimestamp: chunk.downloadTimestamp ?? new Date().toISOString() });
    await store.recordVerified(plan, approval, journal.verifiedPath!, journal.key, journal.bytes, journal.sha256);
  }
  await store.quarantineOrphans(journals.map((journal) => journal.partialPath));
  await store.refreshQuarantineBytes(plan);
  for (const chunk of checkpoint.chunks) {
    if (chunk.status === "FAILED" && chunk.errorCategory === "DECODE_ERROR") throw new AcquisitionSafetyError("DECODE_ERROR");
    if ((chunk.status === "VERIFIED" || chunk.status === "DECODED") && chunk.rawFilePath) {
      try {
        const raw = await store.hashRaw(chunk.rawFilePath);
        if (raw.sha256 !== chunk.rawSha256 || raw.bytes !== chunk.rawByteSize) chunk.status = "PLANNED";
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        chunk.status = "PLANNED";
      }
    }
  }
  await persist(checkpointPath, checkpoint);
  const transferPlan = await planDukascopyS3Acquisition({ instrument: "USDJPY", startDate: approval.batchStart.slice(0, 10), endDate: approval.batchEnd.slice(0, 10), mode: "TRANSFER", requesterPays: true, allowMultiDayTransfer: true });
  transferPlan.objects = approval.keys.map((key) => {
    const entry = snapshot.entries[plan.keys.indexOf(key)];
    const sourceSha = entry.metadata?.checksumType === "FULL_OBJECT" ? entry.metadata.checksums.ChecksumSHA256 : undefined;
    return { objectId: key, key, instrument: "USDJPY", utcDay: assertExactDukascopyKey(plan, key), byteSize: entry.metadata?.contentLength ?? null, ...(sourceSha ? { expectedRawSha256: Buffer.from(sourceSha, "base64").toString("hex") } : {}) };
  });
  const transport = new DukascopyGetTransport({ ...options, session, gate });
  const writer = {
    current: null as ReturnType<DurableAcquisitionStore["artifactWriter"]> | null,
    async writePartial(path: string, source: AsyncIterable<Uint8Array>) {
      const chunk = checkpoint.chunks.find((chunk) => chunk.rawFilePath === path);
      if (!chunk) throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
      this.current = store.artifactWriter(plan, snapshot, chunk.objectKey, options.fault);
      await this.current.writePartial(path, source);
    },
    async publish(partial: string, verified: string) {
      if (!this.current) throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
      await this.current.publish(partial, verified);
      const chunk = checkpoint.chunks.find((chunk) => chunk.rawFilePath === partial);
      if (!chunk) throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
      const raw = await store.hashRaw(verified);
      await store.recordVerified(plan, approval, verified, chunk.objectKey, raw.bytes, raw.sha256);
    },
  };
  while (true) {
    checkpoint = await downloadDukascopyS3PlanSequentially(transferPlan, transport, {
      mode: "TRANSFER",
      requesterPays: true,
      maxObjects: approval.caps.maxObjects,
      maxKnownBytes: Math.max(1, approval.caps.maxVerifiedBytes),
      allowMultiDayTransfer: true,
      rawDirectory: store.path("raw"),
      checkpointPath,
      inventoryRevision: snapshot.revision,
      artifactWriter: writer,
      persistCheckpoint: async (path, value) => {
        checkpoint = value;
        await persist(path, value);
      },
    });
    const failed = checkpoint.chunks.find((chunk) => chunk.status === "FAILED");
    if (!failed) break;
    if (failed.errorCategory !== "TRANSIENT") {
      await store.refreshQuarantineBytes(plan);
      const code = failed.errorCategory === "DECODE_ERROR" ? "DECODE_ERROR" : failed.errorCategory === "CHECKSUM_ERROR" ? "SOURCE_CHANGED" : failed.errorCategory === "DOWNLOAD_FAILED" ? "UNEXPECTED_RESPONSE" : (failed.errorCategory as AcquisitionSafetyError["code"]);
      throw new AcquisitionSafetyError(code);
    }
    await (options.backoff ?? acquisitionBackoff)(failed.attempts, options.signal);
  }
  for (const chunk of checkpoint.chunks) {
    if (chunk.status === "NO_DATA" || chunk.status === "DECODED") continue;
    if (chunk.status !== "VERIFIED" || !chunk.rawFilePath || !chunk.rawSha256 || chunk.rawByteSize === null) throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
    await store.recordVerified(plan, approval, chunk.rawFilePath, chunk.objectKey, chunk.rawByteSize, chunk.rawSha256);
    try {
      const evidence = await (options.decode ?? decodeRaw)(chunk.rawFilePath, chunk.objectKey, chunk.utcDay, chunk.rawSha256);
      if (
        !Number.isSafeInteger(evidence.tickCount) ||
        evidence.tickCount <= 0 ||
        !Number.isSafeInteger(evidence.canonicalMinuteCount) ||
        evidence.canonicalMinuteCount <= 0 ||
        evidence.canonicalMinuteCount > 1440 ||
        evidence.decoderVersion !== DUKASCOPY_BI5_ADAPTER_VERSION ||
        !evidence.firstTickTimestamp.startsWith(chunk.utcDay) ||
        !evidence.lastTickTimestamp.startsWith(chunk.utcDay)
      )
        throw new AcquisitionSafetyError("DECODE_ERROR");
      Object.assign(chunk, evidence, { status: "DECODED", errorCategory: null, errorMessage: null });
    } catch {
      Object.assign(chunk, { status: "FAILED", errorCategory: "DECODE_ERROR", errorMessage: "DECODE_ERROR; raw retained for local diagnostic." });
      await persist(checkpointPath, checkpoint);
      throw new AcquisitionSafetyError("DECODE_ERROR");
    }
    await persist(checkpointPath, checkpoint);
  }
  await store.refreshQuarantineBytes(plan);
  return { mode: session.mode, checkpoint };
}

export function checkpointRelativeName(store: DurableAcquisitionStore, path: string): string {
  return relative(store.root, path);
}
