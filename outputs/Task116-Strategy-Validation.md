# AI-FX-Analyst v1.2 — Task116 Strategy Validation / Out-of-Sample Audit

## 1. Current Validation Architecture

Current branch: `feature/v1.2-task116-strategy-validation`; worktree was clean at audit start. Task114 provides chronological single-dataset Direction replay and forward movement summaries. Task115 adds Research trade lifecycle and gross-only metrics. There is no train/validation/OOS split, baseline registry, parameter search, or statistical-validation runner.

## 2. Historical Data Availability

No real OHLC CSV/JSONL/Parquet history dataset was found in the repository. Existing market fixtures generate synthetic candles in tests; examples include 240 bars per timeframe in `tests/ai.test.ts`, 200 4h bars in `tests/market.mjs`, and 199–220/240-bar generated Regime/MTF fixtures. These are test fixtures, not observed market history; their source period is only the generated timestamp span and is not a recorded source dataset.

The tests exercise USD/JPY, EUR/JPY and GBP/JPY. The E2E market fixture is UI-oriented and uses minimal candle data plus supplied indicators; it is unsuitable as long-range historical price history.

## 3. HistoricalDataset Scalability

Task114 `HistoricalDataset` is an in-memory structure with pair and independent arrays for 15m/1h/4h/1day. Validation requires canonical UTC ISO strings, strictly increasing timestamps, unique timestamps and valid OHLC range ordering. It does not detect missing intervals, distinguish weekends/holidays, retain provider/source/license metadata, or define chunked storage. The as-of replay recomputes prefix indicators for each timestamp; correctness is covered, but long-range performance and data-volume limits are not benchmarked.

## 4. Twelve Data Historical Limitations

The current market client requests latest series with `outputsize: "300"`, `timezone: "UTC"`, `order: "asc"`, across 15m/1h/4h/1day. No `start_date`, `end_date`, pagination, historical backfill loop, local export/import, or persistent historical cache exists. OHLC values are validated and sorted; exact duplicate timestamps are deduplicated by last value in the live provider normalizer. Missing interval/gap detection is absent. Existing cache/rate-limit guards are live-data infrastructure, not a scalable historical acquisition method.

At 300 nominal bars, raw timeframe coverage is approximately 3.125 elapsed days for 15m, 12.5 days for 1h, 50 days for 4h and 300 days for 1day before market closures/missing bars. These are nominal durations, not guaranteed coverage.

## 5. Local Dataset Import

Task114 validates an in-memory `HistoricalDataset`, but CSV/JSON file parsing/import is not present. A minimal future local format can be CSV rows `time,open,high,low,close` plus a small metadata/config file for dataset id, canonical pair, timeframe, source, timezone, export timestamp and optional checksum. Keep parser pure and provider-free; reject non-UTC timestamps, duplicates, malformed OHLC and unordered rows rather than silently repairing them. External API acquisition should remain a separate manual process.

## 6. Data Range Requirements

Separate these concepts in config/results:

- Technical warmup: Task114 complete technical frame requires 205 bars because SMA200 slope compares to a five-bar-earlier SMA200.
- Evaluation period: only signal timestamps assigned to that partition count in its metrics.
- Train period: candidate generation/parameter fitting may read this partition only.
- Validation period: candidate selection/rejection; not a fitting substitute to repeatedly optimize against.
- OOS period: final untouched chronological evaluation.

No fixed period length or split ratio is justified by repository evidence. Warmup history may precede a partition boundary, but its indicators must use only candles at or before each evaluated timestamp.

## 7. Current Cost Model

Task115 exposes spread/slippage/commission config fields at zero, labels results `GROSS` and marks all three `Modeled=false`. Its current validation rejects non-zero values; it does not apply costs to entry, exit, R or equity. Therefore Task115 cannot yet run meaningful non-zero cost sensitivity despite having configuration fields.

## 8. Spread Design

The current OHLC type contains one OHLC series and no bid/ask. Provider code requests UTC intervals but does not declare whether values are mid, last, bid or ask. Do not assume mid-price semantics without provider contract confirmation.

- Fixed round-trip pips: simplest sensitivity scalar, but hides which side incurs which price impact.
- Half-spread per side: explicit entry/exit mechanics and direction-aware bid/ask mapping; requires a convention and pair-specific configuration.
- Bid/ask OHLC: most detailed execution input, but no such dataset exists and a single series cannot recover it.

