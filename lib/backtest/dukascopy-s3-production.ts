import { createHash } from "node:crypto";
import { S3Client, HeadObjectCommand, GetObjectCommand, type HeadObjectCommandOutput, type GetObjectCommandOutput } from "@aws-sdk/client-s3";
import { fromIni } from "@aws-sdk/credential-providers";
import { planDukascopyS3Acquisition, DukascopyS3AcquisitionError, type DukascopyS3Transport } from "./dukascopy-s3-acquisition";
import { DUKASCOPY_BI5_BUCKET, DUKASCOPY_BI5_REGION } from "./dukascopy-bi5-adapter";

export const DUKASCOPY_PLAN_HASH = "c8731ac9b80e8a83373f295e9f8834abaa611fdf08297a9552d3d9346c758302";
export const DUKASCOPY_PROFILE = "dukascopy-pilot";
export const DUKASCOPY_REQUEST_TIMEOUT_MS = 60_000;
export const DUKASCOPY_MAX_ATTEMPTS = 3;
export type AcquisitionOperation = "HEAD" | "GET";
export type AcquisitionErrorCode = "APPROVAL_VIOLATION" | "AMBIGUOUS_ACCESS" | "REQUESTER_PAYS_ERROR" | "SESSION_EXPIRED" | "UNEXPECTED_RESPONSE" | "SOURCE_CHANGED" | "TRANSIENT" | "CANCELLED" | "CAP_EXCEEDED" | "DISK_FULL" | "FILESYSTEM_UNSAFE" | "DECODE_ERROR";

export class AcquisitionSafetyError extends DukascopyS3AcquisitionError {
  constructor(readonly code: AcquisitionErrorCode) {
    super(code, `Acquisition stopped: ${code}`);
    this.name = "AcquisitionSafetyError";
  }
}

export function acquisitionHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export interface FrozenDukascopyPlan {
  readonly planHash: string;
  readonly instrument: "USDJPY";
  readonly requestedStart: string;
  readonly requestedEnd: string;
  readonly bucket: typeof DUKASCOPY_BI5_BUCKET;
  readonly region: typeof DUKASCOPY_BI5_REGION;
  readonly requesterPays: true;
  readonly keys: readonly string[];
}

export async function createFrozenDukascopyPlan(expectedHash = DUKASCOPY_PLAN_HASH): Promise<FrozenDukascopyPlan> {
  const planned = await planDukascopyS3Acquisition({ instrument: "USDJPY", startDate: "2021-01-01", endDate: "2026-01-01", mode: "DRY_RUN", requesterPays: true });
  const keys = Object.freeze(planned.objects.map((object) => object.key));
  if (keys.length !== 1826 || new Set(keys).size !== 1826 || acquisitionHash(keys) !== expectedHash || expectedHash !== DUKASCOPY_PLAN_HASH) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
  return Object.freeze({ planHash: expectedHash, instrument: "USDJPY", requestedStart: planned.requestedStart, requestedEnd: planned.requestedEnd, bucket: DUKASCOPY_BI5_BUCKET, region: DUKASCOPY_BI5_REGION, requesterPays: true, keys });
}

export function assertFrozenPlan(plan: FrozenDukascopyPlan): void {
  if (
    plan.planHash !== DUKASCOPY_PLAN_HASH ||
    plan.instrument !== "USDJPY" ||
    plan.bucket !== DUKASCOPY_BI5_BUCKET ||
    plan.region !== DUKASCOPY_BI5_REGION ||
    plan.requesterPays !== true ||
    plan.requestedStart !== "2021-01-01T00:00:00.000Z" ||
    plan.requestedEnd !== "2026-01-01T00:00:00.000Z" ||
    plan.keys.length !== 1826 ||
    acquisitionHash(plan.keys) !== DUKASCOPY_PLAN_HASH
  )
    throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
}

export function assertExactDukascopyKey(plan: FrozenDukascopyPlan, key: string): string {
  const match = /^USDJPY\/(202[1-5])\/(0[0-9]|1[01])\/(\d\d)_ticks\.bi5$/.exec(key);
  if (!match || !plan.keys.includes(key)) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
  const day = `${match[1]}-${String(Number(match[2]) + 1).padStart(2, "0")}-${match[3]}`;
  if (new Date(`${day}T00:00:00.000Z`).toISOString().slice(0, 10) !== day) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
  return day;
}

