# Task116 Metadata Inventory Durable Resume Support

Date: 2026-10-07
Branch: main; no branch creation, commit or push.
Verdict: offline implementation and regression gates PASS.

## Scope

Approval keys remain the full ordered seven-key batch, not the unresolved subset. The immutable snapshot selected explicitly by approval.inventoryRevision supplies resolved state from a prior approval. No approval file was created in the real store. No real HEAD, GET, LIST, download, AWS credential resolution, IAM operation or DB/migration was performed.

Changed files:

- lib/backtest/dukascopy-inventory-cli.ts
- lib/backtest/dukascopy-s3-runner.ts
- lib/backtest/dukascopy-s3-durable.ts
- lib/backtest/dukascopy-s3-production.ts
- tests/dukascopy-inventory-cli.test.ts
- outputs/Task116-Metadata-Inventory-Durable-Resume.md

## Resume Architecture

DurableAcquisitionStore.loadInventorySnapshot accepts only a 64-character lowercase SHA-256 revision and reads the fixed inventories/<revision>.json path through the existing safe document reader. It verifies the wrapper hash, filename/internal revision equality, frozen source/master plan, exact ordered keys, entries and reconstructed revision. CLI validates the approval against that revision while preserving the existing exact batch-range and ordered-key equality checks. Snapshot and approval are read again after confirmation and before every session request. Runner independently checks that previous equals the immutable stored snapshot, then passes previous to gate and collector.

No latest-snapshot selection or arbitrary cross-approval progress discovery was added. The approval-bound snapshot is authoritative; progress remains scoped to the same approval ID and approval hash. A different seed requires a different approval binding; changing an existing approval ID still fails closed.

## Resolved-Key Protection

Collector skips PRESENT and CONFIRMED_ABSENT. Durable gate independently merges validated seed plus bound durable progress before every HEAD and rejects a resolved key before changing attempts/counters or issuing a request. This also protects progress resolved during a previous invocation. An INVENTORY approval with a non-null revision cannot initialize gate without its snapshot.

The shared merge validates supplied progress entries and rejects duplicate keys. A terminal seed cannot be replaced by nonterminal progress or a contradictory terminal classification/metadata. Compatible terminal progress preserves the entire original seed entry, including checkedAt, metadata, error and attempts. No automatic terminal conflict winner is selected.

## Caps

Seven approved keys require maxObjects=7. The six unresolved keys use maxHeadAttempts=6, maxRetries=0, maxGetAttempts=0, maxNetworkBytes=0 and maxVerifiedBytes=0. Existing global caps, cumulative per-key attempt limits, Requester Pays, transport guards, whitelist and full-key equality are unchanged. Resolved rejections consume no HEAD attempt. Resuming three already resolved progress keys does not spend their attempts a second time. A seventh new request remains blocked.

## Focused Validation

92/92 focused CLI + production tests PASS, including 20 newly added tests. Coverage includes cross-approval ABSENT/PRESENT seed, exactly six HEADs, seed/ledger attempt preservation, immutable seed preservation, durable direct-call resolved rejection, three-key interruption/restart, missing/tampered/wrong revision/plan/source/master range/master keys, malformed revision path, six-key approval rejection, maxObjects=6 rejection, global-cap mismatch, snapshot change during confirmation, stale-progress downgrade, conflicting terminal state/metadata and HEAD/GET caps. Existing HEAD classification, cancellation, same-approval resume, download/BI5/Foundation and synthetic-scale regressions pass. HTTP/HTTPS/TCP/TLS/fetch guards in focused suites report zero actual network calls.

## Real-State Offline Simulation

The real root was only read and fingerprinted; the validated seed and ledger were copied into an isolated canonical-path system temporary store. The approval existed only as an in-memory object. Production runner/session/gate performed fake HEADs there; synthetic metadata is not market evidence and was not published into the real store.

- Approval scope: seven keys, UTC [2021-01-01, 2021-01-08).
- Bound seed revision: 42f53fe5d3f55e60df599577c8cd1a8dc0e9c95152fa91d719e273a069a14e6e.
- Resolved seed: 2021-01-01 CONFIRMED_ABSENT.
- Unresolved: 2021-01-02 through 2021-01-07, six keys.
- Expected/fake HEAD count: 6/6; resolved-key HEAD count: 0.
- Seed entry attempts: 1, preserved; ledger cumulative attempts for that key: 2, preserved. These are distinct counters.
- Global HEAD count: real ledger 3; isolated copied ledger after simulation 9. Real ledger remains unchanged.
- Global caps unchanged; durable gate PASS; actual network requests 0.
- Real-store recursive path/content fingerprint before and after: 1485f932a728689699467c7673c81ec3ebc98b4bdefa1d3500b15182e6163602.
- All real approvals, snapshots, progress and ledger bytes unchanged. No real-store acquire or write.

The first simulation precondition incorrectly assumed seed per-approval attempts equaled ledger cumulative attempts and stopped before a request. A second attempt encountered the existing macOS symlink-ancestor guard before a request. Correcting only the diagnostic assertions and canonicalizing the isolated temporary root produced PASS without relaxing production safeguards.

## Regression Gates

- Unit tests: 1423/1423 PASS.
- Lint: PASS.
- Build: PASS, Next.js 16.3.6. Existing Rosetta performance warning only.
- E2E: 362/362 PASS (`npm run test:e2e -- --workers=1 --reporter=dot`).
- Diff check: `git diff --check` PASS; package.json/package-lock.json unchanged.
- Production audit: most recent recorded production-only audit has all severities 0; no dependency changes in this task. A fresh registry audit was not run under the network prohibition, so current advisory freshness is unverified. The previously recorded full-audit dev-only braces High findings remain unresolved and are not represented as a full-audit PASS.
- AWS requests: 0; credential resolution: 0.
- External network during acquisition validation/simulation: 0. E2E uses localhost browser/server traffic, not AWS.
- DB/migration: none.
- Commit/push: none.

No live run is authorized by this report. The existing null-revision CLI behavior and full batch approval requirements remain supported.
