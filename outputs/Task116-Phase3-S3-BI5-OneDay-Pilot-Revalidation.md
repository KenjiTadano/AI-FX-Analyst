# Task116 Phase 3: BI5 LZMA-Alone Production Fix / One-Day Pilot Revalidation

- 実施日: 2026-10-07
- Branch: `feature/v1.2-task116-historical-acquisition`
- Verdict: **PASS**
- Five-year acquisition gate: **CLEARED**（Pilot検証条件の達成のみ。5年取得の実行許可ではない）

## Production Fix / Contract Audit

既存 `createXzLzmaDecompressor` のcommandを `xz --format=raw --lzma1=dict=8MiB --decompress --stdout` から **`xz --format=lzma --decompress --stdout`** へ変更した。LZMA-Aloneを明示し、標準xzにheader解釈を任せる。新decoder、auto-detection、raw fallback、独自header解析・stripは追加していない。

`DukascopyBi5Receipt.compression` の型と生成値を **`LZMA_ALONE`** に更新した。旧literalを受け入れる互換分岐なし。参照auditでは旧値を判定する他codeやcheckpoint fieldはなく、acquisition / Phase 1 / importerのschema・semanticsは変更していない。adapter versionと公開function名は維持した。20-byte parser以降の挙動も変更していない。

Foundation文書は現行LZMA-Alone契約へ更新。前回FAILのPilot報告書とcompression diagnostic報告書は履歴として無変更のまま保持した。履歴中のraw mode表記は当時の失敗を記録したもの。

## Synthetic Fixtures / Focused Check

fixtureは `xz --format=lzma --lzma1=dict=4MiB --compress --stdout` で生成する。既存testで13-byte header、properties `0x5d`、dictionary 4 MiB、streaming compressorのunknown uncompressed-size sentinelを確認し、overrideなしのproduction decoderによるdecodeと `compression: LZMA_ALONE` receiptを検査する。

raw LZMAおよびXZ containerをproduction decoderが拒否するtestも追加し、fallback / auto-detectionがないことを確認した。unit test内のraw compressionは拒否testの入力に限る。

- Foundation focused tests: **30 / 30 PASS**。
- 初回focused compileは既存TypeScript targetでBigInt literalが使えず失敗。期待値を `BigInt("0xffffffffffffffff")` に修正し、同じcheckを再実行してPASS。target / tsconfigは変更していない。
- compiled JSはsystem `/tmp/task116-*` 一時directoryへ出力し、各実行後に削除した。lint設定を緩めていない。

## Raw Artifact

- Path: `tmp/dukascopy/s3-pilot/2025-01-06/USDJPY_2025-01-06_ticks.bi5`
- Object key: `USDJPY/2025/00/06_ticks.bi5`
- Exact byte size: **687744**、指定値と一致。
- SHA-256: `1304f89abecdf1808997a16d3856b7d94c16530cdea97b0eab5ef1e33fb90d01`、指定値と完全一致。
- 全pipeline前後でhash / sizeを確認し、raw bytesの `Buffer.equals` もtrue。rawは変更していない。
- 既存取得済みlocal artifactのみ使用。AWS/S3 HEAD / list / downloadを追加実行していない。S3 keyやRequester Pays情報を本作業でlive再照会したとは扱わない。

## Production Decode / Tick Validation

**既存 `createDukascopyBi5MidStream` をdecompressor overrideなしで実行してPASS**。明示instrument `USDJPY`、UTC day `2025-01-06`、expected raw SHA-256を渡し、streamを最後まで消費して完了receiptを取得した。以下はdiagnosticからの転載ではなく修正後production実行結果。

- Adapter: `DUKASCOPY_S3_BI5_MID_V2`。
- Compression: **`LZMA_ALONE`**。
- Record format: **20-byte big-endian `>IIIff`**、milliseconds / ask / bid / askVolume / bidVolume。
- PointValue: **1000**、同じrecordのBID/ASKからMIDを計算。
- Decompressed bytes: **3292620**。
- Decoded records: **164631**。
- First tick: **`2025-01-06T00:00:00.101Z`**。
- Last tick: **`2025-01-06T23:59:57.721Z`**。
- Timestamp decreases: **0**、equal timestamps: **0**。
- Crossed quotes（ASK < BID）: **0**。
- Finite positive ASK/BID、finite non-negative volume、UTC day内millisecond offset: **全164631 record PASS、違反0**。既存parserは違反時にthrowするため、完了receiptの取得で全件の検査通過を確認した。
- Trailing remainder: **0**、decompressed byte lengthは20で割り切れる。malformed recordによる例外なし。
- Spread diagnostics（無丸め）: min `0.0009999999999763531`、max `0.14300000000000068`、mean `0.007795269420712715`。strategyやexecution costへ適用していない。

## Canonical 1m / Gaps

