import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { DUKASCOPY_BI5_BUCKET, DUKASCOPY_BI5_REGION } from "./dukascopy-bi5-adapter";

export const DUKASCOPY_S3_ACQUISITION_VERSION = "DUKASCOPY_S3_ACQUISITION_FOUNDATION_V2" as const;
export const DEFAULT_DUKASCOPY_BI5_RAW_DIRECTORY = "tmp/dukascopy/bi5-raw";

export type S3AcquisitionMode = "DRY_RUN" | "TRANSFER";
export type S3ChunkStatus = "PLANNED" | "DOWNLOADING" | "DOWNLOADED" | "VERIFIED" | "DECODED" | "NO_DATA" | "FAILED";
export type DukascopyS3FailureCategory = "OBJECT_NOT_FOUND" | "DOWNLOAD_FAILED" | "ACCESS_DENIED" | "REQUESTER_PAYS_ERROR" | "CHECKSUM_ERROR" | "DECODE_ERROR" | "APPROVAL_VIOLATION" | "AMBIGUOUS_ACCESS" | "SESSION_EXPIRED" | "UNEXPECTED_RESPONSE" | "SOURCE_CHANGED" | "TRANSIENT" | "CANCELLED" | "CAP_EXCEEDED" | "DISK_FULL" | "FILESYSTEM_UNSAFE";

export class DukascopyS3AcquisitionError extends Error {
  constructor(
    readonly category: DukascopyS3FailureCategory,
    message: string,
  ) {
    super(message);
    this.name = "DukascopyS3AcquisitionError";
  }
}

export interface DukascopyS3AcquisitionRequest {
  instrument: "USDJPY";
  startDate: string;
  endDate: string;
  mode?: S3AcquisitionMode;
  requesterPays?: boolean;
  maxObjects?: number;
  maxKnownBytes?: number;
  allowMultiDayTransfer?: boolean;
}

export interface DukascopyS3ObjectDescriptor {
  objectId: string;
  key: string;
  instrument: "USDJPY";
  utcDay: string;
  byteSize: number | null;
  expectedRawSha256?: string;
}

export interface DukascopyS3Transport {
  downloadObject(request: { bucket: "cfg-public-proper-wallaby"; region: "eu-west-1"; key: string; requesterPays: true }): AsyncIterable<Uint8Array>;
}

export interface DukascopyS3LogicalDayChunk {
  utcDay: string;
  startInclusive: string;
  endExclusive: string;
  objectKey: string;
  objectIds: string[];
}

export interface DukascopyS3DryRunSummary {
  instrument: "USDJPY";
  requestedStart: string;
  requestedEnd: string;
  logicalChunkCount: number;
  plannedObjectCount: number;
  plannedObjectIds: string[];
  plannedObjectKeys: string[];
  plannedKeysKnown: true;
  knownByteSizeTotal: number;
  unknownByteSizeCount: number;
  objectInventoryKnown: boolean;
  requesterPays: true;
  bucket: "cfg-public-proper-wallaby";
  region: "eu-west-1";
  transferWouldOccur: false;
  maxObjects: number | null;
  maxKnownBytes: number | null;
  objectCapExceeded: boolean;
  byteCapExceeded: boolean;
}

export interface DukascopyS3AcquisitionPlan {
  acquisitionVersion: typeof DUKASCOPY_S3_ACQUISITION_VERSION;
  mode: S3AcquisitionMode;
  instrument: "USDJPY";
  requestedStart: string;
  requestedEnd: string;
  requesterPays: true;
  bucket: "cfg-public-proper-wallaby";
  region: "eu-west-1";
  logicalChunks: DukascopyS3LogicalDayChunk[];
  objects: DukascopyS3ObjectDescriptor[];
  dryRun: DukascopyS3DryRunSummary;
  allowMultiDayTransfer: boolean;
}

export interface S3AcquisitionChunkCheckpoint {
  objectId: string;
  objectKey: string;
  utcDay: string;
  status: S3ChunkStatus;
  attempts: number;
  rawFilePath: string | null;
  rawByteSize: number | null;
  rawSha256: string | null;
  downloadTimestamp: string | null;
  firstTickTimestamp: string | null;
  lastTickTimestamp: string | null;
  tickCount: number | null;
  canonicalMinuteCount: number | null;
  decoderVersion: string | null;
  errorCategory: string | null;
  errorMessage: string | null;
  absentInventoryRevision?: string;
}

