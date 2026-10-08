# Task116 - Production 30-Day Campaign Cap Authorization

Date: 2026-10-07
Scope: AUTHORIZATION CREATION ONLY. One new real immutable cap-expansion authorization was created using the dedicated offline preparation CLI for the repeated request. The previous authorization is retained unchanged. No cap application, inventory execution, or source change.

## Required Fields

- Verdict: PASS_AUTHORIZATION_CREATED_ONLY.
- Validate-only: PASS, dedicated `cap-authorize-prepare --validate-only` executed first with exact production bindings. Candidate hash generated; production manifest and fingerprint identical before/after; zero durable writes.
- Authorization created: true; dedicated CLI returned PREPARED. No authorization JSON was constructed manually and no generic durable writer was invoked.
- Authorization path: `tmp/dukascopy/s3-production/cap-expansions/task116-cap-30day-20261007115030133-7a15b71f.json`.
- Authorization ID: `task116-cap-30day-20261007115030133-7a15b71f`.
- Authorization hash: `270eb5179396c60a7cb15e6d30f9839e0f3e56ee656a7e179445ae87a88b7ab9`; identical between initial validate-only, prepared wrapper/data hash, and post-write validate-only.
- Authorized at: `2026-10-07T11:50:30.133Z`.
- Expires at: `2026-10-08T11:50:30.133Z`, exactly 24 hours after authorizedAt; finite, canonical, and unexpired at validation.
- Ignored/untracked: PASS, dedicated API validation plus `git check-ignore --quiet --no-index` and `git ls-files --error-unmatch` (statuses 0 and 1 respectively). Authorization is not committed or tracked.
- Secret-free validation: PASS, exact declared field allowlist, secret-like reason/reference rejection, and approved nonsecret input equality. No credentials, environment secrets, or raw SDK output were included.
- Campaign ID: `task116-usdjpy-20210108-20210207`.
- Campaign window: [2021-01-08, 2021-02-07).
- Children: exact ordered descriptors validated by the dedicated assertion, sizes 7, 7, 7, 7, 2; live child maximum remains 7. Each has recovery allowance 1; corresponding child HEAD ceilings remain 8, 8, 8, 8, 3. No child inventory approvals created.
- Normal budget: 30.
- Recovery budget: 5.
- Prior ledger hash binding: PASS, `649f4547bb22f9d9a7df653628cdb6f89b4dcdf1ab0276c06616f2e6d22af34b`, current ledger wrapper/data hash verified and matches authorization.
- Prior ledger generation binding: PASS, effective V1 generation 0.
- Inventory revision binding: PASS, explicitly selected `b5976462eec5ef918ab5025f475753138024538f227f7d73efb543d2bc0470bc`; no implicit latest-state lookup.
- Master plan binding: PASS, 1826 USDJPY keys, key-array hash and plan hash `c8731ac9b80e8a83373f295e9f8834abaa611fdf08297a9552d3d9346c758302`. Source cfg-public-proper-wallaby, region eu-west-1, Requester Pays true. All 30 candidate keys UNKNOWN and unattempted at preparation.
- Ledger cumulative HEAD before: 9.
- Ledger cumulative HEAD after: 9.
- Ledger cap before: 21.
- Ledger cap after: 21. Proposed authorization cap is 44 only; not applied. All unrelated global caps unchanged.
- Ledger generation before: 0.
- Ledger generation after: 0; active remains null.
- Ledger fingerprint unchanged: PASS, exact ledger file-byte SHA-256 preserved; wrapper/data hash remains the prior ledger hash above.
- Snapshots unchanged: PASS, every original snapshot path/content hash unchanged.
- Progress unchanged: PASS, every original progress path/content hash unchanged; no progress added.
- Attempts unchanged: PASS, original ledger bytes and all original attempt/state files unchanged; no attempt created.
- Only authorization evidence added: PASS, original 31-file recursive manifest retained exactly; sole additional file for this request is the authorization above, total 32 files. The previous authorization is not overwritten or revoked. No temporary file or writer lock remains.
- AWS requests: 0 (HEAD/GET/LIST/download all zero).
- Credential resolution: 0.
- Inventory requests: 0.
- Commit/push: none.

## Fingerprint Evidence

- Whole-store before and after initial validate-only for this request: `d2eeac3c168a2dfcef33ed47322e7c9aaaa451fd42affcf850ccae1e4d56a0ba`, 31 files.
- Whole-store after authorization creation and post-write validation for this request: `26925b6e853ca41131289b2e2dcf3e0923998f4da7fcdaf186a8fcd8da3ef4a6`, 32 files.
- Prior run retained as history: original fingerprint `47f535b831d9232015cc77ee54f0d94e35892c787c45f6dcf41c48b26de5c97d` (30 files), followed by `d2eeac3c168a2dfcef33ed47322e7c9aaaa451fd42affcf850ccae1e4d56a0ba` (31 files). Prior authorization ID `task116-cap-30day-20261007114242065-0abb32ef`, hash `3b15e692b6de7e45f5be915b772120375e6b61e32a0dccfd6366d6ffe547e428`, authorizedAt `2026-10-07T11:42:42.065Z`, expiresAt `2026-10-08T11:42:42.065Z`; all retained unchanged.
- Removing only the expected authorization path from the final recursive manifest reproduces the complete original manifest exactly. Whole-store equality was deliberately not required after the authorized addition.
- Source/dependency working diff hash was compared before/after and is unchanged. Prior dirty changes and existing reports were preserved. This request updates only this report outside the ignored authorization area.

## Preparation And Validation