const SDK_SENDERS = new WeakSet<object>();
const LIVE_SESSION_ACTIVATION = Symbol("approved-live-session");

export function createDukascopySdkClient(activation?: symbol): OfflineS3Sender & { destroy(): void } {
  if (typeof window !== "undefined") throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
  const sdk = new S3Client({
    region: DUKASCOPY_BI5_REGION,
    endpoint: "https://s3.eu-west-1.amazonaws.com",
    followRegionRedirects: false,
    maxAttempts: 1,
    credentials: fromIni({ profile: DUKASCOPY_PROFILE, clientConfig: { region: DUKASCOPY_BI5_REGION, maxAttempts: 1, requestHandler: { connectionTimeout: 5_000, requestTimeout: DUKASCOPY_REQUEST_TIMEOUT_MS } } }),
    requestHandler: { connectionTimeout: 5_000, requestTimeout: DUKASCOPY_REQUEST_TIMEOUT_MS, httpsAgent: { maxSockets: 1 } },
  });
  const plan = createFrozenDukascopyPlan();
  const sender: OfflineS3Sender & { destroy(): void } = {
    async send(command, options) {
      if (activation !== LIVE_SESSION_ACTIVATION || !(command instanceof HeadObjectCommand || command instanceof GetObjectCommand) || command.input.Bucket !== DUKASCOPY_BI5_BUCKET || command.input.RequestPayer !== "requester") throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
      assertExactDukascopyKey(await plan, command.input.Key ?? "");
      return command instanceof HeadObjectCommand ? sdk.send(command, options) : sdk.send(command, options);
    },
    destroy() { sdk.destroy(); },
  };
  SDK_SENDERS.add(sender);
  return sender;
}

export interface OfflineS3Sender {
  send(command: HeadObjectCommand | GetObjectCommand, options: { abortSignal: AbortSignal }): Promise<HeadObjectCommandOutput | GetObjectCommandOutput>;
}

export class DukascopyS3Session {
  private readonly client: OfflineS3Sender | null;
  readonly mode: "DRY_RUN" | "OFFLINE_TEST" | "LIVE";

  private readonly frozenPlan = createFrozenDukascopyPlan();
  private closeClient: (() => void) | undefined;
  constructor(options: { mode?: "DRY_RUN" | "OFFLINE_TEST" | "LIVE"; allowLiveRequests?: boolean; fakeClient?: OfflineS3Sender } = {}) {
    if (Object.keys(options).some(key => !["mode", "allowLiveRequests", "fakeClient"].includes(key))) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
    this.mode = options.mode ?? "DRY_RUN";
    if (this.mode === "LIVE") {
      if (options.allowLiveRequests !== true || options.fakeClient) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
      const sdk = createDukascopySdkClient(LIVE_SESSION_ACTIVATION);
      this.client = sdk;
      this.closeClient = () => sdk.destroy();
    } else if (this.mode === "OFFLINE_TEST") {
      if (!options.fakeClient || options.fakeClient instanceof S3Client || SDK_SENDERS.has(options.fakeClient) || options.allowLiveRequests) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
      this.client = options.fakeClient;
    } else {
      if (options.fakeClient || options.allowLiveRequests) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
      this.client = null;
    }
  }

  async send(command: HeadObjectCommand | GetObjectCommand, signal: AbortSignal, approval?: AcquisitionApproval): Promise<HeadObjectCommandOutput | GetObjectCommandOutput> {
    if (!this.client || !(command instanceof HeadObjectCommand || command instanceof GetObjectCommand) || command.input.Bucket !== DUKASCOPY_BI5_BUCKET || command.input.RequestPayer !== "requester") throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
    const plan = await this.frozenPlan;
    assertExactDukascopyKey(plan, command.input.Key ?? "");
    if (this.mode === "LIVE") {
      if (!approval || !approval.keys.includes(command.input.Key!)) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
      assertApproval(plan, approval, command instanceof HeadObjectCommand ? "INVENTORY" : "DOWNLOAD", approval.inventoryRevision);
    }
    if (signal.aborted) throw new AcquisitionSafetyError("CANCELLED");
    return this.client.send(command, { abortSignal: signal });
  }

  destroy(): void { this.closeClient?.(); }
}

