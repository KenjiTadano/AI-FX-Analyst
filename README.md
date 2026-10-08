This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

Unit/integration tests:

```bash
npm test
```

E2E regression (Playwright / Chromium, mocked APIs):

```bash
npx playwright install chromium
npm run test:e2e
```

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

### Task116 Offline Cap Authorization Preparation

```bash
npm run historical:inventory -- cap-authorize-prepare --help
```

PREPARE AUTHORIZATION ONLY - DOES NOT APPLY CAP EXPANSION.

The dedicated command requires an authorization ID, the reviewed campaign ID,
explicit inventory revision, prior ledger hash/generation, master plan hash,
operator approval reference/hash, authorized-at, expires-at, and reason.
Use `--validate-only` to validate and return the candidate hash without any
durable write or production writer lock. Without that flag, only the immutable,
hash-wrapped authorization is saved to the ignored/untracked
`tmp/dukascopy/s3-production/cap-expansions/<authorization-id>.json` location.
Identical replay is idempotent; a conflicting ID fails closed.

The reviewed cap is fixed at 21 to 44 with normal/recovery budgets 30/5 and
children 7+7+7+7+2. Approval lifetime is at most 24 hours; approval must not be
future-dated or older than 24 hours, and expiry must be in the future. Do not put
secrets in the reason or reference. Preparation rejects a writer lock, active
attempt, changed ledger binding, and already attempted/resolved campaign keys.
It never constructs an AWS client, resolves credentials, runs inventory, creates
child approvals, or calls the applying writer. Applying the cap is a separate
operation requiring the prepared evidence; preparation does not authorize
inventory or downloads. No production authorization is included in the repo.

### Task116 Offline Campaign Child Approval Preparation

```bash
npm run historical:inventory -- child-authorize-prepare --help
```

PREPARE CHILD APPROVAL ONLY - DOES NOT EXECUTE INVENTORY.

The command requires explicit campaign/child sequence, ledger hash/generation,
inventory revision, master plan hash, applied cap authorization ID/hash, and
operator reference/hash, authorized-at, expires-at, reason, and approval ID.
The reviewed range, exact ordered keys and caps are derived, not operator options.
Child 1 has seven keys, normal allocation 7, one recovery allowance, HEAD cap 8,
maxObjects 7, maxRetries 0, and GET/network/verified caps 0. Global caps must
exactly match the reviewed ledger, including HEAD cap 44.

`--validate-only` performs zero durable writes and acquires no writer lock.
Normal preparation saves only immutable ignored/untracked evidence at
`tmp/dukascopy/s3-production/child-approvals/<approval-id>.json`. Replay with
identical content is idempotent; conflicting content fails closed. The approval
expires within 24 hours. Never include secrets in operator evidence.

Preparation requires a PENDING current child. Children 2-5 require every preceding
child COMPLETED and the exact predecessor output snapshot as the current revision.
No automatic child chaining occurs. Preparation never calls a runner, reserves an
attempt, changes child status, constructs an AWS client, or resolves credentials.
Separate inventory execution must explicitly select the prepared approval file;
the gate verifies its immutable content and initial ledger binding before changing
the child to IN_PROGRESS. Crash recovery retains the same prepared approval and
existing attempt accounting. No real child approval is created by path tests.

### Task116 Classified-Error Retry Foundation

```bash
npm run historical:inventory -- classified-error-retry-authorize-prepare --help
```

PREPARE CLASSIFIED ERROR RETRY AUTHORIZATION ONLY - DOES NOT APPLY OR EXECUTE.

This path is restricted to Child 1's first key and a settled INITIAL sequence1
CLASSIFIED ERROR/SESSION_EXPIRED. Explicit failure-record, original approval,
progress, partial snapshot, ledger hash/generation, master plan and parent cap
authorization bindings are required. `--validate-only` writes nothing; normal
preparation writes only ignored immutable retry-authorizations evidence.
Operator evidence expires within 24 hours and must contain no secrets.

Future use has separate API steps: `applyTask116RetryCapAmendment` validates an
explicit prepared ticket and publishes a reviewed 44-to-45 cap revision;
`applyTask116ClassifiedErrorRetryAuthorization` allocates one separate replacement
slot and records the stopped-state reopening. Both are evidence-first and
idempotent. Neither executes a HEAD. Historical cap44 approval and failure
journal bytes remain unchanged and are verified against their proven parent
revision instead of being rewritten to cap45.

`prepareTask116RetryExecutionApproval` separately prepares either REPLACEMENT or
CONTINUATION evidence. `runTask116ClassifiedErrorRetry` requires its explicit
ID/hash, retry ticket, phase, seed revision and cap-revision ID/hash. REPLACEMENT
permits one new CLASSIFIED_ERROR_RETRY UUID at cumulative sequence2, linked to
the original attempt and authorization. Its reservation debits the separate
allocation exactly once, not normal or indeterminate budgets. No automatic retry
follows a replacement error; a sent-unknown outcome stops without resending or
borrowing indeterminate reserve. The replacement authorization explicitly allows
zero indeterminate retransmissions.

A successful replacement publishes a new immutable terminal snapshot and becomes
ACTIVE_CONTINUATION; it does not run the remaining six keys. A new explicitly
reviewed continuation approval and separate executor invocation are required.
Old failure/progress/partial snapshot and append-only transition records remain
auditable. Completion requires all seven keys terminal; no Child 2 preparation
or execution is automatic. This is a targeted single-hop amendment foundation,
not a generic cap editor or unlimited retry facility. Foundation tests never
authorize, amend caps, or execute retry against the real production store.

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
