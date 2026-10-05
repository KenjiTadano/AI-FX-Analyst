# AI-FX-Analyst v1.2 — Task115 Trade Simulator Audit

## 1. Current Trade Architecture

Current branch: `feature/v1.2-task115-trade-simulator`; worktree was clean at audit start. Task114 [`replayHistoricalSignals`](../lib/backtest/signal-replay.ts) evaluates confirmed OHLC prefixes and records Direction, Safety/Action observations, Scenario availability, forward returns, MFE and MAE. It does not create positions, fills or exits.

## 2. Scenario Architecture

[`generateScenario`](../lib/ai/scenario.ts#L16) uses current rate and a complete 1h TechnicalFrame. For BUY, entry zone is current rate minus 0.25/0.10 ATR, SL is below recent low or entry zone, TP1 is recent high and TP2 is 0.75 ATR beyond it. SELL uses the mirrored return zone, SL above recent high, TP1 recent low and TP2 0.75 ATR below it. These are proposed conditional prices, not observed fills.

[`validateScenario`](../lib/ai/scenario.ts#L4) validates positive prices and long/short price ordering. RR uses the adverse end of the entry zone and must be at least 1.5. The ratio is recomputed, not trusted from model input.

## 3. Entry Trigger Architecture

[`evaluateStructuredEntryTrigger`](../lib/ai/entry-trigger.ts#L186) supports `price_above`, `price_below`, `candle_close_above`, and `candle_close_below`. It uses strict greater/less comparisons; equality is not met. Price triggers compare current rate. Candle-close evaluation maps only 15min/1h/4h to market series; other allowed trigger timeframes can return unavailable. Trigger MET is observation only and never a recommendation or order.

## 4. Exit Plan Architecture

[`createExitPlan`](../lib/trades/exit-plan.ts#L101) stores registration-time entry, initial SL, optional TP, initial risk and planned reward. Validation checks side-relative SL/TP price relationships. [`calculateRealizedR`](../lib/trades/exit-plan.ts#L162) computes realized R from a manually recorded exit price. No OHLC-based SL/TP touch or fill simulator exists.

## 5. Risk Sizing Architecture

[`positionSize`](../lib/risk/position-size.ts#L12) calculates allowed loss from balance and risk percent, divides by entry-to-stop distance, then floors units to `tradeUnit`. `positionRisk` estimates risk for a supplied size. It does not include spread, slippage, commission, other open positions or currency conversion.

## 6. Trade / Position Model

[`TradeDraft`](../lib/trades/types.ts#L135) stores pair, long/short side, open/closed status, quantity, entry/exit prices, opened/closed timestamps, SL and TP. [`Trade`](../lib/trades/types.ts#L148) adds IDs, realized PnL and optional snapshots. `createTrade` accepts a user draft; `closeTrade` accepts an explicit exit price/time. Neither processes candle history or automatically reacts to signals.

## 7. Existing Performance Metrics

[`summarize`](../lib/trades/analytics.ts#L6) calculates wins/losses/draws, win rate, total PnL, average win/loss, profit factor, extrema and planned RR. [`equityCurve`](../lib/trades/analytics.ts#L21) replays already-realized trades in close-time order. Exit Plan summaries calculate realized R. Expectancy and realized max drawdown are not implemented as Trade performance metrics. `risk/drawdown.ts` shows hypothetical balances after 1/3/5/10 losses, not historical max drawdown.

## 8. Entry Price

For risk sizing only, [`analysisPlan`](../lib/risk/risk-reward.ts#L10) chooses the adverse entry-zone endpoint: long=max, short=min. No actual fill price is selected by this helper.

## 9. Entry Timing

No simulator entry timestamp policy exists. Whether a signal may fill within its signal candle or only from the next candle is undecided. Task114 measures forward movement after the signal candle, but that is not an entry/fill rule.

## 10. Fill Semantics

No limit-touch, zone-intersection, market-order, partial-fill or order-priority semantics exist. Entry zone endpoints and signal price must not be presented as fills without a policy.

## 11. Spread

Market OHLC and Trade quote types do not carry bid/ask spread. No spread model or cost deduction exists. **Undecided.**

## 12. Slippage

No slippage input, estimator or price adjustment exists. **Undecided.**

## 13. Commission

No broker commission/fee field or PnL deduction exists. **Undecided.**

## 14. Gap Handling

OHLC includes `open`, but no entry/SL/TP gap policy is implemented. Whether a stop fills at stop price or worse opening price, and how a target limit behaves after a gap, is **undecided**.

## 15. Stop Loss

Trade validation and Exit Plan validation check price direction. There is no stop-touch detection, stop-market fill policy or intrabar execution logic. **Execution policy undecided.**

## 16. Take Profit

Trade validation checks TP direction and records an explicit exit price; it does not detect a target touch or simulate a limit fill. **Execution policy undecided.**

## 17. Same-Candle Entry/Exit

There is no policy that permits entry and exit in the same candle. Since a signal is known after its candle closes, using that candle's high/low to fill or exit afterward would introduce look-ahead. **Undecided; safest candidate is to begin execution no earlier than the next candle.**

## 18. Same-Candle SL/TP

There is no ordering information in OHLC when both stop and target are touched in one candle, and no existing policy. **Undecided.** SL_FIRST is a conservative candidate, not current behavior.

## 19. Position Sizing

Single-trade sizing exists via `positionSize`, based on capital, risk rate, entry, stop and unit increment. It does not derive those values from a historical fill, reserve capital, recalculate equity after each simulated fill, or sum risk across positions.

## 20. Position Overlap

No open-position cap, per-pair overlap rule, duplicate-signal suppression or aggregate exposure calculation exists. **Undecided.**

## 21. Max Trades / Daily Risk

Daily Trading Plan counts trades opened on the runtime's local day and sums realized losses for those closed trades. A configured Daily Loss Limit changes plan status/warnings; it does not enforce an order block in `createTrade`. No max trades/day rule exists.

## 22. Consecutive Loss Limit

No consecutive-loss stop rule or loss-streak state exists. The drawdown illustration is not a trading restriction.

## 23. Max Holding Period

No time-based exit or maximum holding duration exists. **Undecided.**

## 24. Opposite Signal Exit

No opposite-Direction exit rule exists. **Undecided.**

## 25. End-of-Dataset

Task114 ends with signal/forward observation records and has no open position. Task115 has no policy for marking an open position to market versus forced liquidation at the dataset end. **Undecided.**

## 26. Pair / Pip / PnL Conversion

Supported pairs are USD/JPY, EUR/JPY and GBP/JPY; all quote JPY. [`JPY_PIP_SIZE`](../lib/trades/analysis-price.ts#L5) is 0.01. [`pnl`](../lib/trades/calculations.ts#L5) computes `(exit - entry) × quantity` for long and the reverse for short, rounded to yen cents. Thus JPY-denominated PnL is consistent if quantity is base-currency units and capital is JPY. There is no general cross-currency conversion subsystem.

## 27. Safety Gate

Task113 Safety produces reason codes; Task114 records them. There is no Trade Simulator entry gate yet. Daily Loss Limit, Safety BLOCK and Readiness warnings are not uniformly enforced by `createTrade`; existing E2E coverage explicitly preserves submit availability despite combined warnings.

## 28. AI / Fundamental Limitation

Task114 marks AI context unavailable and records Action as an observation. v2 resolver returns WAIT for unavailable AI context; Fundamental data is also absent and causes the unchanged Data Quality gate to block. Such WAIT must not be represented as a historical strategy decision. Historical AI/Fundamental snapshots are not available from the OHLC dataset.

## 29. Economic Event Limitation

Task114 reports historical event risk as `NOT_EVALUATED`. This is not equivalent to no event or event-safe. No historical event archive is available in the simulator. Current/future calendar data must not be projected backward.

## 30. MTF / Regime

Task114 computes MTF and Regime from as-of prefixes for observation. Neither currently governs Trade execution. Task115 should not add them as Direction or execution gates without an explicit new spec.

## 31. Look-Ahead Risks

Key risks are using the signal candle's range after signal close, choosing an advantageous price inside an entry zone, resolving same-bar SL/TP with future ordering, applying Trigger MET before it was observable, or allowing future signals to alter a currently open position. Preserve Task114 prefix cutoffs; signal-time information must be frozen before examining subsequent bars.

## 32. API / DB Impact

No Trade Simulator API route or persistence table exists. Existing local/in-memory Trade models and Task114 datasets suffice for prototyping. No API request or DB migration is necessary for the simulator core.

## 33. Existing Tests

Position sizing/RR: [`tests/risk.test.ts`](../tests/risk.test.ts#L24). Daily open/closed counts and Daily Loss: [`tests/daily-plan.test.ts`](../tests/daily-plan.test.ts#L236). Realized PnL/Equity: [`tests/trades.test.ts`](../tests/trades.test.ts#L36). Exit Plan/R: [`tests/exit-plan.test.ts`](../tests/exit-plan.test.ts#L177). Readiness/Trigger and submit behavior: [`tests/entry-readiness.test.ts`](../tests/entry-readiness.test.ts) and [`e2e/pretrade-review.spec.ts`](../e2e/pretrade-review.spec.ts#L170). No OHLC execution-policy tests exist.

## 34. Missing Specifications

No established policy for actual fill price/timing, spread, slippage, commission, entry/exit gaps, same-candle entry/exit, same-candle SL/TP ordering, overlap/max concurrent positions, max trades/day, consecutive-loss cap, max holding period, opposite-signal exit, dataset-end treatment, or execution response to unknown events/AI/Fundamentals.

## 35. Recommended Conservative Defaults

These are proposals only, not adopted decisions:

- Evaluate signal after candle close; earliest fill opportunity is the next candle.
- If only OHLC is available and SL and TP both touch, consider SL_FIRST.
- On a gap through a stop, consider filling at the worse open rather than the stop price.
- If spread/slippage/commission inputs are absent, do not call PnL net or profitability.
- At dataset end, report the position as open/unrealized unless an explicit forced-close policy is approved.
- Make overlap, daily risk, timeout and opposite-signal policies explicit config rather than implicit behavior.

## 36. Decisions Required Before Implementation

Approve the fill model, signal-to-entry timing, zone-touch rule, gap policy, bid/ask source, slippage and commission inputs, same-candle precedence, quantity/equity updates, overlap limits, daily trade/loss rules, loss-streak rules, timeout/opposite-signal exits, end-of-dataset valuation, and treatment of event/AI/Fundamental unknowns. Until decided, no simulator should claim these are existing repository semantics.

---

# Task115 Trade Simulator — Implementation Report

## 1. Verdict

Implemented a deterministic, local Research Trade Simulator over Task114 HistoricalDataset. It simulates Research Eligibility, next-candle entry, fills, one position, exits, gross PnL/R and realized equity. No live-profit or strategy-performance claim is made.

## 2. Scope

Task115 adds an in-memory lifecycle simulator. It does not change production Signal/Action semantics, Task113 Engine behavior, Task114 replay/cutoff/warmup/forward metrics, API routes, DB schema or production UI.

## 3. Research Simulation Semantics

Result metadata includes `simulationMode=RESEARCH` and `productionActionReplayed=false`. A research candidate requires non-WAIT Technical Direction, valid Scenario, evaluated/warmed-up replay, available required OHLC and Research Safety ALLOW. The candidate may remain eligible even when production Action is WAIT because AI/Fundamental context is missing; both states are recorded separately.

## 4. Entry Policy

Direction is observed at the signal timeframe candle close. Signal candle cannot fill. Earliest fill opportunity is the next candle or later. Default signal timeframe is 1h.

## 5. Fill Policy

Scenario `entryZone.min/max` is inclusive. If next/later bar open is inside the zone, fill at open. If open is outside but OHLC range intersects the zone, path/order cannot be recovered from OHLC, so the candidate is canceled as `ENTRY_GAP_AMBIGUOUS`; it is not retried at a later favorable price. A non-intersecting bar records `NO_ZONE_TOUCH` while the pending candidate remains active.

## 6. Gap Policy

An ambiguous entry gap is skipped, with no invented fill. A stop gap-through fills at the worse opening price. A target gap fills at TP1, never at a better opening price.

## 7. Stop Loss

Scenario SL is treated as protective stop-market. BUY open below SL and SELL open above SL exit at open; otherwise a stop touch exits at SL.

## 8. Take Profit

TP1 is used as a limit-style target and fills at its price. TP2 is not simulated.

## 9. Same-Candle Policy

The entry bar is checked for exit after an open-in-zone fill. If SL and TP both touch, SL_FIRST applies. On other bars, stop/target checks precede timeout. Signal-bar range is never used for entry/exit.

## 10. Cost Model

Metadata is `costModel=GROSS`, `spreadModeled=false`, `slippageModeled=false`, `commissionModeled=false`. Config fields for spread/slippage/commission default to zero. Task115 v1 rejects non-zero values instead of silently ignoring them. Reported PnL/return/R are gross, not net, realistic or expected live performance.

## 11. Risk Sizing

Reuses existing `positionSize`: default risk 0.5% of current realized equity, Entry fill to Scenario SL distance and tradeUnit=1,000. Quantity floors to the unit increment. Invalid/zero quantity blocks entry. Unrealized PnL is excluded from next-position sizing.

## 12. Equity

Initial capital defaults to ¥50,000. Closed realized gross PnL updates realized equity and subsequent sizing. Open-position mark-to-market is a separate field and never increases realized equity.

## 13. Position Limit

One global position across all pairs; no pyramiding. Signals while a position is open are recorded and blocked as `POSITION_LIMIT`. If multiple pairs are eligible at the same timestamp, all are blocked rather than giving one pair an implicit priority. Multi-pair datasets must have identical signal-timeframe close timestamps.

## 14. Max Trades Per Day

Default three entries per JST calendar day. Later entry attempts are blocked as `MAX_TRADES_PER_DAY`.

## 15. Daily Loss Limit

Default 1% of realized equity at JST day start. Once that day's closed realized gross PnL is at or below the negative threshold, further entries are blocked. Existing positions are not forced closed. Daily state resets at the next JST day.

## 16. Consecutive Loss Limit

Default three consecutive closed losses. Loss increments; win or break-even resets. The limit blocks new entries until the next JST day, when the streak resets.

## 17. Max Holding Period

Default 24 signal-timeframe candles, counting the entry bar as candle one. SL/TP are evaluated first; if neither touches, exit at that candle close with `TIMEOUT`.

## 18. Opposite Signal

Opposite Direction does not close or reverse an existing position. Exit resolver does not accept a future signal input.

## 19. End Of Dataset

No forced close. A remaining position is returned as `OPEN_UNREALIZED`; last-close mark-to-market stays outside realized metrics and equity.

## 20. Pair / Pip / PnL

Supports USD/JPY, EUR/JPY and GBP/JPY. One pip is 0.01; quantity is base-currency units and PnL is JPY. Existing `pnl` helper computes long `(exit-entry)×quantity` and short `(entry-exit)×quantity`. No cross-currency conversion is needed for the supported JPY-quoted pairs.

## 21. R Multiple

Initial risk is fixed at `abs(entryFill - initialStop) × quantity`. Realized R is gross PnL divided by that initial risk. The denominator is never revised after entry.

## 22. Performance Metrics

Closed trades provide count, wins/losses/break-even, win rate, gross PnL/return, average win/loss, profit factor, total/average/median R, JPY/R expectancy, average holding candles and pair/Direction/exit-reason distributions. Open positions are excluded from closed-trade metrics.

## 23. Max Drawdown

Uses realized-equity peak-to-trough values after each closed trade. It does not reuse the hypothetical losing-streak illustration. Unrealized marks are excluded.

## 24. Look-Ahead Protection

Uses Task114 as-of replay; fills start no earlier than the next bar. Scenario is generated from signal-time prefixes. Exit reads only the fill bar and subsequent bars. Later signals do not mutate an open position. Same-bar SL/TP ordering is explicit SL_FIRST. Task113 and Task114 source semantics are unchanged.

## 25. AI / Fundamental Limitation

Historical AI/Fundamental data is not fabricated and is recorded UNAVAILABLE. Production Action remains unchanged and is only observed. Research Eligibility does not reject a candidate solely because AI/Fundamental context is absent. Production DATA_QUALITY reasons are preserved separately from Research Safety.

## 26. Economic Event Limitation

Historical event status is `NOT_EVALUATED`, not event-safe. Unknown event context alone does not remove a research candidate. Current/future calendar data is never applied retrospectively.

## 27. Production Action Separation

`productionActionReplayed=false` is returned in metadata. Production Action/Safety and Research Eligibility/Safety are separate fields. A Research BUY/SELL fill is not a production recommendation or replay of historical production Action.

## 28. API Impact

New API requests: 0. Simulator uses local HistoricalDataset and local computation only. A dedicated test asserts provider `fetch` calls remain zero. Task112 API cache/TTL/dedupe/polling/rate-limit/stale-fallback code is untouched.

## 29. DB Impact

Migrations: 0. Result is in-memory; Trade Journal and immutable snapshots are not written.

## 30. Tests

- Baseline unit: 1224/1224
- Task115 unit: 1248/1248 PASS
- `npm run lint`: PASS (no warnings)
- `npm run test:e2e -- --reporter=dot`: 362/362 PASS
- `npm run build`: PASS
- `git diff --check`: PASS after report update

Dedicated tests cover defaults/cost mode, zone fill/no-touch/gap, BUY/SELL, adverse stop gaps, TP gap cap, SL_FIRST, timeout ordering, same-candle entry/exit, next-candle entry, sizing/unit increments, equity/R/drawdown, production/Research separation, global position limit, JST limits, opposite-signal non-exit, dataset end, deterministic replay and provider fetch 0.

## 31. Changed Files

- `lib/backtest/trade-simulator.ts` — local Research lifecycle, execution policy, risk and metrics
- `tests/trade-simulator.test.ts` — lifecycle and policy tests
- `outputs/Task115-Trade-Simulator.md` — audit plus implementation report

Task112 provider/cache behavior, Task113 Engine/Safety/Action/Scenario/Trigger, Task114 HistoricalDataset/replay, APIs, DB and production UI are unchanged.

## 32. Known Limitations

- PnL/R is gross; spread/slippage/commission are not modeled and non-zero values are rejected.
- Entry open-outside/range-intersects ambiguity is skipped, not priced.
- Same-timestamp multi-pair candidates are all blocked; no pair ranking is invented.
- Daily loss uses closed realized gross PnL; unrealized losses do not trigger the limit.
- Historical Event/AI/Fundamental context remains NOT_EVALUATED/UNAVAILABLE.
- Historical source freshness metadata is unavailable.
- No profitability or live-performance conclusion is possible from this simulator output.

## 33. Task116 Requirements

Before cost sensitivity, define bid/ask spread convention, per-side/round-trip application, slippage units/application, commission and net-PnL reconciliation. Add walk-forward/time split/out-of-sample validation and pair/session sensitivity. Keep execution assumptions separate from parameter tuning and profitability claims.

## 34. Final Verdict

Task115 implements the requested deterministic Research simulator with next-candle entry, ambiguous-gap cancellation, adverse stop-gap fill, TP1 limit pricing, SL_FIRST, one global position, JST daily risk limits, realized equity/R and OPEN_UNREALIZED dataset-end handling. Production Action and Task113/114 semantics remain unchanged. The output is a costless research simulation, not evidence that the strategy is profitable.