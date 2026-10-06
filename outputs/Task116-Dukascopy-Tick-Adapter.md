# Task116 Dukascopy Tick Adapter — Phase 2

監査日: 2026-10-06  
Branch: `feature/v1.2-task116-dukascopy-adapter`  
Network/API/download/provider access: なし  
DB migration: なし  
Commit/push: なし

## 1. Verdict

Observed Dukascopy Historical Data ExportのTick BID/ASK CSV schemaに合わせた、厳密なlockstep source adapterを実装した。raw file hashesを別々に記録し、同期midpoint ticksからcanonical UTC 1m MID OHLC AsyncIterableを生成してPhase 1 engineへ直接渡せる。Task113–116 strategy/execution/validation semanticsは変更していない。

## 2. Scope

対象はlocal BID/ASK fileのexact raw checksum、明示side別逐次parse、row-position synchronization、tick-level midpoint、UTC 1m OHLC aggregation、spread diagnostics、Phase 1 integration、chronological chunk guard。BI5/network/download/Bid-Ask execution modelは対象外。

## 3. Observed Dukascopy Format

実sampleはDownloads内の`USD-JPY_1Tick_BID_2025-01-06_12_00-12_00_Etc_UTC.csv`と対応ASK CSV。headerは正確に`Etc/UTC,Open,High,Low,Close,Volume`。行は6列、timestampは例`2025-01-06T12:00:00+00:00`（seconds precision、UTC offset表記）、Tick filename markerは`1Tick`。Observed Tick行ではOpen/High/Low/Closeが同値だったため、その価格をtick値として採用。

offline全行監査時: BID 13,566 rows、ASK 13,566 rows、row-wise timestamp mismatch 0、timestamp decrease 0、distinct timestamp strings 3,183、BID/ASK OHLC mismatch 0、ASK<BID 0、invalid/non-positive price 0。実時間範囲は12:00:00〜12:59:59 UTC。

監査時raw hash: BID `b44023a4ec5ad863a352fb3a100227454bdcf3902831ac2fa18d9413a100c80d`、ASK `e18c093678faa67cd05d62cb86521c57b3c22a5bb654eeb39cbbe6aadc6591c7`。これらは当時Downloadsにあった実sample bytesのhash。source filesは後にDownloadsから消えており、adapterへの直接再投入は未実施。repositoryへraw sampleは複製していない。

## 4. BID/ASK Synchronization Contract

callerが`bidFile`/`askFile`へroleを明示する。二つのline iteratorをlockstepで1行ずつ読み、header、row count、raw timestamp stringの完全一致、両side個別のnon-decreasing timestamp、価格妥当性、ASK>=BIDを検証する。同秒重複は行位置を保持して許可。片side欠損・時刻ずれ・crossed quoteでfail closed。nearest match、timestamp-only join、sort、dedupe、fillはない。

既知source filename patternならside/pair/date/hour intervalを追加照合する。filenameのside labelは補助検査に限り、roleは引数の`bidFile`/`askFile`で決まる。CSV内容の数値からsideを推測しない。

## 5. Tick Price Semantics

header/列数はobserved sourceと完全一致を要求。各BID/ASK rowで4つのOHLC値を有限正数としてparseし、numeric equalityを検査する。非同一OHLCはsource semanticsが未確認として拒否。Volume列はschema/列数確認のみでMID計算に使わない。

## 6. MID Calculation

同じrow indexの同期tickについて`mid=(bid+ask)/2`、`spread=ask-bid`。mid/spreadはroundしない。Task115 executionやTask116 cost sensitivityには適用しない。

## 7. Canonical 1m Aggregation

mid tickをUTC minute startへfloorし、minute変更時に確定recordをyield。OHLCはfirst/max/min/last。minute内のsame-second rowsも元順を維持。observed tickのないminuteはyieldせずfabricationなし。出力形はPhase 1 canonical `{time,open,high,low,close}`。

## 8. Timestamp / UTC Handling

実sampleで確認したheader timezone `Etc/UTC`とtimestamp形式`YYYY-MM-DDTHH:mm:ss+00:00`のみ受け付ける。local timezone/DST推論なし。source timestampをmillisecond canonical UTCへ正規化し、minute OHLC `time`は`YYYY-MM-DDTHH:mm:00.000Z`。日付/time validityを round-trip checkする。

## 9. Duplicate Timestamp Handling

同一timestampの複数行は正当なmulti-tickとしてposition順にすべて使う。raw row自体のdeduplicationはしない。同一時刻のrow数や値が片側と一致しない場合はlockstep mismatchで停止。

## 10. Ordering

source row orderを維持しtimestamp decreaseは拒否、自動sortなし。future multi-file helper `concatenateCanonicalMinuteChunks`はminute streamの後続chunk startが直前minuteよりstrictly greaterであることを要求し、逆行とsame-minute overlapを別errorで拒否する。

