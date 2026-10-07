# Task116 Phase 3: S3/BI5 One-Day Pilot 検証報告

- 検証日: 2026-10-07
- Branch: `feature/v1.2-task116-historical-acquisition`
- Verdict: **FAIL**
- Five-year acquisition gate: **NOT CLEARED**

## 結論

取得済み実BI5のサイズとSHA-256は指定値に完全一致した。しかし、既存Foundationのproduction decoderは `Compressed data is corrupt` で失敗した。canonical minuteのyieldは0、成功receiptは `null`。実tickの検証、60分のExport-vs-BI5厳密比較、およびPhase 1投入は成立していない。5年取得へ進んではならない。

raw LZMA設定の変更、fallback、自動形式推測によるdecode、新decoderの追加は行っていない。production code、strategy / Signal Engine / Task114 / Task115 / Task116 baseline、DBおよびmigrationは変更していない。commit / push、AWS/S3への追加アクセス・ダウンロードは行っていない。

## 既存実装のAudit

- `lib/backtest/dukascopy-bi5-adapter.ts` の `createDukascopyBi5MidStream` を直接使用した。decompressorのoverrideなし。
- 既存defaultは `xz --format=raw --lzma1=dict=8MiB --decompress --stdout -- <artifactPath>`。system binaryは `/usr/local/bin/xz`。
- parserは20-byte big-endian `>IIIff` をmilliseconds / ask / bid / askVolume / bidVolumeとして読み、USDJPYのpointValueは1000。
- 各recordでUTC日内offset、有限正数価格、ASK >= BID、有限非負volume、timestamp non-decreasingを検査。末尾remainderおよび空record列は拒否する。
- 同一recordのMID `(bid + ask) / 2` をUTC minute startに集約し、OHLCはfirst / max / min / last。sorting / dedupe / rounding / interpolation / empty-minute fabricationなし。
- Phase 2の `createDukascopyTickMidStream` はBID/ASKを元のrow位置でlockstep照合する既存経路。
- Foundation unit testは同じraw LZMA設定で圧縮したsynthetic fixtureを使っている。その成功は実artifactとの互換性を保証しない。

## Raw Artifact Validation

- Path: `tmp/dukascopy/s3-pilot/2025-01-06/USDJPY_2025-01-06_ticks.bi5`
- ファイル存在: **PASS**
- Exact byte size: **687744**、指定値と完全一致: **PASS**
- SHA-256: `1304f89abecdf1808997a16d3856b7d94c16530cdea97b0eab5ef1e33fb90d01`、指定値と完全一致: **PASS**
- production adapterにも上記 `expectedRawSha256`、`instrument: USDJPY`、`sourceUtcDay: 2025-01-06`、`objectKey: USDJPY/2025/00/06_ticks.bi5` を渡した。
- S3 HEADのkey / ContentLength / Requester Paysはユーザー提供の確認済み情報。本作業では再照会していない。

## Real BI5 Decode / Tick Validation

production decoderの実行結果:

```text
LZMA decompression failed (exit=1, signal=null): xz: tmp/dukascopy/s3-pilot/2025-01-06/USDJPY_2025-01-06_ticks.bi5: Compressed data is corrupt
UNTRUSTED_PARTIAL_MINUTES 0
RECEIPT null
```

- Decode: **FAIL**。完了したdecoded record countは取得できず、0 tickと断定しない。
- First / last tick timestamp: **未取得**。
- timestamps non-decreasing、ASK >= BID、finite positive prices、UTC日内millisecond offset、malformed / trailing bytesなし: **実データで未検証**。
- canonical 1m count: 成功した生成結果なし。yieldされたminuteは0。
- First / last canonical minute、missing minute count / list: **未取得**。decode失敗を1440分の市場欠損として扱わない。
- 非decode診断としてraw先頭16 bytesを確認: `5d00004000cc3d320000000000000068`。
- 確認できた直接原因は、既存raw LZMA1設定が指定hashの実artifactを解凍できないこと。`xz`のエラーだけではartifact本体の破損とcompression framing / filter不一致を区別できない。raw checksum一致は指定artifactであることを示すが、期待compression契約の正しさを証明しない。
- 別compression形式、filter変更、header除去、alternate decoderによる再試行は行っていない。

## Export CSV Reference / 60分比較

参照raw CSVは利用可能であり、reference unavailableによるBLOCKEDではない。

- BID: `tmp/dukascopy/USD-JPY_1Tick_BID_2025-01-06_12_00-12_00_Etc_UTC.csv`
- BID SHA-256: `b44023a4ec5ad863a352fb3a100227454bdcf3902831ac2fa18d9413a100c80d`
- ASK: `tmp/dukascopy/USD-JPY_1Tick_ASK_2025-01-06_12_00-12_00_Etc_UTC.csv`
- ASK SHA-256: `e18c093678faa67cd05d62cb86521c57b3c22a5bb654eeb39cbbe6aadc6591c7`
- 両hashはPhase 2実データ報告の値と一致。
- 既存Phase 2 production adapterにpair / expected date / expected UTC hourを明示し、**13566 synchronized ticks** を全件処理。
- Reference tick bounds: `2025-01-06T12:00:00.000Z` ～ `2025-01-06T12:59:59.000Z`。
- Reference canonical MID: **60 minutes**、`2025-01-06T12:00:00.000Z` ～ `2025-01-06T12:59:00.000Z`。
- Cross-source comparison: **未実施 / NOT PASS**。BI5 decode失敗がblocker。60/60 exact matchを確認したとは扱わない。BI5が未生成のためmismatch件数も未算出。
- tolerance / rounding / normalizationによる一致処理なし。

