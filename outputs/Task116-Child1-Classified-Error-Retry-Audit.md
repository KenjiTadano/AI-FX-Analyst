# Task116 - Child 1 Classified-Error Retry / Resume Capability Audit

Date: 2026-10-07
Durable evidence checked at: 2026-10-07T13:37:57.465Z.
Scope: AUDIT ONLY. No source change, credential probe, AWS call, retry, authorization creation or production-state mutation.

## Required Fields

- Verdict: **BLOCKED_MULTIPLE_PREREQUISITES**.
- Failure: terminal CLASSIFIED ERROR / SESSION_EXPIRED, kind INITIAL, settled and charged to NORMAL. Operator reports external session remediation and successful STS identity confirmation for dukascopy-pilot / eu-west-1; accepted as operator-provided context, not re-probed or independently verified here.
- Failed key: `USDJPY/2021/00/08_ticks.bi5`.
- Failed attempt: `a9c06341-7832-47f0-896f-8e2395d15b3d`, sequence1.
- Original approval: `task116-child1-20261007130545074-1a4cc067`, hash `ce4ee376964c174317aa3a41ea7a0b8c9d428d71d7caddd97e0798b145420a84`. Unexpired at inspection (`2026-10-08T13:05:45.074Z`), but not usable to retry/resume stopped state.
- Original maxRetries: 0; ordinary per-key retry ceiling1, failed key already at1.
- Recovery allowance: 1 child indeterminate slot, unused. It does NOT authorize classified-error retry.
- Global HEAD attempts: 10.
- Global cap: 44; remaining34.
- Campaign normal consumed: 1 of30; remaining29.
- Campaign recovery consumed: 0 of5; remaining5.
- Automatic retry allowed: no. The collector retries TRANSIENT only within its ceiling, and this error is SESSION_EXPIRED. The gate/accountant also reject an ordinary RETRY at sequence2 with original maxRetries0.
- Indeterminate recovery allowed: no for this attempt. Its latest journal state is CLASSIFIED, not unresolved MAY_HAVE_BEEN_SENT; no applicable legacy indeterminate marker is present in the preceding offline diagnostic. Do not borrow this reserve.
- Existing stopped-child resume path: absent. Gate requires campaign ACTIVE and rejects child STOPPED. Existing crash resume retains matching IN_PROGRESS approval/reservations; it is not STOPPED/ERROR reactivation. completeCampaignChild's stopped branch only records outputRevision and does not reopen state.
- Existing classified-error authorization path: absent. No dedicated retry ticket/authorization API or CLI exists. Child preparation requires PENDING, UNKNOWN/unattempted keys, exact current state, and derives maxRetries0; it cannot create this retry approval. A one-key ordinary child approval would also fail the full seven-key child-scope equality check.
- Existing retry-budget amendment path: absent. Campaign normal/recovery ceilings must match the original immutable cap authorization. Existing cap preparation/apply is fixed at21-to44 and30/5, rejects an existing campaign, and returns ALREADY_APPLIED for the applied ID; it does not amend normal budget or allocate a classified-error slot.
- Required additional HEAD count: exactly1 over the original30-normal first-pass plan for one successful replacement of this failure. From now, 30 classification HEADs remain: one retry of the failed key plus29 still-unattempted campaign keys. Child1 alone needs7 further classification HEADs: one retry plus six initial HEADs. This assumes no additional failures/recoveries and does not promise success.
- Required budget treatment: a separately reviewed classified-error retry allocation1, or a reviewed normal budget amendment30-to31 with key-specific retry authority. Neither exists today. Indeterminate recovery5 must remain separate. Retaining all5 recovery slots requires global cap45, not44: historical9 + normal30 + recovery5 + classified retry1 =45; equivalently current10 + remaining normal29 + classified retry1 + recovery5 =45. No cap change is authorized or performed by this audit.
- Required state transition: a new evidence-first, idempotent writer must validate current STOPPED/ERROR state and its exact failure, apply approved budget changes once, then reopen campaign to ACTIVE and permit Child1 to enter IN_PROGRESS only under the new explicit retry execution binding. Failed attempt1 remains settled/charged; sequence, totals and per-key attempts are never reset. Existing preparation/gate cannot perform this transition safely by themselves.
- Required immutable evidence: new operator-authorized stopped-child classified-error retry record, budget amendment evidence if needed, and a retry/continuation approval linked to the original approval, failed attempt and partial snapshot. No artifact created here; exact required bindings listed below.
- Required API/CLI: dedicated offline retry-authorization prepare/validate-only; separate audited budget/state apply; separate explicitly confirmed bounded failed-key executor; reviewed continuation/resume preparation. These are missing prerequisites, not existing commands.
- Original failure retained: yes, CLASSIFIED ERROR journal retained, with matching accounting hash, original progress and immutable partial snapshot. Future retry must not overwrite these.
- Counters retained: yes; failed INITIAL remains counted. A future second attempt must add exactly one new attempt and its explicit budget debit, never refund or decrement the first.
- Partial snapshot retained: yes, `afe333d92640ff64c35c9f707186bc2c161ca1cd183b14ed56cbbaec717facb0` remains immutable. Campaign currentInventoryRevision still `b5976462eec5ef918ab5025f475753138024538f227f7d73efb543d2bc0470bc`.
- Recommended next implementation: separately scoped classified-error retry/resume foundation with an exact failed-key/attempt allowlist, maximum one authorized replacement attempt, its own bounded allocation, append-only amendment/retry linkage, crash-safe commit/replay and historical-cap-aware journal reconciliation. Do not implement a generic status reset or increase maxRetries for every child/key.
- Recommended next operator action: keep campaign stopped; review/approve the missing implementation and budget model first. After that passes offline tests, issue fresh scoped immutable authorization through that new path, validate-only first, then separately approve apply and execution steps. The external session fix alone grants no retry/resume permission. Do not rerun existing inventory command or prepare Child2 now.
- Production fingerprint before: `55332f462ec77219560f4115be9110ce6730c503d2a718bdc921e949685428a1`, 44 files.
- Production fingerprint after: `55332f462ec77219560f4115be9110ce6730c503d2a718bdc921e949685428a1`, 44 files; entire recursive path/content manifest identical.
- AWS requests: 0 during this audit.
- Credential resolution: 0; no repeat identity/session probe.
- Production writes: 0.
- Commit/push: none.