export interface DukascopyS3AcquisitionCheckpoint {
  checkpointVersion: typeof DUKASCOPY_S3_ACQUISITION_VERSION;
  source: "Dukascopy Official Historical Price Data S3";
  bucket: "cfg-public-proper-wallaby";
  region: "eu-west-1";
  requesterPays: true;
  instrument: "USDJPY";
  requestedStart: string;
  requestedEnd: string;
  updatedAt: string;
  chunks: S3AcquisitionChunkCheckpoint[];
}

export interface S3TransferSafetyOptions {
  mode: "TRANSFER";
  requesterPays: true;
  maxObjects: number;
  maxKnownBytes: number;
  allowMultiDayTransfer?: boolean;
  rawDirectory?: string;
  checkpointPath: string;
  inventoryRevision?: string;
  artifactWriter?: {
    writePartial(path: string, source: AsyncIterable<Uint8Array>): Promise<void>;
    publish(partialPath: string, verifiedPath: string): Promise<void>;
  };
  persistCheckpoint?: typeof writeDukascopyS3CheckpointAtomic;
}

const DAY_MS = 86_400_000;
const DAY_PATTERN = /^\d{4}-\d\d-\d\d$/;
const SHA256 = /^[a-f0-9]{64}$/i;

function dateStart(value: string, field: string): number {
  if (!DAY_PATTERN.test(value)) throw new Error(`${field} is required in YYYY-MM-DD form`);
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) throw new Error(`${field} is not a valid UTC calendar date`);
  return timestamp;
}

function logicalDays(startAt: number, endAt: number): DukascopyS3LogicalDayChunk[] {
  const chunks: DukascopyS3LogicalDayChunk[] = [];
  for (let at = startAt; at < endAt; at += DAY_MS) {
    const date = new Date(at);
    const utcDay = date.toISOString().slice(0, 10);
    const year = String(date.getUTCFullYear()).padStart(4, "0");
    const month = String(date.getUTCMonth()).padStart(2, "0");
    const day = String(date.getUTCDate()).padStart(2, "0");
    const objectKey = `USDJPY/${year}/${month}/${day}_ticks.bi5`;
    chunks.push({ utcDay, startInclusive: `${utcDay}T00:00:00.000Z`, endExclusive: new Date(at + DAY_MS).toISOString(), objectKey, objectIds: [objectKey] });
  }
  return chunks;
}

export async function planDukascopyS3Acquisition(request: DukascopyS3AcquisitionRequest): Promise<DukascopyS3AcquisitionPlan> {
  if (request.instrument !== "USDJPY") throw new Error("only verified USDJPY BI5 scaling is currently supported");
  const startAt = dateStart(request.startDate, "startDate");
  const endAt = dateStart(request.endDate, "endDate");
  if (startAt >= endAt) throw new Error("startDate must be earlier than exclusive endDate");
  if (request.requesterPays !== true) throw new Error("Requester Pays must be explicitly enabled for this source");
  const mode = request.mode ?? "DRY_RUN";
  if (mode === "TRANSFER" && request.requesterPays !== true) throw new Error("TRANSFER requires explicit requesterPays: true");
  const chunks = logicalDays(startAt, endAt);
  const allowMultiDayTransfer = request.allowMultiDayTransfer === true;
  if (mode === "TRANSFER" && chunks.length > 1 && !allowMultiDayTransfer) throw new Error("multi-day transfer requires allowMultiDayTransfer: true");
  const objects = chunks.map(
    (chunk): DukascopyS3ObjectDescriptor => ({
      objectId: chunk.objectKey,
      key: chunk.objectKey,
      instrument: request.instrument,
      utcDay: chunk.utcDay,
      byteSize: null,
    }),
  );
  const objectIds = objects.map((object) => object.objectId);
  const objectKeys = objects.map((object) => object.key);
  const objectCapExceeded = request.maxObjects !== undefined && objects.length > request.maxObjects;
  const knownByteSizeTotal = 0;
  const unknownByteSizeCount = objects.length;
  const byteCapExceeded = false;
  const summary: DukascopyS3DryRunSummary = {
    instrument: request.instrument,
    requestedStart: new Date(startAt).toISOString(),
    requestedEnd: new Date(endAt).toISOString(),
    logicalChunkCount: chunks.length,
    plannedObjectCount: objects.length,
    plannedObjectIds: objectIds,
    plannedObjectKeys: objectKeys,
    plannedKeysKnown: true,
    knownByteSizeTotal,
    unknownByteSizeCount,
    objectInventoryKnown: false,
    requesterPays: true,
    bucket: DUKASCOPY_BI5_BUCKET,
    region: DUKASCOPY_BI5_REGION,
    transferWouldOccur: false,
    maxObjects: request.maxObjects ?? null,
    maxKnownBytes: request.maxKnownBytes ?? null,
    objectCapExceeded,
    byteCapExceeded,
  };
  return {
    acquisitionVersion: DUKASCOPY_S3_ACQUISITION_VERSION,
    mode,
    instrument: request.instrument,
    requestedStart: summary.requestedStart,
    requestedEnd: summary.requestedEnd,
    requesterPays: true,
    bucket: DUKASCOPY_BI5_BUCKET,
    region: DUKASCOPY_BI5_REGION,
    logicalChunks: chunks,
    objects,
    dryRun: summary,
    allowMultiDayTransfer,
  };
}