Proposed architecture: `spreadPipsByPair`/spread convention in config, applied adversely at each side/fill, with values unselected until sourced. Do not claim current zero-cost results model actual spread.

## 9. Slippage Design

No current slippage model. Fixed pips per fill is the simplest deterministic sensitivity candidate: worsen every entry and exit fill in the side-adverse direction. “Per trade” and volatility-based alternatives need separate definitions/data; volatility-derived slippage could leak future volatility if not sampled as-of the fill.

## 10. Commission Design

No current commission model. A deterministic JPY-per-unit-per-side or JPY-per-trade input could be applied to both entry and exit; the chosen unit/side convention and actual values are undecided. Quantity is base units and supported quote currency is JPY, so a JPY commission avoids FX conversion.

## 11. Gross / Net Metrics

Task115 currently has realized gross PnL, gross R, gross equity, expectancy and drawdown only; it has no per-trade transaction-cost or net fields. Future sensitivity should return separate gross PnL, costs and net PnL; never overwrite gross.

For an explicit net-equity scenario, future position sizing, net return, net PF/expectancy and net drawdown should use a separately named net equity curve. Gross/net R should share a fixed initial-risk denominator and be labeled separately. Daily loss and consecutive-loss rules need an explicit gross-versus-net basis before implementation.

## 12. Time Split

No split implementation exists. Use a chronological timestamp boundary/config, never random shuffle. Dataset splitting should preserve the time order and record exact inclusive/exclusive UTC bounds, warmup source range and evaluated range. Training, validation and OOS data must be distinguishable in result metadata.

## 13. OOS Isolation

No isolation guard currently exists. Proposed design: candidate generation accepts only Train data; candidate selection accepts Train+Validation results; OOS evaluator accepts one frozen config and returns results without exposing them to ranking/search code. If an OOS result influences any parameter/policy choice, mark that OOS consumed and require a new untouched period for another final evaluation.

## 14. Walk-Forward

Task114 prefix replay can support chronological rolling windows, but Task116 does not need a complex orchestrator first. A future rolling sequence may expand Train and advance Test windows; each fold must retain as-of warmup, frozen per-fold parameters and an aggregate that does not feed later parameter selection from the final OOS result.

## 15. Parameter Inventory

Current adjustable values are spread across Signal, Scenario and Simulator code; there is no central versioned strategy configuration. Threshold/weight/indicator values are strategy inputs; risk controls and fill/cost/timeout values are not Direction predictors and should be reported separately.

## 16. Strategy Parameters

- Direction score bands: WAIT inside (-20,+20); BUY/SELL at ±20; STRONG at ±60.
- Technical contribution weights: price-vs-SMA20 15; SMA alignment 20 each; SMA slope 10 each; momentum 15.
- Timeframe score weights: 15m 0.3, 1h 0.4, 4h 0.3.
- Indicators: SMA20/75/200; RSI14 with <30/>70 contextual bands; Wilder ATR14; recent high/low 20 bars; momentum five bars; SMA slope five bars.
- Extended-market checks: absolute momentum >=2 ATR or price-to-SMA20 distance >=2 ATR.
- Scenario: pullback/return offsets 0.25/0.10 ATR, SL padding 0.10/0.50 ATR, TP2 padding 0.75 ATR; RR >=1.5.

These are current code semantics, not recommendations to tune.

## 17. Risk Parameters

Task115: initial capital ¥50,000, risk/trade 0.5%, tradeUnit 1,000, max concurrent positions 1, max entries/JST day 3, Daily Loss Limit 1%, consecutive-loss limit 3, max holding 24 signal-timeframe bars. These are risk/account lifecycle settings, not Signal Direction weights.

## 18. Execution Parameters

Task115: 1h default signal timeframe; NEXT_CANDLE entry; entry zone open-in-zone fill; ambiguous open-outside/range-intersection cancels; SL protective stop with adverse gap-open; TP1 limit at target price; SL_FIRST; timeout at bar close; opposite Signal does not exit; end-of-data remains OPEN_UNREALIZED; spread/slippage/commission zero and unmodeled. Integrity rules must not enter parameter optimization.

## 19. Non-Optimizable Integrity Policies

