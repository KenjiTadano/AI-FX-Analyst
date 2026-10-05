# Task116 Historical Dataset Preparation — Phase 1

監査・実装日: 2026-10-05  
Branch: `feature/v1.2-task116-historical-data`  
Network/download/provider/API/DB access: なし  
Commit/push: なし

## 1. Verdict

Canonical UTC 1m OHLC async streamからUTC 15m/1h/4h/1dayのTask116-compatible CSVをbounded-memoryで生成するPhase 1 engineを追加した。price typeは必須設定・receipt記録のみで、Bid/AskからMIDを合成しない。Task113–116 strategy/validation semanticsは変更していない。指定regressionはすべてPASS。

## 2. Scope

対象はcanonical 1m bar-start streamの検証、UTC bucket resampling、CSV/manifest/receipt生成、Task116 importerとの接続、5年相当stream benchmark。Dukascopy固有parser、source取得、Bid/Ask処理、strategy/validation改訂は対象外。

## 3. Canonical 1m Contract

入力recordは`{ time, open, high, low, close }`。timestampは厳密な`YYYY-MM-DDTHH:mm:ss.sssZ`、1分境界整列、bar START。全価格はpositive finite numberで、`high >= max(open, close, low)`、`low <= min(open, close, high)`。入力全体はstrict chronological。1m専用CSV parserやsource formatの仮定は追加せず、engine APIは同期/非同期Iterableのrecordを受ける。

## 4. Price Type

`priceType`は必須で`MID`、`BID`、`ASK`、`SOURCE_DEFINED`。intended baselineのMIDは呼出側がcanonical inputの価格種別を確認して指定した場合のみ記録される。engineの`priceTypeTransform`は`NONE`。Bid/Askやaggregate済みOHLCからMIDを発明しない。

## 5. Requested Range

既定範囲はUTC半開区間`[2021-01-01T00:00:00.000Z, 2026-01-01T00:00:00.000Z)`。開始含む、終了除外。minute boundary整列と`start < end`を検査する。設定で変更可能。

## 6. Resampling

各target bucketを`[start, end)`とし、`open=first observed open`、`high=max high`、`low=min low`、`close=last observed close`。volumeなし。数値はroundしない。空bucketはCSV candleを出さない。欠損minuteは補間・forward-fill・synthetic OHLCで埋めない。

## 7. UTC Boundaries

全境界をUTC epoch固定で計算し、DST/local timezoneでは移動しない。target timestampはbucket start。Task114は`time + duration`をclose/as-ofとして扱うため既存confirmed-candle semanticsを維持する。

## 8. Partial Bucket Policy

requested rangeが対象bucketの途中から/途中までの場合、そのtarget candleを出力しない。各timeframeの`partialRangeBucketCount`へ記録する。これはrange端だけのpartial判定であり、market closureによる通常の未観測minuteとは区別する。

## 9. Missing Minute Policy

bucketごとにobserved、requested range内calendar-expected、missing minute数を記録する。分類は`UNCLASSIFIED_MISSING_MINUTES`。missing数はprovider outageを意味せず、weekend/holiday/market closureを含み得る。欠損でOHLCを生成・補完しない。

## 10. Empty Bucket Policy

observed minuteが0ならtarget candleなし。`emptyBucketCount`とmissing minute metadataへ記録する。休場/障害を推測しない。

## 11. Validation

invalid/canonical UTC違反、minute未整列、NaN/Infinity/zero/negative、malformed OHLC、duplicate timestamp、previous timestamp以下の順序違反はfail closed。dedupe/autosortなし。入力エラーは行番号相当のstream row countとduplicate/unordered/invalid/rejected countersを持つ`HistoricalPreparationInputError`で中断する。range外の正しい順序行は検証後`ignoredOutOfRangeRows`に数え、出力へ入れない。

## 12. Streaming Architecture

`prepareHistoricalDataset`は`AsyncIterable<unknown> | Iterable<unknown>`を`for await`で逐次処理し、raw 1m row配列を保持しない。4 timeframeごとにcurrent bucket accumulator 1個、bounded 64 KiB CSV write buffer、incremental SHA-256のみ保持する。出力は同一parent内のstaging directoryへ作り、全成功時にrenameで公開する。既存output directoryは上書きせず拒否し、失敗時はstagingを削除する。

## 13. Output CSV

Task116 importerに合わせ、UTF-8/BOMなし/LF、header `time,open,high,low,close`、末尾newline、canonical UTC bucket-start timestampで出力。USD/JPY例は`USDJPY-15m.csv`、`USDJPY-1h.csv`、`USDJPY-4h.csv`、`USDJPY-1day.csv`。EUR/JPY・GBP/JPYではpair slashを除いたprefixとなる。

## 14. Manifest

既存`HistoricalDatasetManifest`を使用し、datasetId、canonical slash pair、sourceName、`timezone: UTC`、generatedAtをexportedAtへ、license provenance、`OBSERVED|SYNTHETIC`、各timeframeのfilenameとactual output bytes SHA-256を生成。schemaは変更しない。

## 15. Quality Receipt

`preparation-receipt.json`をmanifestと分離して生成。preparation version、sourceName/artifact IDs/raw checksums、priceType、original timeframe/timezone、requested half-open range、UTC target boundaries、input/accepted/rejected/out-of-range/duplicate/unordered/invalid counts、各timeframeのoutput count/first-last timestamp/empty/partial/observed/expected/missing/unclassified counts、generatedAt、normalization rulesを保持。

## 16. Provenance

sourceName、sourceArtifactIds、rawChecksums、originalTimezone、originalTimeframe、priceType、requested rangeはconfigから必須/明示値として受ける。timezone変換やsource parsingは本engineの責務ではない。Dukascopy由来値を推定しない。