export interface AcquisitionCaps {
  maxHeadAttempts: number;
  maxGetAttempts: number;
  maxNetworkBytes: number;
  maxVerifiedBytes: number;
  maxObjects: number;
  maxRetries: number;
}

export interface AcquisitionApproval {
  id: string;
  batchId: string;
  operation: "INVENTORY" | "DOWNLOAD";
  planHash: string;
  inventoryRevision: string | null;
  batchStart: string;
  batchEnd: string;
  keys: readonly string[];
  caps: AcquisitionCaps;
  globalCaps: AcquisitionCaps;
  minimumFreeBytes: number;
  expiresAt: string;
}

export function assertApproval(plan: FrozenDukascopyPlan, approval: AcquisitionApproval, operation: AcquisitionApproval["operation"], revision: string | null, now = Date.now()): void {
  assertFrozenPlan(plan);
  const start = Date.parse(approval.batchStart);
  const end = Date.parse(approval.batchEnd);
  if (
    !/^[a-zA-Z0-9_-]{1,80}$/.test(approval.id) ||
    !/^[a-zA-Z0-9_-]{1,80}$/.test(approval.batchId) ||
    approval.operation !== operation ||
    approval.planHash !== plan.planHash ||
    approval.inventoryRevision !== revision ||
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    new Date(start).toISOString() !== approval.batchStart ||
    new Date(end).toISOString() !== approval.batchEnd ||
    start % 86400000 ||
    end % 86400000 ||
    start >= end ||
    start < Date.parse(plan.requestedStart) ||
    end > Date.parse(plan.requestedEnd) ||
    !Number.isFinite(Date.parse(approval.expiresAt)) ||
    Date.parse(approval.expiresAt) <= now ||
    !approval.keys.length ||
    new Set(approval.keys).size !== approval.keys.length ||
    !Number.isSafeInteger(approval.minimumFreeBytes) ||
    approval.minimumFreeBytes < 0
  )
    throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
  if (["__proto__", "constructor", "prototype"].includes(approval.id)) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
  for (const caps of [approval.caps, approval.globalCaps]) {
    const fields: Array<keyof AcquisitionCaps> = ["maxHeadAttempts", "maxGetAttempts", "maxNetworkBytes", "maxVerifiedBytes", "maxObjects", "maxRetries"];
    if (Object.keys(caps).length !== fields.length || fields.some((field) => !Number.isSafeInteger(caps[field]) || caps[field] < 0) || caps.maxObjects < approval.keys.length || caps.maxObjects > 1826 || caps.maxRetries > 2) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
  }
  for (const key of approval.keys) {
    const at = Date.parse(`${assertExactDukascopyKey(plan, key)}T00:00:00.000Z`);
    if (at < start || at >= end) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
  }
}

export interface InventoryMetadata {
  contentLength: number;
  etag: string;
  lastModified: string | null;
  storageClass: string | null;
  checksumType: "FULL_OBJECT" | "COMPOSITE" | null;
  checksums: Record<string, string>;
  requestCharged: "requester";
}

export interface InventoryEntry {
  key: string;
  utcDay: string;
  status: "UNKNOWN" | "PRESENT" | "CONFIRMED_ABSENT" | "AMBIGUOUS_ACCESS" | "ERROR";
  metadata: InventoryMetadata | null;
  checkedAt: string | null;
  attempts: number;
  error: AcquisitionErrorCode | null;
}

export interface InventorySnapshot extends FrozenDukascopyPlan {
  entries: readonly InventoryEntry[];
  createdAt: string;
  actualTotalBytes: number | null;
  revision: string;
}

const CHECKSUM_FIELDS = ["ChecksumCRC32", "ChecksumCRC32C", "ChecksumCRC64NVME", "ChecksumSHA1", "ChecksumSHA256", "ChecksumSHA512", "ChecksumMD5", "ChecksumXXHASH64", "ChecksumXXHASH3", "ChecksumXXHASH128"];

function validateResponseRegion(value: unknown): void {
  const response = value as { $response?: { headers?: Record<string, string> }; $metadata?: { httpStatusCode?: number } };
  const region = response?.$response?.headers?.["x-amz-bucket-region"];
  if ((region && region !== DUKASCOPY_BI5_REGION) || response?.$metadata?.httpStatusCode !== 200) throw new AcquisitionSafetyError("UNEXPECTED_RESPONSE");
}