function checkpointFromPlan(plan: DukascopyS3AcquisitionPlan): DukascopyS3AcquisitionCheckpoint {
  return {
    checkpointVersion: DUKASCOPY_S3_ACQUISITION_VERSION,
    source: "Dukascopy Official Historical Price Data S3",
    bucket: DUKASCOPY_BI5_BUCKET,
    region: DUKASCOPY_BI5_REGION,
    requesterPays: true,
    instrument: plan.instrument,
    requestedStart: plan.requestedStart,
    requestedEnd: plan.requestedEnd,
    updatedAt: new Date().toISOString(),
    chunks: plan.objects.map((object) => ({
      objectId: object.objectId,
      objectKey: object.key,
      utcDay: object.utcDay,
      status: "PLANNED",
      attempts: 0,
      rawFilePath: null,
      rawByteSize: object.byteSize,
      rawSha256: null,
      downloadTimestamp: null,
      firstTickTimestamp: null,
      lastTickTimestamp: null,
      tickCount: null,
      canonicalMinuteCount: null,
      decoderVersion: null,
      errorCategory: null,
      errorMessage: null,
    })),
  };
}

export async function writeDukascopyS3CheckpointAtomic(path: string, checkpoint: DukascopyS3AcquisitionCheckpoint): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const next = { ...checkpoint, updatedAt: new Date().toISOString() };
  await writeFile(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  await rename(temporaryPath, path);
}

export async function readDukascopyS3Checkpoint(path: string): Promise<DukascopyS3AcquisitionCheckpoint | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || (parsed as DukascopyS3AcquisitionCheckpoint).checkpointVersion !== DUKASCOPY_S3_ACQUISITION_VERSION || !Array.isArray((parsed as DukascopyS3AcquisitionCheckpoint).chunks)) {
      throw new Error("unsupported acquisition checkpoint");
    }
    return parsed as DukascopyS3AcquisitionCheckpoint;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export async function isVerifiedS3ArtifactReusable(chunk: S3AcquisitionChunkCheckpoint): Promise<boolean> {
  if ((chunk.status !== "VERIFIED" && chunk.status !== "DECODED") || !chunk.rawFilePath || !chunk.rawSha256 || !SHA256.test(chunk.rawSha256)) return false;
  try {
    return (await hashFile(chunk.rawFilePath)) === chunk.rawSha256;
  } catch {
    return false;
  }
}

export async function markDukascopyS3ChunkDecoded(checkpointPath: string, objectId: string, details: { firstTickTimestamp: string; lastTickTimestamp: string; tickCount: number; canonicalMinuteCount: number; decoderVersion: string }): Promise<DukascopyS3AcquisitionCheckpoint> {
  const checkpoint = await readDukascopyS3Checkpoint(checkpointPath);
  if (!checkpoint) throw new Error("acquisition checkpoint does not exist");
  const chunk = checkpoint.chunks.find((candidate) => candidate.objectId === objectId);
  if (!chunk) throw new Error(`checkpoint object not found: ${objectId}`);
  if (chunk.status !== "VERIFIED") throw new Error(`only VERIFIED chunks can be decoded: ${objectId}`);
  if (details.tickCount < 0 || details.canonicalMinuteCount < 0) throw new Error("decoded counts must be non-negative");
  Object.assign(chunk, details, { status: "DECODED" as const, errorCategory: null, errorMessage: null });
  await writeDukascopyS3CheckpointAtomic(checkpointPath, checkpoint);
  return checkpoint;
}

