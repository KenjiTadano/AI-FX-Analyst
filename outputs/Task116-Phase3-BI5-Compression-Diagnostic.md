# Task116 Phase 3: Real BI5 Compression Contract Diagnostic

- 診断日: 2026-10-07
- Branch: `feature/v1.2-task116-historical-acquisition`
- Verdict: **A — LZMA-Alone confirmed. raw mode assumption is root cause.**
- 診断結果: **PASS**。ただし正式One-Day PilotのPASSではない。
- Five-year acquisition gate: **NOT CLEARED**。

## 結論

指定hashの実artifactは、13-byte headerを持つ **LZMA-Alone framing** と確認できた。productionと同じraw LZMA modeは失敗し、明示的なLZMA-Alone modeおよびPython標準libraryのdefault `lzma.decompress(compressed)` はともに成功した。両者の解凍サイズとSHA-256は一致し、全164631 recordの構造・tick検証、指定3分のOHLC、既存Export reference全60分のtimestamp / OHLC strict equalityが成立した。

この実artifactをheaderなしraw streamとして扱う既存compression framingの仮定が直接原因である。dictionary sizeの値だけを変更すればよいという診断ではない。raw artifactの破損を示す結果ではなく、B / Cではなく **A** と判定する。

今回のBI5解凍・MID集約は診断用であり、既存production BI5 adapterを修正して成功させたものではない。production / test code、Foundation契約、strategy / Signal Engine / Task114 / Task115 / Task116 baseline、DB / migrationは変更していない。AWS/S3へのアクセス、追加download、5年取得、decoder fallback実装、package install、commit / pushは行っていない。credentials / profile / `~/.aws` は参照していない。

## Raw Integrity

- Path: `tmp/dukascopy/s3-pilot/2025-01-06/USDJPY_2025-01-06_ticks.bi5`
- Exact size: **687744 bytes**、期待値と完全一致。
- SHA-256: `1304f89abecdf1808997a16d3856b7d94c16530cdea97b0eab5ef1e33fb90d01`、期待値と完全一致。
- 診断前に再確認し、不一致なら停止するguardを実行した。
- 診断後もsize / SHA-256が一致し、読み直したraw bytesの `Buffer.equals` もtrue。raw artifactは読み取りのみ。

## File / Header Analysis

First 32 bytes hex:

```text
5d00004000cc3d320000000000000068179f9b2bb79450030bdb23d2bbeb0daa
```

`file` command result:

```text
tmp/dukascopy/s3-pilot/2025-01-06/USDJPY_2025-01-06_ticks.bi5: LZMA compressed data, non-streamed, size 3292620
```

先頭13 bytes `5d00004000cc3d320000000000` をLZMA-Alone header layoutとして読むと以下になる。byte offsetは0-based。数値は実byte列から読み取った値であり、推定値ではない。

- Offset `0`: properties byte `5d` = **93**。propertiesの式 `(pb * 5 + lp) * 9 + lc` を逆算すると **lc=3 / lp=0 / pb=2**。
- Offsets `1..4`: dictionary size bytes `00 00 40 00`、uint32 little-endian = **4194304 bytes（4 MiB）**。
- Offsets `5..12`: uncompressed size bytes `cc 3d 32 00 00 00 00 00`、uint64 little-endian = **3292620 bytes**。unknown-size sentinelではない。
- Offset `13`以降はcompressed payload。headerの宣言sizeは実解凍結果 **3292620 bytes** と完全一致。

header解釈だけで確定扱いせず、明示LZMA-Alone解凍、Python解凍、全record構造および参照価格の一致によって裏付けた。公式documentation / Python exampleはユーザー提供の背景情報であり、本作業ではネットワークで再取得していない。

## Compression Diagnostics

### Productionと同じRaw Mode

```text
xz --format=raw --lzma1=dict=8MiB --decompress --stdout -- tmp/dukascopy/s3-pilot/2025-01-06/USDJPY_2025-01-06_ticks.bi5
exit: 1
stdout bytes: 0
stderr: xz: tmp/dukascopy/s3-pilot/2025-01-06/USDJPY_2025-01-06_ticks.bi5: Compressed data is corrupt
```