### Spot Checks

以下は**参照CSV側のみ**の実測値。各OHLCを指定期待値とJavaScript数値のstrict equalityで比較し、すべてPASS。BI5側は未取得のためspot parityは未検証。

- `2025-01-06T12:00:00.000Z`: O `157.2025`, H `157.2145`, L `157.1215`, C `157.1255`。
- `2025-01-06T12:30:00.000Z`: O `157.024`, H `157.1125`, L `156.993`, C `157.096`。
- `2025-01-06T12:59:00.000Z`: O `156.7405`, H `156.7935`, L `156.74`, C `156.7885`。

## Full-Day Phase 1 / Importer

cross-source PASS条件が満たされないため、Phase 1 preparationへの実データ投入は**0回**。1時間のreferenceをfull-dayの代替に使っていない。

- `15m`: row count / first / last timestamp / SHA-256は未生成。
- `1h`: row count / first / last timestamp / SHA-256は未生成。
- `4h`: row count / first / last timestamp / SHA-256は未生成。
- `1day`: row count / first / last timestamp / SHA-256は未生成。
- 実generated datasetがないためTask116 local-dataset importerの実データsmokeは未実施。回帰suiteのsynthetic importer testとは区別する。
- partial / incomplete bucket契約は変更していない。

## Regression

- production adapter用 `npx tsc -p tsconfig.test.json --outDir tmp/task116-phase3-pilot-compiled`: **PASS**。一時compiled JSはproduction adapter検証後に削除済み。
- `npm test`: **PASS**、1330 / 1330 tests、fail / cancelled / skippedはすべて0。既存legacy market regressionもPASS、exit 0。
- `npm run lint`: **PASS**、error / warningなし、exit 0。初回は今回の一時compiled JSがeslint走査対象となり744 errors / 42 warningsで失敗した。今回作成したcompiled directoryだけを削除し、設定やcodeを変更せず同じcommandを再実行して成功した。
- `npm run build`: **PASS**、exit 0。Apple Silicon / Rosetta 2の性能警告あり。TypeScript / route generation完了。
- `npm run test:e2e -- --workers=1 --reporter=dot`: 再実行中。初回は別shell commandによる共有terminal再利用で中断（exit 130、170 passed / 1 interrupted / 191 did not run、2.2分）。初回をPASSとは扱わず、同じcommandを再実行している。
- `git diff --check`: **PASS**。untracked報告書も `git diff --no-index --check /dev/null outputs/Task116-Phase3-S3-BI5-OneDay-Pilot-Report.md` で別途確認済み。

## Git Safety

開始時点はtracked diffなし、staged変更なし。以下5ファイルが既存のuntracked変更であり、本作業では編集していない。

- `lib/backtest/dukascopy-bi5-adapter.ts`
- `lib/backtest/dukascopy-s3-acquisition.ts`
- `outputs/Task116-Dukascopy-S3-BI5-Foundation.md`
- `outputs/Task116-Historical-Acquisition-Audit.md`
- `tests/dukascopy-s3-bi5-foundation.test.ts`

本作業の追加deliverableは本報告書のみ。compilerの一時生成物 `tmp/task116-phase3-pilot-compiled` は削除済み。raw BI5およびCSVは元のtmp pathのまま。generated historical datasetなし。AWS credentials / profile / `~/.aws` は参照・表示・コピー・ログ出力していない。

検証logはignoredの `tmp/dukascopy/s3-pilot/2025-01-06/` 配下の `pilot-npm-test.log` / `pilot-lint.log` / `pilot-build.log` / `pilot-e2e.log` / `pilot-e2e-rerun.log`。初回E2E中断logと再実行logは別々に保持している。

中間確認では `git status --short` は開始時点の5ファイルと本報告書のみ（すべて `??`）、`git diff --stat` / `git diff --cached --stat` は出力なし。`git ls-files -- tmp '*.bi5'` は出力なし。`git check-ignore` でraw BI5 / BID / ASK / 検証logがignoredであることを確認し、実decode試行後のBI5 SHA-256も指定値と一致した。最終確認はE2E後に再実施する。

## Limitations / Acquisition Gate

- 20-byte record layout、pointValue、same-record BID/ASKの意味は既存code契約のauditのみであり、今回の実BI5で成立したとは言えない。
- 全日tick数・範囲・順序・価格・volume・trailing bytes・minute coverageは未確認。
- 参照側spot一致だけではcross-source validationのPASSにできない。
- 全日Phase 1 outputとreal importer smokeも未成立。
- **Five-year acquisition gate: NOT CLEARED**。compression契約の原因を別途確定し、明示許可された修正の後、実decode・60/60 exact parity・Phase 1 / importer・回帰検証を再実施する必要がある。本作業では取得や修正に進まない。