# Task116 — Scalable Metadata Inventory Batch / Crash-Recovery Design Audit

Date: 2026-10-07
Verdict: **NOT READY for the proposed 30-day execution under current caps/CLI; architecture recommendation is bounded sequential child approvals.**
Audit only: no source, approval, ledger, snapshot, IAM, or dependency changes; no AWS/network/credential action.

## Current Offline State

- Frozen plan: 1,826 keys, plan hash `c8731ac9b80e8a83373f295e9f8834abaa611fdf08297a9552d3d9346c758302`.
- Snapshot revision: `b5976462eec5ef918ab5025f475753138024538f227f7d73efb543d2bc0470bc`; wrapper hash and `assertInventorySnapshot` validation pass.
- Completed Jan 1-7: PRESENT 5, CONFIRMED_ABSENT 2, UNKNOWN 0, ERROR 0; observed bytes 1,421,447.
- Master state: PRESENT 5, CONFIRMED_ABSENT 2, UNKNOWN 1,819, ERROR 0. One UNKNOWN key, `USDJPY/2025/00/06_ticks.bi5`, already has one HEAD attempt; the other 1,818 UNKNOWN keys have none.
- Ledger: cumulative HEAD attempts 9, cap 21, remaining 12, active operation null. Latest 7-day approval context has 6 HEAD attempts.
- Candidate `[2021-01-08, 2021-02-07)`: exactly 30 UTC days, 30 ordered unique master keys, all UNKNOWN, all with zero previous attempts. It therefore requires 30 first-pass HEAD attempts.
- Current live CLI hard limit is 7 keys. Its batch selector rejects 30 keys.

## Batching Decision

**Recommend B now; use C as the long-term interface only with a non-configurable production hard ceiling of 7.** Configuration may request a smaller batch (1-7) but must never raise the hard ceiling. Every child remains sequential and individually approved. Do not raise the ceiling to 30 as option A.

- A, one 30-key approval: rejected by current CLI and enlarges the operator's approval/error domain. It does not solve campaign accounting or crash recovery.
- B, 7+7+7+7+2: safest immediate execution pattern with existing CLI. It narrows approval and recovery scope and makes progress reviewable. It still needs enough cumulative campaign/global budget before starting; current remaining 12 cannot complete 30 first-pass keys.
- C, configurable batch size with hard ceiling: suitable future API shape to reduce final partial batches or allow smaller children. It is safe only if configuration cannot override the hard ceiling, the child approvals remain explicit, and all accounting is cumulative. It provides no reason to increase the production ceiling above 7 now.

For a 30-day candidate, partition its exact ordered key list into four children of 7 and a final child of 2. For calendar months, make each month a campaign/review boundary, then partition the month into sequential child approvals of at most 7 keys (e.g. a 31-day month as 7+7+7+7+3). For five years, use a campaign manifest covering the frozen 1,826-key plan, organized into monthly review windows and bounded child approvals; do not make one giant 1,826-key approval. At 7 keys per child, 1,826 days require 261 child batches.

Each completed child publishes a full-plan immutable snapshot. The next approval must explicitly bind `inventoryRevision` to that exact output revision; never infer "latest". An interrupted child resumes under its same approval ID/revision from its progress, or publishes a partial snapshot and obtains a new approval explicitly bound to that revision. Progress from another approval is not implicitly imported.

## Global / Campaign Cap Semantics

Use separate, explicit accounting layers:

