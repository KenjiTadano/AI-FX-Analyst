# AI-FX-Analyst v1.2 — Task116 Historical Dataset Preparation Audit

監査日: 2026-10-05  
対象ブランチ: `feature/v1.2-task116-historical-data`  
範囲: ローカルコードと既存テストのみ。Network、API、download、provider callは実施していない。コード変更なし。

## 1. Existing Dataset Contract

`HistoricalDataset`は`{ id, pair, timeframes }`。pairは`USD/JPY`、`EUR/JPY`、`GBP/JPY`、timeframeは`15m`、`1h`、`4h`、`1day`のいずれも部分的に指定可能。`1m`は未対応。各candleは`{ time, open, high, low, close }`で、volumeやprice typeは持たない。

`time`をbar開始時刻として使う契約はコードから確認できる。as-of cutoffとsignal時刻は`time + timeframe duration`で計算され、simulatorは次のcandleを最短entry候補にする。validatorはUTC ISO、正の有限OHLC、`high >= open/close/low`、`low <= open/close/high`、厳密昇順を検査するが、時間足境界への整列やbar完全性は検査しない。

## 2. Existing Manifest Contract

`manifest.json`の現行フィールドは次の通り。

```json
{
  "datasetId": "USDJPY-2021-2025",
  "pair": "USD/JPY",
  "source": "SOURCE_NAME",
  "timezone": "UTC",
  "exportedAt": "2026-10-05T00:00:00.000Z",
  "licenseProvenance": "source/license note",
  "dataKind": "OBSERVED",
  "files": {
    "15m": { "fileName": "USDJPY-15m.csv", "sha256": "64-hex-digest" }
  }
}
```

`files`は対応timeframeキーごとの`fileName`と`sha256`。少なくとも1つのtimeframe CSVが必要。manifestの追加フィールドは拒否されないが、import後の型付き`provenance`にはコピーされず、保存・保持を保証しない。

## 3. Dukascopy Compatibility

現物ファイルやサンプルがrepository内にない。Dukascopyの取得経路・exporterによって、圧縮binary（BI5系）やCSVなどの配布形態、timestamp表現、価格フィールド、Bid/Ask収録方法、directory layoutが異なるため、この対象dataset固有の詳細はオフライン監査では確定できない。

仮にraw BI5等のbinaryであれば、Task116 importerには直接入らない。CSVであってもheader、timestamp、barラベル、price typeが現行契約と一致することは保証されない。まず取得元の製品名・versionと実ファイルの先頭データを照合する必要がある。特定parserは本監査で実装しない。

## 4. Required Normalization

必要な境界は`source artifact -> source-specific decode -> canonical UTC 1m records -> UTC bucket aggregation -> canonical Task116 CSV + manifest`。raw timestampがbar開始か終了か、価格単位/scale、Bid/Askの意味を取得仕様から確定してから変換する。重複・未整列・invalid値・欠損は記録または拒否し、1mを補間・forward-fillしない。

1mはTask116のsupported timeframeではないため、1mデータを`loadLocalHistoricalDataset`へ直接渡す設計にはならない。出力対象4系列へのnormalization/resamplingが必要。

## 5. Timestamp / Timezone

Task116 CSV importerのtimestampは`YYYY-MM-DDTHH:mm:ss.sssZ`のcanonical UTC。例えば`2021-01-01T00:00:00.000Z`。秒未満やoffset表記、local timeは拒否される。出力時刻はbarの開始時刻とする必要がある。

sourceがUTC以外なら、元timezoneとDST解決規則を知った上でUTCへ変換する。DST foldで同一local時刻が二度現れる場合、またはspring-forwardで不存在時刻がある場合、offset/foldを判断できない入力は推測せず拒否または隔離する。

## 6. Price Type Options

現行Task116は単一のOHLC系列のみを受け、manifestにprice typeを保持しない。Bid OHLC、Ask OHLC、timestampごとのMID、またはsourceが提供する別の単一price seriesは異なる検証価格になる。simulatorはTask115の単一価格・gross execution semanticsで、Bid/Ask executionを実装していない。Task116 cost sensitivityもpost-simulationの費用overlayであり、価格系列の代替ではない。

どれをbaseline OHLCとするかはこの監査で決定しない。特に、集約済みBid/Ask OHLCのhigh/lowを平均してMID high/lowとみなすと、同期したquoteから計算した真のmid extremaとは一致しない可能性がある。

