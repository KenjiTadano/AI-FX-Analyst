# Task116 — Audited Campaign Cap Expansion Foundation

Date: 2026-10-07  
Verdict: **READY_FOR_CAP_EXPANSION_IMPLEMENTATION**. The authorization and enforcement foundation is implemented and verified offline; this does not authorize or execute a production cap expansion or inventory campaign.  
Scope: Source, isolated tests, and this report only. No AWS request, credential resolution, production authorization, or real durable-state write.

## Result

- Frozen master plan: 1,826 USDJPY keys; hash `c8731ac9b80e8a83373f295e9f8834abaa611fdf08297a9552d3d9346c758302`.
- Candidate campaign: 30 days, `[2021-01-08, 2021-02-07)`, 30 keys.
- Existing durable ledger observed read-only: cumulative HEAD attempts 9, global HEAD cap 21, remaining 12. Existing live batch maximum remains 7 keys.
- Campaign budget: 30 normal attempts plus a separately enforced recovery reserve of 5, total 35. Derived global cap is 44 (= 9 existing cumulative attempts + 35); proposed delta from 21 is +23. This is not a five-year cap.
- Fixed sequential children: 7, 7, 7, 7, and 2 keys. Each child is bound to its full ordered key set and explicit preceding snapshot revision. Per-child recovery allowance is one; child HEAD ceilings are 8, 8, 8, 8, and 3 respectively.

## Implementation

- Added an explicit cap-expansion authorization model binding the campaign and fixed child descriptors to the frozen master plan, candidate window, old/new cap, operator approval reference/hash, expiry, and prior ledger hash/generation. Missing, expired, mismatched, or stale authorization fails closed.
- Added a dedicated cap writer. It accepts only the reviewed 21→44 HEAD-cap change, preserves other caps and cumulative/per-key accounting, and records a unique applied expansion reference.
- Crash-safe ordering commits immutable, hash-validated `cap-expansions/<id>.json` evidence before updating the ledger. Restart after evidence-only commit can replay safely; an already committed expansion returns `ALREADY_APPLIED` without charging again.
- Campaign accounting independently enforces 30 normal and 5 recovery attempts. Recovery does not replenish or borrow from the normal budget. Exhaustion and ERROR/INDETERMINATE stop progression.
- Child progression retains the 7-key maximum, exact full-key equality, zero ordinary retries, zero GET/bytes allowance, explicit snapshot revision chaining, and terminal snapshot requirement before advancing. Snapshot completion also verifies that outside-child entries match the explicit seed.
- Ledger V1 compatibility is retained: prior counters and fields are not reset; additive campaign and authorization metadata are optional and exercised using isolated V1 fixtures.

Changed implementation and test files:

- `lib/backtest/dukascopy-inventory-cli.ts`
- `lib/backtest/dukascopy-s3-acquisition.ts`
- `lib/backtest/dukascopy-s3-durable.ts`
- `lib/backtest/dukascopy-s3-production.ts`
- `lib/backtest/dukascopy-s3-runner.ts`
- `tests/dukascopy-inventory-cli.test.ts`
- `tests/dukascopy-s3-production.test.ts`

## Isolated Simulation

- Fake sender and isolated temporary durable store only: applied the 21→44 amendment and completed all five child batches, consuming 30 normal plus 5 recovery attempts. Final isolated cumulative attempts: 44; normal/recovery totals: 30/5.
- Exercised evidence-first commit, replay/idempotence, invalid authorization and cap mismatch rejection, child binding/revision checks, budget exhaustion, and ERROR/INDETERMINATE stop behavior.
- No real authorization or real cap change was created. The actual production ledger and snapshots remain unchanged.

## Verification

- Focused campaign cap suite: **9/9 passed** before the final outside-child snapshot preservation guard; full unit suite below includes the guard.
- Unit: **1453/1453 passed** (`npm test`).
- Lint: **PASS** (`npm run lint`).
- Build: **PASS** (`npm run build`, Next.js 16.3.6); existing Apple Silicon/Rosetta performance warning only.
- E2E: **362/362 passed** in 4.9 minutes (`npm run test:e2e -- --workers=1 --reporter=dot`). An earlier run was interrupted by a concurrent terminal command; the final standalone rerun completed successfully.
- Diff whitespace: **PASS** (`git diff --check`). `package.json` and `package-lock.json` unchanged; no dependency added.
- Offline dependency audit: `npm audit --offline --json` returned zero findings in all severities. No registry request was made; live advisory freshness was not checked.
- Production durable-store recursive fingerprint: `47f535b831d9232015cc77ee54f0d94e35892c787c45f6dcf41c48b26de5c97d`, 30 files; identical to baseline. Ledger and snapshot wrapper hashes also validated read-only.
- AWS requests: **0**. Credential resolution: **0**. Real ledger/snapshot writes: **0**.
- Database/migration or IAM changes: **none**. Commit/push: **none**.

## Authorization State

- Real 21→44 cap expansion executed: **false**.
- 30-day inventory authorized: **false**.
- Five-year inventory authorized: **false**.
- Bulk download authorized: **false**.

The verdict means only that the audited cap-expansion implementation foundation is ready for a separately reviewed operator authorization step. It is not production approval, and no campaign may run until that independent authorization and child approvals exist.
