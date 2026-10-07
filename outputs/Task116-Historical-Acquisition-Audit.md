# Task116 Historical Acquisition Feasibility Audit — Phase 3

Audit date: 2026-10-06  
Branch: `feature/v1.2-task116-historical-acquisition`  
Scope: repository/local artifacts only. No web, network, download, provider, API, code, DB, strategy, commit, or push changes.

## 1. Verdict

**Near-term recommendation: sequential daily Dukascopy Historical Data Export BID/ASK CSV artifacts, followed by the existing Phase 2 CSV adapter and Phase 1 streaming preparation.** This is the only acquisition path in the repository with a real observed schema/sample and a tested source adapter. First pilot one day and verify that the exporter can produce matching, bounded daily artifacts with acceptable size and license terms; these exporter capabilities are not established by repository evidence.

`IHistory.getTicks` and `IHistory.readTicks` are not present in this TypeScript/Next.js repository, and no JForex SDK/dependency exists. Their signatures, paging/streaming behavior, limits, timestamp endpoints, timezone, retry semantics, licensing and credentials are **UNKNOWN** here. Do not select one from method names alone. A JForex source adapter should remain separate from the existing Export CSV adapter and should be considered only after its versioned SDK/API contract is available locally and bounded-memory behavior is demonstrated.

No five-year acquisition was attempted. No source-specific limits or disk-capacity estimate is asserted.

## 2. Current Pipeline

```text
Acquisition source (not implemented in repo)
  -> source-specific BID/ASK normalization/synchronization
  -> canonical UTC 1m MID OHLC AsyncIterable
  -> prepareHistoricalDataset (Phase 1)
  -> local manifest + 15m/1h/4h/1day CSV + preparation receipt
  -> loadLocalHistoricalDataset
  -> runFrozenBaselineValidation (frozen baseline / existing 60-20-20 OOS)
```

Acquisition and strategy evaluation are separate. No acquisition step may inspect OOS outcomes or tune parameters.

## 3. Required Dataset

Pair `USD/JPY`, UTC half-open range `[2021-01-01T00:00:00.000Z, 2026-01-01T00:00:00.000Z)`, intended baseline `MID`. Phase 1 consumes canonical 1m bar-start OHLC records, strictly chronological, positive finite prices, exact OHLC invariants, no duplicates or fills. Phase 1 aggregates each UTC `[start,end)` bucket to 15m/1h/4h/1day using first/max/min/last, outputs bucket-start timestamps, records missing-minute quality without interpolation, and emits a separate preparation receipt.

The 24/7 calendar upper bound in this interval is 1,826 days / 2,629,440 minutes. This is a calendar count, not expected observed FX ticks or guaranteed output count.

## 4. Existing Phase 1

`prepareHistoricalDataset` accepts sync/async iterables and holds one bucket accumulator for each target timeframe plus bounded CSV buffers. It fails closed for invalid, duplicate and unordered 1m rows; partial requested-range target buckets are omitted; missing/empty minutes are recorded and not fabricated. It writes a Task116-compatible manifest and actual target-byte SHA-256 values plus `preparation-receipt.json`.

It does not acquire or convert source timezones/prices, retain raw ticks, resume source downloads, or store acquisition checkpoints. The acquisition layer must supply canonical UTC 1m MID and source raw hashes/provenance explicitly.

## 5. Existing Phase 2

`dukascopy-tick-adapter.ts` is specifically for the observed Historical Data Export 1 Tick CSV contract: exact header `Etc/UTC,Open,High,Low,Close,Volume`; second-precision `+00:00` timestamps; BID and ASK files read in lockstep; each tick's OHLC equality required; source order preserved; same timestamp rows allowed and not deduplicated; crossed quotes rejected. It calculates row-aligned MID ticks, aggregates UTC 1m MID, records both raw hashes and spread diagnostics, and can pass the stream into Phase 1.

Its actual one-hour raw smoke passed previously: BID/ASK 13,566 rows each, 3,183 distinct timestamp strings, zero mismatches/decreases/crossed quotes/OHLC violations, 60 canonical minutes. This smoke is regression evidence for the Export adapter, not five-year acquisition evidence. Keep the adapter unchanged and available.