## 7. Resampling Rules

source timestampが1分bar開始時刻であると確認できた場合、UTC epochに対し対象durationのbucketを決め、各target intervalを`[bucketStart, bucketEnd)`として扱う。各bucket内を時系列順に処理し、`open=最初の1m open`、`high=1m highの最大`、`low=1m lowの最小`、`close=最後の1m close`。Volumeは出力しない。価格の丸めはしない。

bucketに属する分足以外の値を混ぜず、bucket終了前にはそのbarを確定扱いしない。minute timestampがbar終了ラベルなら、取得元の定義を確認してから対象intervalへ変換する。終了ラベルのままfloor bucketに入れると境界barが隣のbucketへずれる。

## 8. 15m Boundary

UTCの`00, 15, 30, 45`分開始。1m開始時刻からbucketを決める。例: `[12:15, 12:30)`は`12:15:00Z`開始の出力barとなり、Task114からは`12:30:00Z`に確定済みとして観測される。

## 9. 1h Boundary

UTCの毎時`HH:00`開始。`[HH:00, HH+1:00)`の分足だけを集約し、candle.timeは`HH:00:00.000Z`。Task114/116ではdurationを加えた時刻がbar close/as-ofになる。

## 10. 4h Boundary

UTCの`00, 04, 08, 12, 16, 20`時開始。DSTやlocal timezoneによって移動させない。各barはUTC 4時間半開区間。

## 11. 1day Boundary

UTC 00:00開始から次のUTC 00:00直前まで。NY close基準の日足やsource独自の日足をそのまま流用すると既定境界と違う。要求されたUTC日足へ再集約する必要がある。

## 12. Missing Data

既存`local-dataset.ts`のgap observationは、隣接するtarget candle開始時刻の差がtimeframe durationより長い時に記録する。classificationは一律`UNCLASSIFIED_GAP`。estimated slotsは時間差からの概算で、欠落理由の判定ではない。gapでimportを拒否したり、行を生成したりはしない。

target bucket内の1分欠損は、出力barが存在してしまえば現行importerでは検出不能。coverage/partial statusのmanifest項目もない。そのためnormalizer側でbucketごとの実観測分数、欠損数、状態をsidecar等に保持する必要がある。

## 13. Weekend Handling

FX weekend closureは日曜再開・金曜終了のUTC時刻が季節やsourceで変わり、holidayやsource outageとも区別が必要。現行importerは週末を特別扱いせず、長いtarget間隔をunclassifiedとして記録するだけ。休場分を埋めず、sourceの実データがない時刻にOHLCを作らない。

## 14. Partial Bars

要求期間は曖昧なinclusive日付ではなく、UTC半開区間`[2021-01-01T00:00:00Z, 2026-01-01T00:00:00Z)`として定義する案が端点処理に適する。この場合、元1mの最後のbar開始は`2025-12-31T23:59:00Z`。取得sourceの範囲仕様は別途確認する。

期間端でtarget bucketの一部しか取得できない場合、既存contractではpartialと判別されない。完全bucketだけ出力するのか、部分barを出力して明示するのか未決定。市場休場による正当な無取引時間と、欠損・期間端partialを同一ルールで扱わないこと。UTC calendar 1dayはFXの閉場時間を含むため、1440件未満を即欠損扱いする判定も不適切になり得る。

## 15. Data Validation

現行target importerはexact header、UTF-8文字列の各row 5列、canonical UTC、finite positive OHLC、OHLC順序、strictly increasing timestampを検査する。BOMは解析時に許容、CRLF/CRはLFへ正規化して解析、quoted fieldsは拒否、空行はskip。checksumはparse正規化前のCSV文字列に対して計算する。

duplicate/unordered target timestampは拒否し、dedupeしない。NaN、Infinity、zero、negative priceも拒否する。source 1m側の検証parserは未実装。target timestampがUTC時間足境界に一致するか、duration間隔か、partialかは既存validatorで検査されない。

## 16. Look-Ahead Safety

UTC固定bucketで`[start,end)`に属する1mだけを使用し、barのcloseはそのbucket最後の観測minuteから得る。15m barの高値/安値/終値へ次の15分以降のminuteを混ぜない。出力timestampをbucket startにし、Task114の`time + timeframe duration <= asOf`によりclose時刻以前には未確定barが見えない。

