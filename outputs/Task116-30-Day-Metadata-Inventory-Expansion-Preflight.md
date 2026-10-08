# Task116 — 30-Day Metadata Inventory Expansion Preflight

Date: 2026-10-07
Verdict: **NOT_READY**
Scope: Offline audit only. No approval created; no AWS/network calls or credential resolution.

## Inputs and Integrity

- Frozen master plan: **PASS**, 1,826 unique ordered keys; plan hash `c8731ac9b80e8a83373f295e9f8834abaa611fdf08297a9552d3d9346c758302` unchanged.
- Current immutable snapshot: revision `b5976462eec5ef918ab5025f475753138024538f227f7d73efb543d2bc0470bc`; wrapper hash `8fc543f9da4326b4d06941f0b80855896a2aa1b1c9b0b5f32ec644f263f0c9e1`; production snapshot validation **PASS**.
- Completed batch `[2021-01-01, 2021-01-08)`: 7 keys; PRESENT 5, CONFIRMED_ABSENT 2, UNKNOWN 0, ERROR 0; observed bytes 1,421,447. Snapshot statuses and byte sum match these values.
- Ledger `active=null`; latest approval context `initial-seven-day-resume-20261007065233-3aaf7345` has 6 HEAD attempts.

## Candidate Batch

The exact UTC half-open range `[2021-01-08, 2021-02-07)` is 30 calendar days. It selects these 30 keys in frozen master-plan order, with no duplicates and all keys present in the master plan:

```text
USDJPY/2021/00/08_ticks.bi5
USDJPY/2021/00/09_ticks.bi5
USDJPY/2021/00/10_ticks.bi5
USDJPY/2021/00/11_ticks.bi5
USDJPY/2021/00/12_ticks.bi5
USDJPY/2021/00/13_ticks.bi5
USDJPY/2021/00/14_ticks.bi5
USDJPY/2021/00/15_ticks.bi5
USDJPY/2021/00/16_ticks.bi5
USDJPY/2021/00/17_ticks.bi5
USDJPY/2021/00/18_ticks.bi5
USDJPY/2021/00/19_ticks.bi5
USDJPY/2021/00/20_ticks.bi5
USDJPY/2021/00/21_ticks.bi5
USDJPY/2021/00/22_ticks.bi5
USDJPY/2021/00/23_ticks.bi5
USDJPY/2021/00/24_ticks.bi5
USDJPY/2021/00/25_ticks.bi5
USDJPY/2021/00/26_ticks.bi5
USDJPY/2021/00/27_ticks.bi5
USDJPY/2021/00/28_ticks.bi5
USDJPY/2021/00/29_ticks.bi5
USDJPY/2021/00/30_ticks.bi5
USDJPY/2021/00/31_ticks.bi5
USDJPY/2021/01/01_ticks.bi5
USDJPY/2021/01/02_ticks.bi5
USDJPY/2021/01/03_ticks.bi5
USDJPY/2021/01/04_ticks.bi5
USDJPY/2021/01/05_ticks.bi5
USDJPY/2021/01/06_ticks.bi5
```

Snapshot state for the candidate: UNKNOWN 30, PRESENT 0, CONFIRMED_ABSENT 0, ERROR/AMBIGUOUS 0. Thus there are 30 HEAD candidates and no resolved candidate keys to re-HEAD. Ledger cumulative HEAD attempts for all 30 candidate keys are 0.

## Capacity and Readiness

- Real ledger cumulative HEAD attempts: **9**.
- Existing global maximum HEAD attempts: **21**.
- Remaining global HEAD capacity: **12**.
- Required additional HEAD capacity for this candidate range at one attempt per unknown key: **30**; shortfall **18**. The corresponding total cumulative ceiling would have to be at least 39 to cover the present cumulative 9 plus 30 new attempts; no cap change is proposed or made.
- Candidate keys each have zero existing attempts, so a per-approval `maxRetries=0` permits one attempt per key. This does not overcome the insufficient global remaining capacity.
- Independent blocker: the production inventory CLI has `INVENTORY_CLI_MAX_BATCH_KEYS = 7`; its live batch selector rejects a 30-key batch. A direct offline invocation of the pure parser/selector confirmed the 30-day live batch is not accepted.

**Safety decision: NOT_READY.** Global capacity is insufficient and the current CLI cannot accept this 30-key live batch. No approval should be created from this preflight. No proposal to alter global caps or CLI limits is included.

## Size Estimate

- Observed 7-day bytes: **1,421,447 bytes** across five PRESENT objects.
- Observed mean per PRESENT object: **284,289.4 bytes**.
- Simple calendar-time extrapolation: $1,421,447 / 7 \times 30 = 6,091,916$ bytes (rounded). This is a simple extrapolation, not a measured 30-day total.
- Existing preflight sensitivity method, applied to that simple extrapolation: 4x = **24,367,663 bytes**; 10x = **60,919,157 bytes**. These are stress scenarios, not forecasts or limits.
- Actual 30-day bytes: **UNKNOWN**. The 7-day observed size is not represented as a 30-day actual.

No AWS pricing lookup or hard-coded unit pricing was used.

## Durable Resume and Transport Safety

- The current runner accepts a validated `previous` snapshot bound by `approval.inventoryRevision`; it merges approval-bound durable progress monotonically. Collector skips PRESENT and CONFIRMED_ABSENT entries. Durable gate independently checks the bound snapshot plus same-approval progress before a HEAD and rejects resolved keys before consuming an attempt.
- Existing focused CLI/production suites: **92/92 PASS**, including persisted progress restart, resolved-key skip, conflict/downgrade rejection, global and per-key attempt caps, and inventory CLI exclusion of GET/LIST/download paths. Network guards report zero calls.
- Persisted snapshot/progress resume is supported. Caveat: a process crash after an attempt is durably reserved but before the result checkpoint is persisted can leave that key unresolved with its attempt consumed. With a zero-retry approval, the gate fails closed rather than repeating the HEAD; this narrow crash window can block completion and should not be described as guaranteed automatic recovery.
- The inventory CLI admits only `HeadObjectCommand`; GET, LIST, and download remain unreachable through this inventory flow. Planned GET requests: 0; LIST: 0; download bytes: 0.

## Audit Changes and Prohibitions

- No source code, approval, ledger, inventory snapshot, IAM, or dependency changes.
- No AWS CLI, AWS SDK live operation, credential provider resolution, HEAD, GET, LIST, download, commit, or push.
- Actual network requests: **0**. Credential resolution: **0**.
- Only this offline audit report was added under `outputs/`.