export async function markDukascopyS3ChunkDecodeFailed(checkpointPath: string, objectId: string): Promise<DukascopyS3AcquisitionCheckpoint> {
  const checkpoint = await readDukascopyS3Checkpoint(checkpointPath);
  if (!checkpoint) throw new Error("acquisition checkpoint does not exist");
  const chunk = checkpoint.chunks.find((candidate) => candidate.objectId === objectId);
  if (!chunk) throw new Error(`checkpoint object not found: ${objectId}`);
  if (chunk.status !== "VERIFIED") throw new Error(`only VERIFIED chunks can fail decode: ${objectId}`);
  Object.assign(chunk, { status: "FAILED" as const, errorCategory: "DECODE_ERROR", errorMessage: "BI5 decoding failed; underlying details are omitted to prevent secret leakage." });
  await writeDukascopyS3CheckpointAtomic(checkpointPath, checkpoint);
  return checkpoint;
}

export function safeArtifactPrefix(objectId: string): string {
  return createHash("sha256").update(objectId, "utf8").digest("hex").slice(0, 24);
}

function assertTransferSafety(plan: DukascopyS3AcquisitionPlan, options: S3TransferSafetyOptions): void {
  if (plan.mode !== "TRANSFER" || options.mode !== "TRANSFER") throw new Error("download execution requires an explicit TRANSFER mode");
  if (options.requesterPays !== true || plan.requesterPays !== true) throw new Error("Requester Pays must be explicitly enabled");
  if (!Number.isSafeInteger(options.maxObjects) || options.maxObjects <= 0) throw new Error("a positive maxObjects cap is required");
  if (!Number.isSafeInteger(options.maxKnownBytes) || options.maxKnownBytes <= 0) throw new Error("a positive maxKnownBytes cap is required");
  if (plan.objects.length === 0) throw new Error("empty daily-key plan; transfer is not authorized");
  if (plan.objects.length > options.maxObjects) throw new Error("planned object count exceeds maxObjects safety cap");
  if (plan.logicalChunks.length > 1 && options.allowMultiDayTransfer !== true) throw new Error("multi-day transfer requires explicit allowMultiDayTransfer: true");
}

