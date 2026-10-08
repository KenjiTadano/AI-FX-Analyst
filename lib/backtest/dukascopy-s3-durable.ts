import { constants } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, lstat, open, rename, link, unlink, readdir, statfs } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { resolve, relative, dirname, join, sep, parse, basename } from "node:path";
import { safeArtifactPrefix, type S3TransferSafetyOptions } from "./dukascopy-s3-acquisition";
import {
  AcquisitionSafetyError,
  acquisitionHash,
  assertApproval,
  assertOperatorApprovalEvidence,
  assertExactDukascopyKey,
  assertFrozenPlan,
  assertInventorySnapshot,
  createInventorySnapshot,
  mergeInventoryProgress,
  SimulatedInventoryCrash,
  type InventoryCrashBoundary,
  type HeadAttemptReservation,
  type AcquisitionApproval,
  type AcquisitionCaps,
  type AcquisitionOperation,
  type AcquisitionRequestGate,
  type FrozenDukascopyPlan,
  type InventorySnapshot,
  type InventoryEntry,
  type OperatorApprovalEvidence,
  type CampaignChildPreparationBinding,
} from "./dukascopy-s3-production";

export const DUKASCOPY_PRODUCTION_ROOT = "tmp/dukascopy/s3-production";
export const CAMPAIGN_CHILD_APPROVAL_DIRECTORY = `${DUKASCOPY_PRODUCTION_ROOT}/child-approvals`;
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
  recoveryHeadAttempts?: number;
  classifiedErrorRetryAttempts?: number;
}

export type HeadAttemptState = "RESERVED" | "MAY_HAVE_BEEN_SENT" | "CLASSIFIED";
export type HeadAttemptKind = "INITIAL" | "RETRY" | "INDETERMINATE_RECOVERY" | "CLASSIFIED_ERROR_RETRY";

export interface HeadAttemptJournalEvent {
  version: 1;
  attemptId: string;
  state: HeadAttemptState;
  kind: HeadAttemptKind;
  approvalId: string;
  approvalHash: string;
  campaignId: string | null;
  batchId: string;
  planHash: string;
  inventoryRevision: string | null;
  key: string;
  sequence: number;
  reservedAt: string;
  mayHaveBeenSentAt?: string;
  classifiedAt?: string;
  classification?: InventoryEntry;
  predecessorAttemptId?: string;
  retryAuthorizationId?: string;
  retryAuthorizationHash?: string;
  capRevisionId?: string;
  capRevisionHash?: string;
}

export interface HeadAttemptAccounting {
  approvalId: string;
  key: string;
  sequence: number;
  kind: HeadAttemptKind;
  campaignId: string | null;
  classificationHash?: string;
  settled?: boolean;
  predecessorAttemptId?: string;
  retryAuthorizationId?: string;
  retryAuthorizationHash?: string;
  capRevisionId?: string;
  capRevisionHash?: string;
}

export interface CampaignChildCapPlan {
  sequence: number;
  batchId: string;
  batchStart: string;
  batchEnd: string;
  keys: readonly string[];
  recoveryAllowance: number;
}

export interface CampaignCapExpansionAuthorization {
  version: 1;
  authorizationId: string;
  campaignId: string;
  oldGlobalCaps: AcquisitionCaps;
  newGlobalCaps: AcquisitionCaps;
  oldMaxHeadAttempts: 21;
  newMaxHeadAttempts: 44;
  normalHeadBudget: 30;
  recoveryHeadBudget: 5;
  campaignStart: "2021-01-08T00:00:00.000Z";
  campaignEnd: "2021-02-07T00:00:00.000Z";
  children: readonly CampaignChildCapPlan[];
  reason: string;
  authorizedAt: string;
  expiresAt: string;
  operatorApprovalReference: string;
  operatorApprovalHash: string;
  priorLedgerHash: string;
  priorLedgerGeneration: number;
  masterPlanHash: string;
  instrument: "USDJPY";
  bucket: FrozenDukascopyPlan["bucket"];
  region: FrozenDukascopyPlan["region"];
  requesterPays: true;
  initialInventoryRevision: string;
}

export interface CampaignChildLedgerState extends CampaignChildCapPlan {
  status: "PENDING" | "IN_PROGRESS" | "COMPLETED" | "STOPPED";
  approvalId?: string;
  approvalHash?: string;
  outputRevision?: string;
  stopReason?: "ERROR" | "INDETERMINATE" | "CAP_EXCEEDED";
}

export interface CampaignBudgetLedger {
  authorizationId: string;
  authorizationHash: string;
  campaignId: string;
  normalHeadBudget: number;
  recoveryHeadBudget: number;
  normalHeadAttempts: number;
  recoveryHeadAttempts: number;
  status: "ACTIVE" | "STOPPED" | "COMPLETED";
  stopReason?: "ERROR" | "INDETERMINATE" | "CAP_EXCEEDED";
  currentChildSequence: number;
  currentInventoryRevision: string;
  children: CampaignChildLedgerState[];
  classifiedErrorRetry?: ClassifiedErrorRetryLedger;
}

export interface ClassifiedErrorRetryLedger {
  authorizationId: string;
  authorizationHash: string;
  allocation: 1;
  consumed: number;
  stage: "RETRY_AUTHORIZED" | "RETRY_IN_PROGRESS" | "ACTIVE_CONTINUATION" | "STOPPED" | "COMPLETED";
  replacementApprovalId?: string;
  replacementApprovalHash?: string;
  continuationApprovalId?: string;
  continuationApprovalHash?: string;
  replacementAttemptId?: string;
  outputRevision?: string;
}

export interface ClassifiedErrorRetryAuthorization extends OperatorApprovalEvidence {
  version: 1;
  authorizationId: string;
  campaignId: string;
  childSequence: 1;
  descriptor: CampaignChildCapPlan;
  masterPlanHash: string;
  instrument: "USDJPY";
  bucket: FrozenDukascopyPlan["bucket"];
  region: FrozenDukascopyPlan["region"];
  requesterPays: true;
  failedKey: string;
  failedAttemptId: string;
  failedKind: "INITIAL";
  failedSequence: 1;
  failedStatus: "ERROR";
  failedError: "SESSION_EXPIRED";
  failedClassifiedHash: string;
  accountingHash: string;
  originalApprovalId: string;
  originalApprovalHash: string;
  originalProgressHash: string;
  priorLedgerHash: string;
  priorLedgerGeneration: number;
  countersHash: string;
  partialRevision: string;
  partialSnapshotHash: string;
  currentInventoryRevision: string;
  capAuthorizationId: string;
  capAuthorizationHash: string;
  oldGlobalCaps: AcquisitionCaps;
  newGlobalCaps: AcquisitionCaps;
  allocation: 1;
  nextSequence: 2;
  indeterminateRecoveryAllowance: 0;
  expiresAt: string;
}

export type ClassifiedErrorRetryPreparationInput = Pick<
  ClassifiedErrorRetryAuthorization,
  | "authorizationId"
  | "campaignId"
  | "childSequence"
  | "failedKey"
  | "failedAttemptId"
  | "failedClassifiedHash"
  | "originalApprovalId"
  | "originalApprovalHash"
  | "originalProgressHash"
  | "priorLedgerHash"
  | "priorLedgerGeneration"
  | "partialRevision"
  | "partialSnapshotHash"
  | "currentInventoryRevision"
  | "masterPlanHash"
  | "capAuthorizationId"
  | "capAuthorizationHash"
  | "authorizedAt"
  | "expiresAt"
  | "operatorApprovalReference"
  | "operatorApprovalHash"
  | "reason"
>;

export interface RetryCapRevision {
  version: 1;
  revisionId: string;
  retryAuthorizationId: string;
  retryAuthorizationHash: string;
  parentAuthorizationId: string;
  parentAuthorizationHash: string;
  priorLedgerHash: string;
  priorLedgerGeneration: number;
  oldGlobalCaps: AcquisitionCaps;
  newGlobalCaps: AcquisitionCaps;
}

export function assertTask116ClassifiedRetryScope(plan: FrozenDukascopyPlan, authorization: ClassifiedErrorRetryAuthorization, now = Date.now()): void {
  assertFrozenPlan(plan);
  assertOperatorApprovalEvidence(authorization, authorization.expiresAt, now);
  const fields = [
    "version",
    "authorizationId",
    "campaignId",
    "childSequence",
    "descriptor",
    "masterPlanHash",
    "instrument",
    "bucket",
    "region",
    "requesterPays",
    "failedKey",
    "failedAttemptId",
    "failedKind",
    "failedSequence",
    "failedStatus",
    "failedError",
    "failedClassifiedHash",
    "accountingHash",
    "originalApprovalId",
    "originalApprovalHash",
    "originalProgressHash",
    "priorLedgerHash",
    "priorLedgerGeneration",
    "countersHash",
    "partialRevision",
    "partialSnapshotHash",
    "currentInventoryRevision",
    "capAuthorizationId",
    "capAuthorizationHash",
    "oldGlobalCaps",
    "newGlobalCaps",
    "allocation",
    "nextSequence",
    "indeterminateRecoveryAllowance",
    "expiresAt",
    "authorizedAt",
    "operatorApprovalReference",
    "operatorApprovalHash",
    "reason",
  ];
  if (Object.keys(authorization).length !== fields.length || Object.keys(authorization).some((field) => !fields.includes(field)) || !/^[a-zA-Z0-9_-]{1,80}$/.test(authorization.originalApprovalId) || !/^[a-zA-Z0-9_-]{1,80}$/.test(authorization.capAuthorizationId)) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
  const oldCaps = { maxHeadAttempts: 44, maxGetAttempts: 0, maxNetworkBytes: 0, maxVerifiedBytes: 0, maxObjects: 7, maxRetries: 2 };
  if (acquisitionHash(authorization.oldGlobalCaps) !== acquisitionHash(oldCaps)) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
  if (
    authorization.version !== 1 ||
    !/^[a-zA-Z0-9_-]{1,80}$/.test(authorization.authorizationId) ||
    ["__proto__", "constructor", "prototype"].includes(authorization.authorizationId) ||
    authorization.campaignId !== TASK116_CAMPAIGN_ID ||
    authorization.childSequence !== 1 ||
    authorization.failedKey !== "USDJPY/2021/00/08_ticks.bi5" ||
    authorization.failedKind !== "INITIAL" ||
    authorization.failedSequence !== 1 ||
    authorization.failedStatus !== "ERROR" ||
    authorization.failedError !== "SESSION_EXPIRED" ||
    authorization.nextSequence !== 2 ||
    authorization.allocation !== 1 ||
    authorization.indeterminateRecoveryAllowance !== 0 ||
    authorization.masterPlanHash !== plan.planHash ||
    authorization.instrument !== plan.instrument ||
    authorization.bucket !== plan.bucket ||
    authorization.region !== plan.region ||
    authorization.requesterPays !== true ||
    acquisitionHash(authorization.descriptor) !== acquisitionHash(buildTask116CampaignChildren(plan)[0]) ||
    authorization.oldGlobalCaps.maxHeadAttempts !== 44 ||
    acquisitionHash(authorization.newGlobalCaps) !== acquisitionHash({ ...authorization.oldGlobalCaps, maxHeadAttempts: 45 })
  )
    throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
  if (
    !/^[a-f0-9-]{36}$/.test(authorization.failedAttemptId) ||
    !Number.isSafeInteger(authorization.priorLedgerGeneration) ||
    authorization.priorLedgerGeneration < 1 ||
    [authorization.failedClassifiedHash, authorization.accountingHash, authorization.originalApprovalHash, authorization.originalProgressHash, authorization.priorLedgerHash, authorization.countersHash, authorization.partialRevision, authorization.partialSnapshotHash, authorization.currentInventoryRevision, authorization.capAuthorizationHash].some(
      (value) => !/^[a-f0-9]{64}$/.test(value),
    )
  )
    throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
}

export type CapExpansionFaultBoundary = Extract<InventoryCrashBoundary, `CAP_${string}`>;

export type CapExpansionResult = "APPLIED" | "ALREADY_APPLIED";

export interface CampaignChildApprovalPreparationInput extends OperatorApprovalEvidence {
  approvalId: string;
  campaignId: string;
  childSequence: number;
  priorLedgerHash: string;
  priorLedgerGeneration: number;
  inventoryRevision: string;
  masterPlanHash: string;
  capAuthorizationId: string;
  capAuthorizationHash: string;
  globalCaps: AcquisitionCaps;
  childDescriptorHash: string;
  instrument: FrozenDukascopyPlan["instrument"];
  bucket: FrozenDukascopyPlan["bucket"];
  region: FrozenDukascopyPlan["region"];
  requesterPays: true;
  expiresAt: string;
}

export interface CampaignChildApprovalPreparationResult {
  operation: "PREPARE CHILD APPROVAL ONLY - DOES NOT EXECUTE INVENTORY";
  mode: "VALIDATE_ONLY" | "PREPARED" | "EXISTING";
  approvalId: string;
  approvalHash: string;
  approvalPath: string;
  validation: {
    campaignId: string;
    childSequence: number;
    childRange: string[];
    keyCount: number;
    inventoryRevision: string;
    priorLedgerHash: string;
    priorLedgerGeneration: number;
    normalAllocation: number;
    recoveryAllowance: number;
    caps: AcquisitionCaps;
    globalCaps: AcquisitionCaps;
    ignored: true;
    untracked: true;
  };
}

export type CampaignCapAuthorizationPreparationInput = Omit<CampaignCapExpansionAuthorization, "version" | "oldMaxHeadAttempts" | "newMaxHeadAttempts" | "normalHeadBudget" | "recoveryHeadBudget">;

export interface CampaignCapAuthorizationPreparationResult {
  operation: "PREPARE AUTHORIZATION ONLY - DOES NOT APPLY CAP EXPANSION";
  mode: "VALIDATE_ONLY" | "PREPARED" | "EXISTING";
  authorizationId: string;
  authorizationHash: string;
  authorizationPath: string;
  validation: {
    priorLedgerHash: string;
    priorLedgerGeneration: number;
    inventoryRevision: string;
    currentHeadAttempts: number;
    currentCap: 21;
    proposedCap: 44;
    normalHeadBudget: 30;
    recoveryHeadBudget: 5;
    childSizes: number[];
    ignored: true;
    untracked: true;
  };
}

const TASK116_CAMPAIGN_ID = "task116-usdjpy-20210108-20210207";
const TASK116_CHILD_WINDOWS = [
  ["2021-01-08", "2021-01-15"],
  ["2021-01-15", "2021-01-22"],
  ["2021-01-22", "2021-01-29"],
  ["2021-01-29", "2021-02-05"],
  ["2021-02-05", "2021-02-07"],
] as const;

