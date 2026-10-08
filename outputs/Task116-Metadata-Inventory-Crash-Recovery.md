# Task116 — Metadata Inventory Crash-Recovery Foundation

Date: 2026-10-07
Scope: Production code, tests, and report. No live inventory or approval creation.
Verdict: PASS. Durable crash-recovery foundation implemented and verified offline.

## Design

- Preserved the fixed live CLI limit of 7 keys, full ordered approval-key equality, explicit immutable `inventoryRevision` binding, resolved-key skipping, Requester Pays transport checks, and zero GET/LIST/download inventory path.
- Added per-attempt immutable hashed journal documents under `head-attempts/<attemptId>/` with monotonic `RESERVED → MAY_HAVE_BEEN_SENT → CLASSIFIED` files. Journal entries bind the attempt to approval ID/hash, campaign ID, batch, plan, inventory revision, key, sequence, retry kind, timestamps, and allowlisted classification. No credentials or raw SDK errors are stored.
- `RESERVED` is the durable accounting commitment. Ledger projection is keyed by attempt ID and replayed idempotently; recovery does not reset global/per-key/approval counters. A reservation can be resumed with the same attempt ID only while still RESERVED. `MAY_HAVE_BEEN_SENT` is indeterminate and never silently retried.
- Added a separate finite `recoveryAllowance.maxIndeterminateHeadRetries`. A permitted retry is a new attempt with a new ID, counts against per-key, approval, global and campaign totals, and remains subject to the existing three-attempt per-key ceiling. Recovery allowance exhaustion fails closed.
- CLASSIFIED results reconcile into same-approval progress idempotently. Conflicting status or terminal metadata fails closed. Foreign child journal events are reconciled using their hash-bound approval descriptors retained in the ledger; foreign terminal results are not imported. A child approval must bind the exact immutable snapshot containing them.
- Kept the ledger identifier `DUKASCOPY_DURABLE_V1` and existing fields/counters. New journal/campaign/recovery fields are optional and marked by `headAttemptJournalVersion: 1` when initialized. V1 idle state loads unchanged; V1 active HEAD becomes legacy indeterminate without erasing its consumed attempt.
- Added read-only stale-lock inspection and explicit `--recover-stale-lock` CLI flow with a separate exact confirmation. Reclaim requires lock token match, v2 process-start identity evidence, PID absence probes, unchanged lock reread, and retained stale/recovery evidence. Live PID, PID reuse/identity mismatch, and legacy locks without adequate identity fail closed. No automatic lock deletion.
- Added `campaignId` binding to attempt events, approval context, and cumulative campaign attempt counters. This is a foundation only; no campaign/month runner or global cap changes were made.
- Retained hash-bound, secret-free approval descriptors in the additive V1 journal extension so startup can reconcile prior child attempts. Foreign terminal classifications fail closed unless the next child explicitly binds a snapshot that already contains the matching terminal result.
- Added an explicit CLI `--recover-stale-lock` path: read-only process/lock inspection, a separate exact recovery phrase, token-checked reclaim, then the ordinary approval/range confirmation before any request. It was exercised only against a synthetic ignored temp repository.

## Fault Injection

| Boundary                                                     | Expected simulated state                        | Verification                                                                 |
| ------------------------------------------------------------ | ----------------------------------------------- | ---------------------------------------------------------------------------- |
| A: before attempt reservation                                | no journaled attempt, no HEAD, no charge        | restart creates one new reservation; passed                                  |
| A+: attempt directory synced, before RESERVED                | empty/temp-only directory, provably no dispatch | ignored without charge; restart succeeds; passed                             |
| B: RESERVED and ledger projection committed, before dispatch | one charged RESERVED attempt, no HEAD           | restart resumes same attempt ID even at exact cap; passed                    |
| B+: RESERVED event committed, ledger projection absent       | one unprojected reservation, no HEAD            | startup projects once; restart uses same ID; passed                          |
| C: MAY_HAVE_BEEN_SENT committed, before SDK call             | attempt charged; send count 0; result unknown   | retry=0 blocks as INDETERMINATE; passed                                      |
| C+: fake SDK entered, before response                        | attempt charged; send count 1; result unknown   | no automatic duplicate HEAD; passed                                          |
| D: response received, before CLASSIFIED                      | attempt charged; response only in memory        | restart treats it as INDETERMINATE; passed                                   |
| E: CLASSIFIED committed, before progress                     | result is durable in journal                    | repeated reconciliation writes progress once; no HEAD; passed                |
| F: progress committed, before snapshot                       | progress is durable                             | restart merges/skips resolved key and publishes snapshot; passed             |
| G: immutable snapshot committed                              | explicit immutable revision exists              | restart with explicit seed performs no HEAD; prior snapshot retained; passed |

Additional windows: an empty attempt directory after parent fsync but before RESERVED is safely ignored because dispatch cannot have begun; a RESERVED event committed before ledger projection replays exactly once; a fake SDK call entered but returned no response remains MAY_HAVE_BEEN_SENT and is never automatically resent.

## Verification

- Focused crash matrix, V1 migration, campaign child binding, stale lock, and recovery allowance tests passed in targeted runs; the final full suite supersedes focused-only coverage.
- Unit: **1443/1443 passed** (`npm test`).
- Lint: **PASS** (`npm run lint`).
- Build: **PASS** (`npm run build`, Next.js 16.3.6). Existing Apple Silicon/Rosetta performance warning only.
- E2E: **362/362 passed**, one worker (`npm run test:e2e -- --workers=1 --reporter=dot`). Existing Rosetta performance warning only.
- Diff: **PASS** (`git diff --check`). `package.json` and `package-lock.json` unchanged.
- Production audit: `npm audit --offline --json` returned **0 findings in all severities**. No registry request was made; advisory freshness is therefore not checked against the live registry.
- Real-store recursive path/content fingerprint before and after isolated proof: `47f535b831d9232015cc77ee54f0d94e35892c787c45f6dcf41c48b26de5c97d` (identical). The real ledger, approvals, snapshots, progress, locks, and raw store were read-only; fake HEAD and writes occurred only in a canonical isolated temp store.
- AWS HEAD/GET/LIST/download: 0. AWS credential resolution: 0.
- No real ledger/snapshot/progress/approval state mutation. Recursive fingerprint is unchanged.
- No DB/migration, strategy/backtest changes, dependency additions, commit, or push.
