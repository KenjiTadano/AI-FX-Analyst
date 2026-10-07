# Task116 Dukascopy S3 / BI5 Historical Acquisition Foundation — Phase 3

Date: 2026-10-06
Branch: `feature/v1.2-task116-historical-acquisition`
Scope: offline decoder/planner/checkpoint foundation with fake transports only. No AWS access, S3 list/download, network, DB, or strategy changes. No commit/push.

Compression contract corrected on 2026-10-07 after the real one-day artifact diagnostic: the current decoder uses explicit LZMA-Alone framing, not headerless raw LZMA. Historical regression numbers below describe the initial foundation run; production pilot revalidation is recorded separately.

## 1. Verdict

Implemented a BI5 decoder and S3 acquisition foundation. The corrected compression contract is LZMA-Alone, confirmed on the real daily artifact; one daily object uses the zero-index-month key, and missing keys are recorded as `NO_DATA`. It decodes the `>IIIff` 20-byte USDJPY contract, validates same-record BID/ASK, emits canonical UTC 1m MID candles, and connects available artifacts to existing Phase 1 once. Planning is deterministic and dry-run by default; no recursive S3 discovery or AWS request was made. Formal production validation is recorded in the separate one-day pilot revalidation report.

## 2. Scope

Added `lib/backtest/dukascopy-bi5-adapter.ts`, `lib/backtest/dukascopy-s3-acquisition.ts`, synthetic/unit tests and this report. Existing Export CSV adapter remains unchanged. The local `xz` command-line decompressor is isolated behind `Bi5Decompressor`; source metadata/decoder do not know about AWS credentials or networking.

## 3. Official Source Contract Used

The current contract is: bucket `cfg-public-proper-wallaby`, region `eu-west-1`, Requester Pays; LZMA-Alone framing (13-byte header, not an `.xz` container or headerless raw stream); one full UTC day per `.bi5`; key `SYMBOL/YYYY/MM/DD_ticks.bi5`, with zero-indexed month; missing objects mean source `NO_DATA` and empty files are not supplied. The BI5 record format remains `>IIIff`, 20 bytes, `(milliseconds, askInteger, bidInteger, askVolumeFloat, bidVolumeFloat)`, timestamp `UTC day start + milliseconds`, USDJPY point value 1000. The initial foundation was offline; the framing correction is grounded in the separately documented real-artifact diagnostic without new S3 access.

## 4. Architecture

```text
Local deterministic daily-key planner / download transport boundary (no AWS implementation)
  -> immutable .bi5 raw artifact + exact raw SHA-256 + checkpoint
  -> separate BI5 decoder
  -> same-record BID/ASK -> MID ticks
  -> canonical UTC 1m MID stream
  -> one existing Phase 1 prepareHistoricalDataset invocation
  -> existing Task116 manifest/CSV/receipt/loader/validation
```

Export CSV adapter remains the separate verified reference adapter. No AWS-specific types or calls were added to Phase 1, Phase 2 CSV adapter, simulator or strategy validation.

## 5. BI5 Decoder

`createDukascopyBi5MidStream` hashes exact raw bytes, checks an optional expected raw hash, explicitly LZMA-Alone-decompresses one artifact, verifies decompressed length in record units, then parses records in original order. It keeps a decompression chunk plus at most 19-byte carry and one current-minute accumulator; it does not build a tick array. Only the verified instrument mapping USDJPY -> pointValue 1000 is accepted.

## 6. Record Layout

Each 20-byte record uses big-endian reads: uint32 milliseconds at offset 0, uint32 ASK integer at 4, uint32 BID integer at 8, float32 ASK volume at 12, float32 BID volume at 16. Volumes must be finite and non-negative and are recorded in no strategy calculation. This unchanged layout was initially based on the operator-provided contract and is now validated on the real 2025-01-06 USDJPY artifact by the separate diagnostic and production revalidation.

## 7. Timestamp

`sourceUtcDay` is required as a valid `YYYY-MM-DD`; record milliseconds must be less than 86,400,000. Tick timestamp is UTC midnight plus milliseconds and is serialized canonical ISO UTC. No local timezone/DST inference. Equal timestamp records are accepted in original order; a decrease fails closed.

## 8. Price Scaling

Only `USDJPY` is mapped, with `ask=askInteger/1000`, `bid=bidInteger/1000`. Unknown instruments fail closed; no generalized point scale is inferred. Scaled values must be finite positive and ASK must be >= BID.

## 9. BID/ASK Synchronization

BID and ASK are in the same binary record per the supplied contract, so the adapter does not create separate quote files or join by timestamp. It consumes that record as one event. Exact timestamp tie and source order are preserved. If actual BI5 decoder findings contradict same-record association, stop and revise the source adapter contract before use.