export interface AcquisitionLedger {
  version: "DUKASCOPY_DURABLE_V1";
  headAttemptJournalVersion?: 1;
  planHash: string;
  inventoryRevision: string | null;
  approvalId: string;
  batchId: string;
  globalCaps: AcquisitionCaps;
  totals: LedgerCounters;
  contexts: Record<string, { bindingHash: string; counters: LedgerCounters }>;
  approvalBindings?: Record<string, AcquisitionApproval>;
  headAttemptAccounting?: Record<string, HeadAttemptAccounting>;
  campaignHeadAttempts?: Record<string, number>;
  legacyIndeterminateHeadKeys?: Record<string, { approvalId: string; batchId: string; sequence: number; recoveredByAttemptId?: string }>;
  ledgerGeneration?: number;
  appliedCapExpansionIds?: string[];
  campaignBudgets?: Record<string, CampaignBudgetLedger>;
  retryCapRevision?: { revisionId: string; revisionHash: string; authorizationId: string; authorizationHash: string };
  attempts: Record<string, number>;
  completedGetKeys: string[];
  verified: Record<string, { key: string; bytes: number; sha256: string }>;
  active: { operation: AcquisitionOperation; key: string; approvalId: string; attemptId?: string } | null;
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

export interface ProcessIdentityEvidence {
  pid: number;
  processStartedAt: string;
  identityHash: string;
}

export interface DurableWriterLock {
  version?: 1 | 2;
  pid: number;
  token: string;
  createdAt: string;
  processStartedAt?: string;
  identityHash?: string;
}

function processIdentityEvidence(pid: number): ProcessIdentityEvidence | null {
  try {
    const processStartedAt = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "ignore"] })
      .trim()
      .replace(/\s+/g, " ");
    const command = execFileSync("ps", ["-p", String(pid), "-o", "comm="], { encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (!processStartedAt || !command) return null;
    return { pid, processStartedAt, identityHash: acquisitionHash({ pid, processStartedAt, command }) };
  } catch {
    return null;
  }
}

function counters(): LedgerCounters {
  return { headAttempts: 0, getAttempts: 0, successfulGets: 0, failedAttempts: 0, receivedBytes: 0, reservedBytes: 0, verifiedBytes: 0, retryCount: 0, objects: [], recoveryHeadAttempts: 0 };
}

function safeDocumentName(value: string): boolean {
  return /^[a-zA-Z0-9._/-]+$/.test(value) && !value.split("/").some((part) => !part || part === "." || part === "..") && !value.includes("\\");
}

export function buildTask116CampaignChildren(plan: FrozenDukascopyPlan): CampaignChildCapPlan[] {
  assertFrozenPlan(plan);
  return TASK116_CHILD_WINDOWS.map(([start, endExclusive], index) => {
    const startIso = `${start}T00:00:00.000Z`;
    const endIso = `${endExclusive}T00:00:00.000Z`;
    const startAt = Date.parse(startIso);
    const endAt = Date.parse(endIso);
    const keys = plan.keys.filter((key) => {
      const day = Date.parse(`${assertExactDukascopyKey(plan, key)}T00:00:00.000Z`);
      return day >= startAt && day < endAt;
    });
    const compact = (value: string) => value.replaceAll("-", "");
    return { sequence: index + 1, batchId: `task116-usdjpy-${compact(start)}-${compact(endExclusive)}`, batchStart: startIso, batchEnd: endIso, keys, recoveryAllowance: 1 };
  });
}