## 6. Acquisition Options

- **A. Historical Data Export CSV:** known local artifact format for the one-hour Tick sample; existing parser/adapter and raw checksum flow. Export automation, selectable maximum period, date endpoint inclusivity, artifact-size limit, export resume and long-range output availability are UNKNOWN.
- **B. JForex `IHistory.getTicks`:** no method declaration, SDK, wrapper, or call site in repo. Return type/materialization, page-size limits, ordering, request boundaries, availability window, behavior during gaps and provider pacing are UNKNOWN.
- **C. JForex `IHistory.readTicks`:** no method declaration, SDK, wrapper, or call site in repo. Whether it streams/callbacks, blocks, pages, buffers internally, or uses inclusive/exclusive bounds is UNKNOWN.
- **D. Other repository acquisition path:** none found. The Node dependencies contain no JForex SDK; no Java/Kotlin source or JForex jar is present. Market-provider clients in this repository do not implement this historical Dukascopy tick acquisition.

Comparison cannot establish external API capability without the exact local JForex SDK version/documentation or an operator-provided contract. No web lookup was used.

## 7. Historical Data Export

This is the recommended first path because the repository has an observed one-hour pair of separate BID/ASK Tick CSVs and an adapter that validates that specific schema. The observed pair totals 1,778,786 bytes (BID 889,567; ASK 889,219) for 13,566 rows per side. This is only that one hour; tick density varies, so it must not be extrapolated as a five-year storage estimate.

Unknowns to pilot: can the Export UI reliably produce a complete UTC day or week; maximum date span/file size; whether export ranges include both endpoints; repeatable automation; artifact revisions; licensing/retention rights. Preserve the exact CSV artifacts and their byte hashes if policy allows.

## 8. JForex getTicks

Repository evidence: no `IHistory`, `getTicks`, JForex import, SDK jar or adapter path. Everything else about this method is **UNKNOWN**: result type, maximum ticks/request, page cursor, memory materialization, source ordering, duplicate semantics, pair/side selection, timezone/timestamp precision, interval endpoint semantics, retries and rate limits. Before adoption, prove that the versioned method can return a bounded ordered cursor/page or callback and can resume a half-open UTC interval without gaps/overlaps. Do not assume `get` means an in-memory list or a stream.

## 9. JForex readTicks

Repository evidence is equally absent. Whether it differs from `getTicks` in blocking, callback, range arguments, pagination, memory use or completeness is **UNKNOWN**. Inspect the exact local SDK signature and its bundled versioned documentation before designing a caller. Do not infer streaming behavior from the name `readTicks`.

## 10. Recommended Acquisition Path

1. Use the currently verified Export CSV BID/ASK adapter as the first end-to-end route, with sequential, non-overlapping UTC daily chunks if the Export tool supports them.
2. Pilot one complete day and validate exact source range, pair/timezone, both sides, row alignment, file sizes, missing intervals, OHLC-equal tick semantics and Phase 1 output before expanding.
3. If a daily artifact exceeds practical local handling/export limits, reduce to UTC-hour chunks and feed their adapters through a chronological canonical-minute combiner. Do not parallelize large acquisition by default.
4. Evaluate a JForex adapter as a separate implementation only after exact `getTicks`/`readTicks` contract and SDK version are supplied. Both adapters should produce the same canonical 1m MID interface and provenance structure; Phase 1 remains shared.

Daily is a recommendation for pilot granularity, not a claim that the UI/API supports it or that the entire 2021–2025 range has already been exported.

## 11. Source Adapter Boundary

Keep Export CSV and JForex source logic separate:

```text
Export BID/ASK files -> existing Export Tick adapter ─┐
                                                      ├-> canonical UTC 1m MID -> Phase 1
JForex history API -> future JForex adapter ──────────┘
```