function allowlistedMetadata(output: HeadObjectCommandOutput): InventoryMetadata {
  validateResponseRegion(output);
  if (!Number.isSafeInteger(output.ContentLength) || output.ContentLength! < 0 || typeof output.ETag !== "string" || !/^"[^"\r\n]{1,128}"$/.test(output.ETag) || output.RequestCharged !== "requester") throw new AcquisitionSafetyError(output.RequestCharged !== "requester" ? "REQUESTER_PAYS_ERROR" : "UNEXPECTED_RESPONSE");
  if (output.ChecksumType !== undefined && output.ChecksumType !== "FULL_OBJECT" && output.ChecksumType !== "COMPOSITE") throw new AcquisitionSafetyError("UNEXPECTED_RESPONSE");
  if (output.StorageClass && !["STANDARD", "STANDARD_IA", "ONEZONE_IA", "INTELLIGENT_TIERING", "REDUCED_REDUNDANCY", "GLACIER", "DEEP_ARCHIVE", "GLACIER_IR"].includes(output.StorageClass)) throw new AcquisitionSafetyError("UNEXPECTED_RESPONSE");
  const checksums: Record<string, string> = {};
  for (const field of CHECKSUM_FIELDS) {
    const value = (output as unknown as Record<string, unknown>)[field];
    if (value !== undefined) {
      if (typeof value !== "string" || !/^[A-Za-z0-9+/]{1,256}={0,2}$/.test(value)) throw new AcquisitionSafetyError("UNEXPECTED_RESPONSE");
      checksums[field] = value;
    }
  }
  if (checksums.ChecksumSHA256 && Buffer.from(checksums.ChecksumSHA256, "base64").length !== 32) throw new AcquisitionSafetyError("UNEXPECTED_RESPONSE");
  return { contentLength: output.ContentLength!, etag: output.ETag, lastModified: output.LastModified?.toISOString() ?? null, storageClass: output.StorageClass ?? null, checksumType: output.ChecksumType ?? null, checksums, requestCharged: "requester" };
}

export function createInventorySnapshot(plan: FrozenDukascopyPlan, supplied: readonly InventoryEntry[], createdAt = new Date().toISOString()): InventorySnapshot {
  assertFrozenPlan(plan);
  const entries = plan.keys.map((key, index) => {
    const entry = supplied[index] ?? { key, utcDay: assertExactDukascopyKey(plan, key), status: "UNKNOWN" as const, metadata: null, checkedAt: null, attempts: 0, error: null };
    if (entry.key !== key || entry.utcDay !== assertExactDukascopyKey(plan, key) || !["UNKNOWN", "PRESENT", "CONFIRMED_ABSENT", "AMBIGUOUS_ACCESS", "ERROR"].includes(entry.status) || !Number.isSafeInteger(entry.attempts) || entry.attempts < 0 || entry.attempts > 3 || (entry.status === "PRESENT") !== (entry.metadata !== null))
      throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
    if (entry.status === "UNKNOWN" ? entry.checkedAt !== null || entry.attempts !== 0 || entry.error !== null : !entry.checkedAt || !Number.isFinite(Date.parse(entry.checkedAt)) || new Date(entry.checkedAt).toISOString() !== entry.checkedAt) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
    if (entry.error && !["APPROVAL_VIOLATION", "AMBIGUOUS_ACCESS", "REQUESTER_PAYS_ERROR", "SESSION_EXPIRED", "UNEXPECTED_RESPONSE", "SOURCE_CHANGED", "TRANSIENT", "CANCELLED", "CAP_EXCEEDED", "DISK_FULL", "FILESYSTEM_UNSAFE", "DECODE_ERROR"].includes(entry.error)) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
    if (entry.metadata) {
      const metadata = entry.metadata;
      const reconstructed = allowlistedMetadata({
        $metadata: { httpStatusCode: 200 },
        ContentLength: metadata.contentLength,
        ETag: metadata.etag,
        RequestCharged: metadata.requestCharged,
        LastModified: metadata.lastModified ? new Date(metadata.lastModified) : undefined,
        StorageClass: metadata.storageClass as HeadObjectCommandOutput["StorageClass"],
        ChecksumType: metadata.checksumType ?? undefined,
        ...metadata.checksums,
      });
      if (acquisitionHash(reconstructed) !== acquisitionHash(metadata)) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
    }
    return Object.freeze({ key: entry.key, utcDay: entry.utcDay, status: entry.status, metadata: entry.metadata ? Object.freeze({ ...entry.metadata, checksums: Object.freeze({ ...entry.metadata.checksums }) }) : null, checkedAt: entry.checkedAt, attempts: entry.attempts, error: entry.error });
  });
  if (supplied.length > plan.keys.length || !Number.isFinite(Date.parse(createdAt))) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
  const complete = entries.every((entry) => entry.status === "PRESENT" || entry.status === "CONFIRMED_ABSENT");
  const content = { planHash: plan.planHash, instrument: plan.instrument, requestedStart: plan.requestedStart, requestedEnd: plan.requestedEnd, bucket: plan.bucket, region: plan.region, requesterPays: plan.requesterPays, keys: Object.freeze([...plan.keys]), entries: Object.freeze(entries), createdAt, actualTotalBytes: complete ? entries.reduce((total, entry) => total + (entry.metadata?.contentLength ?? 0), 0) : null };
  return Object.freeze({ ...content, revision: acquisitionHash(content) });
}