既存modeの失敗を再現した。production codeの変更、decompressor overrideによるproduction成功扱いはしていない。

### Explicit LZMA-Alone Mode

```text
xz --format=lzma --decompress --stdout -- tmp/dukascopy/s3-pilot/2025-01-06/USDJPY_2025-01-06_ticks.bi5
exit: 0
stdout bytes: 3292620
stderr: empty
```

解凍はstdoutを診断processのmemoryに保持し、解凍済みartifactをファイルへ永続化していない。header除去、filter推測、auto fallbackは実施していない。

### Python標準Library

利用可能な `python3` の標準libraryのみを使用し、raw compressed bytesをstdin経由で渡して `lzma.decompress(compressed)` を実行した。format指定やfilter指定なし。package installなし。

- Exit: **0**、stderrなし。
- Decompressed byte length: **3292620**。
- Python `struct.iter_unpack('>IIIff', decoded)` によるrecord count: **164631**。
- Decompressed SHA-256（xz / Pythonとも同じ）: `ba2977e3b269681bd90336c2a31656c05f560c7d440fef5efb5c426c1f511d1e`。
- xzとPythonのlength / hash / first record / last record / 全tick違反件数が一致。

## Structure / Tick Validation

解凍bytesを20-byte big-endian `>IIIff`、順にmilliseconds / askInteger / bidInteger / askVolume / bidVolumeとして全件処理した。USDJPY pointValueは1000。Node診断に加えてPythonでも同じ構造検証を独立実行した。

- Decompressed length: **3292620** = `164631 * 20`。
- `byteLength % 20`: **0**。
- Record count: **164631**。
- Trailing remainder: **0 bytes**。
- UTC day外millisecond offsets: **0**（`0 <= milliseconds < 86400000`）。
- Non-finite / non-positive ASK/BID: **0**。
- ASK < BID: **0**。
- Non-finite / negative volume: **0**。
- Timestamp decreases: **0**、全件non-decreasing。
- Equal adjacent timestamps: **0**。
- header uncompressed sizeとactual byte length: **完全一致**。

First record（record 1）:

```json
{"milliseconds":101,"askInteger":157515,"bidInteger":157505,"askVolume":1.2000000476837158,"bidVolume":3.5999999046325684,"ask":157.515,"bid":157.505,"timestamp":"2025-01-06T00:00:00.101Z"}
```

Last record（record 164631）:

```json
{"milliseconds":86397721,"askInteger":157745,"bidInteger":157737,"askVolume":1.2000000476837158,"bidVolume":4.5,"ask":157.745,"bid":157.737,"timestamp":"2025-01-06T23:59:57.721Z"}
```

volumeはfloat32の実読取値を記録し、丸めていない。sorting / dedupe / interpolation / missing-tick fabricationなし。

## Canonical MID Diagnostic

元record順の同一record BID/ASKから `(bid + ask) / 2` を計算し、UTC minute start単位でfirst / max / min / lastをOHLCとした。tickのないminuteは出力しない。diagnostic canonical minute countは **1429**、first `2025-01-06T00:00:00.000Z`、last `2025-01-06T23:59:00.000Z`。未観測の11分を補完していない。

以下3分は指定期待値と各fieldのJavaScript数値strict equalityで **すべて一致**。rounding / toleranceなし。

- `2025-01-06T12:00:00.000Z`: O `157.2025`, H `157.2145`, L `157.1215`, C `157.1255`。
- `2025-01-06T12:30:00.000Z`: O `157.024`, H `157.1125`, L `156.993`, C `157.096`。
- `2025-01-06T12:59:00.000Z`: O `156.7405`, H `156.7935`, L `156.74`, C `156.7885`。

## Export Reference 60分Comparison

参照側は**既存production** `createDukascopyTickMidStream` をそのまま使用し、`pair: USD/JPY` / expected date `2025-01-06` / expected UTC hour `12` を明示した。