The shared layer should accept a chronological `AsyncIterable<Candle>` and source receipt/raw-checksum metadata. It should not know SDK classes, credentials, fetch policy or source-specific timestamp/price-scale rules. Existing Phase 2 must not be rewritten to accommodate JForex.

## 12. Chunk Strategy

The requested 1,826 days imply approximately 43,824 UTC hour chunks, 1,826 UTC day chunks, or 261 seven-day chunks if the source supports those exact partitions. These are date partitions, not guaranteed source requests/files.

- **Hour:** lowest rework per failed artifact and smaller per-file working set; highest artifact/manifest/checkpoint count and more seams (43,824 pairs if two files per chunk). Strong fallback when daily exports are too large.
- **Day:** recommended first pilot (1,826 pairs); aligns with UTC daily buckets and bounds retry/re-export to one day. Each artifact may be larger; actual export size/limits unknown. Existing filename parser can represent same-date `00`–`23` interval, subject to exporter verification.
- **Week:** about 261 chunks and lower bookkeeping, but larger artifacts, longer recovery/retry time and higher risk of source/export limits. Cross-date filename/metadata behavior is not verified by the existing adapter; split into same-date chunks unless source naming/adapter support is proven.

Measure actual bytes/ticks per pair/day over representative active and quiet periods before deciding whether daily chunk size is acceptable. Do not extrapolate from the single-hour sample.

## 13. Boundary Semantics

Target interval is `[2021-01-01T00:00:00Z, 2026-01-01T00:00:00Z)`. Desired chunk ownership is also half-open and non-overlapping, e.g. adjacent UTC days `[D 00:00, D+1 00:00)` and `[D+1 00:00, D+2 00:00)`.

Whether Export or JForex request endpoints are inclusive/inclusive, inclusive/exclusive, or rounded to second/minute resolution is **UNKNOWN**. Do not implement endpoint subtraction until source precision and filtering behavior are known; subtracting one second could discard multiple same-second ticks. If source windows overlap, retain both raw artifacts and fail the canonical merge on duplicate minute/boundary collision. Any future overlap reconciliation must be an explicit audited policy comparing exact records and artifact provenance; never silently deduplicate.

## 14. Resume / Checkpoint

Maintain a machine-readable acquisition manifest per pair/chunk with: source/method/version, requested half-open bounds, side artifact IDs, state (`PLANNED`, `RUNNING`, `COMPLETE`, `FAILED`, `VERIFY`), attempts, start/end acquisition timestamps, raw hashes, actual first/last timestamp, row/tick counts, error classification, and checksum verification result.

Write checkpoint updates atomically (temporary file then rename). On resume, skip only chunks marked complete whose required BID/ASK artifacts exist and re-hash to the recorded raw digests; revalidate pair/range/schema before merge. Partial downloads remain incomplete/quarantined, never feed Phase 1. Keep completed chunk receipts append-only or version them when artifacts are replaced.

## 15. Retry Policy

Acquire sequentially. Retry only explicitly transient failures with bounded exponential backoff and jitter, cap attempts, record each attempt/error/time, then stop and resume from the failed chunk later. Do not retry schema/pair/timezone/checksum/range-integrity errors automatically. Exact transient status/error classes and provider retry-after semantics are **UNKNOWN** until the selected source contract is known.

## 16. Rate / Provider Safety

Export CSV is a manual local artifact workflow and has no repository-controlled API request path. For a future JForex client, begin at one in-flight chunk, apply a conservative configurable delay, honor only documented throttling signals, use bounded backoff and checkpoint after each artifact pair. Default to no parallel bulk fetch. Provider limits and permitted request cadence are **UNKNOWN**; do not pick numeric rates before source terms/documentation are reviewed.

## 17. Raw Retention

- **Canonical 1m only:** lowest storage; sufficient to regenerate Phase 1 target intervals, but loses tick-level provenance, spread checks and ability to reprocess MID semantics.
- **All raw ticks:** strongest audit/reprocess path, highest storage and license/retention burden.
- **Compressed raw chunks:** lossless compression can reduce disk while preserving rows; raw uncompressed hash and compressed-container hash must be separate. Actual compression ratio is unknown.
- **Raw plus canonical 1m:** strongest reproducibility/audit option if source license and disk budget permit; preferred for validation datasets. Store raw side artifacts read-only/compressed and canonical generation receipts alongside them.