- Canonical UTC 1m MID count: **1429**。
- First minute: **`2025-01-06T00:00:00.000Z`**。
- Last minute: **`2025-01-06T23:59:00.000Z`**。
- 全日1440 UTC minutesに対するmissing minute count: **11**。
- MIDは `(bid + ask) / 2`、minute OHLCはfirst / max / min / last。
- sorting / dedupe / fill / interpolation / rounding / empty-minute fabricationなし。

Missing minute list（すべてUTC）:

```text
2025-01-06T22:00:00.000Z
2025-01-06T22:01:00.000Z
2025-01-06T22:02:00.000Z
2025-01-06T22:03:00.000Z
2025-01-06T22:22:00.000Z
2025-01-06T22:26:00.000Z
2025-01-06T22:27:00.000Z
2025-01-06T22:44:00.000Z
2025-01-06T22:45:00.000Z
2025-01-06T22:46:00.000Z
2025-01-06T22:47:00.000Z
```

欠損理由を市場休止等と推測して分類していない。

## Export Reference Strict Comparison

既存Phase 2 production `createDukascopyTickMidStream` を使用し、BID/ASK CSVをlockstep処理した。pair / date / UTC hourは明示指定。

- BID: `tmp/dukascopy/USD-JPY_1Tick_BID_2025-01-06_12_00-12_00_Etc_UTC.csv`
- BID SHA-256: `b44023a4ec5ad863a352fb3a100227454bdcf3902831ac2fa18d9413a100c80d`
- ASK: `tmp/dukascopy/USD-JPY_1Tick_ASK_2025-01-06_12_00-12_00_Etc_UTC.csv`
- ASK SHA-256: `e18c093678faa67cd05d62cb86521c57b3c22a5bb654eeb39cbbe6aadc6591c7`
- Reference ticks: **13566**、canonical minutes: **60**。
- Reference tick bounds: `2025-01-06T12:00:00.000Z` ～ `2025-01-06T12:59:59.000Z`。
- 比較範囲: `2025-01-06T12:00:00.000Z` ～ `2025-01-06T12:59:00.000Z`。両seriesが期待する連続60 timestampsを持つことを追加確認。
- 既存 `compareCanonicalMinuteSeries` によるtimestamp / open / high / low / close: **60 / 60 exact match、mismatches `[]`、PASS**。
- tolerance / rounding / normalizationなし。

指定spot OHLCもproduction出力から全fieldをstrict equalityで照合し、すべてPASS:

- `12:00 UTC`: O `157.2025`, H `157.2145`, L `157.1215`, C `157.1255`。
- `12:30 UTC`: O `157.024`, H `157.1125`, L `156.993`, C `157.096`。
- `12:59 UTC`: O `156.7405`, H `156.7935`, L `156.74`, C `156.7885`。

## Full-Day → Phase 1

60/60比較PASS後のみ、既存 **`prepareDukascopyBi5HistoricalDataset`** を一度呼び、wrapper内部のproduction BI5 full-day streamから既存 `prepareHistoricalDataset` に投入した。decompressor overrideなし。比較用decodeとwrapper用decodeは別消費だが、両artifact receiptsが完全一致することをassertした。**Phase 1 preparationの実行回数は1回**。

- Dataset directory: `tmp/dukascopy/s3-pilot/2025-01-06/production-revalidation-dataset`
- Dataset ID: `task116-usdjpy-2025-01-06-production-pilot`
- dataKind: **OBSERVED**、pair: `USD/JPY`、priceType: `MID`、originalTimeframe: `1m`、originalTimezone: `UTC`。
- Requested range: `[2025-01-06T00:00:00.000Z, 2025-01-07T00:00:00.000Z)`。5年default範囲は使っていない。
- Accepted input rows: **1429**。rejected / ignored / duplicate / unordered / invalidはすべて **0**。
- Provenanceにはsource名、object key、raw SHA-256を保持。licenseProvenanceにはuser-provided local validation only、再配布・広範取得許可は未評価と明記。

4 timeframe outputs（実CSV bytesからhashを再計算し、manifest / importer checksumsと一致）:

- **15m**: **96 rows**、first `2025-01-06T00:00:00.000Z`、last `2025-01-06T23:45:00.000Z`。SHA-256 `ebfeb8ec19553bbcc1b0fa1f74b56cebf3ce72c631a7927df3bc8fd493373003`。
- **1h**: **24 rows**、first `2025-01-06T00:00:00.000Z`、last `2025-01-06T23:00:00.000Z`。SHA-256 `fb229e3140b2cd3f4bb2ead77ba7f8de2acd94b625ec4702d4641896e67e6924`。
- **4h**: **6 rows**、first `2025-01-06T00:00:00.000Z`、last `2025-01-06T20:00:00.000Z`。SHA-256 `e8456cd20d514cf692e07c9085ca0487eb1655f5652892a73698d041d3c38c39`。
- **1day**: **1 row**、first / lastとも `2025-01-06T00:00:00.000Z`。SHA-256 `0986e04fc0afa1e0935011da88a06129f222c26d4c490e98e1795cd2e5638d96`。