## 11. Spread Diagnostics

receiptにtickCount、minSpread、maxSpread、arithmetic meanSpreadをincrementalに記録。実sample監査値: min `0.001`、max `0.016`、mean約`0.00849402919062`。p50/p95は未実装。diagnostic値をstrategy/risk/costへ適用しない。

## 12. Streaming Architecture

raw SHA-256をfile streamで先に計算し、parser passでも同時hashしてfile changed-between-passesを検出。`readline`でBID/ASK一行ずつ同期し、current minute accumulator、spread sums/extrema、hash stateのみ保持。読み込みは二passだが、いずれもstreamingで全file配列を作らない。1m streamはsingle-use AsyncIterable。

## 13. Raw Checksums

`bidRawSha256`/`askRawSha256`はraw file exact bytesから別々に計算。target CSV hashとは別もの。両raw hashesとrole付きsourceArtifactIdsをPhase 1 configへ渡し、Phase 1 receiptにも保持する。途中でartifact bytesが変わった場合はfail closed。

## 14. Provenance

adapter receipt: version、source name、artifact IDs、BID/ASK raw hashes、canonical pair、period Tick、header timezone Etc/UTC、priceType MID、transform `SYNCHRONIZED_BID_ASK_TICK_MID`、filenameで確認できたdate/hour、first/last source tick、first/last canonical minute、tick/minute counts、spread diagnostics。

## 15. Phase 1 Integration

`prepareDukascopyHistoricalDataset`がadapter streamを既存`prepareHistoricalDataset`へ直接接続。Phase 1 configには`priceType: MID`、`originalTimeframe: 1m`、`originalTimezone: Etc/UTC`、明示raw hashesを渡す。target timeframe aggregationはPhase 1だけが担当。synthetic one-day fixtureでadapter→Phase 1→manifest CSV→`loadLocalHistoricalDataset`を検証し、4 output files、1day row、target actual-byte SHA、source/target hash分離を確認。

## 16. Look-Ahead Safety

ticksはsource orderのままminute bucket内でのみ集約し、次minute tickを受信した時点で前minuteをyield。後続minuteは既確定minute accumulatorへ戻らない。future-tick append invariance testで既出canonical minute不変を検証。Phase 1側にもfuture append invariance regressionあり。

## 17. Chunk Handling

single BID/ASK pairを1 adapter streamとする。将来の連続source chunksは`concatenateCanonicalMinuteChunks`へ渡せる。chunkごとのadapter receipt/raw hashesは個別に保持する前提。chunk overlap、逆行、重複artifactによるsame minute overlapは現状mergeせずfail closed。

## 18. Tests

`tests/dukascopy-tick-adapter.test.ts`追加。observed header/timestamp、Tick OHLC equality、same timestamp preservation、row-wise sync/count mismatch、crossed/invalid/non-positive prices、decrease、timezone/header、filename pair/role/date/hour、exact midpoint/no rounding、minute/day boundaries、missing minute、raw hashes、future append、chunk order/overlap、Phase 1 4-timeframe integration、network zero、80,000 synthetic tick streamingを検査。

実sample自体はtest fixtureとしてcopyせず、schema-derived deterministic synthetic rowsを使う。別途、実sampleが利用可能だった際にoffline全行監査を実施した。

## 19. Performance

synthetic 80,000 ticks（BID/ASK各80k行）、minute outputs 1,334。TAP単独testでadapter stream約945 ms、RSS snapshot delta約76,902,400 bytes。test file generation/Node runtime/GCの影響を含むmachine-specific参考値で、adapter isolated peak memoryではない。Hard thresholdなし。5年real tick stream未実施。

## 20. API Impact

なし。global fetch stub testで0 fetch。Network/API/download/provider callなし。Downloadsのlocal filesだけをsource audit時にreadした。

## 21. DB Impact

なし。DB migration 0。

## 22. Strategy Impact

Task113 Signal Engine、Task114 replay、Task115 execution、Task116 validation/split/OOS、risk/fill/SL_FIRST/NEXT_CANDLE/cost defaults変更なし。Task115は引き続きgross single-price simulator。BID/ASK execution modelを追加していない。

## 23. Changed Files

- `lib/backtest/dukascopy-tick-adapter.ts` (new): source parser, sync tick stream, MID minute aggregation, raw provenance, Phase 1 wrapper, chunk guard。
- `tests/dukascopy-tick-adapter.test.ts` (new): parser/sync/quality/integration/performance cases。
- `outputs/Task116-Dukascopy-Tick-Adapter.md` (new): this report。

## 24. Known Limitations

