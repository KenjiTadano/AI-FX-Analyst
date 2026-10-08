# Task116 - Campaign Child Inventory Approval Preparation Path

Date: 2026-10-07
Scope: PATH IMPLEMENTATION ONLY. All approval writes, state staging and fake inventory tests used isolated canonical temporary repositories. No real production child approval was created.

## Required Fields

- Verdict: PASS - PATH IMPLEMENTATION ONLY. All required verification gates passed.
- Files changed: `lib/backtest/dukascopy-s3-production.ts`, `lib/backtest/dukascopy-s3-durable.ts`, `lib/backtest/dukascopy-inventory-cli.ts`, `tests/dukascopy-inventory-cli.test.ts`, `tests/dukascopy-s3-production.test.ts`, `README.md`, and this report. Existing dirty changes and earlier reports were retained.
- Preparation API: `DurableAcquisitionStore.prepareTask116CampaignChildApproval(plan, input, { projectRoot, validateOnly })`. Returns approval ID/hash/fixed path and validation summary.
- Preparation CLI: `npm run historical:inventory -- child-authorize-prepare --help`. Help/default for this subcommand states `PREPARE CHILD APPROVAL ONLY - DOES NOT EXECUTE INVENTORY`. Existing bootstrap is reused; no new dependency or script entrypoint required.
- Validate-only: zero durable writes, including no child-approvals directory creation, writer lock, attempt reservation, or status change. Constructs and validates the candidate and its current explicit bindings, returning the exact candidate hash.
- Child derivation: range, full ordered frozen-plan keys, size, caps, recovery allowance and normal allocation come from the reviewed persisted campaign descriptor. Child 1 derives seven keys, normal 7, recovery 1, HEAD cap 8, maxObjects 7, maxRetries 0, GET/network/verified caps 0. Child 5 derives two keys and HEAD cap 3. Caller-controlled scope/caps/allocation fields are rejected.
- Explicit state binding: campaign ID, sequence, ledger hash/generation, inventory revision, master plan hash, applied cap authorization ID/hash, exact globalCaps, descriptor hash and source/pair are mandatory. No implicit latest selection. Current state is checked before publication and before returning; stale state and existing writer locks fail closed.
- Immutable persistence: fixed ignored/untracked `tmp/dukascopy/s3-production/child-approvals/<approval-id>.json`, hash/data wrapper, 0600 temporary file, fsync, exclusive atomic link, temporary cleanup and directory/parent fsync. No arbitrary output path or overwrite. Symlink ancestors/destinations and tracked/nonignored outputs are rejected.
- Idempotent replay: identical valid content returns EXISTING without changing bytes while the child remains PENDING and state bindings match. Conflicting content or corrupt wrapper fails closed. Execution-started children cannot be re-prepared.
- Execution separation: preparation uses a private read-only store instance, `assertApproval`, cap-evidence checks, and extracted pure campaign-child validation. It never calls acquire, gate, a runner, cap apply, SDK transport or credential provider. Campaign execution requires the explicitly supplied immutable prepared approval, verifies its body hash and initial ledger binding before PENDING becomes IN_PROGRESS, and retains the matched approval for crash recovery.
- Sequential child enforcement: children 2-5 require the current sequence, all predecessors COMPLETED with explicit immutable output revisions and recorded approval references, and the exact immediately preceding result as currentInventoryRevision. Prior terminal entries must be retained unchanged in the current snapshot. PENDING/IN_PROGRESS/stopped predecessors cannot advance preparation. No automatic chaining.
- Operator evidence validation: explicit reference/hash, authorizedAt, expiresAt and reason. Rejects missing/malformed/placeholder evidence, secret-like text, expired/future timestamps, invalid/noncanonical/nonfinite ordering, approval age over 24 hours and lifetime over 24 hours. Evidence is caller-supplied; no external signature/approval service or credential lookup is claimed.
- V1/current state compatibility: existing approval schema gains an optional versioned campaignPreparation binding; noncampaign V1 approvals remain readable. Historical ledger bindings are structurally validated without requiring historical approval timestamps to be current. Current expanded V1 ledger generation 1/cap44 and counters are preserved by preparation. Campaign regression fixtures prepare evidence through the dedicated API.
- Focused tests: PASS, 73/73 (32 child-path tests, 31 cap-preparation tests, 10 cap/campaign regressions).
- Unit: PASS, 1517/1517 (`npm test`), plus existing market legacy checks. A subsequent prefer-const correction affects only an unreassigned local test variable and was checked by lint/build.
- Lint: PASS (`npm run lint`).
- Build: PASS (`npm run build`, Next.js 16.3.6). Existing Apple Silicon/Rosetta performance warning only.
- E2E: PASS, 362/362 in 4.6 minutes (`npm run test:e2e -- --workers=1 --reporter=dot`).
- Diff: PASS, `git diff --check`; final `git status --short` reviewed. Dependency manifests unchanged. Prior work was preserved; no commit/push.
- Production audit: PASS, `npm audit --offline --omit=dev --json`, exit 0, zero findings in all severities. No registry request; live advisory freshness NOT CHECKED.
- Production fingerprint before: `d0dd9ce313b63eb3228ad61006e2052fd5cf1a857ecfd7a61c8a3d67f3e2bc12`, 33 files.
- Production fingerprint after: `d0dd9ce313b63eb3228ad61006e2052fd5cf1a857ecfd7a61c8a3d67f3e2bc12`, 33 files, identical. Ledger wrapper hash verified; HEAD9, cap44, generation1, active null, normal/recovery consumption 0/0, current sequence1 and Child1 PENDING.
- AWS requests: 0 real HEAD/GET/LIST/download requests. Fake sender regressions and the separately invoked CLI fake-sender proof operate only in isolated stores.
- Credential resolution: 0.
- Production writes: 0. No real approval, writer lock, attempt, campaign consumption, progress, snapshot, raw data or cap mutation.
- DB/migration: none. No IAM, dependency, strategy or backtest algorithm changes.
- Commit/push: none.