Do not retain or redistribute source files until license terms are checked. If retention is restricted, store only permitted derivatives plus source-provided IDs/metadata/checksums and document the resulting loss of reprocessing ability.

## 18. Disk / Memory Considerations

Observed one-hour sample: 13,566 rows and 889,567 bytes BID; 13,566 rows and 889,219 bytes ASK. This one interval is not statistically representative; no five-year raw disk estimate is justified. A naive linear extrapolation would be unsafe.

Phase 2 already reads each side as line streams, does a checksum pass and a parser pass, and holds current minute state rather than whole tick arrays. Phase 1 similarly consumes canonical 1m as a stream and writes four target CSVs. The final Task116 importer loads target CSV text/arrays into memory, so benchmark target loading and five-year validation separately; do not hold raw five-year ticks in JS arrays.

## 19. Provenance

Per chunk record at minimum: source=`Dukascopy Historical Data Export` or exact JForex source/method, pair, requested half-open range, actual first/last source timestamps, timezone, source timeframe/period, price type/transform, acquisition/preparation versions, artifact IDs, raw side hashes, tick counts, side sync/mismatch/duplicate/order counts, spread diagnostics, canonical 1m row count/hash, acquisition timestamp, attempts/retries/errors, and output canonical hash. Phase 1 manifest carries normalized target hashes; Phase 1 receipt carries raw input hash references. Never place secrets in receipts.

## 20. Credentials

No JForex credential config or secret flow exists in this repository. Whether JForex history calls require a logged-in session/account is **UNKNOWN** here. Do not add secrets to source, committed config, report, or a new `.env` assumption. If required, the operator authenticates in the official local client or supplies a separately approved secret-store boundary; adapter receives only an already-authenticated history interface and never serializes credentials.

## 21. Failure Modes

Pair/side mismatch, timezone or price-type ambiguity, unequal BID/ASK streams, out-of-order/repeated overlap across chunks, malformed prices, partial artifact, source revision, unverified checksum, endpoint gaps, provider outage/throttling, disk-full, process termination and license restrictions. Every chunk fails closed, retains diagnostics, is not marked complete until both artifacts and hashes validate, and is excluded from canonical concatenation until repaired. No inferred market closure/outage classification.

## 22. Phase 1 Integration

Merge canonical minute streams from chunks strictly chronologically with `concatenateCanonicalMinuteChunks`; current helper rejects overlapping/equal minute candles and backwards timestamps. Then call `prepareHistoricalDataset` once for the full requested range with `priceType: MID`, source metadata, chunk artifact IDs and raw checksums. Do not call Phase 1 separately per hour/day into the same destination; it creates a complete manifest/output directory atomically and refuses overwriting an existing output.

## 23. Phase 2 Regression

Keep `dukascopy-tick-adapter.ts` unchanged. Its real-file smoke PASS (13,566 synchronized ticks per side, 60 canonical minutes, independent 3-minute checks) is the known baseline. Acquisition chunking must supply filenames/source metadata satisfying that adapter or use a future independent adapter, and chunk concatenation must fail on duplicate minute boundaries.

## 24. Task116 Integration

The result is the existing four target CSVs/manifest/receipt imported by `loadLocalHistoricalDataset`, then passed to frozen-baseline validation. The acquisition plan does not alter pair set, signal semantics, costs, risk, split ratios, Train/Validation/OOS access or consumption state. Record actual coverage/missing data and do not fill gaps.

## 25. OOS Safety

Acquire and validate data before running Task116. Keep the fixed chronological split and frozen baseline. Acquisition/quality decisions may not use OOS performance to select chunk policy or tune signals. Do not inspect OOS metrics while changing strategy parameters; any future strategy decision informed by OOS consumes that period per existing Task116 semantics.

## 26. Implementation Proposal