## 10. MID

`mid=(bid+ask)/2` with JavaScript numeric precision and no pip/decimal rounding. Aggregated BID/ASK OHLC is never averaged. Tick-level BID/ASK pairing must be verified before treating decoded data as baseline MID.

## 11. Canonical 1m

Ticks are grouped by UTC minute `[minuteStart, minuteEnd)`: first MID open, max MID high, min MID low, last MID close. Output timestamp is minute start. Empty minutes produce no candle; no interpolation/forward-fill/synthetic minute. Existing Phase 1 then generates 15m/1h/4h/1day.

## 12. Corruption Handling

Fail closed on unavailable/failed LZMA-Alone decoder, invalid instrument/day, raw hash mismatch, decompressed byte count not divisible by 20, out-of-day millisecond timestamp, invalid quote/volume, ASK<BID, timestamp decrease or an empty artifact. An absent S3 daily key is handled by acquisition as `NO_DATA`, not passed to this decoder. Partial emitted rows have no successful receipt. Equal timestamps are allowed, not deduplicated. Headerless raw LZMA and XZ containers are rejected; there is no format auto-detection or fallback.

## 13. Streaming / Memory

Default decoder requires the system `xz` CLI on `PATH` and invokes `xz --format=lzma --decompress --stdout -- <artifactPath>`. No npm dependency was added. The format is explicitly LZMA-Alone; xz reads properties/dictionary/size from the standard header, with no manual header parsing/stripping or raw fallback. One child process/artifact, streaming stdout, 20-byte parser and minute accumulator are used. Artifact raw hashing is a separate bounded read pass and the file is re-hashed after decode to detect mutation. Synthetic fixture creation uses `xz --format=lzma --lzma1=dict=4MiB --compress --stdout`; tests check the 13-byte header fields and default production decode, and reject headerless raw/XZ alternatives.

Synthetic test: 80,000 records / 1.6 MB decompressed, about 107 ms and RSS snapshot delta about 7.4 MB on this machine; this includes Node/process/test overhead and is not an isolated peak-memory guarantee. No five-year BI5 run or hard threshold was used.

## 14. Raw SHA

SHA-256 is computed over exact compressed artifact bytes before decode and compared with optional expected hash. `rawByteSize`, `rawSha256`, bucket/key and decoder version are placed in the per-artifact receipt/checkpoint. Canonical CSV hashes remain generated by Phase 1 and are separate.

## 15. Provenance

BI5 receipt records source name/method, bucket, region, object key/artifact ID, instrument, UTC source day, raw SHA/size, decompressed bytes, record count, first/last decoded tick, equal/decreasing/crossed counts, spread min/max/mean, canonical minute count/range, priceType MID, same-record transform, pointValue, decoder format, record size and `LZMA_ALONE`. This literal replaces the incorrect former compression label; no legacy-label compatibility branch remains. Checkpoints do not contain the compression literal and their schema is unchanged. They include every planned daily key and its state, attempts, download time/raw hash/size/decoded counts/version/errors. Missing keys are explicitly `NO_DATA` with no raw artifact or candle; access denied, Requester Pays, checksum, decode and generic download errors are `FAILED` with distinct categories. Error text is fixed/redacted rather than the transport exception.

## 16. Acquisition Planner

Pure plan requires explicit `instrument`, `startDate`, `endDate`; no default all-history. It creates deterministic UTC calendar-day chunks on a half-open date range and maps each day directly to exactly one key `USDJPY/YYYY/MM/DD_ticks.bi5`; `MM` is `getUTCMonth()` zero-padded (`00` January through `11` December). For example, 2025-01-06 maps to `USDJPY/2025/00/06_ticks.bi5`, 2025-12-31 to `USDJPY/2025/11/31_ticks.bi5`, and 2024-02-29 to `USDJPY/2024/01/29_ticks.bi5`. The range `[2021-01-01, 2026-01-01)` yields 1,826 daily chunks and 1,826 planned keys. USDJPY only.

## 17. Dry Run

Mode defaults to `DRY_RUN`; it generates all daily object IDs/keys locally and reports count, unknown byte-size count, bucket/region, Requester Pays and `transferWouldOccur:false`. It does not call a locator, list S3, make network requests, or download. The one-day pilot dry-run key is known locally as `USDJPY/2025/00/06_ticks.bi5`. A dry-run key is a planned key, not proof the object exists; existence is resolved only by a future explicit per-key transfer request.

## 18. Requester Pays Safety

