# Task114 — Backtest Engine, Phase 1: Historical Signal Replay

## 1. Verdict

Local OHLCに対して、Task113 Signal Engine v2を変更せず時点再生するpure replay基盤を追加した。Forward returnとMFE/MAEはSignal後の価格動向の記述統計であり、取引収益・勝率・利益性能を示さない。

## 2. Scope

Signal Direction、Safety observation、reference-only Action observation、warmup/WAIT分類、forward movementの計測まで。約定、position lifecycle、SL/TP取引、コスト込みPnL、parameter tuningは対象外。

## 3. Historical Dataset

[`HistoricalDataset`](../lib/backtest/signal-replay.ts) はid、対応pair、timeframeごとのOHLC配列を保持する。対応pairはUSD/JPY、EUR/JPY、GBP/JPY。timeframeは15m/1h/4h/1day。timestampはmillisecondを含むcanonical UTC ISO（`Z`）、足は時系列昇順・重複なし・OHLC整合を要求する。DB保存なし。

## 4. As-Of Architecture

評価timestampは`signalTimeframe`の各足の終了時刻。各timeframeを個別に `candle start + duration <= T` でcutoffし、prefixからIndicatorsを再計算する。Default signal timeframeは1h。future priceは別のpost-signal計測関数からしか読み込まない。

## 5. Confirmed Candle Policy

形成中足はas-of prefixへ含めない。15m/1h/4h/1dayでそれぞれ固有durationを使う。Market Regimeにも同じprefixを渡し、内部のconfirmed-hour filterを再適用する。

## 6. Warmup

`BACKTEST_MIN_TECHNICAL_CANDLES = 205`。SMA200と5本前SMAによるslopeを完全計算するための最低本数。実際の`TechnicalAnalysis.ready`条件（current rateと完全なframe 2本以上）を満たさないTはDirection分布から除外し、`WARMUP_SKIPPED` / `INSUFFICIENT`で記録する。値の補完なし。

## 7. Current Rate Policy

Signal priceはT時点で確認できる最新15m candle close。結果に`currentRateTimeframe: 15m`を含める。source close timestampをprice freshnessとして扱い、Tから古い場合は既存technical freshness validationが不成立になる。

## 8. Signal Engine v2 Integration

`evaluateTechnical`、`calculateSignalDirection`、`evaluateSafetyGate`、`resolveSignalAction`を既存仕様のまま利用し、Action observationには`evaluateSignalEngineV2`を呼ぶ。score/threshold/technical weight/RR/Safety/Action semanticsは変更なし。MTF/RegimeをDirection gateに追加していない。

## 9. Direction Replay

各warmup後のTについて5段階Directionとscoreを記録。Direction distributionのpercentageはwarmup skipを除くevaluated signal数を分母とする。WAITはneutral score帯のDirectionとして保持する。

## 10. Safety Observation

v2 Safety reason codesとstatusを記録する。Historical dataset自体にsource freshness metadataがないため、`STALE_DATA`は未検証として明示。OHLC/Fundamental以外のSafetyも推測でALLOWにしない。

## 11. AI / Fundamental Limitation

AI、News、Fundamentalを作らず、Data QualityはTechnical分だけを算出する（完全でも最大40点）。既存`DATA_QUALITY <60`はそのままSafety BLOCK。AI contextは`UNAVAILABLE_NOT_FABRICATED`。Action WAITはreference observationであり、Strategyが過去にWAIT判断したとの解釈を禁止する。

## 12. Economic Event Limitation

Historical event datasetを取得/生成しない。各Tで`economicEventStatus = NOT_EVALUATED`とし、現在・未来Calendarを過去に適用しない。Event gateは安全だったとは扱わず、既存risk-window policyも変更していない。

## 13. MTF / Regime

MTFはTまでの各prefixだけから作成。200本未満のtimeframeはresourceごと未提供にして、MTFの保存Indicators fallbackへ入れない。200本以上もIndicatorsはas-of prefixから計算。RegimeもTまでの1h prefixのみで算出。どちらもAction/Directionの新しいgateではない。

## 14. Scenario

Technical Directionとas-of 15m current rateから既存`generateScenario`を利用し、availabilityだけを記録。RR >=1.5 validationは変更なし。ScenarioはSignal時点の技術足のみから作る。ScenarioのSL/TP到達や約定は計算しない。

## 15. Forward Return

Default horizonはsignal timeframe単位の1/4/12本。例: 1h replayでは+1h/+4h/+12h。Signal足の次足以降のcloseを使用。raw returnとDirection-adjusted returnをpips（JPY pairは0.01=1 pip）/percentで集計。future不足は`unavailableForwardHorizons`に残す。

