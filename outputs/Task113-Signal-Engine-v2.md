# Task113 — Signal Engine v2

## 1. Verdict

DeterministicなDirection、独立したSafety Gate、Scenario availability、最終Actionを実装した。既存のテクニカル計算と初期閾値を再利用し、勝率・収益性の改善は主張しない。

## 2. Existing WAIT Bias

旧実装はAI未取得、低確信度、矛盾、データ充足率、イベント、急変、Scenario/RRを同じ `decisionReasons` に積み、どれか一つでSignalをWAITへ変更していた。方向スコアもTechnical 70%とAI解釈Fundamentalの合算だった。

## 3. Architecture

`TechnicalAnalysis` → `calculateSignalDirection` → 5段階Direction。並列して `evaluateSafetyGate` が市場データのExecution可否を評価し、Scenario availabilityとAI contextを `resolveSignalAction` がActionへ統合する。TriggerはEntry Timingのまま別評価。

## 4. Signal Engine v2

[`lib/ai/signal-engine-v2.ts`](../lib/ai/signal-engine-v2.ts) に純粋関数 `calculateSignalDirection`、`evaluateSafetyGate`、`resolveSignalAction`、`evaluateSignalEngineV2` を追加した。出力はscore、direction、components、safety、safetyReasons、scenarioStatus、action、actionReasons、waitClassification、entryTriggerContext。

## 5. Score

v2 scoreは既存 `technical.score` を整数化し、-100..+100へclampした値。新しい指標・価格・重みは追加していない。AI/fundamental合成値はDirectionへ使わず、既存APIの `AIAnalysis.score` として後方互換のため保持する。

## 6. Direction Thresholds

- `>= +60`: STRONG BUY
- `+20..+59`: BUY
- `-19..+19`: WAIT
- `-59..-20`: SELL
- `<= -60`: STRONG SELL

閾値は旧 `signalFromScore` と同一。閾値最適化は行っていない。

## 7. Components

現行Technicalの各timeframe scoreを分解して返す。価格対SMA20 15点、SMA20/75およびSMA75/200各20点、SMA slope各10点、5本momentum 15点に既存timeframe weight（15m 0.3、1h 0.4、4h 0.3）を適用。RSIはcontextのみで0点。componentsには計算済み値だけを格納する。

## 8. AI Dependency Changes

AI factorは既存の `AIAnalysis.score` / explanationsに残るが、v2 Direction scoreには加算しない。AI unavailable、confidence <55、`preferWait`、contradictionsはSafetyをBLOCKせず、互換UXのためAction側のsoft wait reasonとして扱う。AI unavailable時もDirectionはTechnicalから計算される。AI promptは変更していない。

## 9. Safety Gate

純粋評価が `ALLOW` / `BLOCK` とreason codesを返す。hard gateは `DATA_QUALITY`（score <60）、`STALE_DATA`、`ECONOMIC_EVENT`、`EXTENDED_MARKET`、`INSUFFICIENT_DATA`。AI contextはSafety reasonsへ混ぜない。

## 10. Economic Event

既存risk-window policyを変更せず再利用。HIGHは30分前〜15分後、MEDIUMは15分前〜5分後、LOWはhard blockなし。時刻不明のHIGHは従来どおりuncertainとしてActionをBLOCKする。Direction scoreは変えない。

## 11. Stale / Data Quality

`buildInput` が既存freshness条件に基づきstale sourceを記録する。Stale値はTechnical計算へ投入せず、SafetyをBLOCKする。technical.ready=falseも別reasonでBLOCKするため、Directionが残っても実行ActionはWAITとなる。Data Quality閾値は従来の60を維持。

## 12. Scenario / RR

Scenarioはv2 Directionを使って独立生成する。RR >=1.5の既存validationは維持。有効Scenarioがなければ `NO_VALID_RISK_SCENARIO` でActionをWAITにするが、Directionは書き換えない。有効Scenarioは別Safety理由でWAIT中でも保持可能。

## 13. Entry Trigger

Structured Entry Triggerの型、validation、評価、Readiness挙動に変更なし。Action resolverはTrigger contextを受け取れるがAction判定には使用しない。METだけでBUY/SELLを生成しない。通常のSignal Engine応答では未評価contextとなり、実評価は従来どおりEntry Readiness側。

## 14. Action Resolution

Safety BLOCK、方向neutral、方向があるがScenario unavailable、またはAI soft context（unavailable / confidence <55 / contradiction / preferWait）でWAIT。それ以外はDirectionの符号からBUY/SELL。Trigger METは必要条件でも十分条件でもない。`signal` は既存互換でActionがWAITなら `wait`、Directionは `directionSignal` と `signalEngineV2.direction` に保持する。

## 15. Legacy vs v2 Comparison

同一の13固定fixtureで旧合成score/旧gateとv2を比較した。Legacy scoreは `round(clamp(technical × 0.7 + fundamental))`。