export function assertInventorySnapshot(plan: FrozenDukascopyPlan, snapshot: InventorySnapshot): void {
  assertFrozenPlan(snapshot);
  const rebuilt = createInventorySnapshot(plan, snapshot.entries, snapshot.createdAt);
  if (rebuilt.revision !== snapshot.revision || rebuilt.actualTotalBytes !== snapshot.actualTotalBytes || acquisitionHash(snapshot) !== acquisitionHash(rebuilt)) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
}

export interface AcquisitionRequestGate {
  before(operation: AcquisitionOperation, key: string, reservedBytes: number): Promise<void>;
  received(key: string, bytes: number): Promise<void>;
  success(operation: AcquisitionOperation, key: string): Promise<void>;
  failure(operation: AcquisitionOperation, key: string, error: AcquisitionErrorCode): Promise<void>;
}

export function classifyAcquisitionError(error: unknown, operation: AcquisitionOperation): AcquisitionSafetyError {
  if (error instanceof AcquisitionSafetyError) return error;
  const value = error as { name?: string; code?: string; $metadata?: { httpStatusCode?: number }; $response?: { headers?: Record<string, string> } };
  const status = value?.$metadata?.httpStatusCode;
  if ((value?.$response?.headers?.["x-amz-bucket-region"] && value.$response.headers["x-amz-bucket-region"] !== DUKASCOPY_BI5_REGION) || status === 301 || status === 307) return new AcquisitionSafetyError("UNEXPECTED_RESPONSE");
  if (["ExpiredToken", "ExpiredTokenException", "InvalidToken", "CredentialsProviderError"].includes(value?.name ?? "")) return new AcquisitionSafetyError("SESSION_EXPIRED");
  if (["InvalidPayer", "RequestPayerRequired", "RequesterPaysError"].includes(value?.name ?? "")) return new AcquisitionSafetyError("REQUESTER_PAYS_ERROR");
  if (status === 403) return new AcquisitionSafetyError("AMBIGUOUS_ACCESS");
  if (operation === "GET" && (status === 404 || status === 412)) return new AcquisitionSafetyError("SOURCE_CHANGED");
  if (status === 429 || [500, 502, 503, 504].includes(status ?? 0) || ["TimeoutError", "RequestTimeout", "RequestTimeoutException"].includes(value?.name ?? "") || ["ECONNRESET", "ETIMEDOUT", "EPIPE"].includes(value?.code ?? "")) return new AcquisitionSafetyError("TRANSIENT");
  return new AcquisitionSafetyError("UNEXPECTED_RESPONSE");
}