## 16. MFE / MAE

Signal足を除くforward windowのhigh/lowから、BUYとSELLの定義に従いMFE/MAEをpips/percentで算出する。これらは将来candleだけを読むpost-signal metricで、signal再計算には戻らない。

## 17. Direction Distribution

STRONG BUY、BUY、WAIT、SELL、STRONG SELLごとにcount/percentageを返す。Direction percentageはreadyなevaluated signalsを分母とし、warmup skipped数はsummaryで別報告する。

## 18. WAIT Classification

`NEUTRAL`、`SAFETY`、`SCENARIO`、`AI_CONTEXT`、`INSUFFICIENT`を複数labelで記録する。複数gateが同時に成立すれば各categoryのcountは重複する。Historical Event未評価はwait categoryではなく独立status。

## 19. Look-Ahead Protection

全timeframeのas-of cutoff、forming candle除外、15m source-price close時刻、prefix-only Indicators、200本未満MTF resource除外、Scenario as-of値、signal足を除いたforward windowを実装。future極端足をappendしても同一TのDirection/score/price/MTF/Regime/ScenarioStatusが不変となるtestsを追加。

## 20. Determinism

入力dataset、signal timeframe、horizonが同一なら、出力はpure calculationと明示的timestampから算出される。API cache、system clock、AI responseに依存しない。

## 21. API Impact

新規request 0。Replay moduleはlocal datasetを直接受け取り、Twelve Data/Finnhub/FRED/FinanceCalendar/OpenRouter/OpenAI clientをimportしない。Replay中の`fetch`が0回であるtestあり。Task112 cache/TTL/dedupe/polling/rate-limit/stale fallbackは未変更。

## 22. DB Impact

Migration 0。Backtest結果はin-memory return object。既存Trade/MarketContext snapshotsを更新・保存しない。

## 23. Trade Simulation Exclusions

Bid/ask spread、slippage、commission、order/fill、position sizing、SL/TP、same-candle順序、Win Rate、Profit Factor、Expectancy、Net Profit、Max Drawdownは実装しない。OHLCで順序が分からない同一足のSL/TP接触も都合よく判定しない。将来のpolicy候補はSL_FIRSTだが、本Phaseでは使用しない。

## 24. Metrics

Direction distribution、pair別dataset run、horizon/direction別raw/adjusted return mean/median/positive rate/negative rate、MFE/MAEを返す。Wait/Safety分類はmulti-label集計。取引損益やnet performanceとは表示・解釈しない。

## 25. Tests

- Baseline unit: 1210/1210
- Task114 unit: 1224/1224 PASS
- `npm run lint`: PASS（warningなし）
- `npm run test:e2e -- --reporter=dot`: 362/362 PASS
- `npm run build`: PASS
- `git diff --check`: PASS

Backtest tests cover dataset/pair/timeframe/OHLC validation、15m/1h/4h/1day cutoff、forming exclusion、204/205 warmup、prefix invariance、MTF fallback suppression、Scenario status、BUY/SELL returnとMFE/MAE、future horizon不足、determinism、AI/Event unavailable、provider fetch 0。

## 26. Changed Files

- `lib/backtest/signal-replay.ts` — dataset validation、as-of replay、metrics
- `tests/signal-replay.test.ts` — pure replay/look-ahead/API tests
- `outputs/Task114-Backtest-Engine.md` — Task114 report

既存Task112/Task113・Trade snapshot・MarketContext・DB migration・production UIは未変更。

## 27. Known Limitations

- As-of priceには15m historyが必要。15mが欠落/古い時点は既存freshness gateによりwarmup skip。
- Historical source freshness metadataがなくSTALE_DATAを評価できない。
- Economic EventはNOT_EVALUATED。
- FundamentalなしによりData Quality SafetyはBLOCKし、AIなしによりreference ActionはWAITする。Direction/forward movementのみがこのdatasetで評価可能。
- Historical corrections/revisions、spread、slippage、commissionは含まない。

## 28. Task115 Requirements

Trade Simulator前に、point-in-time Economic Event/Fundamental availability、実行entry timing、gapとsame-candle SL_FIRST policy、bid/ask spread・slippage・commission、risk sizing、position overlap、exit/timeout、net PnL/R、drawdownの各仮定を仕様化する。追加Historical APIを導入する場合はquota/cost budgetを先に定義する。

## 29. Final Verdict

Deterministicなhistorical Direction replay、as-of Safety observation、明示的AI/Event limitations、forward return/MFE/MAE measurementを構築した。future candle leakageを避け、Task113 semanticsとAPI/DB境界を維持する。これはSignal後の価格動向を測るPhase 1であり、Strategy profitabilityを評価したものではない。