export async function downloadDukascopyS3PlanSequentially(plan: DukascopyS3AcquisitionPlan, transport: DukascopyS3Transport, options: S3TransferSafetyOptions): Promise<DukascopyS3AcquisitionCheckpoint> {
  assertTransferSafety(plan, options);
  const checkpointPath = options.checkpointPath;
  const persistCheckpoint = options.persistCheckpoint ?? writeDukascopyS3CheckpointAtomic;
  const previous = await readDukascopyS3Checkpoint(checkpointPath);
  const checkpoint = previous ?? checkpointFromPlan(plan);
  if (checkpoint.instrument !== plan.instrument || checkpoint.requestedStart !== plan.requestedStart || checkpoint.requestedEnd !== plan.requestedEnd) {
    throw new Error("checkpoint range/instrument does not match acquisition plan");
  }
  const plannedObjects = new Map(plan.objects.map((object) => [object.objectId, object]));
  if (
    checkpoint.chunks.some((chunk) => {
      const object = plannedObjects.get(chunk.objectId);
      return !object || object.key !== chunk.objectKey || object.utcDay !== chunk.utcDay;
    })
  )
    throw new Error("checkpoint object inventory changed; create a newly reviewed checkpoint");
  const rawDirectory = options.rawDirectory ?? DEFAULT_DUKASCOPY_BI5_RAW_DIRECTORY;
  await mkdir(rawDirectory, { recursive: true });
  let totalArtifactBytes = 0;

  for (const object of plan.objects) {
    let chunk = checkpoint.chunks.find((entry) => entry.objectId === object.objectId);
    if (!chunk) {
      chunk = {
        objectId: object.objectId,
        objectKey: object.key,
        utcDay: object.utcDay,
        status: "PLANNED",
        attempts: 0,
        rawFilePath: null,
        rawByteSize: object.byteSize,
        rawSha256: null,
        downloadTimestamp: null,
        firstTickTimestamp: null,
        lastTickTimestamp: null,
        tickCount: null,
        canonicalMinuteCount: null,
        decoderVersion: null,
        errorCategory: null,
        errorMessage: null,
      };
      checkpoint.chunks.push(chunk);
    }
    if (chunk.status === "NO_DATA" && options.inventoryRevision && chunk.absentInventoryRevision === options.inventoryRevision) continue;
    if ((await isVerifiedS3ArtifactReusable(chunk)) && (!object.expectedRawSha256 || chunk.rawSha256 === object.expectedRawSha256.toLowerCase())) {
      totalArtifactBytes += chunk.rawByteSize ?? 0;
      if (totalArtifactBytes > options.maxKnownBytes) throw new Error("verified artifacts exceed maxKnownBytes safety cap");
      continue;
    }

    const prefix = safeArtifactPrefix(object.objectId);
    const partialPath = join(rawDirectory, `${prefix}.${chunk.attempts + 1}.${randomUUID()}.partial`);
    chunk.status = "DOWNLOADING";
    chunk.attempts++;
    chunk.rawFilePath = partialPath;
    chunk.downloadTimestamp = null;
    chunk.errorCategory = null;
    chunk.errorMessage = null;
    await persistCheckpoint(checkpointPath, checkpoint);

    try {
      let currentArtifactBytes = 0;
      const source = (async function* () {
        for await (const bytes of transport.downloadObject({ bucket: DUKASCOPY_BI5_BUCKET, region: DUKASCOPY_BI5_REGION, key: object.key, requesterPays: true })) {
          currentArtifactBytes += bytes.byteLength;
          if (totalArtifactBytes + currentArtifactBytes > options.maxKnownBytes) {
            throw new DukascopyS3AcquisitionError("DOWNLOAD_FAILED", "download exceeded maxKnownBytes safety cap");
          }
          yield bytes;
        }
      })();
      if (options.artifactWriter) await options.artifactWriter.writePartial(partialPath, source);
      else {
        const output = createWriteStream(partialPath, { flags: "wx" });
        try {
          for await (const bytes of source) if (!output.write(bytes)) await once(output, "drain");
          output.end();
          await once(output, "finish");
        } catch (error) {
          output.destroy();
          if (!output.closed) await once(output, "close");
          throw error;
        }
      }

      const rawSha256 = await hashFile(partialPath);
      const rawByteSize = (await stat(partialPath)).size;
      chunk.status = "DOWNLOADED";
      chunk.downloadTimestamp = new Date().toISOString();
      chunk.rawSha256 = rawSha256;
      chunk.rawByteSize = rawByteSize;
      await persistCheckpoint(checkpointPath, checkpoint);
      if (object.byteSize !== null && rawByteSize !== object.byteSize) throw new DukascopyS3AcquisitionError("CHECKSUM_ERROR", "downloaded byte size differs from inventory");
      if (object.expectedRawSha256 && rawSha256 !== object.expectedRawSha256.toLowerCase()) throw new DukascopyS3AcquisitionError("CHECKSUM_ERROR", "downloaded raw SHA-256 differs from inventory");
      const verifiedPath = join(rawDirectory, `${prefix}-${rawSha256}-attempt-${chunk.attempts}.bi5`);
      if (options.artifactWriter) await options.artifactWriter.publish(partialPath, verifiedPath);
      else await rename(partialPath, verifiedPath);
      chunk.status = "VERIFIED";
      chunk.rawFilePath = verifiedPath;
      totalArtifactBytes += rawByteSize;
      await persistCheckpoint(checkpointPath, checkpoint);
    } catch (error) {
      const category = error instanceof DukascopyS3AcquisitionError ? error.category : "DOWNLOAD_FAILED";
      if (category === "OBJECT_NOT_FOUND") {
        await unlink(partialPath).catch(() => undefined);
        chunk.status = "NO_DATA";
        chunk.rawFilePath = null;
        chunk.rawByteSize = null;
        chunk.rawSha256 = null;
        chunk.downloadTimestamp = null;
        chunk.errorCategory = "NO_DATA";
        chunk.errorMessage = "Expected daily object is absent; source reports NO_DATA.";
      } else {
        chunk.status = "FAILED";
        chunk.errorCategory = category;
        chunk.errorMessage = `${category}; underlying details are omitted to prevent secret leakage.`;
      }
      await persistCheckpoint(checkpointPath, checkpoint);
      if (chunk.status === "NO_DATA") continue;
      return checkpoint;
    }
  }
  return checkpoint;
}
