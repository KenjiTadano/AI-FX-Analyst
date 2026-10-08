# Task116 - Campaign Cap Authorization Preparation Path

Date: 2026-10-07
Scope: PATH IMPLEMENTATION ONLY. All authorization persistence and cap simulations used isolated canonical temporary repositories. No real production authorization was created.

## Required Fields

- Verdict: PASS - PATH IMPLEMENTATION ONLY. All required verification gates passed; production authorization and application remain unperformed.
- Files changed: `lib/backtest/dukascopy-s3-durable.ts`, `lib/backtest/dukascopy-inventory-cli.ts`, `tests/dukascopy-inventory-cli.test.ts`, `tests/dukascopy-s3-production.test.ts`, `README.md`, and this report. Pre-existing dirty changes and earlier reports were preserved.
- Preparation API: `DurableAcquisitionStore.prepareTask116CampaignCapExpansionAuthorization(plan, input, { projectRoot, validateOnly })`. Returns authorization ID/hash/fixed relative path plus a validation summary.
- Preparation CLI: `npm run historical:inventory -- cap-authorize-prepare --help`. Default/help for this subcommand states `PREPARE AUTHORIZATION ONLY - DOES NOT APPLY CAP EXPANSION`. Existing script integration is reused without new dependencies.
- Validate-only: constructs and validates the candidate, checks explicitly selected current ledger/snapshot and Git ignore/tracking, returns the exact candidate hash, and performs zero durable writes. No writer lock is acquired; a pre-existing lock fails closed.
- Immutable persistence: fixed ignored/untracked location `tmp/dukascopy/s3-production/cap-expansions/<authorization-id>.json`, `{ hash, data }` wrapper, 0600 temporary file, fsync, exclusive atomic link, temporary cleanup and directory fsync. The parent directory is synced when preparing its directory. Arbitrary paths and symlink destinations/ancestors are rejected.
- Idempotent replay: identical validated content returns EXISTING without modifying bytes; conflicting content, corrupt wrapper or unsafe destination fails closed. No overwrite path is exposed.
- Apply separation: preparation never invokes the applying writer or inventory/download runners. Applying writer now requires matching pre-existing immutable authorization evidence and never synthesizes it from an unprepared input. Existing crash boundaries and replay behavior remain tested in isolated stores.
- Reviewed cap restriction: exactly 21 to 44; normal/recovery budgets fixed to 30/5. Campaign `task116-usdjpy-20210108-20210207`, window [2021-01-08, 2021-02-07), children 7+7+7+7+2, one recovery allowance per child. Expected child HEAD ceilings remain 8, 8, 8, 8, 3. Unrelated global caps are preserved; Task116 CLI derives the reviewed old caps and will reject mismatched current caps.
- Operator evidence validation: requires reference/hash, reason, authorizedAt and expiresAt. Rejects missing/malformed/placeholder evidence, secret-like free text, invalid/noncanonical/nonfinite timestamps, expired or future-dated approval, invalid ordering, approval older than 24 hours, and lifetime over 24 hours. Reference/hash are supplied operator evidence; the path does not fetch or resolve external approval/credential services.
- V1 compatibility: optional ledger generation defaults to 0; isolated V1 fixture retains original ledger bytes, counters, snapshot, progress and all other existing files. Preparation requires cumulative HEAD 9, no active attempt, no existing campaign budget, and UNKNOWN/unattempted campaign keys.
- Focused tests: PASS, 41/41 across preparation and existing cap/campaign regressions. Includes 31 preparation API/CLI tests and 10 cap/campaign tests.
- Unit: PASS, 1485/1485 (`npm test`) plus existing market legacy checks.
- Lint: PASS (`npm run lint`).
- Build: PASS (`npm run build`, Next.js 16.3.6). Existing Apple Silicon/Rosetta performance warning only.
- E2E: PASS, 362/362 in 5.3 minutes (`npm run test:e2e -- --workers=1 --reporter=dot`). Existing Rosetta performance warning only.
- Diff: PASS, `git diff --check`; final `git status --short` reviewed. Dependency manifests unchanged; prior dirty changes and reports retained. No commit or push.
- Production audit: PASS, `npm audit --offline --omit=dev --json`, exit 0, zero findings in all severities. No registry request; live advisory freshness NOT CHECKED.
- Real store fingerprint before: `47f535b831d9232015cc77ee54f0d94e35892c787c45f6dcf41c48b26de5c97d`, 30 files.
- Real store fingerprint after: `47f535b831d9232015cc77ee54f0d94e35892c787c45f6dcf41c48b26de5c97d`, 30 files, identical to before. CLI test-suite before/after fingerprint protection also passed. Final ledger wrapper hash verified: `649f4547bb22f9d9a7df653628cdb6f89b4dcdf1ab0276c06616f2e6d22af34b`; HEAD attempts 9, cap 21, effective generation 0, active null.
- AWS requests: 0.
- Credential resolution: 0.
- Production writes: 0; no production writer-lock acquisition, approval creation, ledger/snapshot/progress mutation, or cap application.
- DB/migration: none. No IAM, strategy/backtest behavior, or dependency changes.
- Commit/push: none.

## Explicit Binding And Safety

The API accepts only the declared authorization preparation fields. Caller must provide the exact prior ledger hash/generation, initial inventory revision, master plan hash, source/pair, old/new global caps, campaign/window, and full ordered child descriptors. The API derives fixed version/cap/budget fields, invokes `assertTask116CampaignCapExpansion`, reads the selected immutable snapshot, and checks current durable state again before publication and before returning. There is no implicit latest-state selection.

The CLI requires these explicit arguments:

```text
--authorization-id
--campaign
--inventory-revision
--prior-ledger-hash
--prior-ledger-generation
--master-plan-hash
--operator-approval-reference
--operator-approval-hash
--authorized-at
--expires-at
--reason
```

`--validate-only` is optional. No `--live`, `--apply`, arbitrary cap, arbitrary output path, inventory approval, or download option is accepted. The output is an authorization candidate/record, not an inventory execution approval.

The preparation API uses a private read-only store instance, not `acquire`, `document`, or `atomicPlain`. Internal dedicated persistence can write only the validated ID-bound authorization. An active writer is never automatically reclaimed. If state changes during preparation, validation fails; any stale evidence cannot pass the separately bound applying-writer checks. Preparation is not a combined prepare-and-apply transaction.

## Test Evidence

- Validate-only leaves the entire isolated store unchanged, including when the authorization directory does not exist.
- Normal preparation adds exactly one hash-valid immutable authorization; all previous files are preserved byte-for-byte.
- Rejects malformed operator evidence, expiry/order, stale ledger hash/generation, nonexistent revision, wrong master plan, campaign/window, child shape/order/recovery allowance, old/new caps and unrelated cap mutation.
- Rejects arbitrary fields/output IDs, wrong store location, writer locks, active HEAD, nonignored/tracked outputs, and symlink paths.
- Isolated subprocess replaces S3 client construction and credential providers with throwing guards, and also guards store acquisition, applying writer and both runners. Preparation completes without reaching any guard. Existing network sentinels recorded zero real calls.
- Applying writer rejects an authorization whose immutable preparation evidence is absent, leaving isolated ledger unchanged. Existing evidence-first crash/replay and 30+5 campaign accounting regressions pass.

## Authorization State

Real production authorization created: **false**

Cap expansion applied: **false**

30-day inventory authorized: **false**

30-day inventory executed: **false**

Five-year inventory authorized: **false**

Bulk download authorized: **false**