export function assertTask116CampaignCapExpansion(plan: FrozenDukascopyPlan, ledger: AcquisitionLedger, authorization: CampaignCapExpansionAuthorization, now = Date.now()): void {
  assertFrozenPlan(plan);
  const capFields: Array<keyof AcquisitionCaps> = ["maxHeadAttempts", "maxGetAttempts", "maxNetworkBytes", "maxVerifiedBytes", "maxObjects", "maxRetries"];
  for (const caps of [authorization.oldGlobalCaps, authorization.newGlobalCaps]) {
    if (Object.keys(caps).length !== capFields.length || capFields.some((field) => !Number.isSafeInteger(caps[field]) || caps[field] < 0)) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
  }
  const expectedChildren = buildTask116CampaignChildren(plan);
  const expectedNewCaps = { ...authorization.oldGlobalCaps, maxHeadAttempts: 44 };
  if (
    authorization.version !== 1 ||
    !/^[a-zA-Z0-9_-]{1,80}$/.test(authorization.authorizationId) ||
    authorization.campaignId !== TASK116_CAMPAIGN_ID ||
    authorization.oldMaxHeadAttempts !== 21 ||
    authorization.newMaxHeadAttempts !== 44 ||
    authorization.oldGlobalCaps.maxHeadAttempts !== 21 ||
    authorization.newGlobalCaps.maxHeadAttempts !== 44 ||
    acquisitionHash(authorization.newGlobalCaps) !== acquisitionHash(expectedNewCaps) ||
    authorization.normalHeadBudget !== 30 ||
    authorization.recoveryHeadBudget !== 5 ||
    authorization.campaignStart !== "2021-01-08T00:00:00.000Z" ||
    authorization.campaignEnd !== "2021-02-07T00:00:00.000Z" ||
    acquisitionHash(authorization.children) !== acquisitionHash(expectedChildren) ||
    typeof authorization.reason !== "string" ||
    authorization.reason.trim().length < 10 ||
    authorization.reason.length > 500 ||
    !Number.isFinite(Date.parse(authorization.authorizedAt)) ||
    new Date(authorization.authorizedAt).toISOString() !== authorization.authorizedAt ||
    Date.parse(authorization.authorizedAt) > now ||
    !Number.isFinite(Date.parse(authorization.expiresAt)) ||
    new Date(authorization.expiresAt).toISOString() !== authorization.expiresAt ||
    Date.parse(authorization.expiresAt) <= now ||
    Date.parse(authorization.expiresAt) <= Date.parse(authorization.authorizedAt) ||
    !/^[A-Z0-9][A-Z0-9_-]{2,127}$/.test(authorization.operatorApprovalReference) ||
    !/^[a-f0-9]{64}$/.test(authorization.operatorApprovalHash) ||
    !/^[a-f0-9]{64}$/.test(authorization.priorLedgerHash) ||
    !Number.isSafeInteger(authorization.priorLedgerGeneration) ||
    authorization.priorLedgerGeneration < 0 ||
    authorization.masterPlanHash !== plan.planHash ||
    authorization.instrument !== plan.instrument ||
    authorization.bucket !== plan.bucket ||
    authorization.region !== plan.region ||
    authorization.requesterPays !== true ||
    !/^[a-f0-9]{64}$/.test(authorization.initialInventoryRevision)
  )
    throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
  if (acquisitionHash(authorization.oldGlobalCaps) !== acquisitionHash(ledger.globalCaps) || authorization.priorLedgerHash !== acquisitionHash(ledger) || authorization.priorLedgerGeneration !== (ledger.ledgerGeneration ?? 0)) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
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
    private readonly faultAt?: InventoryCrashBoundary | CapExpansionFaultBoundary,
  ) {
    this.root = root;
  }

  private async validateClassifiedRetryFailure(plan: FrozenDukascopyPlan, authorization: ClassifiedErrorRetryAuthorization, ledger: AcquisitionLedger): Promise<void> {
    assertTask116ClassifiedRetryScope(plan, authorization);
    const campaign = ledger.campaignBudgets?.[authorization.campaignId];
    const child = campaign?.children[0];
    if (
      !campaign ||
      !child ||
      ledger.active ||
      campaign.status !== "STOPPED" ||
      campaign.stopReason !== "ERROR" ||
      child.status !== "STOPPED" ||
      child.stopReason !== "ERROR" ||
      campaign.currentChildSequence !== 1 ||
      child.outputRevision !== authorization.partialRevision ||
      campaign.currentInventoryRevision !== authorization.currentInventoryRevision ||
      child.approvalId !== authorization.originalApprovalId ||
      child.approvalHash !== authorization.originalApprovalHash ||
      campaign.authorizationId !== authorization.capAuthorizationId ||
      campaign.authorizationHash !== authorization.capAuthorizationHash ||
      campaign.normalHeadBudget !== 30 ||
      campaign.recoveryHeadBudget !== 5 ||
      campaign.normalHeadAttempts !== 1 ||
      campaign.recoveryHeadAttempts !== 0 ||
      ledger.totals.headAttempts !== 10 ||
      ledger.attempts[`HEAD:${authorization.failedKey}`] !== 1 ||
      campaign.classifiedErrorRetry
    )
      throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
    if (acquisitionHash({ totals: ledger.totals, attempts: ledger.attempts, context: ledger.contexts[authorization.originalApprovalId], normal: campaign.normalHeadAttempts, recovery: campaign.recoveryHeadAttempts }) !== authorization.countersHash) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
    const event = (await this.loadHeadAttemptEvents(authorization.failedAttemptId)).CLASSIFIED;
    const accounting = ledger.headAttemptAccounting?.[authorization.failedAttemptId];
    const original = await this.readDocument<AcquisitionApproval>(`child-approvals/${authorization.originalApprovalId}.json`);
    const progress = await this.readDocument<{ approvalHash: string; planHash: string; entry: InventoryEntry }>(`progress/${acquisitionHash(`${authorization.originalApprovalId}:${authorization.failedKey}`)}.json`);
    const partial = await this.loadInventorySnapshot(plan, authorization.partialRevision);
    await this.loadInventorySnapshot(plan, authorization.currentInventoryRevision);
    if (
      !event ||
      !accounting ||
      !original ||
      !progress ||
      event.state !== "CLASSIFIED" ||
      event.kind !== "INITIAL" ||
      event.sequence !== 1 ||
      event.key !== authorization.failedKey ||
      event.approvalId !== authorization.originalApprovalId ||
      event.approvalHash !== authorization.originalApprovalHash ||
      event.classification?.status !== "ERROR" ||
      event.classification.error !== "SESSION_EXPIRED" ||
      acquisitionHash(event) !== authorization.failedClassifiedHash ||
      acquisitionHash(accounting) !== authorization.accountingHash ||
      !accounting.settled ||
      accounting.classificationHash !== acquisitionHash(event.classification) ||
      acquisitionHash(original) !== authorization.originalApprovalHash ||
      acquisitionHash(ledger.approvalBindings?.[original.id]) !== authorization.originalApprovalHash ||
      acquisitionHash(progress) !== authorization.originalProgressHash ||
      progress.approvalHash !== authorization.originalApprovalHash ||
      progress.planHash !== plan.planHash ||
      acquisitionHash(progress.entry) !== acquisitionHash(event.classification) ||
      acquisitionHash(partial) !== authorization.partialSnapshotHash ||
      acquisitionHash(partial.entries[plan.keys.indexOf(authorization.failedKey)]) !== acquisitionHash(event.classification)
    )
      throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
    assertApproval(plan, original, "INVENTORY", authorization.currentInventoryRevision, 0);
    if (acquisitionHash(original.keys) !== acquisitionHash(authorization.descriptor.keys) || original.caps.maxRetries !== 0 || original.recoveryAllowance?.maxIndeterminateHeadRetries !== 1 || acquisitionHash(original.globalCaps) !== acquisitionHash(authorization.oldGlobalCaps)) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
    for (const key of authorization.descriptor.keys.filter((key) => key !== authorization.failedKey)) if (partial.entries[plan.keys.indexOf(key)].status !== "UNKNOWN" || ledger.attempts[`HEAD:${key}`]) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
    const cap = await this.readDocument<CampaignCapExpansionAuthorization>(`cap-expansions/${authorization.capAuthorizationId}.json`);
    if (
      !cap ||
      acquisitionHash(cap) !== authorization.capAuthorizationHash ||
      !ledger.appliedCapExpansionIds?.includes(cap.authorizationId) ||
      acquisitionHash(cap.newGlobalCaps) !== acquisitionHash(authorization.oldGlobalCaps) ||
      cap.masterPlanHash !== plan.planHash ||
      cap.campaignId !== authorization.campaignId ||
      acquisitionHash(cap.children[0]) !== acquisitionHash(authorization.descriptor)
    )
      throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
  }

  private async persistOfflineRetryEvidence(projectRoot: string, name: string, data: unknown, validateOnly: boolean, check: () => Promise<void>): Promise<"VALIDATE_ONLY" | "PREPARED" | "EXISTING"> {
    if (!/^(retry-authorizations|retry-approvals)\/[a-zA-Z0-9_-]{1,80}\.json$/.test(name)) throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
    const relativePath = `${DUKASCOPY_PRODUCTION_ROOT}/${name}`;
    const ignored = () => {
      const ignore = spawnSync("git", ["check-ignore", "--quiet", "--no-index", "--", relativePath], { cwd: projectRoot, stdio: "ignore" });
      const tracked = spawnSync("git", ["ls-files", "--error-unmatch", "--", relativePath], { cwd: projectRoot, stdio: "ignore" });
      if (ignore.status !== 0 || tracked.status !== 1) throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
    };
    await check();
    ignored();
    const expectedHash = acquisitionHash(data);
    const existing = await this.readDocument(name);
    if (existing && acquisitionHash(existing) !== expectedHash) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
    let result: "VALIDATE_ONLY" | "PREPARED" | "EXISTING" = validateOnly ? "VALIDATE_ONLY" : "EXISTING";
    if (!validateOnly && !existing) {
      const directory = dirname(this.path(name));
      await this.ensurePath(directory, true);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await this.ensurePath(directory);
      await this.syncDirectory(this.root);
      const temporary = `${this.path(name)}.${randomUUID()}.tmp`;
      const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        try {
          await handle.writeFile(`${JSON.stringify({ hash: expectedHash, data })}\n`);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await check();
        ignored();
        await this.ensurePath(this.path(name), true);
        try {
          await link(temporary, this.path(name));
          result = "PREPARED";
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST" || acquisitionHash(await this.readDocument(name)) !== expectedHash) throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
        }
      } finally {
        await unlink(temporary);
        await this.syncDirectory(directory);
      }
    }
    await check();
    ignored();
    if (!validateOnly && acquisitionHash(await this.readDocument(name)) !== expectedHash) throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
    return result;
  }

  static async prepareTask116ClassifiedErrorRetryAuthorization(plan: FrozenDukascopyPlan, input: ClassifiedErrorRetryPreparationInput, options: { projectRoot: string; validateOnly?: boolean }) {
    const fields = [
      "authorizationId",
      "campaignId",
      "childSequence",
      "failedKey",
      "failedAttemptId",
      "failedClassifiedHash",
      "originalApprovalId",
      "originalApprovalHash",
      "originalProgressHash",
      "priorLedgerHash",
      "priorLedgerGeneration",
      "partialRevision",
      "partialSnapshotHash",
      "currentInventoryRevision",
      "masterPlanHash",
      "capAuthorizationId",
      "capAuthorizationHash",
      "authorizedAt",
      "expiresAt",
      "operatorApprovalReference",
      "operatorApprovalHash",
      "reason",
    ];
    if (Object.keys(input).length !== fields.length || Object.keys(input).some((field) => !fields.includes(field))) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
    const projectRoot = resolve(options.projectRoot);
    const store = new DurableAcquisitionStore(resolve(projectRoot, DUKASCOPY_PRODUCTION_ROOT), "retry-authorization-read-only");
    await store.ensurePath(store.root);
    const ledger = await store.ledger(plan);
    const accounting = ledger?.headAttemptAccounting?.[input.failedAttemptId];
    const campaign = ledger?.campaignBudgets?.[input.campaignId];
    if (!ledger || !accounting || !campaign || ledger.retryCapRevision) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
    const authorization: ClassifiedErrorRetryAuthorization = {
      ...input,
      version: 1,
      descriptor: buildTask116CampaignChildren(plan)[0],
      instrument: plan.instrument,
      bucket: plan.bucket,
      region: plan.region,
      requesterPays: true,
      failedKind: "INITIAL",
      failedSequence: 1,
      failedStatus: "ERROR",
      failedError: "SESSION_EXPIRED",
      accountingHash: acquisitionHash(accounting),
      countersHash: acquisitionHash({ totals: ledger.totals, attempts: ledger.attempts, context: ledger.contexts[input.originalApprovalId], normal: campaign.normalHeadAttempts, recovery: campaign.recoveryHeadAttempts }),
      oldGlobalCaps: { ...ledger.globalCaps },
      newGlobalCaps: { ...ledger.globalCaps, maxHeadAttempts: 45 },
      allocation: 1,
      nextSequence: 2,
      indeterminateRecoveryAllowance: 0,
    };
    const check = async () => {
      if (await store.readPlain("writer.lock")) throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
      const current = await store.ledger(plan);
      if (!current || acquisitionHash(current) !== input.priorLedgerHash || (current.ledgerGeneration ?? 0) !== input.priorLedgerGeneration || current.retryCapRevision) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
      await store.validateClassifiedRetryFailure(plan, authorization, current);
    };
    const name = `retry-authorizations/${authorization.authorizationId}.json`;
    const mode = await store.persistOfflineRetryEvidence(projectRoot, name, authorization, options.validateOnly ?? false, check);
    return {
      operation: "PREPARE CLASSIFIED ERROR RETRY AUTHORIZATION ONLY - DOES NOT APPLY OR EXECUTE",
      mode,
      authorizationId: authorization.authorizationId,
      authorizationHash: acquisitionHash(authorization),
      authorizationPath: `${DUKASCOPY_PRODUCTION_ROOT}/${name}`,
      allocation: 1,
      nextSequence: 2,
      oldCap: 44,
      reviewedFutureCap: 45,
      awsRequests: 0,
      credentialResolution: 0,
    };
  }

  private async preparedRetryAuthorization(plan: FrozenDukascopyPlan, id: string, expectedHash: string, now = Date.now()): Promise<ClassifiedErrorRetryAuthorization> {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id) || !/^[a-f0-9]{64}$/.test(expectedHash)) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
    const authorization = await this.readDocument<ClassifiedErrorRetryAuthorization>(`retry-authorizations/${id}.json`);
    if (!authorization || authorization.authorizationId !== id || acquisitionHash(authorization) !== expectedHash) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
    assertTask116ClassifiedRetryScope(plan, authorization, now);
    return authorization;
  }

  private retryRevision(authorization: ClassifiedErrorRetryAuthorization): RetryCapRevision {
    return {
      version: 1,
      revisionId: authorization.authorizationId,
      retryAuthorizationId: authorization.authorizationId,
      retryAuthorizationHash: acquisitionHash(authorization),
      parentAuthorizationId: authorization.capAuthorizationId,
      parentAuthorizationHash: authorization.capAuthorizationHash,
      priorLedgerHash: authorization.priorLedgerHash,
      priorLedgerGeneration: authorization.priorLedgerGeneration,
      oldGlobalCaps: authorization.oldGlobalCaps,
      newGlobalCaps: authorization.newGlobalCaps,
    };
  }

  private async assertRetryCapRevision(plan: FrozenDukascopyPlan, ledger: AcquisitionLedger): Promise<ClassifiedErrorRetryAuthorization> {
    const pointer = ledger.retryCapRevision;
    if (!pointer) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
    const authorization = await this.preparedRetryAuthorization(plan, pointer.authorizationId, pointer.authorizationHash, 0);
    const revision = await this.readDocument<RetryCapRevision>(`cap-revisions/${pointer.revisionId}.json`);
    const parent = await this.readDocument<CampaignCapExpansionAuthorization>(`cap-expansions/${authorization.capAuthorizationId}.json`);
    if (
      !revision ||
      !parent ||
      pointer.revisionId !== authorization.authorizationId ||
      pointer.revisionHash !== acquisitionHash(revision) ||
      acquisitionHash(revision) !== acquisitionHash(this.retryRevision(authorization)) ||
      acquisitionHash(parent) !== authorization.capAuthorizationHash ||
      acquisitionHash(parent.newGlobalCaps) !== acquisitionHash(revision.oldGlobalCaps) ||
      !ledger.appliedCapExpansionIds?.includes(parent.authorizationId) ||
      acquisitionHash(ledger.globalCaps) !== acquisitionHash(revision.newGlobalCaps) ||
      (ledger.ledgerGeneration ?? 0) < authorization.priorLedgerGeneration + 1
    )
      throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
    return authorization;
  }

  async applyTask116RetryCapAmendment(plan: FrozenDukascopyPlan, authorizationId: string, authorizationHash: string): Promise<CapExpansionResult> {
    const authorization = await this.preparedRetryAuthorization(plan, authorizationId, authorizationHash);
    const ledger = await this.ledger(plan);
    if (!ledger) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
    if (ledger.retryCapRevision) {
      const applied = await this.assertRetryCapRevision(plan, ledger);
      if (applied.authorizationId !== authorizationId) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
      return "ALREADY_APPLIED";
    }
    if (acquisitionHash(ledger) !== authorization.priorLedgerHash || (ledger.ledgerGeneration ?? 0) !== authorization.priorLedgerGeneration || acquisitionHash(ledger.globalCaps) !== acquisitionHash(authorization.oldGlobalCaps)) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
    await this.validateClassifiedRetryFailure(plan, authorization, ledger);
    const revision = this.retryRevision(authorization);
    await this.ensurePath(this.path("cap-revisions"), true);
    await mkdir(this.path("cap-revisions"), { recursive: true, mode: 0o700 });
    await this.ensurePath(this.path("cap-revisions"));
    await this.syncDirectory(this.root);
    await this.document(`cap-revisions/${revision.revisionId}.json`, revision, true);
    this.fault("CAP_AFTER_AUTHORIZATION_EVIDENCE");
    const current = await this.ledger(plan);
    if (!current || acquisitionHash(current) !== authorization.priorLedgerHash) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
    current.globalCaps = { ...authorization.newGlobalCaps };
    current.ledgerGeneration = authorization.priorLedgerGeneration + 1;
    current.retryCapRevision = { revisionId: revision.revisionId, revisionHash: acquisitionHash(revision), authorizationId, authorizationHash };
    await this.document("ledger.json", current);
    this.fault("CAP_AFTER_LEDGER_COMMIT");
    return "APPLIED";
  }

  private async assertAttemptCapRevision(plan: FrozenDukascopyPlan, ledger: AcquisitionLedger, approval: AcquisitionApproval, event: HeadAttemptJournalEvent): Promise<void> {
    if (!ledger.retryCapRevision) {
      if (acquisitionHash(approval.globalCaps) !== acquisitionHash(ledger.globalCaps) || event.capRevisionId || event.capRevisionHash) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
      return;
    }
    const authorization = await this.assertRetryCapRevision(plan, ledger);
    if (acquisitionHash(approval.globalCaps) === acquisitionHash(authorization.oldGlobalCaps)) {
      if (approval.id !== authorization.originalApprovalId || acquisitionHash(approval) !== authorization.originalApprovalHash || event.attemptId !== authorization.failedAttemptId || event.capRevisionId || event.capRevisionHash) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
      return;
    }
    if (acquisitionHash(approval.globalCaps) !== acquisitionHash(ledger.globalCaps) || event.capRevisionId !== ledger.retryCapRevision.revisionId || event.capRevisionHash !== ledger.retryCapRevision.revisionHash) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
  }

  static async prepareTask116RetryExecutionApproval(
    plan: FrozenDukascopyPlan,
    input: OperatorApprovalEvidence & { expiresAt: string; authorizationId: string; authorizationHash: string; phase: "REPLACEMENT" | "CONTINUATION"; priorLedgerHash: string; priorLedgerGeneration: number; inventoryRevision: string; capRevisionId: string; capRevisionHash: string },
    options: { projectRoot: string; validateOnly?: boolean },
  ) {
    const fields = ["authorizedAt", "operatorApprovalReference", "operatorApprovalHash", "reason", "expiresAt", "authorizationId", "authorizationHash", "phase", "priorLedgerHash", "priorLedgerGeneration", "inventoryRevision", "capRevisionId", "capRevisionHash"];
    if (Object.keys(input).length !== fields.length || Object.keys(input).some((field) => !fields.includes(field)) || !["REPLACEMENT", "CONTINUATION"].includes(input.phase)) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
    assertOperatorApprovalEvidence(input, input.expiresAt);
    const projectRoot = resolve(options.projectRoot);
    const store = new DurableAcquisitionStore(resolve(projectRoot, DUKASCOPY_PRODUCTION_ROOT), "retry-approval-read-only");
    await store.ensurePath(store.root);
    const authorization = await store.preparedRetryAuthorization(plan, input.authorizationId, input.authorizationHash);
    const ledger = await store.ledger(plan);
    const campaign = ledger?.campaignBudgets?.[authorization.campaignId];
    const pool = campaign?.classifiedErrorRetry;
    if (!ledger || !campaign || !pool || campaign.status !== "ACTIVE" || pool.authorizationId !== input.authorizationId || pool.authorizationHash !== input.authorizationHash || input.expiresAt > authorization.expiresAt) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
    const replacement = input.phase === "REPLACEMENT";
    if (replacement ? pool.stage !== "RETRY_AUTHORIZED" || pool.consumed !== 0 || input.inventoryRevision !== authorization.partialRevision : pool.stage !== "ACTIVE_CONTINUATION" || input.inventoryRevision !== pool.outputRevision || campaign.currentInventoryRevision !== input.inventoryRevision) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
    const snapshot = await store.loadInventorySnapshot(plan, input.inventoryRevision);
    const keys = replacement ? [authorization.failedKey] : authorization.descriptor.keys.filter((key) => key !== authorization.failedKey);
    if (!replacement && (keys.length !== 6 || !["PRESENT", "CONFIRMED_ABSENT"].includes(snapshot.entries[plan.keys.indexOf(authorization.failedKey)].status) || keys.some((key) => snapshot.entries[plan.keys.indexOf(key)].status !== "UNKNOWN" || ledger.attempts[`HEAD:${key}`]))) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
    const approval: AcquisitionApproval = {
      id: `${authorization.authorizationId}-${replacement ? "replacement" : "continuation"}`,
      batchId: authorization.descriptor.batchId,
      operation: "INVENTORY",
      planHash: plan.planHash,
      inventoryRevision: input.inventoryRevision,
      batchStart: authorization.descriptor.batchStart,
      batchEnd: authorization.descriptor.batchEnd,
      keys,
      caps: { maxHeadAttempts: keys.length + Number(!replacement), maxGetAttempts: 0, maxNetworkBytes: 0, maxVerifiedBytes: 0, maxObjects: keys.length, maxRetries: 0 },
      globalCaps: { ...ledger.globalCaps },
      campaignId: authorization.campaignId,
      recoveryAllowance: { maxIndeterminateHeadRetries: Number(!replacement) },
      minimumFreeBytes: 0,
      expiresAt: input.expiresAt,
      classifiedErrorRetry: { authorizationId: input.authorizationId, authorizationHash: input.authorizationHash, phase: input.phase, capRevisionId: input.capRevisionId, capRevisionHash: input.capRevisionHash },
      campaignPreparation: {
        version: 1,
        childSequence: 1,
        priorLedgerHash: input.priorLedgerHash,
        priorLedgerGeneration: input.priorLedgerGeneration,
        capAuthorizationId: authorization.capAuthorizationId,
        capAuthorizationHash: authorization.capAuthorizationHash,
        childDescriptorHash: acquisitionHash(authorization.descriptor),
        instrument: plan.instrument,
        bucket: plan.bucket,
        region: plan.region,
        requesterPays: true,
        authorizedAt: input.authorizedAt,
        operatorApprovalReference: input.operatorApprovalReference,
        operatorApprovalHash: input.operatorApprovalHash,
        reason: input.reason,
      },
    };
    const check = async () => {
      if (await store.readPlain("writer.lock")) throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
      const current = await store.ledger(plan);
      if (!current || current.active || acquisitionHash(current) !== input.priorLedgerHash || current.ledgerGeneration !== input.priorLedgerGeneration || current.retryCapRevision?.revisionId !== input.capRevisionId || current.retryCapRevision?.revisionHash !== input.capRevisionHash) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
      await store.assertRetryCapRevision(plan, current);
      assertApproval(plan, approval, "INVENTORY", snapshot.revision);
    };
    const name = `retry-approvals/${approval.id}.json`;
    const mode = await store.persistOfflineRetryEvidence(projectRoot, name, approval, options.validateOnly ?? false, check);
    return { operation: "PREPARE RETRY EXECUTION APPROVAL ONLY - DOES NOT EXECUTE", mode, approvalId: approval.id, approvalHash: acquisitionHash(approval), approvalPath: `${DUKASCOPY_PRODUCTION_ROOT}/${name}`, phase: input.phase, keyCount: keys.length };
  }

  async validateTask116RetryExecutionApproval(plan: FrozenDukascopyPlan, approval: AcquisitionApproval, snapshot: InventorySnapshot, allowClassifiedCompletion = false): Promise<ClassifiedErrorRetryAuthorization> {
    const metadata = approval.classifiedErrorRetry;
    const binding = approval.campaignPreparation;
    if (!metadata || !binding) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
    assertApproval(plan, approval, "INVENTORY", snapshot.revision);
    assertInventorySnapshot(plan, snapshot);
    const authorization = await this.preparedRetryAuthorization(plan, metadata.authorizationId, metadata.authorizationHash);
    const ledger = await this.ledger(plan);
    const campaign = ledger?.campaignBudgets?.[authorization.campaignId];
    const pool = campaign?.classifiedErrorRetry;
    if (
      !ledger ||
      !campaign ||
      !pool ||
      approval.campaignId !== authorization.campaignId ||
      campaign.currentChildSequence !== 1 ||
      pool.authorizationId !== metadata.authorizationId ||
      pool.authorizationHash !== metadata.authorizationHash ||
      metadata.capRevisionId !== ledger.retryCapRevision?.revisionId ||
      metadata.capRevisionHash !== ledger.retryCapRevision?.revisionHash ||
      binding.priorLedgerGeneration !== ledger.ledgerGeneration ||
      acquisitionHash(approval.globalCaps) !== acquisitionHash(ledger.globalCaps) ||
      binding.capAuthorizationId !== authorization.capAuthorizationId ||
      binding.capAuthorizationHash !== authorization.capAuthorizationHash ||
      binding.childDescriptorHash !== acquisitionHash(authorization.descriptor)
    )
      throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
    await this.assertRetryCapRevision(plan, ledger);
    const prepared = await this.readDocument<AcquisitionApproval>(`retry-approvals/${approval.id}.json`);
    if (!prepared || acquisitionHash(prepared) !== acquisitionHash(approval)) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
    const replacement = metadata.phase === "REPLACEMENT";
    const keys = replacement ? [authorization.failedKey] : authorization.descriptor.keys.filter((key) => key !== authorization.failedKey);
    const allowedStages = replacement ? ["RETRY_AUTHORIZED", "RETRY_IN_PROGRESS"] : ["ACTIVE_CONTINUATION"];
    if (allowClassifiedCompletion) allowedStages.push("STOPPED", "COMPLETED", "ACTIVE_CONTINUATION");
    if (
      !allowedStages.includes(pool.stage) ||
      (!allowClassifiedCompletion && campaign.status !== "ACTIVE") ||
      acquisitionHash(approval.keys) !== acquisitionHash(keys) ||
      approval.batchId !== authorization.descriptor.batchId ||
      approval.batchStart !== authorization.descriptor.batchStart ||
      approval.batchEnd !== authorization.descriptor.batchEnd ||
      approval.inventoryRevision !== (replacement ? authorization.partialRevision : campaign.currentInventoryRevision) ||
      approval.caps.maxHeadAttempts !== keys.length + Number(!replacement) ||
      approval.caps.maxObjects !== keys.length ||
      approval.caps.maxRetries !== 0 ||
      approval.recoveryAllowance?.maxIndeterminateHeadRetries !== Number(!replacement) ||
      approval.caps.maxGetAttempts !== 0 ||
      approval.caps.maxNetworkBytes !== 0 ||
      approval.caps.maxVerifiedBytes !== 0
    )
      throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
    const currentId = replacement ? pool.replacementApprovalId : pool.continuationApprovalId;
    const currentHash = replacement ? pool.replacementApprovalHash : pool.continuationApprovalHash;
    if (currentId ? currentId !== approval.id || currentHash !== acquisitionHash(approval) : acquisitionHash(ledger) !== binding.priorLedgerHash) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
    return authorization;
  }

  private async bindRetryExecution(plan: FrozenDukascopyPlan, approval: AcquisitionApproval, snapshot: InventorySnapshot, ledger: AcquisitionLedger): Promise<void> {
    const authorization = await this.validateTask116RetryExecutionApproval(plan, approval, snapshot);
    const pool = ledger.campaignBudgets![authorization.campaignId].classifiedErrorRetry!;
    const replacement = approval.classifiedErrorRetry!.phase === "REPLACEMENT";
    if (replacement && !pool.replacementApprovalId) {
      await this.retryTransition(authorization, "RETRY_IN_PROGRESS", approval.id, { priorLedgerHash: acquisitionHash(ledger), from: "RETRY_AUTHORIZED", approvalHash: acquisitionHash(approval) });
      pool.replacementApprovalId = approval.id;
      pool.replacementApprovalHash = acquisitionHash(approval);
      pool.stage = "RETRY_IN_PROGRESS";
    } else if (!replacement && !pool.continuationApprovalId) {
      await this.retryTransition(authorization, "CONTINUATION_IN_PROGRESS", approval.id, { priorLedgerHash: acquisitionHash(ledger), approvalHash: acquisitionHash(approval), seed: snapshot.revision });
      pool.continuationApprovalId = approval.id;
      pool.continuationApprovalHash = acquisitionHash(approval);
    }
    ledger.campaignBudgets![authorization.campaignId].children[0].status = "IN_PROGRESS";
  }

  private async completeRetryExecution(plan: FrozenDukascopyPlan, approval: AcquisitionApproval, snapshot: InventorySnapshot): Promise<void> {
    const metadata = approval.classifiedErrorRetry!;
    const authorization = await this.preparedRetryAuthorization(plan, metadata.authorizationId, metadata.authorizationHash);
    const ledger = await this.ledger(plan);
    const campaign = ledger?.campaignBudgets?.[authorization.campaignId];
    const pool = campaign?.classifiedErrorRetry;
    if (!ledger || !campaign || !pool || metadata.capRevisionId !== ledger.retryCapRevision?.revisionId || metadata.capRevisionHash !== ledger.retryCapRevision?.revisionHash) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
    const prepared = await this.readDocument<AcquisitionApproval>(`retry-approvals/${approval.id}.json`);
    if (!prepared || acquisitionHash(prepared) !== acquisitionHash(approval)) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
    if (pool.outputRevision === snapshot.revision && ["ACTIVE_CONTINUATION", "STOPPED", "COMPLETED"].includes(pool.stage)) return;
    if (acquisitionHash(await this.loadInventorySnapshot(plan, snapshot.revision)) !== acquisitionHash(snapshot)) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
    const journal = await this.headAttemptJournal();
    for (const key of approval.keys) {
      const entry = snapshot.entries[plan.keys.indexOf(key)];
      const event = journal.filter((event) => event.approvalId === approval.id && event.key === key).at(-1);
      if (entry.status === "UNKNOWN" && !event) continue;
      if (!event || event.approvalHash !== acquisitionHash(approval)) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
      await this.assertAttemptCapRevision(plan, ledger, approval, event);
      if (event.state === "CLASSIFIED") {
        if (acquisitionHash(event.classification) !== acquisitionHash(entry) || !ledger.headAttemptAccounting?.[event.attemptId]?.settled) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
      } else if (event.state !== "MAY_HAVE_BEEN_SENT" || entry.status !== "ERROR" || entry.error !== "INDETERMINATE" || entry.attempts !== event.sequence) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
    }
    const seed = await this.loadInventorySnapshot(plan, approval.inventoryRevision!);
    for (const key of plan.keys) if (!approval.keys.includes(key) && acquisitionHash(seed.entries[plan.keys.indexOf(key)]) !== acquisitionHash(snapshot.entries[plan.keys.indexOf(key)])) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
    const replacement = metadata.phase === "REPLACEMENT";
    if (replacement ? pool.replacementApprovalId !== approval.id || pool.consumed !== 1 : pool.continuationApprovalId !== approval.id) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
    const complete = approval.keys.every((key) => ["PRESENT", "CONFIRMED_ABSENT"].includes(snapshot.entries[plan.keys.indexOf(key)].status));
    const stage = !complete ? "STOPPED" : replacement ? "ACTIVE_CONTINUATION" : "COMPLETED";
    await this.retryTransition(authorization, stage, snapshot.revision, { from: pool.stage, approvalId: approval.id, approvalHash: acquisitionHash(approval), outputRevision: snapshot.revision });
    this.fault("RETRY_AFTER_TRANSITION_EVIDENCE");
    pool.outputRevision = snapshot.revision;
    pool.stage = stage;
    const child = campaign.children[0];
    child.outputRevision = snapshot.revision;
    if (!complete) {
      campaign.status = "STOPPED";
      child.status = "STOPPED";
      child.stopReason = snapshot.entries.some((entry) => approval.keys.includes(entry.key) && entry.error === "INDETERMINATE") ? "INDETERMINATE" : "ERROR";
      campaign.stopReason = child.stopReason;
    } else {
      campaign.currentInventoryRevision = snapshot.revision;
      if (!replacement) {
        if (!child.keys.every((key) => ["PRESENT", "CONFIRMED_ABSENT"].includes(snapshot.entries[plan.keys.indexOf(key)].status))) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
        child.status = "COMPLETED";
        campaign.currentChildSequence = 2;
      }
    }
    await this.document("ledger.json", ledger);
  }

  private async retryTransition(authorization: ClassifiedErrorRetryAuthorization, stage: string, trigger: string, details: unknown): Promise<void> {
    await this.ensurePath(this.path("retry-transitions"), true);
    await mkdir(this.path("retry-transitions"), { recursive: true, mode: 0o700 });
    await this.ensurePath(this.path("retry-transitions"));
    await this.syncDirectory(this.root);
    await this.document(
      `retry-transitions/${authorization.authorizationId}-${stage}-${trigger}.json`,
      { version: 1, authorizationId: authorization.authorizationId, authorizationHash: acquisitionHash(authorization), stage, trigger, failedAttemptId: authorization.failedAttemptId, originalStopReason: "SESSION_EXPIRED", originalPartialRevision: authorization.partialRevision, details },
      true,
    );
  }

  async applyTask116ClassifiedErrorRetryAuthorization(plan: FrozenDukascopyPlan, authorizationId: string, authorizationHash: string): Promise<CapExpansionResult> {
    const authorization = await this.preparedRetryAuthorization(plan, authorizationId, authorizationHash);
    const ledger = await this.ledger(plan);
    if (!ledger || !ledger.retryCapRevision) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
    const applied = await this.assertRetryCapRevision(plan, ledger);
    if (applied.authorizationId !== authorizationId) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
    const pool = ledger.campaignBudgets?.[authorization.campaignId]?.classifiedErrorRetry;
    if (pool) {
      if (pool.authorizationId !== authorizationId || pool.authorizationHash !== authorizationHash || !(await this.readDocument(`retry-transitions/${authorizationId}-RETRY_AUTHORIZED-apply.json`))) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
      return "ALREADY_APPLIED";
    }
    const original = structuredClone(ledger);
    delete original.retryCapRevision;
    original.globalCaps = { ...authorization.oldGlobalCaps };
    if (authorization.priorLedgerGeneration === 0) delete original.ledgerGeneration;
    else original.ledgerGeneration = authorization.priorLedgerGeneration;
    if (acquisitionHash(original) !== authorization.priorLedgerHash || ledger.ledgerGeneration !== authorization.priorLedgerGeneration + 1) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
    await this.validateClassifiedRetryFailure(plan, authorization, original);
    await this.retryTransition(authorization, "RETRY_AUTHORIZED", "apply", { priorLedgerHash: acquisitionHash(ledger), priorLedgerGeneration: ledger.ledgerGeneration, fromCampaign: "STOPPED_ERROR", fromChild: "STOPPED_ERROR", allocation: 1 });
    this.fault("CAP_AFTER_AUTHORIZATION_EVIDENCE");
    const current = await this.ledger(plan);
    if (!current || acquisitionHash(current) !== acquisitionHash(ledger)) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
    const campaign = current.campaignBudgets![authorization.campaignId];
    campaign.classifiedErrorRetry = { authorizationId, authorizationHash, allocation: 1, consumed: 0, stage: "RETRY_AUTHORIZED" };
    campaign.status = "ACTIVE";
    current.ledgerGeneration = authorization.priorLedgerGeneration + 2;
    await this.document("ledger.json", current);
    this.fault("CAP_AFTER_LEDGER_COMMIT");
    return "APPLIED";
  }

  static async prepareTask116CampaignChildApproval(plan: FrozenDukascopyPlan, input: CampaignChildApprovalPreparationInput, options: { projectRoot: string; validateOnly?: boolean }): Promise<CampaignChildApprovalPreparationResult> {
    const fields = [
      "approvalId",
      "campaignId",
      "childSequence",
      "priorLedgerHash",
      "priorLedgerGeneration",
      "inventoryRevision",
      "masterPlanHash",
      "capAuthorizationId",
      "capAuthorizationHash",
      "globalCaps",
      "childDescriptorHash",
      "instrument",
      "bucket",
      "region",
      "requesterPays",
      "authorizedAt",
      "expiresAt",
      "operatorApprovalReference",
      "operatorApprovalHash",
      "reason",
    ];
    if (
      Object.keys(input).length !== fields.length ||
      Object.keys(input).some((field) => !fields.includes(field)) ||
      input.campaignId !== TASK116_CAMPAIGN_ID ||
      !Number.isSafeInteger(input.childSequence) ||
      input.childSequence < 1 ||
      input.childSequence > 5 ||
      input.masterPlanHash !== plan.planHash ||
      input.instrument !== plan.instrument ||
      input.bucket !== plan.bucket ||
      input.region !== plan.region ||
      input.requesterPays !== true
    )
      throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
    assertOperatorApprovalEvidence(input, input.expiresAt);
    const projectRoot = resolve(options.projectRoot);
    const store = new DurableAcquisitionStore(resolve(projectRoot, DUKASCOPY_PRODUCTION_ROOT), "child-approval-read-only");
    await store.ensurePath(store.root);
    let approval: AcquisitionApproval | undefined;
    const assertCurrentState = async () => {
      if (await store.readPlain("writer.lock")) throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
      const ledger = await store.ledger(plan);
      const campaign = ledger?.campaignBudgets?.[input.campaignId];
      const child = campaign?.children[input.childSequence - 1];
      if (
        !ledger ||
        !campaign ||
        !child ||
        ledger.active !== null ||
        acquisitionHash(ledger) !== input.priorLedgerHash ||
        (ledger.ledgerGeneration ?? 0) !== input.priorLedgerGeneration ||
        ledger.globalCaps.maxHeadAttempts !== 44 ||
        acquisitionHash(ledger.globalCaps) !== acquisitionHash(input.globalCaps) ||
        campaign.status !== "ACTIVE" ||
        campaign.currentChildSequence !== input.childSequence ||
        child.status !== "PENDING" ||
        child.approvalId ||
        child.approvalHash ||
        campaign.currentInventoryRevision !== input.inventoryRevision ||
        campaign.authorizationId !== input.capAuthorizationId ||
        campaign.authorizationHash !== input.capAuthorizationHash
      )
        throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
      await store.assertCampaignCapEvidence(plan, ledger, input.campaignId);
      const descriptor = buildTask116CampaignChildren(plan)[input.childSequence - 1];
      if (acquisitionHash(descriptor) !== input.childDescriptorHash) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
      const capAuthorization = await store.readDocument<CampaignCapExpansionAuthorization>(`cap-expansions/${input.capAuthorizationId}.json`);
      if (!capAuthorization) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
      if (input.childSequence === 1 && input.inventoryRevision !== capAuthorization.initialInventoryRevision) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
      const snapshot = await store.loadInventorySnapshot(plan, input.inventoryRevision);
      for (const previous of campaign.children.slice(0, input.childSequence - 1)) {
        if (previous.status !== "COMPLETED" || !previous.outputRevision || !previous.approvalId || !previous.approvalHash) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
        const result = await store.loadInventorySnapshot(plan, previous.outputRevision);
        if (previous.keys.some((key) => !["PRESENT", "CONFIRMED_ABSENT"].includes(result.entries[plan.keys.indexOf(key)].status) || acquisitionHash(result.entries[plan.keys.indexOf(key)]) !== acquisitionHash(snapshot.entries[plan.keys.indexOf(key)]))) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
      }
      if (input.childSequence > 1 && campaign.children[input.childSequence - 2].outputRevision !== input.inventoryRevision) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
      if (
        ledger.contexts[input.approvalId] ||
        child.keys.some((key) => snapshot.entries[plan.keys.indexOf(key)].status !== "UNKNOWN" || snapshot.entries[plan.keys.indexOf(key)].attempts !== 0 || ledger.attempts[`HEAD:${key}`]) ||
        campaign.normalHeadAttempts + child.keys.length > campaign.normalHeadBudget ||
        campaign.recoveryHeadAttempts + child.recoveryAllowance > campaign.recoveryHeadBudget ||
        ledger.totals.headAttempts + child.keys.length + child.recoveryAllowance > ledger.globalCaps.maxHeadAttempts
      )
        throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
      const binding: CampaignChildPreparationBinding = {
        version: 1,
        childSequence: input.childSequence,
        priorLedgerHash: input.priorLedgerHash,
        priorLedgerGeneration: input.priorLedgerGeneration,
        capAuthorizationId: input.capAuthorizationId,
        capAuthorizationHash: input.capAuthorizationHash,
        childDescriptorHash: input.childDescriptorHash,
        instrument: input.instrument,
        bucket: input.bucket,
        region: input.region,
        requesterPays: true,
        authorizedAt: input.authorizedAt,
        operatorApprovalReference: input.operatorApprovalReference,
        operatorApprovalHash: input.operatorApprovalHash,
        reason: input.reason,
      };
      const candidate: AcquisitionApproval = {
        id: input.approvalId,
        batchId: child.batchId,
        operation: "INVENTORY",
        planHash: plan.planHash,
        inventoryRevision: snapshot.revision,
        batchStart: child.batchStart,
        batchEnd: child.batchEnd,
        keys: [...descriptor.keys],
        caps: { maxHeadAttempts: child.keys.length + child.recoveryAllowance, maxGetAttempts: 0, maxNetworkBytes: 0, maxVerifiedBytes: 0, maxObjects: child.keys.length, maxRetries: 0 },
        globalCaps: { ...ledger.globalCaps },
        campaignId: input.campaignId,
        recoveryAllowance: { maxIndeterminateHeadRetries: child.recoveryAllowance },
        campaignPreparation: binding,
        minimumFreeBytes: 0,
        expiresAt: input.expiresAt,
      };
      assertApproval(plan, candidate, "INVENTORY", snapshot.revision);
      store.validateCampaignChild(candidate, snapshot, ledger);
      if (approval && acquisitionHash(approval) !== acquisitionHash(candidate)) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
      approval = candidate;
    };
    await assertCurrentState();
    const candidate = approval!;
    const name = `child-approvals/${candidate.id}.json`;
    const approvalPath = `${DUKASCOPY_PRODUCTION_ROOT}/${name}`;
    const approvalHash = acquisitionHash(candidate);
    const assertIgnoredUntracked = () => {
      const ignored = spawnSync("git", ["check-ignore", "--quiet", "--no-index", "--", approvalPath], { cwd: projectRoot, stdio: "ignore" });
      const tracked = spawnSync("git", ["ls-files", "--error-unmatch", "--", approvalPath], { cwd: projectRoot, stdio: "ignore" });
      if (ignored.status !== 0 || tracked.status !== 1) throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
    };
    assertIgnoredUntracked();
    const existing = await store.readDocument<AcquisitionApproval>(name);
    if (existing && acquisitionHash(existing) !== approvalHash) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
    let mode: CampaignChildApprovalPreparationResult["mode"] = options.validateOnly ? "VALIDATE_ONLY" : "EXISTING";
    if (!options.validateOnly && !existing) {
      const directory = dirname(store.path(name));
      await store.ensurePath(directory, true);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await store.ensurePath(directory);
      await store.syncDirectory(store.root);
      const temporary = store.path(`child-approvals/${candidate.id}.${randomUUID()}.tmp`);
      const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        try {
          await handle.writeFile(`${JSON.stringify({ hash: approvalHash, data: candidate })}\n`);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await assertCurrentState();
        assertIgnoredUntracked();
        await store.ensurePath(store.path(name), true);
        try {
          await link(temporary, store.path(name));
          mode = "PREPARED";
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST" || acquisitionHash(await store.readDocument(name)) !== approvalHash) throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
        }
      } finally {
        await unlink(temporary);
        await store.syncDirectory(directory);
      }
    }
    await assertCurrentState();
    assertIgnoredUntracked();
    if (!options.validateOnly && acquisitionHash(await store.readDocument(name)) !== approvalHash) throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
    return {
      operation: "PREPARE CHILD APPROVAL ONLY - DOES NOT EXECUTE INVENTORY",
      mode,
      approvalId: candidate.id,
      approvalHash,
      approvalPath,
      validation: {
        campaignId: input.campaignId,
        childSequence: input.childSequence,
        childRange: [candidate.batchStart, candidate.batchEnd],
        keyCount: candidate.keys.length,
        inventoryRevision: input.inventoryRevision,
        priorLedgerHash: input.priorLedgerHash,
        priorLedgerGeneration: input.priorLedgerGeneration,
        normalAllocation: candidate.keys.length,
        recoveryAllowance: candidate.recoveryAllowance!.maxIndeterminateHeadRetries,
        caps: candidate.caps,
        globalCaps: candidate.globalCaps,
        ignored: true,
        untracked: true,
      },
    };
  }

  static async prepareTask116CampaignCapExpansionAuthorization(plan: FrozenDukascopyPlan, input: CampaignCapAuthorizationPreparationInput, options: { projectRoot: string; validateOnly?: boolean }): Promise<CampaignCapAuthorizationPreparationResult> {
    const projectRoot = resolve(options.projectRoot);
    const store = new DurableAcquisitionStore(resolve(projectRoot, DUKASCOPY_PRODUCTION_ROOT), "authorization-read-only");
    await store.ensurePath(store.root);
    const authorization: CampaignCapExpansionAuthorization = {
      version: 1,
      authorizationId: input.authorizationId,
      campaignId: input.campaignId,
      oldGlobalCaps: { ...input.oldGlobalCaps },
      newGlobalCaps: { ...input.newGlobalCaps },
      oldMaxHeadAttempts: 21,
      newMaxHeadAttempts: 44,
      normalHeadBudget: 30,
      recoveryHeadBudget: 5,
      campaignStart: input.campaignStart,
      campaignEnd: input.campaignEnd,
      children: input.children.map((child) => ({ ...child, keys: [...child.keys] })),
      reason: input.reason,
      authorizedAt: input.authorizedAt,
      expiresAt: input.expiresAt,
      operatorApprovalReference: input.operatorApprovalReference,
      operatorApprovalHash: input.operatorApprovalHash,
      priorLedgerHash: input.priorLedgerHash,
      priorLedgerGeneration: input.priorLedgerGeneration,
      masterPlanHash: input.masterPlanHash,
      instrument: input.instrument,
      bucket: input.bucket,
      region: input.region,
      requesterPays: input.requesterPays,
      initialInventoryRevision: input.initialInventoryRevision,
    };
    const fixedFields = ["version", "oldMaxHeadAttempts", "newMaxHeadAttempts", "normalHeadBudget", "recoveryHeadBudget"];
    const allowedFields = Object.keys(authorization).filter((field) => !fixedFields.includes(field));
    const now = Date.now();
    if (
      Object.keys(input).length !== allowedFields.length ||
      Object.keys(input).some((field) => !allowedFields.includes(field)) ||
      !/^[A-Za-z0-9][A-Za-z0-9 .,()\[\]:;_/-]{9,499}$/.test(authorization.reason) ||
      /secret|password|credential|token|bearer|private.?key|AKIA|ASIA|placeholder|\bTODO\b|\bdummy\b/i.test(authorization.reason) ||
      /^(?:PLACEHOLDER|TODO|TEST|NONE|UNKNOWN|DUMMY)(?:$|[_-])/i.test(authorization.operatorApprovalReference) ||
      /secret|password|credential|token|bearer|private.?key|AKIA|ASIA/i.test(authorization.operatorApprovalReference) ||
      /^([a-f0-9])\1{63}$/.test(authorization.operatorApprovalHash) ||
      Date.parse(authorization.authorizedAt) < now - 86_400_000 ||
      Date.parse(authorization.expiresAt) - Date.parse(authorization.authorizedAt) > 86_400_000
    )
      throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
    const assertCurrentState = async () => {
      if (await store.readPlain("writer.lock")) throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
      const ledger = await store.ledger(plan);
      if (!ledger || ledger.active !== null || ledger.totals.headAttempts !== 9 || ledger.campaignBudgets?.[authorization.campaignId]) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
      assertTask116CampaignCapExpansion(plan, ledger, authorization);
      const snapshot = await store.loadInventorySnapshot(plan, authorization.initialInventoryRevision);
      for (const child of authorization.children)
        for (const key of child.keys) {
          if (snapshot.entries[plan.keys.indexOf(key)].status !== "UNKNOWN" || ledger.attempts[`HEAD:${key}`]) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
        }
      return ledger;
    };
    const ledger = await assertCurrentState();
    const name = `cap-expansions/${authorization.authorizationId}.json`;
    const authorizationPath = `${DUKASCOPY_PRODUCTION_ROOT}/${name}`;
    const assertIgnoredUntracked = () => {
      const ignored = spawnSync("git", ["check-ignore", "--quiet", "--no-index", "--", authorizationPath], { cwd: projectRoot, stdio: "ignore" });
      const tracked = spawnSync("git", ["ls-files", "--error-unmatch", "--", authorizationPath], { cwd: projectRoot, stdio: "ignore" });
      if (ignored.status !== 0 || tracked.status !== 1) throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
    };
    assertIgnoredUntracked();
    const authorizationHash = acquisitionHash(authorization);
    const existing = await store.readDocument<CampaignCapExpansionAuthorization>(name);
    if (existing && acquisitionHash(existing) !== authorizationHash) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
    let mode: CampaignCapAuthorizationPreparationResult["mode"] = options.validateOnly ? "VALIDATE_ONLY" : "EXISTING";
    if (!options.validateOnly && !existing) {
      const directory = dirname(store.path(name));
      await store.ensurePath(directory, true);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await store.ensurePath(directory);
      await store.syncDirectory(store.root);
      const temporary = store.path(`cap-expansions/${authorization.authorizationId}.${randomUUID()}.tmp`);
      const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        try {
          await handle.writeFile(`${JSON.stringify({ hash: authorizationHash, data: authorization })}\n`);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await assertCurrentState();
        assertIgnoredUntracked();
        await store.ensurePath(store.path(name), true);
        try {
          await link(temporary, store.path(name));
          mode = "PREPARED";
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST" || acquisitionHash(await store.readDocument(name)) !== authorizationHash) throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
        }
      } finally {
        await unlink(temporary);
        await store.syncDirectory(directory);
      }
    }
    await assertCurrentState();
    assertIgnoredUntracked();
    if (!options.validateOnly && acquisitionHash(await store.readDocument(name)) !== authorizationHash) throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
    return {
      operation: "PREPARE AUTHORIZATION ONLY - DOES NOT APPLY CAP EXPANSION",
      mode,
      authorizationId: authorization.authorizationId,
      authorizationHash,
      authorizationPath,
      validation: {
        priorLedgerHash: authorization.priorLedgerHash,
        priorLedgerGeneration: authorization.priorLedgerGeneration,
        inventoryRevision: authorization.initialInventoryRevision,
        currentHeadAttempts: ledger.totals.headAttempts,
        currentCap: 21,
        proposedCap: 44,
        normalHeadBudget: 30,
        recoveryHeadBudget: 5,
        childSizes: authorization.children.map((child) => child.keys.length),
        ignored: true,
        untracked: true,
      },
    };
  }

  static async inspectStaleWriterLock(root = resolve(DUKASCOPY_PRODUCTION_ROOT)): Promise<DurableWriterLock> {
    const inspector = new DurableAcquisitionStore(resolve(root), "read-only-lock-inspector");
    const lock = await inspector.readPlain<DurableWriterLock>("writer.lock");
    if (!lock || !Number.isSafeInteger(lock.pid) || lock.pid <= 0 || !/^[a-zA-Z0-9-]{16,80}$/.test(lock.token) || !lock.processStartedAt || !/^[a-f0-9]{64}$/.test(lock.identityHash ?? "")) throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
    const assertDead = () => {
      try {
        process.kill(lock.pid, 0);
        throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
      } catch (error) {
        if (error instanceof AcquisitionSafetyError || (error as NodeJS.ErrnoException).code !== "ESRCH") throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
      }
    };
    assertDead();
    if (processIdentityEvidence(lock.pid)) throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
    assertDead();
    const confirmed = await inspector.readPlain<DurableWriterLock>("writer.lock");
    if (!confirmed || acquisitionHash(confirmed) !== acquisitionHash(lock)) throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
    return lock;
  }

  static async acquire(root = resolve(DUKASCOPY_PRODUCTION_ROOT), options: { staleLockToken?: string; freeBytes?: () => Promise<number>; faultAt?: InventoryCrashBoundary | CapExpansionFaultBoundary } = {}): Promise<DurableAcquisitionStore> {
    const absolute = resolve(root);
    const token = randomUUID();
    const store = new DurableAcquisitionStore(absolute, token, options.freeBytes, options.faultAt);
    await store.ensurePath(absolute, true);
    await mkdir(absolute, { recursive: true, mode: 0o700 });
    await store.ensurePath(absolute);
    for (const folder of ["raw", "journals", "inventories", "progress", "batches", "quarantine", "locks", "head-attempts", "cap-expansions"]) {
      await store.ensurePath(join(absolute, folder), true);
      await mkdir(join(absolute, folder), { mode: 0o700, recursive: true });
    }
    const lockPath = join(absolute, "writer.lock");
    let reclaimedLock: DurableWriterLock | undefined;
    if (options.staleLockToken) {
      const lock = await DurableAcquisitionStore.inspectStaleWriterLock(absolute);
      if (lock.token !== options.staleLockToken) throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
      const confirmed = await store.readPlain<DurableWriterLock>("writer.lock");
      if (!confirmed || confirmed.token !== lock.token || acquisitionHash(confirmed) !== acquisitionHash(lock)) throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
      await rename(lockPath, join(absolute, "locks", `stale-${token}.json`));
      reclaimedLock = lock;
    }
    try {
      const handle = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        const evidence = processIdentityEvidence(process.pid);
        const lock: DurableWriterLock = { version: 2, pid: process.pid, token, createdAt: new Date().toISOString(), processStartedAt: evidence?.processStartedAt, identityHash: evidence?.identityHash };
        await handle.writeFile(JSON.stringify(lock));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await store.syncDirectory(absolute);
    } catch {
      throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
    }
    if (reclaimedLock) {
      try {
        await store.document(`locks/recovery-${token}.json`, { version: 1, previousLock: reclaimedLock, reclaimedAt: new Date().toISOString(), reclaimedByPid: process.pid, reclaimedByIdentity: processIdentityEvidence(process.pid) }, true);
      } catch (error) {
        await store.release();
        throw error;
      }
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

  fault(boundary: InventoryCrashBoundary | CapExpansionFaultBoundary): void {
    if (this.faultAt === boundary) throw new SimulatedInventoryCrash(boundary);
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
    this.fault("G_AFTER_SNAPSHOT");
  }

  async loadInventorySnapshot(plan: FrozenDukascopyPlan, revision: string): Promise<InventorySnapshot> {
    if (!/^[a-f0-9]{64}$/.test(revision)) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
    const snapshot = await this.readDocument<InventorySnapshot>(`inventories/${revision}.json`);
    if (!snapshot || snapshot.revision !== revision) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
    assertInventorySnapshot(plan, snapshot);
    return snapshot;
  }

  async saveInventoryEntry(plan: FrozenDukascopyPlan, approval: AcquisitionApproval, entry: InventoryEntry): Promise<void> {
    await this.document(`progress/${acquisitionHash(`${approval.id}:${entry.key}`)}.json`, { planHash: plan.planHash, approvalHash: acquisitionHash(approval), entry });
    this.fault("F_AFTER_PROGRESS");
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

  private headAttemptEventPath(attemptId: string, state: HeadAttemptState): string {
    if (!/^[a-f0-9-]{36}$/.test(attemptId)) throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
    return `head-attempts/${attemptId}/${state}.json`;
  }

  private async loadHeadAttemptEvents(attemptId: string): Promise<Partial<Record<HeadAttemptState, HeadAttemptJournalEvent>>> {
    const events: Partial<Record<HeadAttemptState, HeadAttemptJournalEvent>> = {};
    for (const state of ["RESERVED", "MAY_HAVE_BEEN_SENT", "CLASSIFIED"] as const) {
      const event = await this.readDocument<HeadAttemptJournalEvent>(this.headAttemptEventPath(attemptId, state));
      if (event) {
        if (event.version !== 1 || event.attemptId !== attemptId || event.state !== state || !Number.isSafeInteger(event.sequence) || event.sequence < 1 || !/^[a-zA-Z0-9_-]{1,80}$/.test(event.approvalId) || !/^[a-f0-9]{64}$/.test(event.approvalHash) || !["INITIAL", "RETRY", "INDETERMINATE_RECOVERY", "CLASSIFIED_ERROR_RETRY"].includes(event.kind))
          throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
        events[state] = event;
      }
    }
    const reserved = events.RESERVED;
    if (!reserved || (events.MAY_HAVE_BEEN_SENT && events.MAY_HAVE_BEEN_SENT.reservedAt !== reserved.reservedAt) || (events.CLASSIFIED && (!events.MAY_HAVE_BEEN_SENT || events.CLASSIFIED.reservedAt !== reserved.reservedAt || !events.CLASSIFIED.classification))) throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
    for (const event of Object.values(events)) {
      if (
        !event ||
        event.attemptId !== reserved.attemptId ||
        event.approvalId !== reserved.approvalId ||
        event.approvalHash !== reserved.approvalHash ||
        event.batchId !== reserved.batchId ||
        event.campaignId !== reserved.campaignId ||
        event.planHash !== reserved.planHash ||
        event.inventoryRevision !== reserved.inventoryRevision ||
        event.key !== reserved.key ||
        event.sequence !== reserved.sequence ||
        event.kind !== reserved.kind ||
        event.predecessorAttemptId !== reserved.predecessorAttemptId ||
        event.retryAuthorizationId !== reserved.retryAuthorizationId ||
        event.retryAuthorizationHash !== reserved.retryAuthorizationHash ||
        event.capRevisionId !== reserved.capRevisionId ||
        event.capRevisionHash !== reserved.capRevisionHash
      )
        throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
    }
    return events;
  }

  async reserveHeadAttempt(plan: FrozenDukascopyPlan, approval: AcquisitionApproval, key: string, sequence: number, kind: HeadAttemptKind): Promise<HeadAttemptJournalEvent> {
    assertFrozenPlan(plan);
    assertExactDukascopyKey(plan, key);
    if (!approval.keys.includes(key) || !Number.isSafeInteger(sequence) || sequence < 1) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
    if (kind === "CLASSIFIED_ERROR_RETRY" || approval.classifiedErrorRetry?.phase === "REPLACEMENT") {
      const ledger = await this.ledger(plan);
      const pool = ledger?.campaignBudgets?.[approval.campaignId!]?.classifiedErrorRetry;
      if (kind !== "CLASSIFIED_ERROR_RETRY" || sequence !== 2 || key !== "USDJPY/2021/00/08_ticks.bi5" || !approval.classifiedErrorRetry || !ledger || !pool || pool.stage !== "RETRY_IN_PROGRESS" || pool.consumed !== 0 || pool.replacementApprovalId !== approval.id || pool.replacementApprovalHash !== acquisitionHash(approval))
        throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
      await this.validateTask116RetryExecutionApproval(plan, approval, await this.loadInventorySnapshot(plan, approval.inventoryRevision!));
    }
    const attemptId = randomUUID();
    const event: HeadAttemptJournalEvent = { version: 1, attemptId, state: "RESERVED", kind, approvalId: approval.id, approvalHash: acquisitionHash(approval), campaignId: approval.campaignId ?? null, batchId: approval.batchId, planHash: plan.planHash, inventoryRevision: approval.inventoryRevision, key, sequence, reservedAt: new Date().toISOString() };
    if (approval.classifiedErrorRetry) {
      const metadata = approval.classifiedErrorRetry;
      event.capRevisionId = metadata.capRevisionId;
      event.capRevisionHash = metadata.capRevisionHash;
      if (kind === "CLASSIFIED_ERROR_RETRY") {
        const authorization = await this.preparedRetryAuthorization(plan, metadata.authorizationId, metadata.authorizationHash);
        event.predecessorAttemptId = authorization.failedAttemptId;
        event.retryAuthorizationId = metadata.authorizationId;
        event.retryAuthorizationHash = metadata.authorizationHash;
      }
    }
    const attemptDirectory = this.path(`head-attempts/${attemptId}`);
    await this.ensurePath(dirname(attemptDirectory));
    await mkdir(attemptDirectory, { mode: 0o700 });
    await this.syncDirectory(dirname(attemptDirectory));
    this.fault("A_AFTER_ATTEMPT_DIRECTORY");
    await this.document(this.headAttemptEventPath(attemptId, "RESERVED"), event, true);
    return event;
  }

  async markHeadAttemptMayHaveBeenSent(attemptId: string): Promise<HeadAttemptJournalEvent> {
    const events = await this.loadHeadAttemptEvents(attemptId);
    if (!events.RESERVED || events.MAY_HAVE_BEEN_SENT || events.CLASSIFIED) throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
    const event: HeadAttemptJournalEvent = { ...events.RESERVED, state: "MAY_HAVE_BEEN_SENT", mayHaveBeenSentAt: new Date().toISOString() };
    await this.document(this.headAttemptEventPath(attemptId, "MAY_HAVE_BEEN_SENT"), event, true);
    return event;
  }

  async classifyHeadAttempt(plan: FrozenDukascopyPlan, attemptId: string, entry: InventoryEntry): Promise<HeadAttemptJournalEvent> {
    const events = await this.loadHeadAttemptEvents(attemptId);
    if (!events.RESERVED || !events.MAY_HAVE_BEEN_SENT || events.CLASSIFIED || entry.key !== events.RESERVED.key) throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
    const entries = [...createInventorySnapshot(plan, []).entries];
    entries[plan.keys.indexOf(entry.key)] = entry;
    const candidate = createInventorySnapshot(plan, entries);
    const classification = candidate.entries[plan.keys.indexOf(entry.key)];
    const event: HeadAttemptJournalEvent = { ...events.RESERVED, state: "CLASSIFIED", mayHaveBeenSentAt: events.MAY_HAVE_BEEN_SENT.mayHaveBeenSentAt, classifiedAt: new Date().toISOString(), classification };
    await this.document(this.headAttemptEventPath(attemptId, "CLASSIFIED"), event, true);
    return event;
  }

  async headAttemptJournal(): Promise<HeadAttemptJournalEvent[]> {
    const directory = this.path("head-attempts");
    await this.ensurePath(directory);
    const attempts: HeadAttemptJournalEvent[] = [];
    for (const item of await readdir(directory, { withFileTypes: true })) {
      if (!item.isDirectory() || !/^[a-f0-9-]{36}$/.test(item.name)) throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
      const attemptPath = this.path(`head-attempts/${item.name}`);
      const names = await readdir(attemptPath);
      if (names.length === 0 || names.every((name) => /^RESERVED\.json\.[a-f0-9-]{36}\.tmp$/.test(name))) continue;
      const events = await this.loadHeadAttemptEvents(item.name);
      attempts.push(events.CLASSIFIED ?? events.MAY_HAVE_BEEN_SENT ?? events.RESERVED!);
    }
    return attempts.sort((left, right) => left.key.localeCompare(right.key) || left.sequence - right.sequence || left.attemptId.localeCompare(right.attemptId));
  }

  private accountHeadReservation(plan: FrozenDukascopyPlan, approval: AcquisitionApproval, ledger: AcquisitionLedger, event: HeadAttemptJournalEvent): void {
    ledger.headAttemptAccounting ??= {};
    ledger.campaignHeadAttempts ??= {};
    const existing = ledger.headAttemptAccounting[event.attemptId];
    const expected: HeadAttemptAccounting = { approvalId: event.approvalId, key: event.key, sequence: event.sequence, kind: event.kind, campaignId: event.campaignId };
    for (const field of ["predecessorAttemptId", "retryAuthorizationId", "retryAuthorizationHash", "capRevisionId", "capRevisionHash"] as const) if (event[field]) expected[field] = event[field];
    if (existing) {
      if (
        existing.approvalId !== expected.approvalId ||
        existing.key !== expected.key ||
        existing.sequence !== expected.sequence ||
        existing.kind !== expected.kind ||
        existing.campaignId !== expected.campaignId ||
        ["predecessorAttemptId", "retryAuthorizationId", "retryAuthorizationHash", "capRevisionId", "capRevisionHash"].some((field) => existing[field as keyof HeadAttemptAccounting] !== expected[field as keyof HeadAttemptAccounting])
      )
        throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
      return;
    }
    if (event.approvalId !== approval.id || event.approvalHash !== acquisitionHash(approval) || event.planHash !== plan.planHash || event.campaignId !== (approval.campaignId ?? null)) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
    const identity = `HEAD:${event.key}`;
    const previous = ledger.attempts[identity] ?? 0;
    if (event.sequence !== previous + 1 || event.sequence > 3) throw new AcquisitionSafetyError("CAP_EXCEEDED");
    const context = ledger.contexts[approval.id]?.counters;
    if (!context) throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
    const retries = Math.min(3, approval.caps.maxRetries + 1, ledger.globalCaps.maxRetries + 1);
    if ((event.kind === "INITIAL" && event.sequence !== 1) || (event.kind === "RETRY" && (event.sequence < 2 || event.sequence > retries))) throw new AcquisitionSafetyError("CAP_EXCEEDED");
    let campaign: CampaignBudgetLedger | undefined;
    if (event.campaignId) {
      campaign = ledger.campaignBudgets?.[event.campaignId];
      if (!campaign || campaign.status !== "ACTIVE") throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
      if (event.kind === "INDETERMINATE_RECOVERY") {
        if (campaign.recoveryHeadAttempts >= campaign.recoveryHeadBudget) throw new AcquisitionSafetyError("CAP_EXCEEDED");
      } else if (event.kind === "CLASSIFIED_ERROR_RETRY") {
        const pool = campaign.classifiedErrorRetry;
        if (!pool || pool.consumed !== 0 || pool.stage !== "RETRY_IN_PROGRESS" || event.sequence !== 2 || event.key !== "USDJPY/2021/00/08_ticks.bi5" || event.retryAuthorizationId !== pool.authorizationId || event.retryAuthorizationHash !== pool.authorizationHash || event.predecessorAttemptId === undefined || event.approvalId !== pool.replacementApprovalId)
          throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
      } else if (campaign.normalHeadAttempts >= campaign.normalHeadBudget) throw new AcquisitionSafetyError("CAP_EXCEEDED");
    }
    if (event.kind === "INDETERMINATE_RECOVERY") {
      const allowance = approval.recoveryAllowance?.maxIndeterminateHeadRetries ?? 0;
      context.recoveryHeadAttempts ??= 0;
      if (!allowance || context.recoveryHeadAttempts >= allowance || event.sequence < 2) throw new AcquisitionSafetyError("INDETERMINATE");
    }
    if (ledger.totals.headAttempts + 1 > ledger.globalCaps.maxHeadAttempts || context.headAttempts + 1 > approval.caps.maxHeadAttempts) throw new AcquisitionSafetyError("CAP_EXCEEDED");
    ledger.attempts[identity] = event.sequence;
    ledger.totals.headAttempts++;
    context.headAttempts++;
    if (event.sequence > 1) {
      ledger.totals.retryCount++;
      context.retryCount++;
    }
    if (event.kind === "INDETERMINATE_RECOVERY") {
      ledger.totals.recoveryHeadAttempts = (ledger.totals.recoveryHeadAttempts ?? 0) + 1;
      context.recoveryHeadAttempts = (context.recoveryHeadAttempts ?? 0) + 1;
      if (campaign) campaign.recoveryHeadAttempts++;
    } else if (event.kind === "CLASSIFIED_ERROR_RETRY" && campaign) {
      const pool = campaign.classifiedErrorRetry!;
      pool.consumed = 1;
      pool.replacementAttemptId = event.attemptId;
      ledger.totals.classifiedErrorRetryAttempts = (ledger.totals.classifiedErrorRetryAttempts ?? 0) + 1;
      context.classifiedErrorRetryAttempts = (context.classifiedErrorRetryAttempts ?? 0) + 1;
    } else if (campaign) {
      campaign.normalHeadAttempts++;
    }
    if (event.campaignId) ledger.campaignHeadAttempts[event.campaignId] = (ledger.campaignHeadAttempts[event.campaignId] ?? 0) + 1;
    ledger.headAttemptAccounting[event.attemptId] = expected;
  }

  private settleHeadClassification(ledger: AcquisitionLedger, event: HeadAttemptJournalEvent): void {
    if (!event.classification) throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
    const accounting = ledger.headAttemptAccounting?.[event.attemptId];
    if (!accounting) throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
    const classificationHash = acquisitionHash(event.classification);
    if (accounting.classificationHash && accounting.classificationHash !== classificationHash) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
    if (ledger.active?.attemptId === event.attemptId) ledger.active = null;
    if (accounting.settled) return;
    accounting.classificationHash = classificationHash;
    accounting.settled = true;
    const legacy = ledger.legacyIndeterminateHeadKeys?.[event.key];
    if (legacy?.recoveredByAttemptId === event.attemptId) delete ledger.legacyIndeterminateHeadKeys![event.key];
    if (event.classification.status !== "PRESENT") {
      const context = ledger.contexts[event.approvalId]?.counters;
      if (!context) throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
      ledger.totals.failedAttempts++;
      context.failedAttempts++;
      const campaign = event.campaignId ? ledger.campaignBudgets?.[event.campaignId] : undefined;
      if (campaign && !["CONFIRMED_ABSENT"].includes(event.classification.status)) {
        campaign.status = "STOPPED";
        campaign.stopReason = "ERROR";
        const child = ledger.approvalBindings?.[event.approvalId]?.classifiedErrorRetry ? campaign.children[0] : campaign.children.find((candidate) => candidate.approvalId === event.approvalId);
        if (child) {
          child.status = "STOPPED";
          child.stopReason = "ERROR";
        }
      }
    }
  }

  async reconcileHeadAttempts(plan: FrozenDukascopyPlan, approval: AcquisitionApproval, snapshot?: InventorySnapshot): Promise<void> {
    if (snapshot) {
      assertInventorySnapshot(plan, snapshot);
      if (snapshot.revision !== approval.inventoryRevision) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
    }
    const ledger = await this.ledger(plan);
    if (!ledger || !ledger.contexts[approval.id]) throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
    ledger.headAttemptAccounting ??= {};
    ledger.campaignHeadAttempts ??= {};
    const events = await this.headAttemptJournal();
    const recoveryCount = events.filter((event) => event.approvalId === approval.id && event.kind === "INDETERMINATE_RECOVERY").length;
    const approvalContext = ledger.contexts[approval.id];
    if (!approvalContext) throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
    const progress = await this.loadInventoryProgress(plan, approval);
    let merged = mergeInventoryProgress(plan, snapshot ?? createInventorySnapshot(plan, []), progress);
    const journalCounts = new Map<string, number>();
    for (const event of events) journalCounts.set(event.key, (journalCounts.get(event.key) ?? 0) + 1);
    merged = this.migrateUnjournaledV1Attempts(approval, ledger, merged, progress, journalCounts);
    for (const event of events) {
      const eventApproval = event.approvalId === approval.id ? approval : ledger.approvalBindings?.[event.approvalId];
      if (!eventApproval || event.approvalHash !== acquisitionHash(eventApproval) || event.planHash !== plan.planHash || event.inventoryRevision !== eventApproval.inventoryRevision) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
      await this.assertAttemptCapRevision(plan, ledger, eventApproval, event);
      assertApproval(plan, eventApproval, "INVENTORY", eventApproval.inventoryRevision, 0);
      if (!eventApproval.keys.includes(event.key)) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
      const isCurrentApproval = event.approvalId === approval.id;
      this.accountHeadReservation(plan, eventApproval, ledger, event);
      if (event.state === "CLASSIFIED") {
        const classification = event.classification!;
        if (isCurrentApproval) {
          merged = mergeInventoryProgress(plan, merged, [classification]);
          const currentProgress = progress.find((entry) => entry.key === event.key);
          const seedEntry = snapshot?.entries[plan.keys.indexOf(event.key)];
          const reconciledEntry = merged.entries[plan.keys.indexOf(event.key)];
          if ((!seedEntry || !["PRESENT", "CONFIRMED_ABSENT"].includes(seedEntry.status)) && acquisitionHash(currentProgress ?? null) !== acquisitionHash(reconciledEntry)) await this.saveInventoryEntry(plan, approval, reconciledEntry);
        } else if (approval.keys.includes(event.key) && ["PRESENT", "CONFIRMED_ABSENT"].includes(classification.status)) {
          const currentEntry = merged.entries[plan.keys.indexOf(event.key)];
          if (currentEntry.status !== classification.status || acquisitionHash(currentEntry.metadata) !== acquisitionHash(classification.metadata)) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
        }
        this.settleHeadClassification(ledger, event);
      } else if (event.state === "RESERVED" && event.attemptId === ledger.active?.attemptId) {
        ledger.active = null;
      } else if (event.state === "MAY_HAVE_BEEN_SENT" && event.attemptId === ledger.active?.attemptId) {
        ledger.active = null;
      }
    }
    if (ledger.active?.operation === "HEAD" && ledger.active.attemptId) {
      const active = events.find((event) => event.attemptId === ledger.active?.attemptId);
      if (!active) throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
    }
    approvalContext.counters.recoveryHeadAttempts = Math.max(approvalContext.counters.recoveryHeadAttempts ?? 0, recoveryCount);
    await this.document("ledger.json", ledger);
  }

  private migrateUnjournaledV1Attempts(approval: AcquisitionApproval, ledger: AcquisitionLedger, snapshot: InventorySnapshot, progress: readonly InventoryEntry[], journalCounts: ReadonlyMap<string, number>): InventorySnapshot {
    ledger.legacyIndeterminateHeadKeys ??= {};
    const migrated = snapshot;
    for (const key of approval.keys) {
      const existing = ledger.legacyIndeterminateHeadKeys[key];
      if (existing) continue;
      const entry = migrated.entries[migrated.keys.indexOf(key)];
      const resultSaved = progress.some((candidate) => candidate.key === key) || entry.status === "PRESENT" || entry.status === "CONFIRMED_ABSENT";
      const unjournaledAttempts = (ledger.attempts[`HEAD:${key}`] ?? 0) - (journalCounts.get(key) ?? 0);
      if (unjournaledAttempts > 0 && !resultSaved) ledger.legacyIndeterminateHeadKeys[key] = { approvalId: ledger.approvalId, batchId: ledger.batchId, sequence: ledger.attempts[`HEAD:${key}`] };
    }
    return migrated;
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
    if (ledger.headAttemptJournalVersion !== undefined && ledger.headAttemptJournalVersion !== 1) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
    if (ledger.ledgerGeneration !== undefined && (!Number.isSafeInteger(ledger.ledgerGeneration) || ledger.ledgerGeneration < 0)) throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
    if (ledger.appliedCapExpansionIds !== undefined && (!Array.isArray(ledger.appliedCapExpansionIds) || new Set(ledger.appliedCapExpansionIds).size !== ledger.appliedCapExpansionIds.length || ledger.appliedCapExpansionIds.some((id) => !/^[a-zA-Z0-9_-]{1,80}$/.test(id)))) throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
    for (const count of [ledger.totals, ...Object.values(ledger.contexts).map((context) => context.counters)]) {
      if (!count || !Array.isArray(count.objects) || new Set(count.objects).size !== count.objects.length) throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
      for (const field of ["headAttempts", "getAttempts", "successfulGets", "failedAttempts", "receivedBytes", "reservedBytes", "verifiedBytes", "retryCount"] as const) if (!Number.isSafeInteger(count[field]) || count[field] < 0) throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
      if (count.recoveryHeadAttempts !== undefined && (!Number.isSafeInteger(count.recoveryHeadAttempts) || count.recoveryHeadAttempts < 0 || count.recoveryHeadAttempts > count.headAttempts)) throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
      if (count.classifiedErrorRetryAttempts !== undefined && (!Number.isSafeInteger(count.classifiedErrorRetryAttempts) || count.classifiedErrorRetryAttempts < 0 || count.classifiedErrorRetryAttempts > count.headAttempts)) throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
      for (const key of count.objects) assertExactDukascopyKey(plan, key);
    }
    if (ledger.headAttemptAccounting !== undefined) {
      if (!ledger.headAttemptAccounting || Object.keys(ledger.headAttemptAccounting).length > ledger.totals.headAttempts) throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
      for (const [attemptId, accounting] of Object.entries(ledger.headAttemptAccounting)) {
        if (
          !/^[a-f0-9-]{36}$/.test(attemptId) ||
          !/^[a-zA-Z0-9_-]{1,80}$/.test(accounting.approvalId) ||
          !Number.isSafeInteger(accounting.sequence) ||
          accounting.sequence < 1 ||
          accounting.sequence > 3 ||
          !["INITIAL", "RETRY", "INDETERMINATE_RECOVERY", "CLASSIFIED_ERROR_RETRY"].includes(accounting.kind) ||
          (accounting.campaignId !== null && !/^[a-zA-Z0-9_-]{1,80}$/.test(accounting.campaignId)) ||
          (accounting.classificationHash !== undefined && !/^[a-f0-9]{64}$/.test(accounting.classificationHash)) ||
          (accounting.settled !== undefined && typeof accounting.settled !== "boolean")
        )
          throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
        assertExactDukascopyKey(plan, accounting.key);
      }
    }
    if (ledger.approvalBindings !== undefined) {
      if (!ledger.approvalBindings || Object.keys(ledger.approvalBindings).length > Object.keys(ledger.contexts).length) throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
      for (const [id, binding] of Object.entries(ledger.approvalBindings)) {
        if (binding.id !== id || ledger.contexts[id]?.bindingHash !== acquisitionHash(binding)) throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
        assertApproval(plan, binding, binding.operation, binding.inventoryRevision, 0);
      }
    }
    if (ledger.campaignHeadAttempts !== undefined) {
      if (!ledger.campaignHeadAttempts || Object.entries(ledger.campaignHeadAttempts).some(([campaignId, count]) => !/^[a-zA-Z0-9_-]{1,80}$/.test(campaignId) || !Number.isSafeInteger(count) || count < 0) || Object.values(ledger.campaignHeadAttempts).reduce((sum, count) => sum + count, 0) > ledger.totals.headAttempts)
        throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
    }
    if (ledger.legacyIndeterminateHeadKeys !== undefined) {
      if (!ledger.legacyIndeterminateHeadKeys) throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
      for (const [key, marker] of Object.entries(ledger.legacyIndeterminateHeadKeys)) {
        assertExactDukascopyKey(plan, key);
        if (!/^[a-zA-Z0-9_-]{1,80}$/.test(marker.approvalId) || !/^[a-zA-Z0-9_-]{1,80}$/.test(marker.batchId) || !Number.isSafeInteger(marker.sequence) || marker.sequence < 1 || marker.sequence > (ledger.attempts[`HEAD:${key}`] ?? 0) || (marker.recoveredByAttemptId !== undefined && !/^[a-f0-9-]{36}$/.test(marker.recoveredByAttemptId)))
          throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
      }
    }
    if (ledger.campaignBudgets !== undefined) {
      if (!ledger.campaignBudgets) throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
      const expectedChildren = buildTask116CampaignChildren(plan);
      for (const [campaignId, campaign] of Object.entries(ledger.campaignBudgets)) {
        if (
          campaign.campaignId !== campaignId ||
          !ledger.appliedCapExpansionIds?.includes(campaign.authorizationId) ||
          !/^[a-f0-9]{64}$/.test(campaign.authorizationHash) ||
          !Number.isSafeInteger(campaign.normalHeadBudget) ||
          !Number.isSafeInteger(campaign.recoveryHeadBudget) ||
          !Number.isSafeInteger(campaign.normalHeadAttempts) ||
          !Number.isSafeInteger(campaign.recoveryHeadAttempts) ||
          campaign.normalHeadAttempts < 0 ||
          campaign.normalHeadAttempts > campaign.normalHeadBudget ||
          campaign.recoveryHeadAttempts < 0 ||
          campaign.recoveryHeadAttempts > campaign.recoveryHeadBudget ||
          !["ACTIVE", "STOPPED", "COMPLETED"].includes(campaign.status) ||
          !Number.isSafeInteger(campaign.currentChildSequence) ||
          !/^[a-f0-9]{64}$/.test(campaign.currentInventoryRevision) ||
          campaign.children.length !== 5
        )
          throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
        for (let index = 0; index < campaign.children.length; index++) {
          const child = campaign.children[index];
          const expected = expectedChildren[index];
          if (
            child.sequence !== expected.sequence ||
            child.batchId !== expected.batchId ||
            child.batchStart !== expected.batchStart ||
            child.batchEnd !== expected.batchEnd ||
            acquisitionHash(child.keys) !== acquisitionHash(expected.keys) ||
            child.recoveryAllowance !== expected.recoveryAllowance ||
            !["PENDING", "IN_PROGRESS", "COMPLETED", "STOPPED"].includes(child.status)
          )
            throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
          for (const key of child.keys) assertExactDukascopyKey(plan, key);
          if (child.approvalId && !/^[a-zA-Z0-9_-]{1,80}$/.test(child.approvalId)) throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
          if (child.approvalHash && !/^[a-f0-9]{64}$/.test(child.approvalHash)) throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
          if (child.outputRevision && !/^[a-f0-9]{64}$/.test(child.outputRevision)) throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
        }
      }
    }
    for (const [identity, count] of Object.entries(ledger.attempts)) {
      if (!/^(HEAD|GET):/.test(identity) || !Number.isSafeInteger(count) || count < 1 || count > 3) throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
      assertExactDukascopyKey(plan, identity.slice(identity.indexOf(":") + 1));
    }
    for (const record of Object.values(ledger.verified)) if (!Number.isSafeInteger(record.bytes) || record.bytes < 0 || !/^[a-f0-9]{64}$/.test(record.sha256)) throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
    if (ledger.retryCapRevision) await this.assertRetryCapRevision(plan, ledger);
    else if (ledger.campaignBudgets?.[TASK116_CAMPAIGN_ID] && ledger.globalCaps.maxHeadAttempts !== 44) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
    for (const campaign of Object.values(ledger.campaignBudgets ?? {}))
      if (campaign.classifiedErrorRetry) {
        const pool = campaign.classifiedErrorRetry;
        if (
          pool.allocation !== 1 ||
          !Number.isSafeInteger(pool.consumed) ||
          pool.consumed < 0 ||
          pool.consumed > 1 ||
          !["RETRY_AUTHORIZED", "RETRY_IN_PROGRESS", "ACTIVE_CONTINUATION", "STOPPED", "COMPLETED"].includes(pool.stage) ||
          pool.authorizationId !== ledger.retryCapRevision?.authorizationId ||
          pool.authorizationHash !== ledger.retryCapRevision?.authorizationHash
        )
          throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
      }
    return ledger;
  }

  async applyTask116CampaignCapExpansion(plan: FrozenDukascopyPlan, authorization?: CampaignCapExpansionAuthorization): Promise<CapExpansionResult> {
    if (!authorization) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
    const ledger = await this.ledger(plan);
    if (!ledger) throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
    const evidencePath = `cap-expansions/${authorization.authorizationId}.json`;
    const existingEvidence = await this.readDocument<CampaignCapExpansionAuthorization>(evidencePath);
    if (!existingEvidence || acquisitionHash(existingEvidence) !== acquisitionHash(authorization)) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
    const alreadyApplied = ledger.appliedCapExpansionIds?.includes(authorization.authorizationId) ?? false;
    if (alreadyApplied) {
      const campaign = ledger.campaignBudgets?.[authorization.campaignId];
      if (!existingEvidence || acquisitionHash(ledger.globalCaps) !== acquisitionHash(authorization.newGlobalCaps) || ledger.ledgerGeneration !== authorization.priorLedgerGeneration + 1 || !campaign || campaign.authorizationHash !== acquisitionHash(authorization)) throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
      return "ALREADY_APPLIED";
    }
    assertTask116CampaignCapExpansion(plan, ledger, authorization);
    if (ledger.campaignBudgets?.[authorization.campaignId]) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
    const initialSnapshot = await this.loadInventorySnapshot(plan, authorization.initialInventoryRevision);
    this.fault("CAP_AFTER_AUTHORIZATION_EVIDENCE");
    const current = (await this.ledger(plan))!;
    if (acquisitionHash(current) !== authorization.priorLedgerHash || (current.ledgerGeneration ?? 0) !== authorization.priorLedgerGeneration || acquisitionHash(current.globalCaps) !== acquisitionHash(authorization.oldGlobalCaps)) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
    const campaign: CampaignBudgetLedger = {
      authorizationId: authorization.authorizationId,
      authorizationHash: acquisitionHash(authorization),
      campaignId: authorization.campaignId,
      normalHeadBudget: authorization.normalHeadBudget,
      recoveryHeadBudget: authorization.recoveryHeadBudget,
      normalHeadAttempts: 0,
      recoveryHeadAttempts: 0,
      status: "ACTIVE",
      currentChildSequence: 1,
      currentInventoryRevision: initialSnapshot.revision,
      children: authorization.children.map((child) => ({ ...child, keys: [...child.keys], status: "PENDING" })),
    };
    current.globalCaps = { ...authorization.newGlobalCaps };
    current.ledgerGeneration = authorization.priorLedgerGeneration + 1;
    current.appliedCapExpansionIds ??= [];
    current.appliedCapExpansionIds.push(authorization.authorizationId);
    current.campaignBudgets ??= {};
    current.campaignBudgets[authorization.campaignId] = campaign;
    await this.document("ledger.json", current);
    this.fault("CAP_AFTER_LEDGER_COMMIT");
    return "APPLIED";
  }

  private async assertCampaignCapEvidence(plan: FrozenDukascopyPlan, ledger: AcquisitionLedger, campaignId: string): Promise<void> {
    const campaign = ledger.campaignBudgets?.[campaignId];
    if (!campaign) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
    const authorization = await this.readDocument<CampaignCapExpansionAuthorization>(`cap-expansions/${campaign.authorizationId}.json`);
    if (ledger.retryCapRevision) await this.assertRetryCapRevision(plan, ledger);
    if (
      !authorization ||
      acquisitionHash(authorization) !== campaign.authorizationHash ||
      authorization.authorizationId !== campaign.authorizationId ||
      authorization.campaignId !== campaignId ||
      authorization.masterPlanHash !== plan.planHash ||
      acquisitionHash(authorization.newGlobalCaps) !== acquisitionHash(ledger.retryCapRevision ? (await this.assertRetryCapRevision(plan, ledger)).oldGlobalCaps : ledger.globalCaps) ||
      !ledger.appliedCapExpansionIds?.includes(authorization.authorizationId) ||
      (ledger.ledgerGeneration ?? 0) < authorization.priorLedgerGeneration + 1 ||
      campaign.normalHeadBudget !== authorization.normalHeadBudget ||
      campaign.recoveryHeadBudget !== authorization.recoveryHeadBudget ||
      campaign.children.length !== authorization.children.length
    )
      throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
    for (let index = 0; index < campaign.children.length; index++) {
      const child = campaign.children[index];
      const authorized = authorization.children[index];
      if (child.sequence !== authorized.sequence || child.batchId !== authorized.batchId || child.batchStart !== authorized.batchStart || child.batchEnd !== authorized.batchEnd || child.recoveryAllowance !== authorized.recoveryAllowance || acquisitionHash(child.keys) !== acquisitionHash(authorized.keys))
        throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
    }
  }

  private validateCampaignChild(approval: AcquisitionApproval, snapshot: InventorySnapshot | undefined, ledger: AcquisitionLedger): CampaignChildLedgerState | undefined {
    if (!approval.campaignId) return undefined;
    const campaign = ledger.campaignBudgets?.[approval.campaignId];
    if (!campaign || campaign.status !== "ACTIVE") throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
    const child = campaign.children[campaign.currentChildSequence - 1];
    if (!child || child.status === "COMPLETED" || child.status === "STOPPED" || child.sequence !== campaign.currentChildSequence) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
    if (
      approval.batchId !== child.batchId ||
      approval.operation !== "INVENTORY" ||
      acquisitionHash(approval.globalCaps) !== acquisitionHash(ledger.globalCaps) ||
      approval.batchStart !== child.batchStart ||
      approval.batchEnd !== child.batchEnd ||
      acquisitionHash(approval.keys) !== acquisitionHash(child.keys) ||
      approval.inventoryRevision !== campaign.currentInventoryRevision ||
      snapshot?.revision !== campaign.currentInventoryRevision ||
      approval.caps.maxObjects !== child.keys.length ||
      approval.caps.maxHeadAttempts !== child.keys.length + (approval.recoveryAllowance?.maxIndeterminateHeadRetries ?? 0) ||
      approval.recoveryAllowance?.maxIndeterminateHeadRetries !== child.recoveryAllowance ||
      approval.caps.maxRetries !== 0 ||
      approval.caps.maxGetAttempts !== 0 ||
      approval.caps.maxNetworkBytes !== 0 ||
      approval.caps.maxVerifiedBytes !== 0 ||
      approval.globalCaps.maxGetAttempts !== 0 ||
      approval.globalCaps.maxNetworkBytes !== 0 ||
      approval.globalCaps.maxVerifiedBytes !== 0
    )
      throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
    const bindingHash = acquisitionHash(approval);
    if (child.status === "IN_PROGRESS" && (child.approvalId !== approval.id || child.approvalHash !== bindingHash)) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
    return child;
  }

  private async assertPreparedCampaignChildApproval(plan: FrozenDukascopyPlan, approval: AcquisitionApproval, snapshot: InventorySnapshot | undefined, ledger: AcquisitionLedger): Promise<void> {
    const child = this.validateCampaignChild(approval, snapshot, ledger);
    const binding = approval.campaignPreparation;
    const campaign = approval.campaignId ? ledger.campaignBudgets?.[approval.campaignId] : undefined;
    if (
      !child ||
      !binding ||
      !campaign ||
      binding.childSequence !== child.sequence ||
      binding.priorLedgerGeneration !== (ledger.ledgerGeneration ?? 0) ||
      binding.capAuthorizationId !== campaign.authorizationId ||
      binding.capAuthorizationHash !== campaign.authorizationHash ||
      binding.childDescriptorHash !== acquisitionHash(buildTask116CampaignChildren(plan)[child.sequence - 1])
    )
      throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
    const prepared = await this.readDocument<AcquisitionApproval>(`child-approvals/${approval.id}.json`);
    if (!prepared || acquisitionHash(prepared) !== acquisitionHash(approval) || (child.status === "PENDING" && binding.priorLedgerHash !== acquisitionHash(ledger))) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
  }

  private bindCampaignChild(approval: AcquisitionApproval, snapshot: InventorySnapshot | undefined, ledger: AcquisitionLedger): void {
    const child = this.validateCampaignChild(approval, snapshot, ledger);
    if (!child) return;
    child.status = "IN_PROGRESS";
    child.approvalId = approval.id;
    child.approvalHash = acquisitionHash(approval);
  }

  async completeCampaignChild(plan: FrozenDukascopyPlan, approval: AcquisitionApproval, snapshot: InventorySnapshot): Promise<void> {
    if (approval.classifiedErrorRetry) {
      assertInventorySnapshot(plan, snapshot);
      await this.completeRetryExecution(plan, approval, snapshot);
      return;
    }
    if (!approval.campaignId) return;
    assertInventorySnapshot(plan, snapshot);
    if (approval.inventoryRevision === null) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
    const seed = await this.loadInventorySnapshot(plan, approval.inventoryRevision);
    const ledger = await this.ledger(plan);
    const campaign = ledger?.campaignBudgets?.[approval.campaignId];
    if (!ledger || !campaign) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
    const child = campaign.children[campaign.currentChildSequence - 1];
    if (!child || child.approvalId !== approval.id || child.approvalHash !== acquisitionHash(approval) || approval.inventoryRevision !== campaign.currentInventoryRevision) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
    if (campaign.status === "STOPPED" && child.status === "STOPPED") {
      child.outputRevision = snapshot.revision;
      await this.document("ledger.json", ledger);
      return;
    }
    if (campaign.status !== "ACTIVE" || child.status !== "IN_PROGRESS") throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
    const selected = child.keys.map((key) => snapshot.entries[plan.keys.indexOf(key)]);
    for (const key of plan.keys) {
      if (!child.keys.includes(key) && acquisitionHash(snapshot.entries[plan.keys.indexOf(key)]) !== acquisitionHash(seed.entries[plan.keys.indexOf(key)])) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
    }
    const complete = selected.every((entry) => entry.status === "PRESENT" || entry.status === "CONFIRMED_ABSENT");
    child.outputRevision = snapshot.revision;
    if (!complete) {
      child.status = "STOPPED";
      campaign.status = "STOPPED";
      child.stopReason = selected.some((entry) => entry.status === "ERROR" || entry.status === "AMBIGUOUS_ACCESS") ? "ERROR" : "INDETERMINATE";
      campaign.stopReason = child.stopReason;
    } else {
      child.status = "COMPLETED";
      campaign.currentInventoryRevision = snapshot.revision;
      campaign.currentChildSequence++;
      if (campaign.currentChildSequence > campaign.children.length) campaign.status = "COMPLETED";
    }
    await this.document("ledger.json", ledger);
  }

  async gate(plan: FrozenDukascopyPlan, suppliedApproval: AcquisitionApproval, snapshot?: InventorySnapshot): Promise<AcquisitionRequestGate> {
    const gateWasInitialized = this.gateInitialized;
    const approval = JSON.parse(JSON.stringify(suppliedApproval)) as AcquisitionApproval;
    assertApproval(plan, approval, approval.operation, approval.inventoryRevision);
    if (approval.operation === "INVENTORY" && approval.inventoryRevision !== null && !snapshot) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
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
    if (approval.operation === "INVENTORY" && approval.campaignId) {
      await this.assertCampaignCapEvidence(plan, ledger, approval.campaignId);
      if (approval.classifiedErrorRetry) await this.bindRetryExecution(plan, approval, snapshot!, ledger);
      else await this.assertPreparedCampaignChildApproval(plan, approval, snapshot, ledger);
    }
    if (approval.operation === "INVENTORY" && !approval.classifiedErrorRetry) this.bindCampaignChild(approval, snapshot, ledger);
    if (ledger.active?.operation === "HEAD" && !ledger.active.attemptId) {
      const key = ledger.active.key;
      const sequence = ledger.attempts[`HEAD:${key}`] ?? 0;
      if (!sequence) throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
      ledger.legacyIndeterminateHeadKeys ??= {};
      ledger.legacyIndeterminateHeadKeys[key] ??= { approvalId: ledger.active.approvalId, batchId: ledger.batchId, sequence };
      ledger.active = null;
    }
    const bindingHash = acquisitionHash(approval);
    if (Object.hasOwn(ledger.contexts, approval.id) && ledger.contexts[approval.id].bindingHash !== bindingHash) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
    ledger.contexts[approval.id] ??= { bindingHash, counters: counters() };
    ledger.approvalBindings ??= {};
    if (ledger.approvalBindings[approval.id] && acquisitionHash(ledger.approvalBindings[approval.id]) !== bindingHash) throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
    ledger.approvalBindings[approval.id] ??= approval;
    ledger.headAttemptJournalVersion = 1;
    this.gateInitialized = true;
    ledger.approvalId = approval.id;
    ledger.batchId = approval.batchId;
    if (approval.operation === "DOWNLOAD") ledger.inventoryRevision = approval.inventoryRevision;
    await this.document("ledger.json", ledger);
    if (approval.operation === "INVENTORY") await this.reconcileHeadAttempts(plan, approval, snapshot);
    ledger = (await this.ledger(plan))!;
    if (ledger.active) {
      if (gateWasInitialized) throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
      if (ledger.active.operation === "HEAD") throw new AcquisitionSafetyError("INDETERMINATE");
      ledger.totals.failedAttempts++;
      const previous = ledger.contexts[ledger.active.approvalId];
      if (!previous) throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
      previous.counters.failedAttempts++;
      ledger.active = null;
      await this.document("ledger.json", ledger);
    }
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
      fault: (boundary) => this.fault(boundary),
      markHeadMayHaveBeenSent: (attemptId) =>
        serial(async () => {
          const active = current.active;
          if (active?.operation !== "HEAD" || active.attemptId !== attemptId || active.approvalId !== approval.id) throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
          await this.markHeadAttemptMayHaveBeenSent(attemptId);
          this.fault("C_AFTER_MAY_HAVE_BEEN_SENT");
        }),
      classifyHead: (attemptId, entry) =>
        serial(async () => {
          const active = current.active;
          if (active?.operation !== "HEAD" || active.attemptId !== attemptId || active.approvalId !== approval.id) throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
          await this.classifyHeadAttempt(plan, attemptId, entry);
          this.fault("E_AFTER_CLASSIFIED");
        }),
      before: (operation, key, bytes) =>
        serial(async () => {
          assertScope(operation, key);
          if (operation === "HEAD") {
            const seed = snapshot ?? createInventorySnapshot(plan, []);
            const entries = mergeInventoryProgress(plan, seed, await this.loadInventoryProgress(plan, approval)).entries;
            const entry = entries[plan.keys.indexOf(key)];
            if (entry.status === "PRESENT" || entry.status === "CONFIRMED_ABSENT") throw new AcquisitionSafetyError("APPROVAL_VIOLATION");
          }
          if (operation === "HEAD") {
            if (current.active || !Number.isSafeInteger(bytes) || bytes !== 0) throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
            const context = current.contexts[approval.id].counters;
            this.fault("A_BEFORE_RESERVATION");
            const attempts = current.attempts[`HEAD:${key}`] ?? 0;
            const journal = await this.headAttemptJournal();
            const prior = journal.filter((event) => event.key === key).sort((left, right) => left.sequence - right.sequence);
            const last = prior.at(-1);
            if (last?.state === "RESERVED" && last.approvalId === approval.id && last.approvalHash === acquisitionHash(approval)) {
              this.accountHeadReservation(plan, approval, current, last);
              const reservation: HeadAttemptReservation = { attemptId: last.attemptId, sequence: last.sequence, kind: last.kind };
              current.active = { operation: "HEAD", key, approvalId: approval.id, attemptId: last.attemptId };
              await save();
              this.fault("B_AFTER_RESERVED");
              return reservation;
            }
            let kind: HeadAttemptKind = attempts === 0 ? "INITIAL" : "RETRY";
            if (approval.classifiedErrorRetry?.phase === "REPLACEMENT") {
              const pool = current.campaignBudgets?.[approval.campaignId!]?.classifiedErrorRetry;
              if (!pool || key !== "USDJPY/2021/00/08_ticks.bi5" || attempts !== 1 || pool.consumed !== 0) throw new AcquisitionSafetyError("CAP_EXCEEDED");
              kind = "CLASSIFIED_ERROR_RETRY";
            }
            const legacyIndeterminate = current.legacyIndeterminateHeadKeys?.[key];
            if (last?.state === "MAY_HAVE_BEEN_SENT" || (legacyIndeterminate && !legacyIndeterminate.recoveredByAttemptId)) {
              const recoveryAllowance = approval.recoveryAllowance?.maxIndeterminateHeadRetries ?? 0;
              context.recoveryHeadAttempts ??= 0;
              const journalRecoveryAttempts = journal.filter((event) => event.approvalId === approval.id && event.kind === "INDETERMINATE_RECOVERY").length;
              const recoveryAttemptsUsed = Math.max(context.recoveryHeadAttempts, journalRecoveryAttempts);
              if (!recoveryAllowance || recoveryAttemptsUsed >= recoveryAllowance) {
                const campaign = approval.campaignId ? current.campaignBudgets?.[approval.campaignId] : undefined;
                if (campaign) {
                  campaign.status = "STOPPED";
                  campaign.stopReason = "INDETERMINATE";
                  const child = campaign.children.find((candidate) => candidate.approvalId === approval.id);
                  if (child) {
                    child.status = "STOPPED";
                    child.stopReason = "INDETERMINATE";
                  }
                  await save();
                }
                throw new AcquisitionSafetyError("INDETERMINATE");
              }
              kind = "INDETERMINATE_RECOVERY";
            }
            const campaign = approval.campaignId ? current.campaignBudgets?.[approval.campaignId] : undefined;
            if (
              campaign &&
              ((kind === "INDETERMINATE_RECOVERY" && campaign.recoveryHeadAttempts >= campaign.recoveryHeadBudget) ||
                (kind !== "INDETERMINATE_RECOVERY" && kind !== "CLASSIFIED_ERROR_RETRY" && campaign.normalHeadAttempts >= campaign.normalHeadBudget) ||
                current.totals.headAttempts >= current.globalCaps.maxHeadAttempts ||
                context.headAttempts >= approval.caps.maxHeadAttempts)
            ) {
              campaign.status = "STOPPED";
              campaign.stopReason = "CAP_EXCEEDED";
              const child = campaign.children.find((candidate) => candidate.approvalId === approval.id);
              if (child) {
                child.status = "STOPPED";
                child.stopReason = "CAP_EXCEEDED";
              }
              await save();
              throw new AcquisitionSafetyError("CAP_EXCEEDED");
            }
            checkCaps(current.totals, current.globalCaps, operation, key, bytes);
            checkCaps(context, approval.caps, operation, key, bytes);
            const sequence = attempts + 1;
            const retryLimit = Math.min(3, approval.caps.maxRetries + 1, current.globalCaps.maxRetries + 1);
            if ((kind === "INITIAL" && sequence !== 1) || (kind === "RETRY" && sequence > retryLimit) || sequence > 3) {
              if (campaign) {
                campaign.status = "STOPPED";
                campaign.stopReason = "CAP_EXCEEDED";
                const child = campaign.children.find((candidate) => candidate.approvalId === approval.id);
                if (child) {
                  child.status = "STOPPED";
                  child.stopReason = "CAP_EXCEEDED";
                }
                await save();
              }
              throw new AcquisitionSafetyError("CAP_EXCEEDED");
            }
            const event = await this.reserveHeadAttempt(plan, approval, key, sequence, kind);
            this.fault("B_AFTER_RESERVED_EVENT");
            this.accountHeadReservation(plan, approval, current, event);
            const legacy = current.legacyIndeterminateHeadKeys?.[key];
            if (kind === "INDETERMINATE_RECOVERY" && legacy && !legacy.recoveredByAttemptId) legacy.recoveredByAttemptId = event.attemptId;
            current.active = { operation: "HEAD", key, approvalId: approval.id, attemptId: event.attemptId };
            await save();
            const reservation: HeadAttemptReservation = { attemptId: event.attemptId, sequence, kind };
            this.fault("B_AFTER_RESERVED");
            return reservation;
          }
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
            count.getAttempts++;
            count.reservedBytes += bytes;
            if (!count.objects.includes(key)) count.objects.push(key);
            if (attempts > 0) count.retryCount++;
          }
          current.active = { operation, key, approvalId: approval.id };
          await save();
          return null;
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
          if (operation === "HEAD") {
            const attemptId = current.active.attemptId;
            if (!attemptId) throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
            const event = (await this.loadHeadAttemptEvents(attemptId)).CLASSIFIED;
            if (event?.classification?.status !== "PRESENT") throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
            this.settleHeadClassification(current, event);
            await save();
            return;
          }
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
            if (operation === "HEAD") {
              const attemptId = current.active.attemptId;
              if (!attemptId) throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
              const event = (await this.loadHeadAttemptEvents(attemptId)).CLASSIFIED;
              if (!event?.classification || event.classification.status === "PRESENT") throw new AcquisitionSafetyError("FILESYSTEM_UNSAFE");
              this.settleHeadClassification(current, event);
              await save();
              return;
            }
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
      try {
        ledger.partialBytes += (await lstat(journal.partialPath)).size;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
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