1. **Per-key attempts:** each durable reservation counts against the key, whether the result is success, confirmed absence, denial, timeout, ambiguous, or indeterminate. A reservation is not refunded unless durable ordering proves the network invocation never began.
2. **Child approval cap:** maximum total HEAD reservations for that child, set to its bound unresolved keys plus any separately specified recovery/retry allowance. `maxRetries=0` means one total attempt per key, not one successful attempt plus a free recovery.
3. **Campaign cap:** an append-only, operator-approved budget across all children/restarts in the campaign. Child authorizations debit it; changing approval IDs or snapshot revisions never resets it.
4. **Store/global ceiling:** cumulative across campaigns in the ledger. It never resets on resume or campaign rollover. Raising it requires an explicit operator-approved, auditable budget amendment/version; preserve the previous ceiling and all prior consumption rather than deleting/reinitializing the ledger. Current gate requires approval `globalCaps` to exactly match the ledger, so an in-place cap increase is not currently supported safely.
5. **Recovery/retry allowance:** reserve a finite, explicit amount separately from first-pass coverage. Retryable service errors and indeterminate crash recovery consume this same cumulative request budget unless a reviewed policy separates them. Do not grant an implicit unlimited retry loop. Every additional attempt is charged before invocation; ambiguous/failed calls are not assumed free.

For the 30-day child campaign, the first-pass requirement is exactly 30 new attempts. Current remaining capacity is 12, short by 18. A total ceiling of at least 39 would only cover the existing 9 plus this one first pass and includes no recovery contingency; this is a lower bound, not a proposed cap. The campaign is not executable under the current 21 ceiling.

For a first pass over the current full inventory, 1,819 UNKNOWN keys require one new HEAD each. One UNKNOWN already has a prior attempt, so `maxRetries=0` would reject that key under the current per-key formula. At least 1,819 new attempts are needed for first-pass coverage, yielding a cumulative minimum of 1,828 including the existing 9, before any recovery/retry allowance. This is a derived minimum, not a recommendation to set a five-year cap to 1,828; a campaign needs a separately reviewed finite recovery budget and an explicit policy for the prior-attempt UNKNOWN key.

## Crash Ordering and Failure Windows

Current ordering in `DurableAcquisitionStore.gate().before()` and `collectDukascopyInventory()` is:

1. Validate approval/key and resolved state.
2. Increment per-key/global/context attempt counters, set `ledger.active={operation,key,approvalId}`, and atomically persist the ledger document.
3. Return from `gate.before`; collector marks `started=true`, increments its in-memory entry attempt count, then calls `session.send(HeadObjectCommand)`.
4. Receive response; classify/allowlist it in memory. On success, set the in-memory entry PRESENT, then call `gate.success()` which clears active and persists ledger.
5. Persist the classified entry separately via `saveInventoryEntry()` to approval-bound progress. Confirmed 404 uses `gate.failure()` first, then progress persistence. Other terminal errors follow the same separate failure-then-progress pattern.
6. After the collector returns, runner publishes a new immutable full-plan snapshot under its revision hash. CLI prints the revision only after that publication.

Crash windows:

- Before durable reservation: no request; no attempt; no result. Safe to restart.
- While reservation document is being atomically replaced: `before()` has not returned, so collector cannot yet invoke HEAD. On recovery, the old or new ledger document is authoritative; request was not invoked by this process before `before()` returns.
- After reservation is durable and before/during SDK invocation: request may or may not have been sent; attempt is consumed and `active` remains. Recovery can see an active reservation but cannot determine dispatch. Gate startup marks it failed and clears active, retaining the consumed per-key attempt. With retries=0 it blocks the next attempt. With a larger cap, retry may duplicate a billable HEAD.
- After service response, before `gate.success()`/`gate.failure()`: attempt is consumed; active remains; response/classification exists only in memory. Recovery cannot recover that result; it clears active as failed. Retry may duplicate a request; retries=0 blocks.
- After success/failure gate persistence clears active, but before progress persistence: ledger records the attempt, but not the classification. Snapshot/progress remains UNKNOWN or stale. The same approval cannot re-HEAD with retries=0 because the per-key attempt limit is exhausted. With retry allowance it may safely repeat HEAD semantically, but cannot know whether the earlier request happened and may duplicate billing.
- During progress atomic write before rename: old progress (or none) survives. Attempt remains consumed; same result ambiguity and cap behavior as above. After rename/fsync, progress can be reloaded and merged idempotently.
- After progress commit but before snapshot publication: same-approval restart can load progress and skip resolved keys, then publish a snapshot. A different approval cannot implicitly inherit that progress; it must bind an explicitly published snapshot.
- During immutable snapshot publication: before the final link, no new revision is published; after it, the immutable revision exists. A crash before CLI output can leave a valid revision without an operator-visible summary. Use a campaign/child journal to recover its exact revision; never select by newest filename.
- Hard process death also leaves `writer.lock`. The CLI calls `DurableAcquisitionStore.acquire()` without `staleLockToken`, and exposes no stale-lock reclaim option. Normal CLI restart therefore fails closed at lock acquisition until an explicit safe reclaim is performed. Existing store API requires matching token and a dead PID and preserves stale-lock evidence; PID reuse/live owner is rejected.