export async function acquisitionBackoff(attempt: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new AcquisitionSafetyError("CANCELLED");
  const delay = Math.min(2_000, 100 * 2 ** attempt) + Math.floor(Math.random() * 100);
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(new AcquisitionSafetyError("CANCELLED"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, delay);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function abortedRace<Result>(promise: Promise<Result>, signal: AbortSignal): Promise<Result> {
  if (signal.aborted) return Promise.reject(new AcquisitionSafetyError("CANCELLED"));
  return new Promise((resolve, reject) => {
    const abort = () => reject(new AcquisitionSafetyError("CANCELLED"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

async function withDeadline<Result>(work: (signal: AbortSignal) => Promise<Result>, timeoutMs: number, parent?: AbortSignal): Promise<Result> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 300_000) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
  if (parent?.aborted) throw new AcquisitionSafetyError("CANCELLED");
  const controller = new AbortController();
  const abort = () => controller.abort();
  let timeout = false;
  const timer = setTimeout(() => {
    timeout = true;
    controller.abort();
  }, timeoutMs);
  parent?.addEventListener("abort", abort, { once: true });
  try {
    return await abortedRace(work(controller.signal), controller.signal);
  } catch (error) {
    if (timeout) throw new AcquisitionSafetyError("TRANSIENT");
    if (parent?.aborted) throw new AcquisitionSafetyError("CANCELLED");
    throw error;
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener("abort", abort);
  }
}

export async function collectDukascopyInventory(options: {
  plan: FrozenDukascopyPlan;
  approval: AcquisitionApproval;
  session: DukascopyS3Session;
  gate: AcquisitionRequestGate;
  previous?: InventorySnapshot;
  resumedEntries?: readonly InventoryEntry[];
  signal?: AbortSignal;
  timeoutMs?: number;
  backoff?: typeof acquisitionBackoff;
  persistEntry?: (entry: InventoryEntry) => Promise<void>;
}): Promise<InventorySnapshot> {
  const { plan, approval, session, gate } = options;
  if (options.previous) assertInventorySnapshot(plan, options.previous);
  assertApproval(plan, approval, "INVENTORY", options.previous?.revision ?? null);
  const initial = options.previous ?? createInventorySnapshot(plan, []);
  if (session.mode === "DRY_RUN") return initial;
  const entries = initial.entries.map((entry) => ({ ...entry }));
  for (const entry of options.resumedEntries ?? []) {
    if (!approval.keys.includes(entry.key)) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
    entries[plan.keys.indexOf(entry.key)] = entry;
  }
  createInventorySnapshot(plan, entries);
  for (const key of approval.keys) {
    const index = plan.keys.indexOf(key);
    if (["PRESENT", "CONFIRMED_ABSENT"].includes(entries[index].status)) continue;
    let attempts = entries[index].attempts;
    while (true) {
      let started = false;
      try {
        if (options.signal?.aborted) throw new AcquisitionSafetyError("CANCELLED");
        await gate.before("HEAD", key, 0);
        started = true;
        attempts++;
        const output = await withDeadline((signal) => session.send(new HeadObjectCommand({ Bucket: plan.bucket, Key: key, RequestPayer: "requester" }), signal, approval), options.timeoutMs ?? DUKASCOPY_REQUEST_TIMEOUT_MS, options.signal);
        entries[index] = { key, utcDay: assertExactDukascopyKey(plan, key), status: "PRESENT", metadata: allowlistedMetadata(output), checkedAt: new Date().toISOString(), attempts, error: null };
        await gate.success("HEAD", key);
      } catch (error) {
        const value = error as { name?: string; $metadata?: { httpStatusCode?: number }; $response?: { headers?: Record<string, string> } };
        const region = value?.$response?.headers?.["x-amz-bucket-region"];
        const absent = value?.$metadata?.httpStatusCode === 404 && ["NoSuchKey", "NotFound"].includes(value.name ?? "") && (!region || region === plan.region) && value?.$response?.headers?.["x-amz-delete-marker"] !== "true";
        const safe = classifyAcquisitionError(error, "HEAD");
        if (started) await gate.failure("HEAD", key, safe.code);
        if (safe.code === "TRANSIENT" && attempts < Math.min(3, approval.caps.maxRetries + 1, approval.globalCaps.maxRetries + 1)) {
          await (options.backoff ?? acquisitionBackoff)(attempts, options.signal);
          continue;
        }
        entries[index] = { key, utcDay: assertExactDukascopyKey(plan, key), status: absent ? "CONFIRMED_ABSENT" : safe.code === "AMBIGUOUS_ACCESS" ? "AMBIGUOUS_ACCESS" : "ERROR", metadata: null, checkedAt: new Date().toISOString(), attempts, error: absent ? null : safe.code };
        await options.persistEntry?.(entries[index]);
        if (!absent) return createInventorySnapshot(plan, entries);
      }
      await options.persistEntry?.(entries[index]);
      break;
    }
  }
  return createInventorySnapshot(plan, entries);
}

export class DukascopyGetTransport implements DukascopyS3Transport {
  private busy = false;
  constructor(private readonly options: { plan: FrozenDukascopyPlan; snapshot: InventorySnapshot; approval: AcquisitionApproval; session: DukascopyS3Session; gate: AcquisitionRequestGate; signal?: AbortSignal; timeoutMs?: number }) {
    assertInventorySnapshot(options.plan, options.snapshot);
    assertApproval(options.plan, options.approval, "DOWNLOAD", options.snapshot.revision);
  }

  async *downloadObject(request: Parameters<DukascopyS3Transport["downloadObject"]>[0]): AsyncGenerator<Uint8Array> {
    const { plan, snapshot, approval, session, gate } = this.options;
    assertInventorySnapshot(plan, snapshot);
    assertApproval(plan, approval, "DOWNLOAD", snapshot.revision);
    assertExactDukascopyKey(plan, request.key);
    if (this.busy || request.bucket !== plan.bucket || request.region !== plan.region || request.requesterPays !== true || !approval.keys.includes(request.key) || session.mode === "DRY_RUN") throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
    const entry = snapshot.entries[plan.keys.indexOf(request.key)];
    if (entry.status !== "PRESENT" || !entry.metadata) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
    const expected = entry.metadata;
    const timeoutMs = this.options.timeoutMs ?? DUKASCOPY_REQUEST_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 300_000) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
    this.busy = true;
    let body: (AsyncIterable<Uint8Array> & { destroy?: () => void }) | undefined;
    let iterator: AsyncIterator<Uint8Array> | undefined;
    let timedOut = false;
    let started = false;
    const controller = new AbortController();
    const abort = () => controller.abort();
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      body?.destroy?.();
    }, timeoutMs);
    this.options.signal?.addEventListener("abort", abort, { once: true });
    try {
      if (this.options.signal?.aborted) throw new AcquisitionSafetyError("CANCELLED");
      await gate.before("GET", request.key, expected.contentLength);
      started = true;
      const output = (await abortedRace(session.send(new GetObjectCommand({ Bucket: plan.bucket, Key: request.key, RequestPayer: "requester", IfMatch: expected.etag }), controller.signal, approval), controller.signal)) as GetObjectCommandOutput;
      body = output.Body as typeof body;
      validateResponseRegion(output);
      if (output.RequestCharged !== "requester") throw new AcquisitionSafetyError("REQUESTER_PAYS_ERROR");
      if (output.ETag !== expected.etag || output.ContentLength !== expected.contentLength) throw new AcquisitionSafetyError("SOURCE_CHANGED");
      if (!body || typeof body[Symbol.asyncIterator] !== "function") throw new AcquisitionSafetyError("UNEXPECTED_RESPONSE");
      iterator = body[Symbol.asyncIterator]();
      let received = 0;
      while (true) {
        const next = await abortedRace(iterator.next(), controller.signal);
        if (next.done) break;
        if (!(next.value instanceof Uint8Array)) throw new AcquisitionSafetyError("UNEXPECTED_RESPONSE");
        received += next.value.byteLength;
        await gate.received(request.key, next.value.byteLength);
        if (controller.signal.aborted) throw new AcquisitionSafetyError("CANCELLED");
        if (received > expected.contentLength) throw new AcquisitionSafetyError("UNEXPECTED_RESPONSE");
        yield next.value;
      }
      if (received !== expected.contentLength) throw new AcquisitionSafetyError("UNEXPECTED_RESPONSE");
      await gate.success("GET", request.key);
    } catch (error) {
      const safe = timedOut ? new AcquisitionSafetyError("TRANSIENT") : this.options.signal?.aborted ? new AcquisitionSafetyError("CANCELLED") : classifyAcquisitionError(error, "GET");
      if (started) await gate.failure("GET", request.key, safe.code);
      throw safe;
    } finally {
      clearTimeout(timer);
      controller.abort();
      body?.destroy?.();
      void iterator?.return?.().catch(() => undefined);
      this.options.signal?.removeEventListener("abort", abort);
      this.busy = false;
    }
  }
}

export type { DukascopyS3Transport };
