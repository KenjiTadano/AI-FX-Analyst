# Task116 - Production Campaign Child 1 Approval

Date: 2026-10-07
Scope: CHILD 1 APPROVAL CREATION ONLY. One immutable production approval was created through the dedicated offline CLI. No inventory execution, AWS request, credential resolution, or source/dependency change.

## Required Fields

- Verdict: PASS_CHILD1_APPROVAL_CREATED_ONLY.
- Validate-only: PASS, dedicated child-authorize-prepare --validate-only invoked first with exact explicit production bindings. Candidate ID/hash generated, zero durable writes, no writer lock, and full 33-file production manifest unchanged.
- Child 1 approval created: true, dedicated CLI returned PREPARED. No manual approval JSON or generic durable writer was used.
- Approval path: `tmp/dukascopy/s3-production/child-approvals/task116-child1-20261007130545074-1a4cc067.json`.
- Approval ID: `task116-child1-20261007130545074-1a4cc067`.
- Approval hash: `ce4ee376964c174317aa3a41ea7a0b8c9d428d71d7caddd97e0798b145420a84`, identical across initial validate-only, saved wrapper/data, replay and post-write validate-only.
- Authorized at: `2026-10-07T13:05:45.074Z`.
- Expires at: `2026-10-08T13:05:45.074Z`, exactly 24 hours later; finite, canonical and unexpired at validation.
- Ignored/untracked: PASS, dedicated API plus git check-ignore --quiet --no-index (exit 0) and git ls-files --error-unmatch (exit 1). File mode 0600; no commit.
- Secret-free: PASS, declared approval/binding field allowlists, exact expected input equality and secret-like reason/reference rejection. No credentials or raw SDK output stored.
- Campaign ID: `task116-usdjpy-20210108-20210207`.
- Child sequence: 1, explicitly bound in campaignPreparation metadata.
- Child range: [2021-01-08, 2021-01-15), derived from persisted reviewed descriptor.
- Key count: 7.
- Ordered keys validation: PASS, full ordered keys below match frozen plan, persisted child descriptor and selected snapshot. All seven UNKNOWN/unattempted before and after creation.
- Inventory revision binding: PASS, explicit `b5976462eec5ef918ab5025f475753138024538f227f7d73efb543d2bc0470bc`, matches campaign revision; immutable wrapper/hash verified, no latest lookup.
- Master plan binding: PASS, 1826 USDJPY keys, frozen key-array/plan hash `c8731ac9b80e8a83373f295e9f8834abaa611fdf08297a9552d3d9346c758302`. Source cfg-public-proper-wallaby, eu-west-1, Requester Pays true.
- Ledger hash binding: PASS, `efd84f567409bfacbf3f7fdd32c742f8ef646569d1e6885c34ece9257186e735`.
- Ledger generation binding: PASS, 1.
- Cap authorization binding: PASS, `task116-cap-30day-20261007115030133-7a15b71f` / `270eb5179396c60a7cb15e6d30f9839e0f3e56ee656a7e179445ae87a88b7ab9`; applied reference and immutable wrapper validated.
- Global cap: 44, matches exact unchanged ledger globalCaps.
- Normal allocation: 7.
- Recovery allowance: 1, recoveryAllowance.maxIndeterminateHeadRetries.
- Child HEAD cap: 8.
- Max objects: 7.
- Max retries: 0.
- GET/network/verified caps: 0/0/0; LIST/download are not authorized or invoked.
- Ledger cumulative HEAD before: 9.
- Ledger cumulative HEAD after: 9; generation1, cap44, active null remain unchanged.
- Campaign normal consumed: 0 of 30.
- Campaign recovery consumed: 0 of 5.
- Child status: PENDING, current sequence1; no execution approvalId/hash was recorded in the child ledger state by preparation.
- Ledger unchanged: PASS, exact original ledger bytes and wrapper/data hash unchanged.
- Snapshots unchanged: PASS, all original path/content hashes retained; no snapshot added.
- Progress unchanged: PASS, all original files retained; no progress added.
- Attempts unchanged: PASS, original ledger/attempt files retained; no reservation created.
- Raw unchanged: PASS, all original path/content hashes retained.
- Only Child 1 approval added: PASS, original 33-file manifest preserved exactly and one expected child-approvals file added, total 34 files. No writer lock, temporary file or Child 2 artifact added.
- Idempotent replay: PASS, same dedicated command/input returned EXISTING, with exact full-store manifest and approval bytes unchanged. Subsequent --validate-only also returned PASS and the same hash.
- AWS requests: 0, including HEAD/GET/LIST/download.
- Credential resolution: 0.
- Inventory requests: 0.
- Commit/push: none.

## Fingerprint Evidence

- Whole-store before and after initial validate-only: `d0dd9ce313b63eb3228ad61006e2052fd5cf1a857ecfd7a61c8a3d67f3e2bc12`, 33 files.
- Whole-store after creation/replay/post-write validation: `17fd2febc8a447062eab4c3ce8491efcde980f7515ea1ff45cb92e597fe86013`, 34 files.
- Excluding only the expected Child 1 approval path from the final manifest reproduces the original manifest exactly. Whole-store equality is intentionally not required after the permitted addition.
- The source/dependency working diff hash before/after is identical. Existing dirty changes and reports were preserved. No IAM, DB/migration, dependency, cap or source change occurred.