1. Keep current Export CSV adapter as the verified Export source adapter.
2. Build an acquisition manifest/checkpoint orchestrator around sequential per-day BID/ASK artifacts, with hour fallback after a size pilot; preserve raw hashes and artifact identity.
3. Pilot one UTC day from the chosen source, measure artifact bytes/ticks/time, validate exact requested-vs-actual ranges and endpoint behavior, then retry/resume and reproducibility-test it.
4. Feed successful chunks through existing adapter streams and strict canonical-minute chunk concatenation, then one Phase 1 preparation invocation for the five-year requested range.
5. Only if automation requirements remain unmet, inspect a specific local JForex SDK/API version and design a separate JForex adapter after confirming its streaming/page/range contract. Do not implement both paths speculatively.

Audit-only: no code, data, network, DB or strategy changes made.

## 27. Tests Required

- Exact requested 5-year half-open UTC coverage; first/last actual timestamps and gap inventory.
- Chunk plan generation for day/hour, no overlap, exact adjacency, leap day/year boundary.
- Resume skips only hash-verified complete chunks; missing/corrupt/partial side restarts only that chunk.
- Raw BID/ASK exact hash and independent canonical output hash; deterministic receipts.
- Adapter BID/ASK lockstep per chunk, ordering and duplicate timestamp policy, Tick OHLC equality, ASK>=BID.
- Inclusive endpoint fixture demonstrating overlap is detected/fails and never silently deduped; separately test chosen source half-open request semantics once documented.
- Sequential retry/backoff state machine, bounded attempts, fatal schema errors not retried, fake provider request count/rate guard.
- Multi-chunk concatenation future/range and canonical minute strict chronology; Phase 1 importer validation on representative target outputs.
- Synthetic 5-year streaming generator benchmark: elapsed, peak RSS/heap where possible, raw chunk counts and target rows. Do not claim synthetic volume as source-volume forecast.
- Credential values absent from logs, checkpoint, receipt and Git; raw artifact paths ignored/not staged.

## 28. Decisions Required

1. Source path for actual five-year run: manual Export, a specified JForex SDK method/version, or approved alternative.
2. Source license/redistribution/retention rights and whether raw/compressed BID/ASK chunks may be kept.
3. Export/API maximum period, file size/tick count, timestamp precision, timezone, missing-data and correction behavior.
4. Whether full five-year acquisition is expected from the currently observed one-hour Tick sample workflow or a different export workflow.
5. Daily vs hourly chunk choice after an actual full-day size/retry pilot.
6. Source range endpoint semantics and timestamp resolution; protocol for boundary overlaps and inclusive ranges.
7. Credential/authentication mechanism (if any), safe local secret-store boundary and operator ownership.
8. Provider request limits/delay/retry rules from an authoritative local contract.
9. Required raw retention period, storage budget, compression format and manifest/checkpoint versioning.
10. Acceptance budgets for acquisition time, disk, peak RSS and five-year Task116 validation runtime.

## 29. Risks / Unknowns

- No JForex API or SDK exists in this repository; `getTicks` and `readTicks` semantics are UNKNOWN.
- Dukascopy Export range/file-size limit, automation/resume and endpoint inclusivity are UNKNOWN.
- Sample covers one hour only; observed ~0.87 MiB/side and 13,566 rows/side cannot estimate five-year storage/ticks.
- Licensing/retention rights, credentials, throttling, history revisions and source outage behavior are UNKNOWN.
- Daily/weekly artifacts may be too large or exporter may not support them; pilot before choosing final granularity.
- Current Phase 2 chunk filenames are same-date source-file conventions; cross-date weekly filenames have no verified support.
- Inclusive boundary duplicates cannot be safely reconciled from timestamp alone because multiple distinct ticks may share timestamps; fail closed until source contract resolves it.
- Final loader and repeated as-of validation may dominate memory/runtime after raw streaming succeeds; benchmark separately.

## 30. Final Recommendation

