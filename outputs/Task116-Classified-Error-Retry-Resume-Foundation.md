# Task116 - Classified-Error Retry / Stopped Campaign Resume Foundation

Date: 2026-10-07
Scope: FOUNDATION IMPLEMENTATION ONLY. Authorization/apply/attempt/continuation writes and sends were isolated temporary-store operations with fake senders. Real production was read-only.

## Required Fields

- Verdict: **FOUNDATION_IMPLEMENTED_E2E_GATE_NOT_PASSED**. Retry behavior/unit/lint/build and production safety gates passed; complete E2E gate did not pass. No production authorization or rollout is approved by this report.
- Files changed: `lib/backtest/dukascopy-s3-production.ts`, `lib/backtest/dukascopy-s3-durable.ts`, `lib/backtest/dukascopy-s3-runner.ts`, `lib/backtest/dukascopy-inventory-cli.ts`, new `tests/dukascopy-classified-retry.test.ts`, `README.md`, and this report. Pre-existing worktree changes and user-edited prior audit reports were retained.
- Retry kind: CLASSIFIED_ERROR_RETRY, distinct from RETRY and INDETERMINATE_RECOVERY. Restricted to Child1's first-key settled INITIAL sequence1 CLASSIFIED ERROR/SESSION_EXPIRED; replacement is a new UUID at cumulative sequence2.
- Retry budget model: optional classifiedErrorRetry allocation1/consumed0 pool; reservation consumes1 once and updates separate classifiedErrorRetryAttempts counters. Normal/recovery consumption remains unchanged by the replacement, and original failure remains NORMAL charged. No refund/reset.
- Retry authorization schema: immutable version1 binds operator evidence/expiry/reason, campaign/child/frozen source, failed key/attempt/classification/accounting hashes, original approval/progress, ledger/counters/generation, partial snapshot/revision, initial campaign revision, parent cap authorization and reviewed44-to45 caps. Fixed allocation1/nextSequence2, zero replacement indeterminate allowance, zero GET/bytes and no arbitrary key/error/cap options.
- Preparation API: `DurableAcquisitionStore.prepareTask116ClassifiedErrorRetryAuthorization`.
- Preparation CLI: `historical:inventory -- classified-error-retry-authorize-prepare`; help states PREPARE CLASSIFIED ERROR RETRY AUTHORIZATION ONLY - DOES NOT APPLY OR EXECUTE. Requires explicit evidence/state bindings; rejects live/apply/execute/arbitrary cap/path flags.
- Validate-only: zero durable writes and no writer acquisition, returns candidate hash/summary. Normal preparation writes only ignored/untracked immutable retry-authorizations hash/data evidence. Exact replay EXISTING; conflicts reject.
- Cap revision compatibility: separate `applyTask116RetryCapAmendment` validates prepared ticket and writes immutable cap-revisions evidence before updating reviewed44-to45/global generation. Parent authorization hashes are explicitly chained. Original cap44 approval/journal bytes are never rewritten; the exact proven historical failed event reconciles against old caps, while new reservations carry current revision ID/hash. Unproven45/arbitrary caps reject. Targeted single-hop revision only, not generic cap editing.
- Stopped-state apply path: separate `applyTask116ClassifiedErrorRetryAuthorization` requires the cap revision already applied and exact reconstructable STOPPED/ERROR state/counters. Append-only RETRY_AUTHORIZED evidence precedes one-time allocation and campaign ACTIVE. Original child stop reason/binding retained; child remains STOPPED until explicit replacement execution enters RETRY_IN_PROGRESS. APPLIED/ALREADY_APPLIED replay does not allocate/debit twice.
- Execution gate: `runTask116ClassifiedErrorRetry` requires explicit prepared approval ID/hash, authorization ID/hash, phase, seed and cap revision ID/hash, plus caller-supplied session/store. Validates prepared evidence/current generation/pool/scope. Replacement permits only the failed key once. Standard inventory runner rejects replacement approvals; no CLI combines prepare/apply/execute.
- Attempt linkage: new immutable RESERVED records predecessorAttemptId, retryAuthorizationId/hash and capRevisionId/hash; exact linkage retained through MAY_HAVE_BEEN_SENT/CLASSIFIED and accounting. New UUID/sequence2 verified, with original sequence1 records unchanged.
- Crash recovery: final isolated matrix covers pre-reservation, unprojected/projected RESERVED, MAY_HAVE_BEEN_SENT, response before CLASSIFIED, CLASSIFIED before progress, progress before snapshot, snapshot before transition, transition evidence before ledger, and both cap/state apply commit boundaries. Attempt-ID projection prevents double debit; RESERVED resumes same attempt. Sent-unknown result stops as INDETERMINATE without resend/recovery debit. CLASSIFIED reconciles without another send; journal timestamps make replacement snapshot replay deterministic.
- Continuation semantics: PRESENT/CONFIRMED_ABSENT publishes new immutable snapshot and ACTIVE_CONTINUATION evidence; no remaining key auto-runs. `prepareTask116RetryExecutionApproval` separately prepares REPLACEMENT or CONTINUATION with explicit current bindings/operator evidence. Continuation derives six UNKNOWN keys, normal allocation6, one child indeterminate allowance, HEAD cap7/maxRetries0/zero GET/bytes. Separate invocation required; all seven terminal states required for completion; no automatic Child2 preparation/execution.
- History preservation: original failure journal/normal debit/progress/approval/caps/partial snapshot retained. Append-only state records cover RETRY_AUTHORIZED, RETRY_IN_PROGRESS, ACTIVE_CONTINUATION/STOPPED and continuation/completion. Completion requires the persisted immutable result snapshot and corresponding classified/settled journal evidence; forged success from unknown outcome rejects.
- V1 compatibility: optional additive ledger/counter/approval/event fields; guarded current production V1 read-only ledger/journal load passed without mutation. Existing normal retry, indeterminate recovery, child preparation, cap expansion and crash regressions passed in full unit suite.
- Focused tests: PASS,44/44 final classified retry suite (includes19 nested binding refusals), covering CLI/offline guards, apply replay, cap-chain rejection, exactly-one reservation, success/absence/error, crash matrix, explicit continuation, forged-result rejection and counter corruption.
- Unit: PASS,1561/1561 (`npm test`), plus market legacy checks. Final run500.1 seconds in the current environment.
- Lint: PASS (`npm run lint`).
- Build: PASS (`npm run build`, Next.js16.3.6). Existing Apple Silicon/Rosetta performance warning only.
- E2E: **NOT PASSED**. First full workers1 run360/362 passed, with two30-second timeouts; unchanged focused rerun of those cases passed2/2 in7.3 seconds. Second full workers1 run359/362 passed, with three different timeout/teardown failures. No UI/test timeout/config code was modified. Details below; clean full-suite PASS not established.
- Diff: PASS, `git diff --check`; final `git status --short` reviewed, preserving prior work. Final report whitespace validated separately.
- Production audit: `npm audit --offline --omit=dev --json`, exit0, zero findings in every severity. No registry request; live advisory freshness NOT CHECKED.
- Production fingerprint before: `55332f462ec77219560f4115be9110ce6730c503d2a718bdc921e949685428a1`,44 files.
- Production fingerprint after: `55332f462ec77219560f4115be9110ce6730c503d2a718bdc921e949685428a1`,44 files, identical. Real HEAD10/cap44/generation1, campaign/Child1 STOPPED/ERROR, normal1/recovery0, active null; no retry artifacts or retry cap pointer/pool exist.
- AWS requests:0 real HEAD/GET/LIST/download requests. Mutation/execution tests used OFFLINE_TEST fake senders only.
- Credential resolution:0; no identity/session probe.
- Production writes:0; no real authorization, cap revision, apply, writer lock, reservation, progress, snapshot or campaign mutation.
- DB/migration:none. No IAM or strategy/backtest algorithm changes.
- Dependencies:none added; package manifests unchanged.
- Commit/push:none.