**Answer:** yes, current `maxRetries=0` can strand an UNKNOWN key for that approval after a durably consumed reservation whose result did not reach progress. It does not silently exceed caps. A new explicitly authorized retry budget can provide a path if campaign/global capacity remains, but the attempt may duplicate a billable HEAD. Hard crash may additionally block CLI startup on the stale lock.

## Recommended Crash-Safe Semantics

Introduce an append-only per-attempt operation journal integrated with the single-writer budget gate:

- Persist a unique attempt ID, approval/campaign binding, key, and RESERVED state before any network call.
- Persist a MAY_HAVE_BEEN_SENT state before invoking the SDK. A crash before this transition proves no invocation was started; a crash after it is indeterminate and remains charged. There is no atomic transaction spanning local disk and S3, so the small pre-send ambiguity cannot be eliminated.
- Persist a sanitized classified HEAD outcome durably before treating the operation as complete. Journal outcome is canonical; ledger counters and progress are idempotent projections/reconciliation, not independent competing truths.
- On restart, reconcile RESERVED-without-dispatch as not sent; reconcile a durable outcome into progress/snapshot without another HEAD; treat MAY_HAVE_BEEN_SENT-without-outcome as indeterminate. Any retry is an idempotent HEAD but a new, separately charged attempt using a finite, explicitly approved recovery allowance.
- Reconcile the existing active ledger/journal and stale writer lock through an explicit, audited recovery path. Do not automatically reclaim a lock with a live/reused PID and do not delete it.
- Publish child snapshot revision and campaign manifest transition idempotently. Next child requires that exact revision in its approval.

Finite budgets cannot guarantee completion through an unbounded sequence of repeated crashes. If explicit recovery allowance is exhausted, stop and require an auditable operator-approved budget amendment; never reset the ledger or silently exceed a cap. This avoids automatic stranding within the approved recovery envelope and preserves a safe manual path beyond it.

## Required Code and Tests (Not Implemented in This Audit)

- Versioned attempt journal and atomic/idempotent reconciliation with cumulative reservation accounting; migration must preserve V1 totals, per-key attempts, global caps, progress, and all snapshot hashes.
- Explicit stale-lock recovery UX/API in the CLI with dead-owner checks, retained evidence, and no implicit takeover.
- Campaign manifest/budget, immutable budget amendments, child approval binding to the explicit previous revision, sequential orchestration, and hard max batch size 7 (configurable downward only).
- Crash injection after each boundary: before/after reservation commit; before/after MAY_HAVE_BEEN_SENT; fake sender before/after dispatch; after response/before classification; after classification/before outcome journal; after outcome/before progress; before/after progress rename; before/after snapshot publication; before campaign manifest update; stale/live/PID-reused lock recovery.
- Assert exactly which attempts remain charged, duplicate recovery HEADs consume a second slot, no terminal downgrade, idempotent repeated reconciliation, cap enforcement across all child approvals/restarts, no implicit latest-snapshot use, and GET/LIST/download remain unreachable.
- Verify legacy V1 stores remain readable and no reset or reinterpretation of historical counters occurs.

## Changes and Network

Only this audit report was added. No source code, approval, ledger, snapshot, IAM, dependency, commit, or push changes. AWS/network requests: **0**; credential resolution: **0**.