For a scalable five-year candidate, evaluate the operator-reported official S3 route via a bounded, sequential one-day pilot, but do not implement/use it until a real one-day `.bi5` artifact and authoritative decoder example establish the format. Existing Export CSV + Phase 2 adapter remains the verified reference path and should be retained for cross-source validation. S3 object layout, byte sizes, endpoint rules, Requester Pays invocation details and BI5 records are not verified here. JForex `getTicks`/`readTicks` remain unselected UNKNOWN alternatives. This is an audit recommendation only; no acquisition implementation or external request was performed.

## S3 / BI5 Compatibility Audit

Operator-provided information (not independently browsed or confirmed): Dukascopy documents an AWS S3 Historical Price Data bulk-download route, `eu-west-1`, Requester Pays, instrument discovery, historical `.bi5` tick artifacts, an example decoding/export pipeline, start/end processing, and raw artifact retention. Treat each as a source lead requiring a local one-day artifact smoke and versioned contract before production use.

### 1. Updated Verdict

S3 is a promising candidate for reproducible bulk acquisition, while the Export CSV adapter remains the only currently implemented/real-file-smoked source path. Minimal architecture is a separate S3 acquisition layer plus a separate BI5 decoder/source adapter; both converge on canonical UTC 1m MID and the unchanged Phase 1. Do not implement until an actual one-day S3 artifact and decoder contract are available offline.

### 2. Official S3 Source Boundary

The bucket/requester-pays/region/instrument-discovery facts above are supplied by the operator. This audit made no AWS call, web lookup, listing, download, credential check or cost calculation. Exact bucket URL, object-key naming, permissions, object granularity and source version remain **UNKNOWN** locally.

### 3. Acquisition Architecture

```text
AWS/S3 acquisition controller (outside lib/backtest; not implemented)
  -> immutable raw .bi5 chunk files + chunk checkpoint/receipt
  -> independent BI5 decoder/source adapter (not implemented)
  -> verified source tick records with explicit BID/ASK synchronization
  -> MID tick -> canonical UTC 1m MID AsyncIterable
  -> existing prepareHistoricalDataset (Phase 1)
  -> Task116 local loader / frozen validation
```

The acquisition controller owns AWS calls, Requester Pays, dry-run, retries and checkpoints. The decoder owns only raw artifact bytes to source records. The existing Export CSV adapter remains a separate source adapter. No AWS/S3 classes belong in the strategy/backtest simulator or Phase 1.

### 4. BI5 Unknowns To Verify

No BI5 artifact, decoder package, official example or binary fixture is present in this checkout. Do not infer any layout from `.bi5` extension. Verify from an operator-supplied, versioned official example and one real artifact:

- compression/container format and whether compression is per-file/per-block;
- record byte size, framing, endian, version markers and truncated-record detection;
- timestamp representation, epoch/base, resolution, timezone and ordering;
- whether BID/ASK are paired in one event record or separate records/streams;
- quote-side flags/encoding and exact synchronization/event identity semantics;
- integer/decimal price scale, units, rounding and valid ranges;
- volume representation/units and whether it is meaningful for ticks;
- file/object naming, instrument encoding, period partition and chunk boundaries;
- requested-hour/day boundary inclusion and timezone/DST semantics;
- missing object vs empty object vs no-trade period behavior;
- source ordering and duplicate/equal timestamp behavior.

All items above remain **UNKNOWN** until verified. The Export CSV sample schema is not evidence for BI5 byte layout.

### 5. Decoder Boundary

Keep current `dukascopy-tick-adapter.ts` unchanged. A future `DukascopyS3Bi5Adapter` should receive an already acquired raw file stream/path plus verified instrument/range/decoder metadata and yield source records through a bounded async iterator. It must not contain AWS acquisition, credential lookup, bucket traversal or strategy logic. Decoder version and fixture/raw hashes must be recorded. If source records do not guarantee paired synchronized BID/ASK, the adapter must first implement the verified association key/rule or fail closed; it must not join by approximate timestamp.

### 6. MID Contract