## Explicit Lifecycle

1. Offline immutable retry authorization preparation, validate-only first. No state reopen or execution.
2. Separate future cap amendment apply publishes reviewed44-to45 revision evidence and updates generation once, preserving counters/history.
3. Separate future retry-state apply records RETRY_AUTHORIZED, allocates separate pool and reopens campaign. Generation advances once again; original child stop reason remains auditable.
4. Separate REPLACEMENT approval preparation binds current ledger/generation/partial revision; no send/debit.
5. Explicit bounded executor enters RETRY_IN_PROGRESS, reserves one linked CLASSIFIED_ERROR_RETRY and follows durable attempt lifecycle. No second classified replacement, automatic ordinary retry, or indeterminate retransmission.
6. Success publishes deterministic immutable snapshot and ACTIVE_CONTINUATION. Error stops again. Sent-unknown outcome retains unresolved journal and INDETERMINATE result, never fictional success; classified pool stays consumed1.
7. Separate reviewed CONTINUATION approval and invocation can process the six remaining keys. No automatic Child2 preparation. Later ordinary cap45 child preparation beyond this targeted retry/continuation foundation requires separately reviewed compatibility work; no such production operation was performed here.

Isolated simulated generations are1-to2 for cap amendment and2-to3 for retry-state allocation. These are not real production values. Real production remains generation1/cap44/HEAD10 and stopped.

## E2E Residual Gate

First complete run (35.8 minutes):

- daily-plan:26 no auto trading copy, page.goto aborted at30-second timeout.
- pretrade-context:8 DLL reached saved,30-second test timeout.
- Both passed unchanged in a focused one-worker rerun (7.3 seconds).

Second complete run (51.1 minutes):

- entry-trigger-watch:15 not_met-to-met transition notice, page.goto aborted at30-second timeout.
- exit-plan:34 Readiness5, browser context teardown exceeded30 seconds. Browser logged CVDisplayLinkCreateWithCGDisplay failures and repeated HMR connection messages.
- mtf-snapshot:7 close shows stored MTF in Post-Trade Review, cloud-save locator did not appear before test timeout.

These are existing dashboard/navigation/save/teardown surfaces, not classified retry assertions. Variable failing cases and focused pass suggest environment/timing instability, but an E2E cause was not proven and the suite is not marked PASS. No unrelated frontend or Playwright configuration change was made. Resolve/revalidate this remaining gate before treating the whole change as release-validated.

## Limits And Safety

Replacement ticket explicitly allows zero indeterminate retransmissions. An unknown outcome cannot borrow normal or indeterminate reserve; further authority would require separately reviewed evidence/model. Existing indeterminate semantics remain separate in original allowed contexts and the explicitly reviewed continuation allowance.

Authorization/execution evidence is finite and at most24 hours, with placeholder/malformed/secret-like inputs rejected. Operator hashes are supplied approval evidence, not external digital signatures. No broad error/key allowlist, arbitrary cap increase, unlimited budget, multi-hop amendment chain or blind state reset was added.

## Production Authorization State

Production retry authorization created: **false**

Production cap45 applied: **false**

Production retry applied: **false**

Production HEAD retry executed: **false**

Child1 completed: **false**

Child2 preparation allowed: **false**

30-day campaign completed: **false**

Bulk download authorized: **false**