Every download request carries `requesterPays:true`, bucket and `eu-west-1`. There is no list/locator interface and no recursive prefix/bucket operation. Transfer is sequential and capped by explicit daily-key count and a streaming byte ceiling; it fails before transfer if caps or Requester Pays are not explicit, or a multi-day range lacks `allowMultiDayTransfer:true`. No monetary AWS cost estimate is made.

## 19. Transport Boundary

`DukascopyS3Transport.downloadObject` is the only acquisition boundary. There is no AWS SDK dependency or concrete AWS implementation. A future transport must map confirmed S3 missing-key responses to `DukascopyS3AcquisitionError("OBJECT_NOT_FOUND", ...)`; access denied and Requester Pays responses must use their own categories. Fake transport validates request bounds/Requester Pays and feeds local bytes. Real AWS access is deferred to Pilot task.

## 20. Checkpoint / Resume

Checkpoint statuses: `PLANNED`, `DOWNLOADING`, `DOWNLOADED`, `VERIFIED`, `DECODED`, `NO_DATA`, `FAILED`. Atomic update writes a sibling temp file then renames. Per-day metadata includes requested range/source/bucket/region/instrument, deterministic artifact/key/day, attempts/state, local path, raw size/hash, download timestamp, decoded first/last tick/count/minute count/decoder version and redacted failure. Only object-not-found maps to `NO_DATA`; no empty file is decoded and no candle is fabricated. `NO_DATA` is not counted as a downloaded artifact. Access/download/Requester Pays/checksum/decode errors remain `FAILED`. Resume reuses only VERIFIED/DECODED files whose bytes re-hash to checkpoint; missing or modified local files are fetched as new immutable attempt/hash-named artifacts.

## 21. Raw Artifact Policy

Default raw path is `tmp/dukascopy/bi5-raw`, covered by the current `.gitignore` rule `/tmp/dukascopy/`. Downloader uses `.partial` attempt files and content-hash/attempt names for verified artifacts; it does not overwrite prior raw artifacts or delete them. This task did not create/download BI5 raw files. Confirm Git status before any future commit.

## 22. Phase 1 Integration

`prepareDukascopyBi5HistoricalDataset` sequentially creates decoder streams, concatenates canonical minute candles in strict chronological order, maps raw hashes/object IDs and `priceType:MID` into one `prepareHistoricalDataset` call, then returns per-artifact receipts plus Phase 1 receipt. It does not call Phase 1 per chunk or change Phase 1 semantics. Synthetic full-day test loads all four target CSVs with `loadLocalHistoricalDataset`.

## 23. Cross-Source Comparison Hook

`compareCanonicalMinuteSeries` reports every exact per-index timestamp/OHLC mismatch, missing row or length difference without mutation. `assertCanonicalMinuteSeriesEqual` fails with all mismatch details; no tolerance/normalization is applied. The hook was used on the corrected production BI5 output against the existing production Export adapter for 2025-01-06 12:00-12:59 UTC: all 60 timestamp/OHLC rows matched exactly. See the separate pilot revalidation report for the receipt, source hashes and limitations.

## 24. Tests

`tests/dukascopy-s3-bi5-foundation.test.ts` covers LZMA-Alone header fixture decode and compression receipt, rejection of headerless raw LZMA/XZ without fallback, exact 20-byte `>IIIff` fields/scaling/MID, duplicate timestamps, arbitrary decompression chunk boundaries, UTC day bounds, corruption/truncation, price/volume/crossed validation, checksum, Phase 1 integration, January/December zero-index month keys, leap-day key, one-day/one-key, 1,826-day/1,826-key planning, no recursive discovery, dry-run network/download zero, `NO_DATA` without artifact/candle/FAILED status, distinct access/download/Requester Pays/checksum/decode failures, sequential fake downloads, checkpoint atomicity/resume, credential redaction and strict cross-source comparison.

## 25. Regression

Full contract-correction regression completed:

- `npm test`: **1,330/1,330 PASS**.
- `npm run lint`: **PASS**.
- `npm run build`: **PASS**; Next.js emitted only the environment's Apple Silicon/Rosetta performance warning.
- `npm run test:e2e -- --workers=1 --reporter=dot`: **362/362 PASS**, 4.7 minutes.
- `git diff --check`: **PASS**.
- Synthetic decoder benchmark: **80,000 records / 1.6 MB**, about 107 ms and RSS snapshot delta 7,446,528 bytes in focused run; no hard threshold.

## 26. API Impact

No concrete S3/AWS client or fetch call was added. No network request was made. Fake download transport only in unit tests.

## 27. DB Impact

None. No migration or database import.

## 28. Strategy Impact

No Task113/114/115/116 thresholds, weights, risk, execution, cost, split or OOS semantics changed. Existing Export CSV adapter is unchanged. Task115 remains the existing single-price gross simulator.