Do not optimize same-candle SL_FIRST, confirmed/as-of cutoff, signal-candle exclusion, NEXT_CANDLE entry, adverse stop-gap pricing, no favorable TP gap bonus, or end-of-dataset open treatment to improve backtest results. These define data/execution integrity, not strategy alpha.

## 20. Session Analysis

No FX session classifier exists. Task115 defines JST day boundaries only. London/New York/overlap analysis needs IANA timezone rules (`Europe/London`, `America/New_York`) and DST-aware local intervals; fixed UTC hour labels would shift seasonally. Session boundaries and holiday treatment are not specified. A minimal future segmentation can annotate existing signals by as-of timezone conversion without creating an entry gate.

## 21. Regime Analysis

Task114 Regime includes trending/range/transition/unavailable and high/normal/low volatility; it is computed from as-of 1h candles. Task115 results do not directly include Regime per trade/signal, though signal timestamps can be joined to Task114 replay records. It can be added as descriptive segmentation only; no new entry gate.

## 22. Pair Analysis

Task115 outputs pair distribution. Pair-specific metric summaries can be grouped from simulated trades. Joint multi-pair simulation requires identical signal-timeframe close timestamps; with global maxConcurrentPositions=1, simultaneous candidates across pairs are all blocked rather than ranked. Independent per-pair runs answer a different question and must not be presented as one shared-capital portfolio.

## 23. Sample Size

Task115 includes trade counts alongside metrics. Existing `MIN_INSIGHT_SAMPLE_SIZE=5` is a descriptive UI insight threshold, not a Task116 statistical acceptance policy. No minimum backtest sample rule, confidence interval or evidence grade exists. Treat minimum samples as a decision still required; always show counts and undefined metrics for empty groups.

## 24. Statistical Validation

No confidence interval, bootstrap, Monte Carlo, Sharpe, Sortino, calibration or significance-test implementation was found. Minimal Task116 scope should first retain baseline/chronological OOS separation and descriptive mean/median/positive rate with sample count. Any interval method needs dependence/autocorrelation assumptions before being interpreted; avoid adding a significance claim prematurely.

## 25. Parameter Search

No grid search/optimizer exists. Do not add a search until Train/Validation/OOS data access is structurally separated. If added later, each candidate/result must include config hash, train metrics, validation metrics and a distinct OOS record; ranking APIs must not accept OOS metrics.

## 26. Baseline Strategy

Run current frozen Task113/115 config through Train, Validation and OOS before evaluating any candidate. Store baseline config/version and exact dataset/split metadata locally. Candidate comparisons should reference that baseline while leaving OOS isolated.

## 27. Data Leakage Risks

- Dataset split: random shuffle or overlapping boundaries can put future bars in Train.
- Warmup: indicators may use only bars at/before each evaluated timestamp; warmup data is context, not scored samples.
- Regime/session: join by exact as-of timestamp, not latest/current snapshot.
- Parameter selection: Validation may select; OOS may not rank/tune.
- OOS reuse: any post-result adjustment consumes that OOS.
- Costs: future/current spread or volatility must not price earlier fills.
- Corrections: revised historical values/vintages may differ from what was known at that time.

## 28. Historical Bias Limitations

Available repository fixtures are synthetic, not verified market history. Live Twelve Data code obtains only latest 300-bar series and contains no range/pagination/local import path. Calendar is near-current, not historical. FRED selects latest/previous observations, not vintages. Missing bars, weekends/holidays and provider corrections are not fully represented or tagged. Survivorship is less like an equity-universe issue for fixed FX pairs, but historical instrument/provider availability and revisions still need provenance.

## 29. API Cost

Validation must read local CSV/JSON dataset and never call Twelve Data/Finnhub/FRED/Calendar/AI providers. Keep acquisition separate from replay and add provider-fetch-zero checks. Current latest-window API client must not be used as an OOS history loader.

## 30. DB Requirements

No validation result persistence requirement is established. Prefer local/in-memory/file result output and DB migration 0 until reproducibility/sharing needs are demonstrated.

## 31. Existing Tests

Task114 validates canonical UTC OHLC, strict ordering, as-of cutoff, warmup and future-prefix invariance. Task115 validates simulator policy and deterministic gross results. Market client tests use fake fetches and synthetic bars; there is no real local historical OHLC dataset or split/OOS/optimizer test suite.