Canonical intended baseline remains `MID=(BID+ASK)/2` per synchronized same-tick event. Use it only after the real BI5 layout establishes that the values are same-event BID and ASK and shows their exact ordering/association. Do not infer synchronization from equal timestamps alone when multiple events can share a timestamp. Do not average aggregated BID/ASK OHLC highs/lows. Preserve source decimals without unsupported rounding; any canonical serialization precision policy must be explicitly verified.

### 7. Checkpoint Design

One manifest entry per planned raw chunk, with atomic checkpoint replacement. Required fields: source/method/version; pair; bucket/key or artifact ID; requested half-open range; status `PLANNED`, `DOWNLOADING`, `DOWNLOADED`, `VERIFIED`, `DECODED`, `FAILED`; attempt count; download/acquisition timestamp; raw byte size; raw SHA-256; actual first/last decoded tick; decoded tick count; BID/ASK sync/mismatch counters; canonical minute count; decoder version; canonical output checksum; error type/detail. Keep credentials/tokens out. Mark `DECODED` only after full validation and checksum verification; partial outputs remain quarantined.

### 8. Requester Pays Safety

Treat AWS cost as an explicit operator-approved boundary. Require explicit pair and start/end dates; default pilot to one UTC day; require a dry-run inventory showing planned object count, keys and known object sizes before transfer; impose a configurable maximum object count/byte cap and explicit confirmation. Never recursively copy the whole bucket, never silently expand range, and do not enable parallel bulk transfer by default. Checkpoint each successfully verified artifact. Exact CLI flag/permissions and pricing remain for the operator-provided official instructions; no actual price estimate is possible without object sizes/current AWS pricing.

### 9. Raw Retention

- **Raw `.bi5` retained:** highest re-decode/audit ability; potentially highest disk and license-retention burden; preserve immutable bytes and their SHA-256.
- **Raw losslessly compressed/archived:** retains decoder reprocessability if archive handling is verified; store original raw hash and separate archive/container hash/size. Do not assume `.bi5` is or is not already compressed.
- **Canonical 1m only:** smallest source history but cannot audit tick MID/synchronization or re-decode changed logic.
- **Raw + canonical 1m:** preferred for validation reproducibility if license and storage policy allow; keep raw and derived files in separate locations/namespaces and record transform versions.

Do not commit raw source artifacts. Check redistribution/retention rights before choosing retention duration.

### 10. Cross-Source Validation

Use the known Export CSV reference interval `USD/JPY, 2025-01-06 12:00–13:00 UTC` after obtaining an S3 artifact for the identical interval. Independently decode both sources to canonical 1m MID and compare all 60 minute timestamps plus open/high/low/close. Report differing rows and deltas; any unexplained difference is FAIL/investigation, not a reason to silently select one feed. First verify both artifacts cover identical events/ranges and price precision. Do not require raw byte equality. If source coverage differs, label comparison inconclusive rather than normalizing away gaps.

### 11. Performance

Stream S3 object bytes through bounded decompression/record decode into one synchronized tick-pair state and one current 1m accumulator, then emit canonical minutes. Buffering in the AWS CLI/process pipe, decompressor implementation, SDK callbacks, page fetches or native decoder is currently **UNKNOWN** and must be measured. Do not accumulate five-year tick arrays. Measure one-day pilot elapsed time, peak RSS/heap, raw bytes, decoded ticks, canonical rows, decompression CPU and retry overhead before planning scale. Existing Phase 1 retains only per-target bucket accumulators and bounded CSV writers; Task116 replay remains a separate time/RSS benchmark.

### 12. Security

Never hardcode AWS credentials, commit them, log them, store them in checkpoints/receipts, add them to `NEXT_PUBLIC_*`, or place secret values in reports/chat. Use the standard local AWS credential chain/profile or operator-approved secret store; do not assume or create `.env` entries. Use least privilege scoped to required bucket/object prefixes and read-only actions. No credential value was accessed in this audit.

### 13. Tests