全timeframe qualityはobserved minutes **1429**、expected calendar minutes **1440**、unclassified missing minutes **11**。empty bucket / partial range bucketは **0**。既存Phase 1は要求範囲が部分的なbucketを出力せず、範囲内で観測minuteがあるbucketはmissing minuteがあっても観測OHLCから出力する。この契約を変更していない。96 / 24 / 6 / 1 rowsは1440 minuteがすべて観測されたことを意味しない。

## Local-Dataset Importer Smoke

生成実datasetを既存 **`loadLocalHistoricalDataset`** へ投入し、**valid=true、errors `[]`、PASS**。

- manifest、source / timezone / dataKind / license provenance、canonical dates、supported timeframes、OHLC、strictly increasing timestampsを既存validatorで確認。
- 全4 CSVのSHA-256、rows、first / last timestampsをmanifestおよびPhase 1 qualityと照合。
- importer target-timeframe missingIntervalsは `[]`。元1mの11欠損はpreparation receiptに保持され、target intervalが連続していることとは区別する。
- 実CSVをmemory内だけで改変したnegative smoke: hash tamper / invalid timezone / invalid exportedAt / unsupported timeframeをすべて既存importerが拒否。生成CSV / manifest本体は改変していない。
- この1日datasetをstrategy evidence / OOS evidenceとして使っていない。

## Regression

- Focused Foundation: **30 / 30 PASS**。
- `npm test`: **1331 / 1331 PASS**、fail / cancelled / skippedは0、legacy market regressionsもPASS、exit 0。
- `npm run lint`: **PASS**、error / warningなし、exit 0。
- `npm run build`: **PASS**、exit 0。環境のApple Silicon / Rosetta 2性能警告あり。
- `npm run test:e2e -- --workers=1 --reporter=dot`: **362 / 362 PASS**、workers=1、5.0分、exit 0。今回の再検証では中断なしで完走。
- `git diff --check`: **PASS**。変更対象untracked 4ファイルも `git diff --no-index --check /dev/null <file>` で確認し、全件空白違反なし。初回はFoundation文書の既存2行の末尾スペースを検出し、その2箇所だけ除去して同じcheckを再実行しPASS。

## Git Safety / Scope

今回変更した既存ファイルはBI5 adapter、Foundation tests、Foundation契約文書。新規追加は本報告書のみ。その他開始時点のuntracked作業を保持した。

raw BI5 / reference CSV / generated pilot dataset / machine-readable summary / regression logsは `tmp/dukascopy/` 配下のままGit管理しない。production validationの構造化記録は `tmp/dukascopy/s3-pilot/2025-01-06/production-revalidation-summary.json` に保存。

E2E後の最終Git確認:

- `git status --short`: 開始時のuntracked 7ファイルに本報告書1ファイルを加えた8ファイルのみ。raw / reference / dataset / credentialsの追加表示なし。
- `git diff --stat`: 出力なし。変更したadapter / tests / Foundation文書は開始時点からuntrackedのため、このcommandのstatには現れない。
- `git diff --cached --stat`: 出力なし、staged変更なし。
- `git ls-files -- tmp '*.bi5'`: 出力なし、raw / generated datasetのtracked登録なし。
- `git check-ignore`: raw BI5 / BID / ASK / generated manifest / machine-readable summaryはすべてignored。
- 最終raw size / SHA-256は **687744 bytes** / 指定hashと完全一致。

AWS credentials / profile / `~/.aws` の参照・表示・コピー・ログ出力なし。AWS/S3追加アクセス・downloadなし。5年取得なし。DB / migration / strategy / Signal Engine / Task114 / Task115 / Task116 baseline logic変更なし。commit / pushなし。

## Limitations / Five-Year Acquisition Gate

- 実確認はUSDJPYの1日・1artifactのみ。他の日付 / pair / framing variants、5年の存在coverage / bytes / throughput / memory / costsは未検証。
- 欠損11分の意味は未分類。fillや市場休止の推定で消していない。
- 1日datasetはstrategyの優位性やOOSの証拠ではない。
- **Five-year acquisition gate: CLEARED**。production real BI5 decode、全tick validation、60/60 exact parity、Phase 1、real importer smoke、test / lint / build / single-worker E2E / diff checkがすべてPASSしたため、今回指定のPilot gate条件を達成した。
- **CLEAREDは5年downloadの実行許可ではない**。実取得は別途object数・推定bytes・Requester Paysコスト・resume/checkpoint設計・license/retentionを確認し、明示許可を得る必要がある。本作業では取得しない。