## Existing Mechanisms

1. Ordinary retry: journal kind RETRY, sequence>=2, consumes campaign NORMAL. Collector automatically retries only TRANSIENT; ledger/gate ceiling is min(3, child maxRetries+1, global maxRetries+1). Original approval permits only sequence1, and campaign validation explicitly requires maxRetries0.
2. Indeterminate recovery: journal kind INDETERMINATE_RECOVERY, uses its separate finite allowance and recovery budget. It targets unknown outcome, not a known terminal ERROR. The presence of an older MAY_HAVE_BEEN_SENT record is not eligibility once CLASSIFIED exists for that attempt.
3. Crash resume: can resume the same RESERVED attempt or reconcile an IN_PROGRESS bound approval, preserving counters. It neither reopens STOPPED/ERROR nor permits an additional ordinary attempt outside the approval's limits.
4. Operator-authorized classified-error retry: missing. There is no retry-specific authorization, applied retry-ticket accounting, stopped-state transition writer, or separate budget amendment model.

Targeted searches of backtest implementation and operator scripts found no dedicated classified-error retry/resume/budget-amendment path. Relevant owners are the collector/classifier in dukascopy-s3-production, reservation/accounting/campaign gate in dukascopy-s3-durable, and the existing plan/inventory, cap-authorize-prepare and child-authorize-prepare CLI paths. No execution API was called to test these guards.

## Budget And Approval Design

The original failed request consumed NORMAL even though no key received terminal PRESENT/CONFIRMED_ABSENT classification. The30-key campaign snapshot currently has ERROR1, UNKNOWN29, PRESENT0 and CONFIRMED_ABSENT0. Session remediation cannot restore the consumed slot.

The safest extension is a separately modeled, per-key classified-error retry ticket tied to this exact failure, instead of broadening automatic retries. The original normal/recovery accounting can stay1/30 and0/5; a new classified-error pool would start0/1. The replacement attempt would debit that pool plus global/per-key/child totals once. This is a proposed extension, not a supported current capability.

A normal budget amendment to31 is another explicit model, but existing cap evidence fixes30 and all ordinary RETRYs are currently debited to normal. Raising only the counter ceiling, changing only maxRetries, or recreating a generic child approval is insufficient. If all existing recovery allowances are retained, full Child1 aggregate capacity must cover8 classification attempts (the failed first attempt plus7 further HEADs) and its separate one indeterminate reserve, i.e.9 total; the present child cap8 is not sufficient for both. The full campaign needs45 capacity with all5 recovery slots retained.

Keeping global cap44 could fit the retry plus30 eventual classifications only by reducing other reserved capacity; with all remaining29 normal slots required, one recovery slot would have to be explicitly relinquished. That would amend the reviewed recovery model rather than borrow it, and no such amendment path exists. This audit recommends preserving the reviewed indeterminate reserve and separately reviewing any45-cap extension; it authorizes neither option.