これは入力minute timestampの意味が確認され、時系列が厳密であることが前提。future candle appendで過去bucketが変わらないテストを必須にする。Task114/116既存semanticsとの矛盾はないが、align/close completenessは現在コードでは保証されない。

## 17. Memory / Performance

連続24/7の上限概算で、5年間は1826日、1mは約2,629,440行。出力は15m約175,296、1h約43,824、4h約10,956、1day約1,826行、計約231,902 candle（休場を無視した上限目安）。

数百万のJS candle objectとtimestamp文字列、raw CSV文字列、parse配列、`validateHistoricalDataset`のcopyを同時に保持する構成はmemory pressure/GC/OOMリスクがある。現行`loadLocalHistoricalDataset`は`readFileSync`で各CSV全文を文字列に読み、importerはすべての配列を作成してからvalidate時にもcopyする。Node heap上の実測値は未取得。

推奨案はsourceをchronological stream/chunkで処理し、4 timeframeの現行bucket accumulatorだけ保持、closed target CSVを逐次書き出す方式。raw 1m全件を`HistoricalDataset`に載せる必要はなく、現在の`HistoricalDataset`も1mを受け付けない。最終4系列は現行importerがmemoryへ読み込むため、そのtarget規模で別途実測する。

追加リスクとして`replayHistoricalSignals`はsignal時刻ごとにas-of prefixを構築しindicatorを計算するため、長期データでは計算量が大きい。5年1h/15m全期間のTask116 validationは準備処理だけでなく、replay runtime/peak memoryもbenchmark対象とする。

## 18. Output Files

現行importerはfilename自体をtimeframeから推論せず、manifestのtimeframe keyとbasenameを対応させる。`USDJPY-15m.csv`、`USDJPY-1h.csv`、`USDJPY-4h.csv`、`USDJPY-1day.csv`はいずれもbasename許可patternに合う。既存testの例は`usdjpy_15m.csv`だが固定命名ルールではない。

提案構成例: `data/historical/usdjpy_2021-2025/manifest.json`と同directoryの上記4 CSV。repositoryに既存historical CSV/BI5/JSONL datasetや専用保存規約は見つからなかったため、保存dirの最終決定は別途必要。pair値はfilenameと異なり`USD/JPY`。

## 19. Provenance

現行manifestに保持できるのはdatasetId、pair、freeform source、timezone=`UTC`、exportedAt、freeform licenseProvenance、dataKind=`OBSERVED|SYNTHETIC`、各target file名/checksum。import時にrow count、actual first/last timestamp、gap observationが算出され、返却`provenance`に載るがmanifestへ自動書戻しはしない。

source URL/nameの構造化値、download date、original timeframe/timezone、Bid/Ask/MID等のprice type、requested period、raw source filenames/checksums、resampling software/version/config、per-bar coverageは現行provenance型にない。`exportedAt`はdownload dateとして意味が定義されていない。自由記述欄へ詰めてもmachine-readable provenanceにはならない。normalized output manifestとraw-source/preparation receipt sidecarの分離が望ましい。

## 20. Checksum

`sha256Hex`はCSV文字列そのもののUTF-8 bytesにSHA-256を適用し、小文字64桁hexを生成。importerはhex大小を許容し、CSV全文のhashと一致比較する。解析用BOM除去・CRLF変換より前にchecksumを計算するので、byte contentが違えばchecksumも異なる。

生成側は書き出し完了後、実ファイルbytesのhashをmanifestへ入れる。再現性のためcanonical LF、UTF-8、BOMなし等の書出し規約を決める。raw source hashはtarget `files[*].sha256`とは別に記録する。

## 21. Baseline Price-Type Decision Required

必須決定。Bid、Ask、raw quoteからのMID、source独自単一priceのどれをSignal/Scenario/Task115 baseline inputにするか、history期間を通じ一貫する基準と証跡を決める。spread sensitivityはこれを自動決定しない。決定前にsourceの契約とサンプル数行を確認し、baselineにBid/Ask executionを追加しない。

## 22. Implementation Proposal