The same fixed CLI arguments, authorization ID, timestamps, operator evidence and reason were used for all three invocations:

1. Dedicated preparation command with `--validate-only`: PASS; no authorization file exists and original production manifest unchanged.
2. Dedicated preparation command without `--validate-only`: PREPARED; writes only immutable hash-wrapped cap-expansion evidence.
3. Dedicated preparation command with `--validate-only` again: PASS; re-runs `assertTask116CampaignCapExpansion` against the current ledger and explicitly selected snapshot and compares the existing authorization content/hash.

Post-write checks also independently parsed the wrapper, recomputed the authorization hash, checked prior ledger hash/generation, exact caps/budgets/campaign/window, all five child windows/sizes/recovery allowances, expiry, and operator evidence equality. Exact child ordered keys/source bindings are enforced by the dedicated validator. No applying writer or cap-apply command was called.

Reason stored in the authorization:

> Task116 USDJPY 30-day metadata inventory campaign [2021-01-08, 2021-02-07); normal HEAD 30; recovery reserve 5; reviewed cumulative cap 21 to 44; no GET/LIST/download authorization. Authorization creation only; cap application and inventory execution require separate approval.

## Current Operator Evidence

- Fresh reference: `OP-TASK116-CAP-PREP-20261007115030133-7A15B71F`.
- Approval hash: `493fa2d805346594c3ae02eaf43ebb930fa017426630eea89ac2072c3abd59f6`.
- Approval source: the explicit repeated user request, restricted to authorization creation. No external operator signature or approval service is claimed. The reviewed scope/state/reason are unchanged from the retained prior evidence below.
- Reproduce the current approval hash by parsing the retained prior JSON evidence, merging the following overrides as `{ ...priorEvidence, ...overrides }` (existing property order retained), then computing SHA-256 over JSON.stringify of the result. The full current evidence was generated in operator memory and passed only as its reference/hash to the dedicated CLI; this JSON is audit provenance, not manually constructed authorization content.

```json
{
  "reference": "OP-TASK116-CAP-PREP-20261007115030133-7A15B71F",
  "approvalSource": "Explicit repeated user request: Task116 - Prepare Production 30-Day Campaign Cap Authorization",
  "authorizedAt": "2026-10-07T11:50:30.133Z",
  "expiresAt": "2026-10-08T11:50:30.133Z"
}
```

## Prior Operator Evidence

- Fresh reference: `OP-TASK116-CAP-PREP-20261007114242065-0ABB32EF`.
- Approval hash: `09e909d6dfbd7db5cb7f3adf73664b85736e7efcf8c0746e9a3d7916ed726c62`.
- Approval source: the user's explicit request to create this scoped authorization offline. The implementation accepts caller-supplied approval reference/hash; it does not provide an external approval service or a digital signature. The reference was freshly generated, and the hash is SHA-256 over JSON.stringify of the following nonsecret scoped evidence. This evidence was kept in operator memory, not added as a second production file.

```json
{
  "version": 1,
  "reference": "OP-TASK116-CAP-PREP-20261007114242065-0ABB32EF",
  "approvalSource": "Explicit user request: Task116 - Prepare Production 30-Day Campaign Cap Authorization",
  "purpose": "AUTHORIZATION_CREATION_ONLY",
  "campaignId": "task116-usdjpy-20210108-20210207",
  "campaignStart": "2021-01-08T00:00:00.000Z",
  "campaignEnd": "2021-02-07T00:00:00.000Z",
  "masterPlanHash": "c8731ac9b80e8a83373f295e9f8834abaa611fdf08297a9552d3d9346c758302",
  "inventoryRevision": "b5976462eec5ef918ab5025f475753138024538f227f7d73efb543d2bc0470bc",
  "priorLedgerHash": "649f4547bb22f9d9a7df653628cdb6f89b4dcdf1ab0276c06616f2e6d22af34b",
  "priorLedgerGeneration": 0,
  "oldGlobalCaps": {
    "maxHeadAttempts": 21,
    "maxGetAttempts": 0,
    "maxNetworkBytes": 0,
    "maxVerifiedBytes": 0,
    "maxObjects": 7,
    "maxRetries": 2
  },
  "newGlobalCaps": {
    "maxHeadAttempts": 44,
    "maxGetAttempts": 0,
    "maxNetworkBytes": 0,
    "maxVerifiedBytes": 0,
    "maxObjects": 7,
    "maxRetries": 2
  },
  "normalHeadBudget": 30,
  "recoveryHeadBudget": 5,
  "childWindows": [
    ["2021-01-08", "2021-01-15"],
    ["2021-01-15", "2021-01-22"],
    ["2021-01-22", "2021-01-29"],
    ["2021-01-29", "2021-02-05"],
    ["2021-02-05", "2021-02-07"]
  ],
  "childSizes": [7, 7, 7, 7, 2],
  "authorizedAt": "2026-10-07T11:42:42.065Z",
  "expiresAt": "2026-10-08T11:42:42.065Z",
  "reason": "Task116 USDJPY 30-day metadata inventory campaign [2021-01-08, 2021-02-07); normal HEAD 30; recovery reserve 5; reviewed cumulative cap 21 to 44; no GET/LIST/download authorization. Authorization creation only; cap application and inventory execution require separate approval.",
  "capExpansionApplied": false,
  "inventoryAuthorized": false
}
```

## Authorization State

Cap expansion applied: **false**

30-day inventory authorized: **false**

30-day inventory executed: **false**

Five-year inventory authorized: **false**

Bulk download authorized: **false**