Important compatibility blocker: reconcileHeadAttempts currently requires historical approval.globalCaps to equal the current ledger.globalCaps. Raising current cap to45 while preserving original44-bound failure evidence would need an explicit cap-revision/amendment-aware reconciliation design. The original approval/journal must not be edited to make this comparison pass.

## Required Authorization Bindings

Any future dedicated authorization should bind at least:

- Unique immutable retry authorization ID/hash, version, reason, operator approval reference/hash, authorizedAt and finite expiresAt.
- Campaign ID, Child1 sequence/range, frozen master plan/source/pair/region/Requester Pays and full reviewed child descriptor.
- Failed key `USDJPY/2021/00/08_ticks.bi5`; failed attempt ID `a9c06341-7832-47f0-896f-8e2395d15b3d`, sequence1, INITIAL, ERROR/SESSION_EXPIRED, CLASSIFIED record hash `cf0432feb3f07e98351595e20ccd61fcf059320f2921b83cb154063b91ab522d` and classification/accounting linkage.
- Original approval ID/hash, retained descriptor and original immutable error-progress evidence.
- Current ledger hash `6ca217a2fff58ad802602cbfe6bbf774b1494c1fde2fbb6266ef1db169f86707`, generation1, current caps/counters, STOPPED/ERROR campaign and child states and expected per-key count1.
- Partial output revision `afe333d92640ff64c35c9f707186bc2c161ca1cd183b14ed56cbbaec717facb0` and its wrapper hash `80eb50ef463ada1228a96a64f1c22794ca485cbd990e53e6100636df35ab9480`; separately bind current initial campaign revision rather than silently replacing it.
- Applied cap authorization ID `task116-cap-30day-20261007115030133-7a15b71f` and hash `270eb5179396c60a7cb15e6d30f9839e0f3e56ee656a7e179445ae87a88b7ab9`, plus any newly reviewed cap/budget amendment evidence and resulting generation/reference.
- Exactly one classified-error retry allocation, failed-key-only scope, next cumulative sequence2, separate normal/indeterminate consumption, expiry, GET/network/verified caps0 and disabled LIST/download.
- Explicit predecessor/retry linkage, one-time consumed/apply identity, immutable resume seed policy and permitted STOPPED-to-ACTIVE/IN_PROGRESS transition. No new approval or retry should be selected by implicit latest lookup.

## Future Audit History Representation

If a separately authorized second attempt were later implemented and executed, it must use a new attempt UUID, same key, cumulative sequence2 and an explicit reference to the failed attempt/retry ticket. Existing journal supports a new RETRY event only with sufficient ordinary authority; a proposed CLASSIFIED_ERROR_RETRY kind and its own debit would require schema/gate/journal extensions because that kind does not currently exist.

Keep attempt1 RESERVED/MAY_HAVE_BEEN_SENT/CLASSIFIED and its settled normal debit unchanged. Use distinct retry-specific approval/progress evidence, not an overwrite of original approval-bound ERROR progress. Preserve the partial snapshot and publish a new immutable result snapshot after any authorized execution. The final snapshot may show the latest successful/absent key state, but snapshots alone do not encode the complete attempt history; original failure and retry linkage must remain in the append-only journals/authorizations. Future completion must verify all seven keys terminal and retain outside-child entries before Child2 advances.

## Audit Verification

- Hash wrappers verified for current ledger, original approval, CLASSIFIED event and explicitly selected partial snapshot. Failure classification/accounting linkage and expected counts matched durable state.
- Arithmetic independently checked: normal remaining29, recovery remaining5, global remaining34, missing classified replacement allocation1, and required cap45 if all five recovery slots are preserved. These are audit calculations, not approved amendments.
- No applicable legacy indeterminate marker exists for the failed key. The current head accounting is INITIAL/settled; child context has HEAD1 and recovery0.
- Full production manifest before/after matched, including original failure/progress/snapshot, approvals, attempts, raw files and lock evidence. Source/dependency working diff hash also matched.
- No store acquire, gate, reconciliation, preparation, budget apply, SDK session, credential provider, AWS CLI or retry API was invoked. No process or credential probe was performed.
- Only this Markdown report was created outside the production store. No source, dependency, IAM, DB/migration, counter/state or approval changes; no commit/push.

## Authorization State

Retry authorized: **false**

Child 1 completed: **false**

Child 2 preparation allowed: **false**

30-day campaign completed: **false**

Bulk download authorized: **false**