## API And CLI Contract

The existing inventory approval schema remains the payload. The optional campaignPreparation extension binds the selected sequence, prior ledger hash/generation, cap authorization ID/hash, reviewed descriptor hash, source/pair and operator evidence. Global caps are copied from the exact current ledger; the metadata HEAD-only child caps are derived rather than operator configurable.

CLI required arguments:

```text
--approval-id
--campaign
--child-sequence
--inventory-revision
--prior-ledger-hash
--prior-ledger-generation
--master-plan-hash
--cap-authorization-id
--cap-authorization-hash
--operator-approval-reference
--operator-approval-hash
--authorized-at
--expires-at
--reason
```

Optional: `--validate-only`. No live/execute, range, key, cap, allocation, download or output-path option is accepted by preparation. Help was smoke-tested through the actual operator script without reading or writing a real child approval.

The inventory CLI accepts the dedicated child-approvals location only as an explicitly selected approval path, alongside the existing legacy approval directory. Its global HEAD-cap44 allowance is campaign-specific and requires prepared metadata; the seven-key live batch maximum is unchanged. The durable gate additionally validates the applied cap evidence, exact child descriptor and stored prepared approval before execution. Initial PENDING execution must match the original ledger hash; an IN_PROGRESS restart must retain the same bound approval ID/hash, generation and cap authorization, allowing existing reservation/recovery accounting to continue without resetting counters.

## Focused Safety Evidence

- Validate-only and normal preparation preserve every original file and all PENDING/counter state; normal preparation adds exactly one immutable approval.
- Rejects wrong campaign/sequence, stale ledger hash/generation/revision, wrong master plan or applied authorization, globalCaps/descriptor mismatch and caller-controlled ranges/keys/caps/allocations.
- Rejects expired/malformed/secret-like operator evidence, invalid output IDs, nonignored/tracked paths, symlinks and corrupt wrappers.
- Isolated state-staging tests cover children 1-5 with exact predecessor revisions, rejection before Child 1 completion, and rejection of wrong predecessor revisions. No sender is used in those tests.
- Isolated subprocess guards S3 client construction, credential providers, network, writer acquisition, gate, cap apply and both runners with throwing sentinels; normal child preparation completes without reaching a guard.
- Execution rejects absent/tampered evidence and stale initial ledger binding without modifying the ledger. A separate explicitly confirmed CLI invocation with an OFFLINE_TEST fake sender demonstrates compatibility with cap44, seven HEAD-only keys and no automatic Child 2 approval.
- Existing cap expansion/replay, 30+5 budget exhaustion, ERROR/INDETERMINATE stop and five-child crash-recovery regressions remain passing.

## Authorization State

Real Child 1 approval created: **false**

Child 1 inventory executed: **false**

Child 2 approval created: **false** (production)

30-day campaign completed: **false** (production)

Five-year inventory authorized: **false**

Bulk download authorized: **false**

## Revalidation On Repeated Request

- Production baseline re-read at 2026-10-07T12:55:28.405Z: 33 files, fingerprint `d0dd9ce313b63eb3228ad61006e2052fd5cf1a857ecfd7a61c8a3d67f3e2bc12`; HEAD9, cap44, generation1, current Child1 PENDING, normal/recovery consumed 0/0. Explicit snapshot/key-array binding and seven UNKNOWN/unattempted Child1 keys verified. No real child approval exists.
- Existing dedicated API/CLI and preparation/execution separation already satisfy this request. No additional source, test, dependency or infrastructure changes were needed; only this report is updated for the repeated request.
- Focused revalidation: PASS, 73/73, isolated stores only.
- Full unit revalidation: PASS, 1517/1517, including the final const-corrected test source; legacy market checks also passed.
- Lint/build/actual CLI help revalidation: PASS. Existing Rosetta performance warning only.
- Offline production dependency audit revalidation: PASS, exit 0, zero findings; no registry request, live advisory freshness NOT CHECKED. Dependency manifests unchanged.
- E2E revalidation: pending dedicated workers=1 rerun.
- Final production fingerprint/diff/status revalidation: pending after E2E.
- Production writes, AWS requests, credential resolution, real child approval creation/execution, DB/migration and commit/push remain zero/none. All six authorization/execution flags above remain false.