## 17. Checksum

target SHA-256はCSV writerへ渡した正確なUTF-8 bytes（headerと各LF含む）へincrementalに計算しmanifestへ格納。raw checksumはconfigからreceiptの`rawChecksums`へ独立記録し、target hashと混ぜない。対象fileそのものを後から再読してhashする必要はないが、testでは実output bytesと照合する。

## 18. Look-Ahead Protection

minute timestampからUTC bucket startを決定し、そのbucketの`[start,end)`内recordだけを集約する。end時刻以降のminuteは別bucketへ進み、既に閉じたbucketを変更できない。Task114/116向けtimestampはstartのままなので、既存duration加算でclose/as-of時刻となる。future append invariance test追加済み。

## 19. Memory / Performance

5年相当generator benchmark: 2,629,440 input rows、約24,989 ms、RSS snapshot差分76,828,672 bytes、`process.resourceUsage().maxRSS` native-unit差分119,592。OS native unitはここで換算しない。OOMなし。raw candle配列を保持せず、出力行数は15m 175,296、1h 43,824、4h 10,956、1day 1,826。測定はこのmachine/runtime/testでの参考値でhard thresholdではない。Node process全体の厳密なisolated peak計測ではない。

## 20. Task116 Compatibility

生成manifest/4 CSV一式を既存`loadLocalHistoricalDataset`で再importし、USD/JPY、OBSERVED、全target timeframeを確認するtest追加済み。さらに340日synthetic 1m stream（489,600 rows）からDaily系列を生成し、loader経由で再import。1day系列のみを渡したfrozen-baseline smokeが完了し、Train/Validation/OOSそれぞれ1 run、204/68/68 evaluation signals、205 ms。これはpipeline connectivity smokeであり全4系列5年replayのperformance証明ではない。Task116 as-of replayは時刻ごとにprefix/indicatorsを再計算するため実dataset規模の長期performanceは別途測定が必要。strategy semanticsは変更しない。

## 21. API Impact

なし。engine/testで`fetch`をstubして0 callsを検査。Network/download/provider accessなし。

## 22. DB Impact

なし。migration 0。

## 23. Tests

`tests/historical-dataset-preparation.test.ts`に19ケースを追加: Task116再import/hash分離、4 timeframe OHLC、UTC境界/day/month/year/leap day、invalid/duplicate/unordered、missing/empty/weekend-like gaps、partial range、future append、chunk invariance、deterministic bytes、priceType no-transform、config provenance validation、既存output保護、5年generator benchmark、network fetch 0。

## 24. Regression

- `npm test`: **1,283/1,283 PASS**。
- `npm run lint`: **PASS**, warningsなし。
- `npm run build`: **PASS**。
- `npm run test:e2e -- --workers=1 --reporter=dot`: **362/362 PASS**, 4.5 minutes。
- 5-year benchmark: **2,629,440 rows**, 24,989 ms; output rows 175,296 / 43,824 / 10,956 / 1,826; RSS snapshot delta 76,828,672 bytes; maxRSS native-unit delta 119,592; OOMなし。
- `git diff --check`: 最終実行後に結果を記録。

## 25. Changed Files

- `lib/backtest/historical-dataset-preparation.ts` (new): offline bounded-memory streaming engine。
- `tests/historical-dataset-preparation.test.ts` (new): resampling/quality/integration/performance tests。
- `outputs/Task116-Historical-Dataset-Preparation.md` (new): this report。

既存Task113 Signal Engine、Task114 replay、Task115 execution、Task116 split/OOS、risk/fill/cost defaultsは変更なし。

## 26. Known Limitations

- canonical input recordsは呼出側がすでにUTC minute-startへnormalize済みである前提。実際のCSV/BI5 source adapterはない。
- `originalTimezone`はprovenanceであり、timezone conversionを実行しない。
- missing countはUTC calendar minutesとの差で、FX closuresを除外せず、provider outageも分類しない。
- rejected inputではfail-closed例外を返し、成功manifest/receiptは公開しない。失敗counterはexceptionに含む。
- staged output renameは同一filesystem内のdirectory renameを前提。
- Task116の長期as-of replay performanceは未benchmark。

## 27. Dukascopy Adapter Requirements

実sample、product/version、license/source artifactを確認してから別adapterを設計する。timestampがbar start/endのどちらか、timezone、Bid/Ask/tick/minute形式、price scaling/precision、binary/CSV layoutを推測しない。adapterはraw artifactを変更せずraw byte checksumを取り、canonical UTC 1m streamを供給する。MIDを選ぶ場合はsynchronized raw Bid/Askのtimestamp-level quoteから作る仕様を別途確定する。aggregated Bid/Ask OHLC high/lowの平均は使用しない。

## 28. Real Dataset Next Step

1. 実artifactを受領しsource/license/format metadataとraw checksumを記録する。
2. canonicalizerをsource固有adapterとして追加し、少数sampleでtimestamp/price scale/price typeをsource仕様と照合する。
3. Phase 1 engineへAsyncIterableで渡し、receiptのcoverage/gap/partial countersをレビューする。
4. 出力manifestをTask116 importerでload後、データ範囲・price type・Task116長期replay時間/RSSを別途判断する。

## 29. Final Verdict

Phase 1 generic canonical-stream engineは実装済み。Dukascopy parser/価格選択は意図的に未実装・未決定。Task113–116 semanticsに変更はない。unit、lint、build、single-worker full E2E、5年stream benchmark、限定Task116 smokeはPASS。final diff check後にPhase 1としてmerge可能。