Extend the future source-adapter tests with: real-format decoder fixture from a licensed/sample artifact; corrupt/truncated `.bi5`; invalid record/scale; timestamp ordering/duplicate policy; verified BID/ASK event pairing; MID calculation; canonical minute OHLC; empty/missing object distinction; day/hour chunk chronology and overlap failure; raw/derived checksum separation; deterministic decode; future append invariance; checkpoint resume and failed download state; dry-run/planned object count/date guard/no recursive bucket traversal; sequential retry cap; no secret leakage; Export-vs-S3 60-minute all-row comparison; Phase 1 integration; mocked S3 request count/rate guard. Unit tests must use a mocked local transport and make zero network requests.

### 14. Implementation Plan

1. Obtain a versioned official decoder example/specification and one-day `.bi5` artifact locally; hash raw bytes before decoding.
2. Verify record layout, tick pairing, price scale, time base, sort/duplicate and interval-boundary semantics against a small hand-inspected sample.
3. Implement a separate decoder adapter emitting a bounded stream of verified BID/ASK events; add corrupt/truncation and deterministic fixture tests.
4. Add a separate acquisition/checkpoint tool that requires explicit range, dry-run inventory/size cap, sequential transfer and per-object hash checkpoints.
5. Run a one-day S3-to-canonical MID pilot; cross-compare all 60 minutes with the Export CSV reference.
6. Send verified canonical 1m through Phase 1 and Task116 loader, then benchmark full target preparation and replay separately.
7. Expand day-by-day with resume only after pilot, license, memory, rate and endpoint behavior are approved.

### 15. One-Day Pilot Plan

Pair USD/JPY, `[2025-01-06T00:00:00Z, 2025-01-07T00:00:00Z)`, but first perform an S3 dry-run object inventory only after operator authorizes AWS access. Verify planned object count/size and Requester Pays conditions; do not execute in this audit. Acquire only the one day in the future implementation. Decode/hash and compare the overlapping 12:00–13:00 UTC interval against the retained Export reference. Then validate missing minutes, first/last event, cross-boundary completeness, target Phase 1 load and receipt. This pilot range is a plan, not a claim that a full-day artifact currently exists.

### 16. Five-Year Plan

After pilot success, generate a deterministic plan for 1,826 UTC calendar-day chunks across `[2021-01-01T00:00:00Z, 2026-01-01T00:00:00Z)`, subject to actual source object layout. Estimate planned objects/known bytes from dry-run inventory before downloading; unknown sizes stay explicitly unknown. Process sequentially, checkpoint verified chunks, resume only checksum-matching completed chunks, and stop on the first integrity/range contract failure. Aggregate chunk canonical streams chronologically into one Phase 1 invocation; never feed partial acquisition into Task116.

### 17. Risks / Unknowns

- S3 bucket/object-key scheme, instrument discovery protocol, exact region endpoint and Requester Pays CLI syntax are operator-provided leads but not locally verified.
- `.bi5` compression, record layout, BID/ASK pairing, price scale, volume, timestamp resolution, ordering/duplicates, empty/missing object semantics and chunk boundary inclusivity are UNKNOWN.
- AWS identity requirements, authorization scope, throttling, retry-after behavior, limits and current costs are UNKNOWN.
- Full-year/year-boundary instrument coverage, source revisions/corrections, timezone/session semantics and source/license retention rights are UNKNOWN.
- One-hour Export sample does not predict S3 artifact sizes or five-year tick volumes.
- A silent seam overlap could duplicate same-timestamp ticks; exact tick timestamps may not uniquely identify events.
- Adapter/decompressor internal buffering and full five-year Task116 replay cost need measured pilots.

### 18. Final Recommendation

Treat official S3 as the leading candidate for automated bulk acquisition only after operator supplies the exact local decoder example/spec and a one-day artifact. Start with a bounded Requester Pays dry run and one-day pilot; preserve raw hashes and chunk checkpoints, keep transfers sequential, and require all-60-minute canonical comparison with the verified Export CSV reference before scaling. Keep Export CSV adapter untouched as the reference path. JForex methods remain UNKNOWN and are not required if S3 pilot meets reliability/reproducibility needs. No web/AWS access, download, code, DB, or strategy operation occurred in this audit.