- bullish clean: Legacy STRONG BUY / BUY、v2 BUY / BUY
- bearish clean: Legacy STRONG SELL / SELL、v2 SELL / SELL
- neutral: 両方 WAIT / WAIT
- AI unavailable: Legacy BUY / WAIT、v2 STRONG BUY / WAIT
- low confidence: 両方 BUY / WAIT
- stale: 両方 BUY / WAIT
- insufficient data: 両方 BUY / WAIT
- economic HIGH risk: Legacy BUY / WAIT、v2 STRONG BUY / WAIT
- contradiction: 両方 BUY / WAIT
- extended: Legacy BUY / WAIT、v2 STRONG BUY / WAIT
- Scenario RR failure: 両方BUY方向 / WAIT
- strong bullish / strong bearish: 方向・Actionとも両方一致

Actionは13/13一致。DirectionはFundamental合成で閾値を越えていたfixtureなどで差が出た。これは収益改善を示すものではない。

## 16. WAIT Classification

固定fixture上、Safety WAITはstale・insufficient・event risk・extendedの4件、Scenario WAIT 1件、Directional WAIT（AI context）3件、Neutral WAIT 1件。Reason codeと `waitClassification` によって分類できる。

## 17. WAIT Count Before / After

固定13ケースでLegacy 9 WAIT、v2 9 WAIT。減少を成功条件にしていない。この値は指定fixture群の件数であり、本番頻度・市場一般のWAIT率ではない。

## 18. Explainability

`signalEngineV2` にscore、5段階direction、timeframe別component値/point、Safety status/reasons、Scenario status、Action/reasons、WAIT分類を含める。v2方向scoreをDashboardの「方向スコア」表示に使用する。

## 19. API Impact

新規requestは0。既存analysis pipelineの入力を同じ場所で利用する。`AIAnalysis.signalEngineV2` はoptional additive fieldで、AIAnalysis.score等の既存フィールドは残す。

## 20. DB Impact

Migration 0。DB schema、query、保存列は変更していない。

## 21. Snapshot Compatibility

`TradeAiAnalysisSnapshot`、`MarketContextSnapshot`、`MarketContextRevision`の型・version・sanitizerは変更していない。既存保存snapshotは不変。今後作成するtrade snapshotでは従来fieldへv2 Directionが保存されるが、snapshot形状は同じ。

## 22. Task112 Regression

API cache/TTL/request dedupe/polling/visibility/rate limit/stale fallback/provider countersを実装変更していない。market/fundamental clientとTask112周辺の回帰testsはそのまま実行しPASS。

## 23. Tests

- Baseline unit: 1193/1193 PASS
- Task113 unit: 1210/1210 PASS
- `npm run lint`: PASS
- `npm run test:e2e`: 362/362 PASS
- `npm run build`: PASS
- `git diff --check`: PASS（report追加後）

新規pure testsは5段階threshold、各Safety gate、AI unavailable/low confidence/preferWait、Scenario failure、Trigger MET、component分解、13ケースLegacy/v2比較とWAIT内訳を検証する。

## 24. Changed Files

- `lib/ai/signal-engine-v2.ts` — pure Direction / Safety / Action resolver
- `lib/ai/engine.ts` — v2 pipeline integration、互換field維持
- `lib/ai/input.ts` — stale source metadata
- `lib/ai/technical.ts` —既存weightをv2と共有
- `lib/ai/types.ts` — optional v2 result field
- `components/dashboard/ai-analysis.tsx` — v2 direction score表示
- `tests/signal-engine-v2.test.ts` — pure testsと比較fixture
- `tests/ai.test.ts` — stale / Direction / Scenario regression
- `outputs/Task113-Signal-Engine-v2.md` — implementation report

## 25. Known Limitations

- v2は既存technical scoreの再分類で、新しい予測能力・収益性能を追加していない。
- AI unavailable等はSafety BLOCKではないが、互換性のためActionはsoft waitになる。Directionは変わらない。
- Data Quality/insufficient/staleでBLOCKされてもDirectional scoreは表示され得る。必ずSafetyとActionを併読する。
- AI-derived fundamentalsはlegacy `AIAnalysis.score`には残るため、legacy scoreとv2 direction scoreは一致しない場合がある。
- 固定13ケースは本番分布を代表しない。

## 26. Backtest Requirements

将来のBacktestで、時系列分割・pair/session別集計、spread/slippage/commission、signal availabilityとSafety blockを含む取引可能性、neutral/safety/scenario/context WAIT各群を計測する。Thresholdやweight変更はout-of-sample評価前に行わない。

## 27. Final Verdict

Task113の目的であるdeterministicなDirectionとTrade Safety / Entry Timingの分離、AIなしでのDirection計算、理由分類、Legacy比較を実装した。WAIT数は固定fixtureで同数、利益性能は未評価。Backtest Engineでの検証を次工程とする。