1. Dukascopy/export製品、取得方法、license、元ファイル一式の構造とsampleをオフラインで確認する。raw artifactsは変更せず保持し、ファイル名/bytes hashを記録する。
2. source-specific normalization specを確定する。timestamp start/end convention、timezone、price type、decimal scale、列/record構造、重複時のpolicyを明記する。
3. streaming normalizerで1m recordsをUTC canonical orderingにし、duplicates/disorder/invalid OHLCをfail closed。4つのUTC bucket accumulatorでOHLCを生成し、欠損分は補間しない。coverage/partial状態はsidecarに記録。
4. UTF-8 canonical CSVをtarget filenamesで生成し、各出力bytesのSHA-256を計算して既存manifest schemaへ最小情報を記録する。raw sourceとresampling provenanceは別receiptに残す。
5. `loadLocalHistoricalDataset`で4 timeframeをimportし、counts/ranges/gapsとalignmentを照合後、5年全量のTask116 replayを性能測定する。

これは提案のみであり、parser、aggregation、schema、validation semanticsへの変更は本監査では行わない。

## 23. Tests Required

- OHLC first/max/min/lastを手計算できる15m/1h/4h/1day fixture。
- UTC境界直前・ちょうど・直後、日/月/年境界、leap day。4h境界が指定6時刻のみ。
- 1m start/end label fixtureの違いと変換後timestamp、barがduration後にのみconfirmedになること。
- future minutesをappendして既確定target barsが不変、次のbucketデータが過去barへ影響しないこと。
- source chunk境界をまたぐ集約、file reorder、重複timestamp、overlap duplicate、同timestamp異値、unordered input。
- 1m missing within bucket、weekend/holiday-like gap、DST前後、UTC bucket固定、scheduled closureとsource outageを混同しないこと。
- first/last partial bucket、期間端、部分観測barのpolicy、coverage metadataとの一貫性。
- NaN/Infinity/zero/negative/malformed OHLC、precision、bad timestamp/timezone、invalid scale。
- exact UTF-8 output checksum、LF/CRLF/BOM差、manifest file names/hash mismatch、source raw hash receipt。
- 5年相当のstreaming benchmark: elapsed time、peak RSS/heap、GC、行数、出力一致性。Task116 replay全期間の別benchmark。

## 24. Risks

- source product/sampleが未提示で、Dukascopyのtimestamp、format、Bid/Ask、organizationを確定できない。
- Bid/Ask/MID choice materially changes OHLC signals; price typeはcurrent schemaから追跡できない。
- bucket alignment/partial coverageはimporterでは検査されず、誤ったbarでもvalidatorを通過し得る。
- target gap detectorは週末/holiday/source outageを区別しない。1m欠損が同一target candle内に隠れる。
- FX session closure and DST, provider revisions, licensing/redistribution, price scaling/rounding are unrepresented.
- raw 1m full-memory ingestion and repeated as-of replay may exhaust practical memory/time despite target resampling.
- UTC 1day boundaries are not necessarily provider/JForex daily-bar boundaries; cannot compare without normalization.

## 25. Decisions Required Before Implementation

1. Exact Dukascopy source product, download/export route, version, artifact sample, license and raw retention requirements.
2. Source timestamp semantics (bar open/close), timezone declaration, DST ambiguity policy, units/decimal scaling, and whether data are minute OHLC or tick quotes.
3. Baseline price type: Bid, Ask, timestamp-level MID, or other source-defined series; MID construction policy if selected.
4. Requested interval semantics: confirm UTC half-open `[2021-01-01T00:00:00Z, 2026-01-01T00:00:00Z)` and source's inclusive date handling.
5. Missing 1m minute, duplicate/overlap, weekend/holiday, and scheduled market closure handling; preserve/reject/quarantine policies.
6. Partial bar policy (especially first/last bucket and UTC daily FX bars), completeness evidence, and how sidecar quality data are delivered to consumers.
7. Whether provenance schema may evolve or a separate source/preparation receipt is required; where raw data and normalized CSVs should live.
8. Target 5-year memory/time budget and Task116 replay benchmark acceptance thresholds.

## Audit Conclusion

UTC-aligned 15m/1h/4h/1day aggregation using the proposed UTC boundaries is compatible with Task114/116 candle-open timestamp and close-confirmation semantics, provided output `time` is bucket start and only observations in `[start,end)` are used. Compatibility is not enforced by current validators. Dukascopy raw input is not guaranteed to be importer-ready; an offline source-specific normalization/resampling stage is required. No price type, gap policy, partial-bar policy, or source parser is selected here.