- actual Downloads BID/ASK filesはadapter実装中に消失し、adapterに対する実file end-to-end smokeを再実行できなかった。実sampleのheader/all-row audit metrics/raw hashesは取得済み。unit fixturesはsyntheticでありmarket evidenceではない。
- parserは観測済みseconds precision `+00:00`、exact header、6-column formatに限定。subsecond timestamp、別header/line ending details、filename variantsは実artifact確認なしに許容しない。
- Volume値を解釈・使用しない。
- current Phase 1 final output requires each target timeframe to contain at least one complete candle; partial requested periods shorter than 1day cannot make all four CSV outputs. Use longer aligned input chunks/range; semanticsは変更しない。
- filename metadataはknown export patternでのみ照合。他のfilenameならcaller-provided explicit pair/role and source expectationsが必要。
- No long historical real ticks benchmark or full-day actual Dukascopy-to-Phase1 dataset was run.

## 25. Real Dataset Acquisition Requirements

ユーザー提供のread-only raw BID/ASK exports、source/export version、license/retention permission、選択pair/date/hour、filename/header/timezoneを保持。次回はfilesをavailable pathへ置いてadapterを直接smokeし、receipt raw hashesを再照合。full-dayまたはより長いaligned chunksをcanonical minute streamとして連結後、Phase 1へ渡す。Adapter自体はdownloadしない。

### Actual Real-File Smoke

- Result: **PASS**. Existing adapter ran directly against both raw artifacts; Phase 1 resampling was not invoked because this source covers one hour only.
- BID path: `tmp/dukascopy/USD-JPY_1Tick_BID_2025-01-06_12_00-12_00_Etc_UTC.csv`; SHA-256 `b44023a4ec5ad863a352fb3a100227454bdcf3902831ac2fa18d9413a100c80d`.
- ASK path: `tmp/dukascopy/USD-JPY_1Tick_ASK_2025-01-06_12_00-12_00_Etc_UTC.csv`; SHA-256 `e18c093678faa67cd05d62cb86521c57b3c22a5bb654eeb39cbbe6aadc6591c7`.
- Both headers exactly matched `Etc/UTC,Open,High,Low,Close,Volume`; requested pair `USD/JPY`, source timezone `Etc/UTC`, source period Tick, date/hour filename metadata matched `2025-01-06` / `12 UTC`.
- BID rows **13,566**, ASK rows **13,566**, adapter synchronized ticks **13,566**. Row-wise raw timestamp mismatch **0**; timestamp decreases **0**; repeated same timestamp rows **10,383** (3,183 distinct timestamp strings) and were preserved positionally.
- BID Tick OHLC equality violations **0**; ASK Tick OHLC equality violations **0**; ASK<BID crossed quotes **0**. Thus all 13,566 pairs yielded valid midpoint ticks using the adapter transform `SYNCHRONIZED_BID_ASK_TICK_MID`.
- First/last source tick: `2025-01-06T12:00:00.000Z` / `2025-01-06T12:59:59.000Z`. Canonical UTC 1m MID rows: **60**, from `2025-01-06T12:00:00.000Z` through `2025-01-06T12:59:00.000Z`.
- Spread diagnostics: min `0.0009999999999763531`, max `0.016000000000019554`, mean `0.00849402919062374` price units. Floating point values are reported without rounding.
- No interpolation: 60 emitted minute buckets each had observed ticks; no empty minute was emitted. No dedupe: adapter tickCount equals both raw row counts, including the 10,383 repeated-timestamp rows. No autosort: raw timestamp-decrease count was 0 and row order was retained.
- Independent spot calculation from synchronized source rows matched all emitted minute candles. `12:00 UTC`: O `157.2025`, H `157.2145`, L `157.1215`, C `157.1255`. `12:30 UTC`: O `157.024`, H `157.1125`, L `156.993`, C `157.096`. `12:59 UTC`: O `156.7405`, H `156.7935`, L `156.74`, C `156.7885`.
- Raw hashes before/after the smoke were identical. Raw CSV bytes were read only and remain ignored by Git.

## 26. Full Regression

- `npm test`: **1,301/1,301 PASS**。
- `npm run lint`: **PASS**, warningsなし。
- `npm run build`: **PASS**。
- `npm run test:e2e -- --workers=1 --reporter=dot`: **362/362 PASS**, `workers=1`, 4.5 minutes。
- Synthetic performance: **80,000 ticks**, 945 ms, RSS snapshot delta 76,902,400 bytes。
- `git diff --check`: PASS after this report update.

## 27. Final Verdict

Source-specific Phase 2 adapterを観測済みDukascopy Tick CSV formatへ限定して実装。今回のactual raw BID/ASK 13,566組を全件stream検証し、lockstep、価格意味、canonical 1m MID 60行、独立OHLC spot checksが一致したためActual Real-File SmokeはPASS。Task115 executionやTask116 strategy semanticsは変更なし。No commit or push was performed.