## Ordered Keys

```text
USDJPY/2021/00/08_ticks.bi5
USDJPY/2021/00/09_ticks.bi5
USDJPY/2021/00/10_ticks.bi5
USDJPY/2021/00/11_ticks.bi5
USDJPY/2021/00/12_ticks.bi5
USDJPY/2021/00/13_ticks.bi5
USDJPY/2021/00/14_ticks.bi5
```

## Execution Separation

All operator invocations used child-authorize-prepare: initial validate-only, one normal preparation, exact replay, and post-write validate-only. The dedicated API re-ran existing approval/campaign/cap-evidence validators on each invocation. No inventory --live, execution gate, runner, attempt API, SDK client or cap-apply operation was called.

The stored approval authorizes only the bounded Child 1 HEAD-only inventory scope while its expiry and state bindings remain valid. It does not execute the child, authorize another child, or complete the campaign. A later execution remains a separate explicitly selected approval and confirmation workflow. The ledger child remains PENDING until that separate workflow starts.

Reason:

> Task116 USDJPY 30-day metadata inventory campaign Child 1 [2021-01-08, 2021-01-15); 7 HEAD-only metadata inventory keys; normal allocation 7; indeterminate recovery allowance 1; no GET/LIST/download authorization; approval creation only.

## Operator Evidence

Fresh reference: `OP-TASK116-CHILD1-PREP-20261007130545074-1A4CC067`.
Approval hash: `d907b36c441572d156a35fc18bd698915a8fdbe99256c3b9a894210bdca3cc56`.

The current explicit user request is the source of approval-creation permission. The implementation accepts caller-supplied reference/hash and does not claim an external signature or approval service. The hash is SHA-256 over JSON.stringify of the following scoped nonsecret evidence, generated in operator memory. This is audit provenance, not a manually constructed inventory approval or another production artifact.

```json
{
  "version": 1,
  "reference": "OP-TASK116-CHILD1-PREP-20261007130545074-1A4CC067",
  "approvalSource": "Explicit user request: Task116 - Prepare Production Campaign Child 1 Approval",
  "purpose": "CHILD_1_APPROVAL_CREATION_ONLY",
  "campaignId": "task116-usdjpy-20210108-20210207",
  "childSequence": 1,
  "childDescriptor": {
    "sequence": 1,
    "batchId": "task116-usdjpy-20210108-20210115",
    "batchStart": "2021-01-08T00:00:00.000Z",
    "batchEnd": "2021-01-15T00:00:00.000Z",
    "keys": ["USDJPY/2021/00/08_ticks.bi5", "USDJPY/2021/00/09_ticks.bi5", "USDJPY/2021/00/10_ticks.bi5", "USDJPY/2021/00/11_ticks.bi5", "USDJPY/2021/00/12_ticks.bi5", "USDJPY/2021/00/13_ticks.bi5", "USDJPY/2021/00/14_ticks.bi5"],
    "recoveryAllowance": 1
  },
  "inventoryRevision": "b5976462eec5ef918ab5025f475753138024538f227f7d73efb543d2bc0470bc",
  "masterPlanHash": "c8731ac9b80e8a83373f295e9f8834abaa611fdf08297a9552d3d9346c758302",
  "priorLedgerHash": "efd84f567409bfacbf3f7fdd32c742f8ef646569d1e6885c34ece9257186e735",
  "priorLedgerGeneration": 1,
  "capAuthorizationId": "task116-cap-30day-20261007115030133-7a15b71f",
  "capAuthorizationHash": "270eb5179396c60a7cb15e6d30f9839e0f3e56ee656a7e179445ae87a88b7ab9",
  "globalCaps": {
    "maxHeadAttempts": 44,
    "maxGetAttempts": 0,
    "maxNetworkBytes": 0,
    "maxVerifiedBytes": 0,
    "maxObjects": 7,
    "maxRetries": 2
  },
  "normalAllocation": 7,
  "recoveryAllowance": 1,
  "childCaps": {
    "maxHeadAttempts": 8,
    "maxGetAttempts": 0,
    "maxNetworkBytes": 0,
    "maxVerifiedBytes": 0,
    "maxObjects": 7,
    "maxRetries": 0
  },
  "authorizedAt": "2026-10-07T13:05:45.074Z",
  "expiresAt": "2026-10-08T13:05:45.074Z",
  "reason": "Task116 USDJPY 30-day metadata inventory campaign Child 1 [2021-01-08, 2021-01-15); 7 HEAD-only metadata inventory keys; normal allocation 7; indeterminate recovery allowance 1; no GET/LIST/download authorization; approval creation only.",
  "inventoryExecuted": false
}
```

The childDescriptorHash in the actual operator evidence is calculated from the childDescriptor object above and inserted immediately after childDescriptor before hashing the complete evidence. Reproduction must insert that derived field in the same position; the dedicated approval records this descriptor hash in campaignPreparation.

## Authorization State

Child 1 inventory authorized: **true**

Child 1 inventory executed: **false**

Child 2 approval created: **false**

30-day campaign completed: **false**

Five-year inventory authorized: **false**

Bulk download authorized: **false**