## 32. Missing Specifications

Historical source/license/provenance, data corrections/vintages, missing-interval policy, split boundary policy and ratios, minimum sample, session/DST windows, spread convention/source, slippage and commission unit, gross/net metrics basis, confidence intervals, and whether Validation can be reused are not decided by existing code.

## 33. Recommended Task116 Scope

Keep current Strategy parameters fixed. Add a local dataset manifest/import validator and reproducible split metadata; implement chronological Train/Validation/OOS access boundaries with warmup-only prefix rules; run frozen baseline first; return counts and descriptive pair/Regime/session metrics; preserve gross/net distinction and zero provider requests. Defer optimizer, inferential statistics and cost values until their assumptions/data sources are approved.

## 34. Decisions Required Before Implementation

Approve: dataset file format/provenance/checksum and data-source rights; split boundaries/ratios and warmup policy; OOS freeze/consumption policy; session definition/DST/calendar; minimum sample/uncertainty policy; spread source/convention; slippage and commission model/units; gross/net equity/risk/daily-loss basis; whether per-pair runs are independent or shared portfolio; whether cost sensitivity is required before any performance summary.

## 35. Implementation Delivered

- Added `lib/backtest/local-dataset.ts`: local manifest/CSV import, SHA-256 verification, canonical UTC timestamps, strictly increasing rows, positive finite OHLC validation, pair/timeframe validation, source/license/data-kind provenance, row counts, date bounds and unclassified gap observations. `loadLocalHistoricalDataset` reads only files from the supplied local directory; it has no network/provider integration.
- Added `lib/backtest/strategy-validation.ts`: frozen Task113/115 baseline with deterministic SHA-256 config hash; configurable chronological split defaulting to 60/20/20; per-partition bounds, warmup-only historical candles, cost sensitivity and descriptive pair/regime/session segmentation. Validation and OOS input views do not include OOS metrics. Calling `markOosConsumed` records reuse and requires a fresh untouched period.
- Added an optional evaluation start gate to `simulateTrades` as a third argument. Existing Task115 callers keep the same behavior; Task116 supplies each partition start so warmup candles cannot create trades, consume position capacity or alter evaluation capital before its boundary.
- Validation and OOS partitions fail closed when any available timeframe lacks 204 pre-boundary candles. The training partition starts at the dataset's earliest timestamp and therefore has no external prehistory; Task114's as-of indicator readiness still prevents incomplete technical frames from becoming evaluable.
- Cost scenarios are a post-simulation overlay only: fixed total round-trip spread pips, adverse slippage per entry/exit fill and JPY commission per completed trade. Gross Task115 fills, sizing, exits and metrics are not mutated. Net PnL, R, equity, expectancy, profit factor and drawdown are returned separately.
- Session grouping requires caller-provided IANA timezone windows; absent windows are labeled unavailable. No default session hours are guessed. Pair results are independent pair-run summaries, not a shared-capital portfolio.
- Added `tests/strategy-validation.test.ts` for manifest/data validation, local disk-only loading, gaps/checksums, exact split boundaries, warmup insufficiency, future-tail invariance, baseline freeze/hash, OOS selection/consumption, cost separation, session DST examples and end-to-end partition metadata.

## 36. Data And Interpretation Limits

No verified observed-market OHLC history is bundled. Synthetic test results demonstrate pipeline behavior only and are not strategy-performance evidence. The importer supports local CSV supplied by the operator; it does not acquire data. Missing intervals are recorded as unclassified and never filled, since weekends, holidays and provider outages cannot be distinguished from OHLC timestamps alone. No parameter optimizer, minimum-sample acceptance rule, confidence interval, bootstrap or statistical significance claim was added. Cost defaults are zero-valued sensitivities, not broker quotes.

The frozen config captures current repository constants; it is not a universal trading recommendation. When actual CSV history, source/license rights, session intervals and broker cost inputs are supplied, rerun with those explicit inputs. Any strategy change informed by OOS marks that period consumed.

## 37. Verification

Production build succeeded; lint completed with no warnings; the unit suite passed all 1,264 tests. Full E2E: 362/362 PASS with `workers=1` (4.6 minutes). `git diff --check` passed after this verification update.