## 29. Changed Files

- `lib/backtest/dukascopy-bi5-adapter.ts`: separate BI5 decoder, canonical minute stream, Phase 1 wrapper, cross-source comparator.
- `lib/backtest/dukascopy-s3-acquisition.ts`: pure daily-key planner, download transport interface, dry-run summary, safety guards, sequential fakeable transfer/checkpoint foundation.
- `tests/dukascopy-s3-bi5-foundation.test.ts`: synthetic decoder/planner/checkpoint/Phase 1 tests.
- `outputs/Task116-Dukascopy-S3-BI5-Foundation.md`: this report.

No `.gitignore`, Phase 1, Export adapter, simulator, strategy or DB file changes.

## 30. Known Limitations

- The initial foundation accessed no real `.bi5`; subsequent one-day diagnostic confirmed LZMA-Alone framing. Formal corrected-production evidence belongs to the separate pilot revalidation report.
- `xz` must be installed on `PATH`; production uses explicit LZMA-Alone and standard header interpretation. There is no raw fallback or support claim for other framing variants.
- No concrete S3 transport exists. The key layout and one-object-per-UTC-day granularity are implemented from the current official contract, but live object existence and Requester Pays behavior have not been exercised.
- A future transport must distinguish a true missing-key response from access-denied and Requester Pays errors; only the former may become `NO_DATA`.
- No actual Requester Pays operation, AWS rate/price, full five-year raw size, or five-year real tick runtime was measured.
- `tmp/dukascopy/bi5-raw/` is ignored but was not populated in this task.

## 31. One-Day Pilot Requirements

After explicit authorization for a future pilot: dry-run locally and confirm the planned `USDJPY/2025/00/06_ticks.bi5` key; request only that exact daily key with Requester Pays (no recursive listing); treat a confirmed missing key as `NO_DATA`, but stop on access/Requester Pays errors; otherwise save to the ignored raw directory, verify raw SHA/size and decode all records; compare the 2025-01-06 12:00–13:00 UTC canonical minutes against Export CSV for exact time/OHLC; document any mismatch and stop on unexplained differences; pass available day data once through Phase 1. No AWS call was made in this task.

## 32. Five-Year Readiness

The foundation deterministically plans 1,826 daily keys. One-day pilot gate results are recorded separately; even a cleared pilot gate is not authorization for five-year acquisition. Explicit acquisition approval still requires object/byte estimates, Requester Pays cost, license/retention and resume/checkpoint review. Dry-run does not assert that every planned key exists; missing dates become `NO_DATA` only when an authorized exact-key request confirms absence.

## 33. Final Verdict

The decoder/planner/checkpoint foundation now follows the corrected LZMA-Alone, daily-key and `NO_DATA` contract with no AWS, DB or strategy changes. The original synthetic-only framing assumption was disproved by the real pilot and corrected following the compression diagnostic. See the separate production revalidation report for current pilot evidence. No five-year transfer is authorized by this foundation document.

## 34. Official Contract Correction

- **Decompressor:** `Bi5Decompressor` remains the adapter boundary. Runtime dependency is system `xz` on `PATH`; current invocation is `xz --format=lzma --decompress --stdout -- <artifactPath>`. No npm dependency was added. The synthetic fixture uses explicit LZMA-Alone compression, checks header fields, then decodes the exact 20-byte `>IIIff` record fields unchanged. The former raw-mode assumption is not retained as a compatibility path.
- **Daily key:** planner generates one deterministic key per UTC day, with zero-indexed month: `2025-01-06` -> `USDJPY/2025/00/06_ticks.bi5`, `2025-12-31` -> `USDJPY/2025/11/31_ticks.bi5`, `2024-02-29` -> `USDJPY/2024/01/29_ticks.bi5`.
- **NO_DATA:** missing expected key is checkpointed as `NO_DATA`, without a raw artifact, decoded ticks or candle. `DOWNLOAD_FAILED`, `ACCESS_DENIED`, `REQUESTER_PAYS_ERROR`, `CHECKSUM_ERROR` and `DECODE_ERROR` remain failures with distinct categories. Phase 1 receives only available BI5 artifact streams, so missing minutes remain missing and are represented by existing quality/coverage provenance.
- **Dry-run:** no recursive discovery, S3 list, network or download. `[2021-01-01, 2026-01-01)` plans 1,826 daily keys; some resolve to `NO_DATA` and are not counted as downloaded artifacts.
- **Regression:** `npm test` 1,330/1,330 PASS; lint/build PASS; single-worker E2E 362/362 PASS (4.7 minutes); `git diff --check` PASS.
