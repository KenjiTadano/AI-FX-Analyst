# Task116 — Metadata Inventory Campaign Cap Expansion Audit

Date: 2026-10-07
Verdict: **NOT_READY** for implementation/operation under current cap model; required expansion is derivable, but the operator-authorized cap amendment and enforced campaign budget are not implemented.
Scope: Audit only. No source, approval, ledger, snapshot, progress, IAM, or campaign state changed; no AWS/network/credential action.

## Verified Current State

- Frozen master plan: 1,826 keys; plan hash `c8731ac9b80e8a83373f295e9f8834abaa611fdf08297a9552d3d9346c758302`.
- Explicit candidate snapshot: `b5976462eec5ef918ab5025f475753138024538f227f7d73efb543d2bc0470bc`; production validation and wrapper hash verified in the preceding offline audit.
- Ledger: cumulative HEAD 9, global HEAD cap 21, remaining 12; no active attempt.
- Candidate `[2021-01-08, 2021-02-07)`: 30 UTC days; 30 keys; all 30 UNKNOWN; no previous attempts.
- Current live batch hard maximum: 7 keys.

## Exact Cap Semantics in Current Code

- **Store/global cap:** each gate requires the approval's `globalCaps` hash to exactly equal `ledger.globalCaps`. Every reservation is charged in the durable ledger and per-key attempt map. No reset occurs. There is no supported audited method to increase `globalCaps` while preserving an amendment history.
- **Campaign cap:** `campaignId` binds journal events, and `campaignHeadAttempts[campaignId]` accumulates uses. It is a counter only: the code has no campaign normal/recovery ceilings and does not enforce a campaign allocation.
- **Child approval cap:** `caps.maxHeadAttempts` checks cumulative attempt reservations for that approval; CLI remains capped at seven approved keys and requires full ordered-key equality. `maxObjects` must be at least the full approval key count, so use that child key count (at most seven).
- **Per-key cap:** at most three total attempts. Ordinary retry ceiling is `min(3, approval.maxRetries + 1, global.maxRetries + 1)`. `maxRetries=0` allows one ordinary attempt per key.
- **Indeterminate recovery:** separate `recoveryAllowance.maxIndeterminateHeadRetries`; recovery is a new attempt and consumes child/global/per-key/campaign accounting. It does not grant ordinary transient retries. Cumulative total also remains bounded by the store global hard cap.

## Derived 30-Day Budget

- Normal first-pass HEAD budget: exactly **30**, one per candidate key.
- Recommended finite recovery reserve: **5**, one indeterminate recovery slot per sequential child. Because execution is serial, only one child is active at once. A second indeterminate event within a child exhausts its allowance and requires another explicit authorization; it does not auto-retry.
- Total proposed campaign allocation: **35** attempts = 30 normal + 5 recovery.
- Required cumulative store hard cap: existing 9 + 35 = **44**. Current cap 21; proposed delta is **+23**, which would leave exactly 35 slots after expansion. This is derived from the specified campaign and reserve, not an arbitrary five-year value.
- Keep all other `globalCaps` fields unchanged. Child caps: `maxRetries=0`, `maxObjects=key count`, `maxHeadAttempts=key count + 1 recovery slot` (8, 8, 8, 8, 3), GET attempts/bytes/verified bytes 0. If an operator chooses no recovery reserve, the arithmetic lower bound is cap 39, but a single indeterminate request can strand that child until new authorization.

## Child Batch Proposal

All children are ordered subsets of the 30-day window and remain <=7 keys. Each approval contains exactly that child's full ordered keys, `maxObjects` equal to its key count, `maxRetries=0`, GET/LIST/download disabled, and `inventoryRevision` equal to the exact preceding immutable snapshot revision.

1. `[2021-01-08, 2021-01-15)`: 7 keys, normal 7, recovery 1, child HEAD cap 8.
2. `[2021-01-15, 2021-01-22)`: 7 keys, normal 7, recovery 1, child HEAD cap 8.
3. `[2021-01-22, 2021-01-29)`: 7 keys, normal 7, recovery 1, child HEAD cap 8.
4. `[2021-01-29, 2021-02-05)`: 7 keys, normal 7, recovery 1, child HEAD cap 8.
5. `[2021-02-05, 2021-02-07)`: 2 keys, normal 2, recovery 1, child HEAD cap 3.

Use one stable campaign ID, e.g. `task116-usdjpy-20210108-20210207`, and unique child IDs. After a child completes, publish R1, R2, etc.; only then prepare the next approval bound to that exact revision. Any ERROR or INDETERMINATE stops the campaign. Do not prepare the next child from an implicit latest snapshot. The five-year 1,826-key effort is a separate review and is not authorized by this proposed 30-day allocation.

## Cap Expansion Evidence Gap

Current implementation is insufficient for a safe operator cap expansion:

- Changing `ledger.globalCaps` manually or using generic `document("ledger.json", ...)` has no dedicated approval, evidence, or validated amendment workflow.
- Existing exact global-cap equality prevents a child approval with cap 44 from running while the ledger still says 21.
- Campaign counters do not enforce the proposed 30/5 campaign allocations or distinguish normal from recovery campaign totals.
- Child approvals bind their values, but there is no immutable cap-expansion record linking old cap, new cap, campaign allocation, authorization and resulting ledger generation.

Minimum future implementation:

- Add an immutable, append-only cap-expansion authorization record with `oldCaps`, `newCaps`, reason, `campaignId`, `normalHeadBudget=30`, `recoveryHeadBudget=5`, `authorizedAt`, operator approval reference/hash, and the prior ledger hash/generation.
- Add a dedicated writer that accepts only a validated explicit operator authorization; requires old cap equality with current ledger, only permits a reviewed monotonic HEAD-cap increase, preserves all counters/per-key attempts/other caps, and records the expansion reference in one atomic ledger generation. The record must be durable before the ledger points to it; replay must be idempotent across a crash between those writes.
- Enforce campaign normal and recovery subtotals independently from child caps and the store hard cap. Keep `campaignHeadAttempts` as a cumulative counter, not the budget source of truth.
- Require each child approval's `globalCaps` to equal the expanded ledger and verify its campaign allocation and explicit prior snapshot revision.

Required tests: operator authorization absent/expired/mismatched rejects; old/new cap and prior ledger hash verified; crash before/after evidence/ledger commit is idempotent; no reset or decrease; normal and recovery allocations cannot consume each other; cumulative store cap cannot be exceeded across children/restarts; V1 ledger without extension remains byte-compatible/readable in isolated tests; child full-key equality/revision binding and resolved skip remain; ERROR/INDETERMINATE blocks next child; GET/LIST/download remain unreachable.

## Safety

Five-year campaign remains out of scope. No AWS HEAD/GET/LIST/download, AWS CLI, credential resolution, approval creation, IAM change, or dependency change occurred. Current global cap and all real durable state were left unchanged.