- BID path: `tmp/dukascopy/USD-JPY_1Tick_BID_2025-01-06_12_00-12_00_Etc_UTC.csv`
- BID SHA-256: `b44023a4ec5ad863a352fb3a100227454bdcf3902831ac2fa18d9413a100c80d`
- ASK path: `tmp/dukascopy/USD-JPY_1Tick_ASK_2025-01-06_12_00-12_00_Etc_UTC.csv`
- ASK SHA-256: `e18c093678faa67cd05d62cb86521c57b3c22a5bb654eeb39cbbe6aadc6591c7`
- Reference synchronized ticks: **13566**、tick bounds `12:00:00.000Z` ～ `12:59:59.000Z`。
- Reference canonical minute count: **60**。
- BI5 diagnostic candidate count（同じ1時間）: **60**。
- 比較範囲: `2025-01-06T12:00:00.000Z` ～ `2025-01-06T12:59:00.000Z`。
- 各indexが期待する連続60個のminute timestampを持つことを両seriesで確認した。
- 既存 `compareCanonicalMinuteSeries` によるtime / open / high / low / closeのstrict comparison: **60 / 60 exact match**、mismatches `[]`。
- tolerance、丸め、値の正規化による一致処理なし。

これは**diagnostic comparison PASS**であり、production BI5 decoderを通した正式PilotのPASSではない。Phase 1 preparation / local-dataset importerへの投入は今回実施していない。

## Recommended Production Fix（未実施）

別途明示許可された変更作業で、既存 `createXzLzmaDecompressor` の解凍framingを固定のraw modeから、確認済みの **explicit LZMA-Alone mode `--format=lzma`** へ修正することを推奨する。headerからproperties / dictionary / uncompressed sizeを解釈する標準decoderに任せ、独自header除去やraw fallbackを追加しない。dictionaryを8 MiBから4 MiBに変更するだけではheader framingの問題を解消する根拠にならない。

同じ変更作業でreceiptの `compression: RAW_LZMA`、source契約documentation、synthetic compression fixturesも実確認済みLZMA-Alone契約に整合させる必要がある。20-byte layout、pointValue=1000、same-record MID、order、minute aggregation、Phase 1 bucket semanticsは変更しない。本診断ではそのいずれも編集していない。

修正後はproduction経路でraw size/hash、全tick検証、canonical minute coverage、Exportとの60/60 strict parity、Phase 1への一度だけの投入と4 timeframe出力hash、local importer、必要な回帰検証を実施する。それまでは正式Pilotの失敗を解除しない。

## Safety / Limitations

- 本診断の追加deliverableは本報告書のみ。既存未追跡Foundation関連ファイルおよび前回Pilot報告書は変更しない。
- production Export adapterと比較helperの実行用TypeScript compiled filesは `/tmp/task116-compression-diagnostic.*` の一時directoryに生成し、終了時に削除した。source / test filesは編集していない。
- raw BI5およびreference CSVは元のtmp pathのまま。解凍bytesはmemory / stdoutのみ、generated historical datasetなし。
- 対象はUSDJPYの指定1日・1artifactのみ。他の日付 / pair / framing variantsの成立は未確認。
- 今回は診断のみのためnpm test / lint / build / E2Eの新規実行はしていない。実行用 `tsc` と診断commandはexit 0。
- 最終 `git status --short`: 診断開始時のuntracked 6ファイルに本報告書1ファイルを追加した計7ファイルのみ。既存Foundation / test / 前回Pilot報告書はそのまま。
- `git diff --stat` / `git diff --cached --stat`: 出力なし、tracked変更 / staged変更なし。
- `git ls-files -- tmp '*.bi5'`: 出力なし。raw / generated datasetのtracked登録なし。
- `git check-ignore`: 対象raw BI5およびBID / ASK reference CSVはすべてignored。
- 最終raw確認: **687744 bytes**、SHA-256は期待値と完全一致。
- `git diff --check`: **PASS**。新規untracked報告書の `git diff --no-index --check /dev/null ...` も空白違反の診断出力なし（exit 1は新規ファイルと空fileの差分ありを示す）。editor diagnosticsもなし。
- **Five-year gate remains NOT CLEARED**。診断成功を正式production Pilot PASSへ置き換えない。