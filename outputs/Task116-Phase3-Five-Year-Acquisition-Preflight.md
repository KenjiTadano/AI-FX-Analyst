# Task116 Phase 3: USDJPY Five-Year Historical Acquisition Preflight

- 実施日: 2026-10-07
- Branch: `feature/v1.2-task116-five-year-acquisition-preflight`
- Verdict: **NOT READY**（実取得開始のproduction readiness）
- **Bulk Download Authorization: NOT AUTHORIZED**
- 対象予定範囲: `[2021-01-01T00:00:00.000Z, 2026-01-01T00:00:00.000Z)`、USDJPYのみ。

## 1. 結論 / Scope

正式One-Day PilotのPASSとPilot gate CLEAREDは維持する。しかし、5年取得を開始できるproduction componentと安全運用は未完了。**concrete AWS transportがなく、metadata inventory / cumulative retry・bytes ledger / crash recovery / batch承認制御が未実装**。実5年のobject存在数・bytes・費用も未確認。local空き容量は約16.22 GiBで、後述の暫定32 GiB推奨を下回る。

推奨は **exact-key HEAD inventory + AWS SDK for JavaScript v3のstreaming transport**。GetObject中心のRoleを維持し、ListBucketを当然の前提にしない。403は欠損と判断せず停止する。未解決objectがあるままactual five-year size / acquisition READYにしない。

本作業はaudit / local dry-run / 設計 / focused tests / 報告書のみ。production / test / DB / migration / strategy / Signal Engine / Task114 / Task115 / Task116 baselineは変更しない。AWS CLI command、認証付きAWS API、S3 HEAD / GET / LIST、1825未確認objectへのrequestは**0**。追加download、recursive listing、sync、5年取得、Access Key作成、commit / pushなし。公開公式資料の閲覧は実施したが、data bucket / accountへアクセスしていない。credentials / profile内容 / `~/.aws` は参照・表示・コピーしていない。

## 2. 前提となる実Pilot

[Task116-Phase3-S3-BI5-OneDay-Pilot-Revalidation.md](Task116-Phase3-S3-BI5-OneDay-Pilot-Revalidation.md) の正式PASSを前提にする。

- Local raw: `tmp/dukascopy/s3-pilot/2025-01-06/USDJPY_2025-01-06_ticks.bi5`
- Known key: `USDJPY/2025/00/06_ticks.bi5`
- Actual known compressed bytes: **687744**。
- SHA-256: `1304f89abecdf1808997a16d3856b7d94c16530cdea97b0eab5ef1e33fb90d01`。今回localでsize/hashを再照合し一致。
- 実検証済みcompression: **LZMA-Alone**、20-byte `>IIIff`、USDJPY pointValue=1000、same-record MID。
- 164631 ticks / 1429 canonical minutes / 11 unclassified missing minutes / Export 60/60 strict parity / Phase 1 / importer / regressionは既存Pilot evidence。
- Pilot target CSVの今回local実測bytes: 15m **6785**、1h **1742**、4h **473**、1day **92**。
- 1日PASSは他1825日の存在・size・quality、取得費用、5年strategy / OOS evidenceを証明しない。

## 3. Existing Implementation Audit

対象は [lib/backtest/dukascopy-s3-acquisition.ts](../lib/backtest/dukascopy-s3-acquisition.ts)、[lib/backtest/dukascopy-bi5-adapter.ts](../lib/backtest/dukascopy-bi5-adapter.ts)、[lib/backtest/historical-dataset-preparation.ts](../lib/backtest/historical-dataset-preparation.ts)、[lib/backtest/local-dataset.ts](../lib/backtest/local-dataset.ts)、[.gitignore](../.gitignore)、既存Foundation tests。

### 成立しているFoundation

- Plannerはexplicit instrument / start / exclusive end / Requester Paysを要求し、default modeはDRY_RUN。one-day / one-key、zero-index month、UTC calendarによるpure deterministic plan。
- `DukascopyS3Transport` は `downloadObject(...) => AsyncIterable<Uint8Array>` のinterfaceのみ。実装検索では**testのFakeS3Transportだけ**が存在し、production AWS CLI / SDK transportはない。
- Transferにはexplicit TRANSFER、positive integerのmaxObjects / maxKnownBytes、multi-day明示許可が必要。streamを逐次処理し、一度に1object。
- Artifact名はobjectIdのhash prefixとcontent SHA / attemptを使い、remote keyをそのままlocal pathにしない。`.partial` はexclusive create、hash / size照合後にverified `.bi5` へrenameする。
- checkpointは一時JSONを作ってrenameし、state / attempts / hash / bytes / pathを記録。decode成功 / failureのmark関数がある。
- VERIFIED / DECODEDのreuseはlocal rawを再hashし、一致した場合だけskipする。missing / changed local bytesは再取得対象となり、古いartifactを直接上書きしない。
- OBJECT_NOT_FOUNDだけがNO_DATA。ACCESS_DENIED / REQUESTER_PAYS_ERROR / CHECKSUM_ERROR / DECODE_ERRORはFAILED。messageはredacted。
- BI5 adapterは既存LZMA-Alone decoderでsource順を保持し、no fill / dedupe / sort / rounding。Phase 1 wrapperは利用可能artifactのcanonical minutesをchronologicalに連結し、requested range全体へ一度だけpreparationする。
- `/tmp/dukascopy/` はGit ignore。final manifest / receipt / target-byte hashes / existing importerがある。

### 実取得前に解消するGap

1. **Transport / inventory / operator runnerなし。** InterfaceだけではRole認証、HEAD metadata、GET response validation、download / decode / checkpoint orchestrationは実行できない。
2. **maxKnownBytesは総通信費上限ではない。** `totalArtifactBytes` は呼出しごとに0へ戻り、reuse rawと今回成功したrawは加算されるが、過去失敗attemptの通信bytes、残存partial、他batchの総費用を永続合計しない。stream chunkを受信してからcap判定するため受信bytesの超過もあり得る。
3. **retry上限 / timeout / cancellationなし。** attemptsは記録するだけで最大回数を拒否しない。再実行によるretryを繰り返せる。SDK / CLI内部retryを加えると見かけのattemptsと実request数がずれる。
4. **NO_DATAはresume skip対象でない。** 現状はresume時に同じmissing objectを再requestし得る。確認済み欠損にはinventory snapshot / 判定証拠 / recheck承認を持たせる必要がある。
5. **DECODE_ERRORのrawを再downloadし得る。** decoder failure後はFAILEDになり、valid raw hashが残っていてもreuse predicate対象外。診断・local再decodeとnetwork retryを分離し、同じbytesを自動再取得しない設計が必要。
6. **Interruption recoveryが不十分。** DOWNLOADING / DOWNLOADED / FAILEDはreuse対象外。partial / verified rename直後とcheckpoint更新前のcrashではorphanが残る。既存raw hashとinventoryでreconcileできる場合は再取得せず復旧するjournalが必要。
7. **single-writer / durability / path検証なし。** checkpoint読込はversion / chunks arrayの最低限検査のみで、各entryのschema、approved plan hash、bucket / region / requesterPays、path containmentを厳密に照合しない。lockなし。atomic renameは電源断に対するraw / checkpoint / directory fsync保証ではない。
8. **immutableは単一processでの運用前提。** content/attempt命名とexclusive partialは良いが、renameのno-overwrite保証、並行起動防止、readonly raw・symlink防止は未整備。remote revised objectを同じ取得として無言で差し替えない。
9. **expected SHAの出所なし。** 本pilotは既知SHAをoperatorが与えた。HEADのETagをSHA-256に使えない。source FULL_OBJECT checksumがなければlocal SHAは再現性の記録であり、独立source checksum検証とは区別する。
10. **download失敗時のcommand exit判定なし。** FoundationはFAILED checkpointをreturnする場合がある。runnerがstatusを検査しnonzero exit・次batch停止にしないと、Promise完了を成功と誤認する。
11. **5年scale未測定。** Phase 1入力はstreamingだが、wrapperは全artifactのstream descriptorとhashを先に作り、initial hashingを行う。importerはtarget CSV / arraysをmemoryへ読む。5年相当のmemory / time budget検証とsource license / retention確認が必要。

NO_DATA処理は現在empty `.partial` をunlinkする。raw BI5 deleteではないが、提案するno-delete運用ではHEAD確定欠損からartifactを作らず、crash / failed partialはquarantineへ保全し、cleanupは明示承認制とする。

## 4. Deterministic Local Dry-Run

既存 `planDukascopyS3Acquisition` に `instrument=USDJPY` / `startDate=2021-01-01` / `endDate=2026-01-01` / `mode=DRY_RUN` / `requesterPays=true` / `maxObjects=1826` を渡した。**TRANSFERは実行していない**。

- Planned UTC days: **1826**。
- Planned deterministic keys: **1826**。
- First key: **`USDJPY/2021/00/01_ticks.bi5`**。
- Last key: **`USDJPY/2025/11/31_ticks.bi5`**。
- Duplicate keys: **0**。
- 全1826日のday adjacency、UTC半開区間、keyとdayの対応、chronological order、zero-index month: **PASS**。
- 年別days: 2021 **365** / 2022 **365** / 2023 **365** / 2024 **366** / 2025 **365**。
- 範囲内leap day: **2024-02-29** → **`USDJPY/2024/01/29_ticks.bi5`**。
- 2020 / 2026へのrange expansionなし。最後のexclusive endは **2026-01-01T00:00:00.000Z**。
- 同一requestで2回生成したplanのdeep equality: **PASS**。
- `JSON.stringify(orderedKeys)` のSHA-256: `c8731ac9b80e8a83373f295e9f8834abaa611fdf08297a9552d3d9346c758302`。
- `transferWouldOccur=false`、network/process-acquisition禁止guardの呼出し **0**。
- Plannerの `objectInventoryKnown=false` / `unknownByteSizeCount=1826` は正しい未調査状態。local既知pilot metadataをplannerへ注入していないため全1826をunknownとして返す。unknownはabsentではない。

1826はplanned keysの数であり、download成功数や実在object数ではない。週末・休日も自動除外しない。

## 5. Metadata Inventory / IAM

### 推奨A: Exact-Key HEAD

承認後のinventory taskでのみ、frozen planの1826 keysに対して一件ずつHEADする。bucket / region / pair / dates / ordered-key-list hashを固定し、RequestPayer=requesterを必須にする。recursive / whole-bucket listing、range外key、他pair、data GETは行わない。

保持する非secret metadataはkey / UTC day / status / ContentLength / ETag / LastModified / storage class / checksum type・値が提供される場合のchecksum / RequestCharged / checkedAt / attempts / inventory revision hash。Authorization / token / account ID / Role ARN / credential chainはログへ出さない。inventoryとcheckpointはignored local storageへ置く。

- 現在のRoleがGetObject中心という前提に合う。**HEADに必要なIAM actionはs3:GetObjectであり、s3:HeadObjectというactionではない。** HEAD実行のためだけにListBucketを追加しない。
- **重要: ListBucketなしでは存在しないkeyも403になり得る。** 403はAccessDenied / Requester Pays / scope不足 / missing等を区別できず、NO_DATAにしない。HEADはerror bodyを返さないため、原因をメッセージ推測で確定しない。
- trusted bucketとexact keyで確認された404 / 明確なNoSuchKeyだけを欠損証拠にできる。403、NoSuchBucket、expired session、InvalidObjectStateは欠損ではない。delete marker等の異常responseも黙って欠損へ変換せずreviewする。
- 403に遭遇したらcheckpointを保存して**そのinventoryを停止**。未調査keysをunknownとして残し、「残りも同様」と外挿しない。
- 最終inventoryで全keysのpresent / confirmed absentが解決できるまでactual total bytesはUNKNOWN。HEAD確認と後日のGETの間でsourceが変わり得るため、snapshotのETag / sizeをGETで再照合する。
- Pilotの既存HEAD metadataをtrusted evidenceとしてreuseできれば初回未調査HEADは **1825 requests**。freshnessが必要ならpilotを含む **1826**。今回どちらも送信していない。

### B / Cとの比較

- **B: bounded date-prefix LIST** はListBucketを必要とする。初期推奨ではない。403を解消する必要がある場合だけ、Roleとprovider側policyを別途reviewし、承認batch内のexact-key prefixに限定するLISTを提案する。bounded max keys / pagination cap / expected canonical-key whitelistが必要。prefix LISTの結果が曖昧なHEAD404へ自動的に同じ権限効果を与えるとは仮定せず、LIST自身の成功結果で対象keyの有無を照合する。全USDJPY prefixや全bucketの再帰listを行わない。
- **C: provider発行の信頼できるcomplete manifest** があれば存在・size確定を補助できる。しかし現在そのmanifestの存在・版・完全性は未確認。自分の権限でprovider bucketのS3 Inventory / metadata tablesを新規設定しない。
- **Range GETで欠損確認** は推薦しない。metadataだけの目的でdata転送が発生し、GetObjectもListBucketなしのmissing時は403になり得るため、根本問題を解消しない。

### IAM Impact / Unknowns

このpreflightでは**IAM変更0、Role policy / sessionのlive確認0**。既存 `dukascopy-pilot` Role profileを将来使用するが、policyがpilot keyのみか、2021-2025の全USDJPY keysへGetObjectを許すかは未確認。profile / `~/.aws` を読むことで確認していない。

HEAD方式なら新しいactionは原則不要だが、resource scope拡張が必要なら**提案・承認のみ**。GetObjectをUSDJPYの2021-2025対象へ限定し、application側でもexact planned-key whitelistを強制する。PutObject / DeleteObject / ListBucket / unrelated pair / blanket s3:*を追加しない。versionId GETを選ぶならGetObjectVersion、KMS暗号化等が確認された場合はその追加権限を別途reviewする。認証失効時はoperatorが既存Role sessionを更新し、Access Keyを作らない。

## 6. Size / Disk Estimate

すべての数値はlocal script計算。市場activity、年次差、source availability、compressed ratioは未知。**687744 bytes/dayは1日の実測でありdaily最大値ではない。**

単純全calendar-day外挿:

$$687744 \times 1826 = 1255820544\ \text{bytes}$$

**1.255820544 decimal GB / 約1.169574 binary GiB**。全1826日をpilotと同じsizeとして数える「上限参考シナリオ」にすぎず、実5年sizeでも数学的upper boundでもない。週末欠損で減る可能性と、活発な日に増える可能性がある。

- Compressed raw reference: **1255820544 bytes**。
- 4倍stress assumption: **5023282176 bytes / 約4.678296 GiB**。
- 10倍stress assumption: **12558205440 bytes / 約11.695740 GiB**。
- 4倍 / 10倍は予測や保証ではなくdisk reserve感度確認の仮定。inventoryが超えれば見積もりを再承認し、取得開始しない。

Target CSVのcalendar row ceiling（観測row数ではない）:

- 15m: **175296 rows**。
- 1h: **43824 rows**。
- 4h: **10956 rows**。
- 1day: **1826 rows**。
- 160 bytes / rowを保守的なserialization budgetとして置くと、4 headersを含め **37104420 bytes / 約35.386 MiB**。actual hashes / rows / bytesは取得・生成後に測定する。
- 全calendar minute ceiling **2629440**。optional日別canonical 1m cacheは160 bytes / rowと1826 headersで **420756050 bytes**。この上限計算のためにmissing minuteをfabricateしない。

### 暫定Recommended Free-Disk Reserve: 32 GiB

以下は**将来のlocal disk予算案**であり、承認済みdownload capsでも既存実装の保証でもない。

- Retained compressed raw: **16 GiB**。
- Raw revision / failed partial / quarantine: **4 GiB**。
- Sequential active `.partial` / optional bounded transport staging: **256 MiB**。日別sizeがこの仮定を超えた場合はpauseして再設計。SDK推奨なら二重raw copy不要。
- Canonical 1m cache: **512 MiB**。
- Final target CSV + Phase 1 staging: **256 MiB**。
- Checkpoint / inventory / bounded logs / manifests / receipts: **512 MiB**。無制限debug logは禁止。
- OS / filesystem / working headroom: **8 GiB**。

合計 **29.5 GiB** を **32 GiB free** へ切り上げた。既存final outputを保持して再生成するならその実bytesも追加する。backupを同じdiskへ複製する場合も別枠が必要。

Local今回観測: `df -k .` の空き **17017940 KiB**。focused check後の `statfs` は **17417281536 bytes / 約16.221107 GiB**。check中のOS変動を含むsnapshotであり、約32 GiB推奨を下回る。`tmp/dukascopy` は当初 **3048 KiB**。小さいreference外挿が収まることを理由に5年取得をREADYにはしない。

Inventory後は固定32 GiBではなく **actual retained raw + worst-case quarantine/staging + canonical cache + target/staging + logs + OS reserve** を再計算し、開始前・各batch前・各GET前にfree diskを確認する。足りなければ停止し、operatorによる明示cleanupや十分な暗号化diskの選択を待つ。勝手なraw削除はしない。

## 7. AWS Requester Pays Cost Model

単価はcodeへhard-codeしない。**実行直前にAWS公式S3 Pricingでeu-west-1、対象storage class、internet DTO、請求account / allowancesを確認**し、timestamp付き見積もりをreviewする。今回は認証accountの課金情報・税・free-tier残高・credits・為替を照会しておらず、ドル金額を提示しない。

Requester Paysでは成功requestとdata downloadの料金はrequester側（assumed Role所属account）、source storageはbucket owner側。local Macへの取得はS3からinternetへの**Data Transfer Out**であり、AWS内同一region無料経路と同一視しない。ISP料金・external disk費用はAWS料金の外。

定義: $H_b,G_b,L_b$ は実際にbillableなHEAD / GET / LISTの件数、$p_H,p_G,p_L$ は公式確認済み1000 requestsあたりの単価。failed / missing / retry requestsもoperation / HTTP status / payerごとに記録し、公式error-billing規則に従ってbillable件数へ含める。失敗がすべて無料・すべて有料のどちらとも仮定しない。

AWSのerror billing文書では、一般のS3 requestは200と通常の4xxが課金対象、5xxは非課金、一部の3xx / 4xx error codeは非課金とされる。Requester Paysのpayer規則とaccount / organization境界も併せて判定する。**NoSuchKey / 404を「missingだから無料」と仮定しない**。HEADはgeneric statusしか得られない場合があるため、不明な分類は保守的に費用予算へ含めてreviewする。

$$C_{requests}=p_H\frac{H_b}{1000}+p_G\frac{G_b}{1000}+p_L\frac{L_b}{1000}$$

$B_{AWS}$ は成功転送に加えfailed / interrupted / retryで**AWSが送信した**bytes。受信側が観測したbytesより多い場合がある。$q$ は実行時公式pricingのbytes単位、$F_{eligible}$ は当月実際に適用可能なDTO allowanceとする。

$$C_{DTO}=\operatorname{OfficialTieredDTOPrice}\left(\max\left(0,\frac{B_{AWS}}{q}-F_{eligible}\right)\right)$$

$$C_{total}=C_{requests}+C_{DTO}+C_{retrieval\ if\ applicable}+C_{KMS\ if\ applicable}+C_{optional\ audit}+C_{tax}$$

上式の追加費目はrequester側に請求が適用されるもののみ。IAM / storage class / pricingで適用が確認されない費目を勝手に0と断定しない。archive storage / restorationが必要なresponseは止めて別途payer・費用・権限reviewし、RestoreObjectを自動実行しない。source storageやowner負担のrestoration費用をrequesterのlocal-retention費用として二重計上しない。

基準request model:

- 初回inventory: 最大1826 HEAD（trusted pilot reuseなら1825）。
- 成功GET: inventoryでpresentと確定し、local reusable rawがないobject数 $N_{new}$。まだ未知。
- Retry: 最大**2 retries / object / operation、初回を含む3 attempts**を設計提案。full planの各HEAD / GET attempt上限参考はそれぞれ **5478**。実際のapproval capsはbatch / present countに縮小する。
- HEAD404 / GET NoSuchKey / 403等はrequest ledgerへ記録し、正しいerror-billing分類を適用。NO_DATA日はGET不要となる設計を優先。
- 推奨AではLIST **0**。Bを別承認したときだけbounded LISTとpaginationのrequest費用を追加。
- Inventory size $S_i$ を各GET attempt前に全量予約すると、3 attempts/object仮定のdata-body最大参考は $3\sum S_i$。誤size、source change、再取得承認は別review。受信途中killで無料になるとは仮定しない。

**Zero-spend budgetはhard spending capではない。** Billing / Budgets notificationには遅延があり、閾値到達後も料金が発生し得る。任意のBudget actionも即時・完全な通信停止保証として扱わない。request / attempts / bytes ledger、approval、process cancellationを主安全機構にする。それでもprovider側送信中bytesやbilling遅延があるため厳密な金額上限保証ではない。

## 8. Cost / Execution Guardrails（未実装の設計）

- Frozen master planは**1826 keysを超えない**。batchはそのsubsetのみ。in-memory planの書換えを信用せず、keyをUTC dayから再導出しapproval hashと照合。
- 独立したINVENTORY approvalとDOWNLOAD approvalを要求する。後者にはreview済みsize・cost・disk・batch range・caps・expiryをbindする。
- 最大successful artifact bytes、retained disk bytes、received network bytes、attemptごとのfull-size予約bytes、HEAD / GET attemptsを**全batch / resume / process restartをまたぐ永続ledger**で別管理する。
- Download bytes capはinventory sumに基づく承認値とし、pilot外挿だけを自動採用しない。超過をchunk受信後だけでなくGET発行前にも防ぐ。
- Concurrencyは初期**1**。日別 / batch別 / global attempts cap、wall-clock / idle timeout、cancellationを要求する。timeout値はfuture bounded validationでreviewして設定し、無制限待ちにしない。
- SDKのautomatic retriesは1 attemptへ固定し、runnerで明示最大3 attemptsを持つ。CLIを使うなら同じく内部retryを明示制御し、二重retryを避ける。transient 429 / 5xx / network timeoutだけにbounded backoff + jitterを適用する。
- ACCESS_DENIED / expired session / Requester Pays異常 / size or checksum mismatch / DECODE_ERROR / unexpected bucket-region-key / non-approved redirect等はstop。異常をNO_DATAへ変換しない。
- GETにはinventory ETagのIf-Match、expected ContentLength、RequestCharged等を照合する。412 / revised metadataは旧rawを保持してstopし、再inventory・再承認する。ETagはopaque identityでありSHA-256ではない。
- Logはoperation / key / classified code / bytes / attempts / duration / outcomeをallowlist化。raw AWS exceptions / debug / signed headers / credentials / Role identityを保存しない。

## 9. Recommended Production Flow

```text
PLAN (local exact keys, frozen hash)
  -> INVENTORY (separate approval; exact HEAD only)
  -> USER APPROVAL (resolved metadata, price/caps/disk/batch)
  -> DOWNLOAD (one approved key, explicit Requester Pays)
  -> RAW HASH VERIFY (size + available source checksum + local SHA)
  -> DECODE (existing production BI5 adapter)
  -> CHECKPOINT (raw/decode/coverage/attempts/cost ledger)
  -> RESUME (rehash + reconcile; never implicit range/retry expansion)
  -> PHASE1 (one final full-range preparation)
  -> IMPORT VALIDATION (existing local loader)
```

DOWNLOADとDECODE間のcrashに備え、raw verify / atomic publication時にもcheckpointをpersistする。downloading / downloaded / verified / decodedをdurableに記録し、SIGINT / SIGTERMでcheckpoint保存、Mac sleep / process終了 / network interruptionからexact object単位で再開する。runtime内でのsleep回避とは別に、future runnerのbackoffはcancellable timerを使う。

VERIFIED / DECODEDは**再hash一致ならredownloadしない**。missing / mismatchなら旧artifactを保全しnew immutable attemptを作る。valid rawのDECODE_ERRORはnetwork取得で解決しようとせずlocal診断を要求する。crash `.partial` はverifiedではなく、size/hash/metadataとjournalを照合できる場合だけ復旧、できなければ保全して承認範囲内の再attempt。byte-range resumeは初期実装に追加せず、completed object単位のresumeとする。

NO_DATAはconfirmed missing evidenceとinventory revisionにbindしてresume時の再照会をskipする。recheckには別承認が必要。calendar・週末・403・空bytesからNO_DATAを推定しない。

全available daysのcanonical 1m streamsをsource UTC順で連結し、source gapsを保持したまま**最後にPhase 1を1回**実行。日別 / 月別Phase 1 CSVを雑にmergeしてfinalを作らない。既存partial-range bucket、empty bucket、missing minute、OHLC契約を変更しない。既存preparationはoutput directoryの上書きを拒否するため、失敗staging / 既存finalも勝手にdeleteしない。

## 10. Batch Strategy

metadataはmaster1826-key snapshotで設計するが、実行はsequentialの小さいapproval batchに分ける。最適throughputはまだ未測定なので、以下は安全側の初期案。

1. **最初の7 UTC days**: `[2021-01-01, 2021-01-08)`。欠損 / 権限曖昧性 / transient retry / interruptionを検証。7 keysであり7実在objectsとは言わない。
2. PASS後、**続く30 UTC days**: `[2021-01-08, 2021-02-07)`。前batchと非重複、同じfrozen master subset。
3. PASS後、**calendar month boundary batches**。まず残り `[2021-02-07, 2021-03-01)`、その後2025-12末まで月単位。master rangeは60 calendar monthsで、7+30 warmupにより実行batch partitionsの数とは一致しない。month/bytes/attempts capに収まらなければさらに日単位へ縮小する。

各batch後にdownloaded / VERIFIED / DECODED / confirmed NO_DATA / FAILED / unresolved / actual bytes / hashes / first-last tick / canonical minute coverage・gaps / request-attempt ledger / remaining diskをreviewする。**FAILED / unresolvedが1件でもあれば次へ自動進行しない**。NO_DATAにも根拠が必要。次batchはoperator明示approval、concurrency拡大は別承認。

既存checkpointはrequestedStart / requestedEndをbindするので、異なるbatch rangeで同じcheckpointを再利用できない。最小runnerは**frozen master manifest + batchごとのcheckpoint + global cost/bytes ledger**を持つ設計にする。alternativeのmaster checkpoint subset処理は現状APIにないため、実装なしで可能と仮定しない。

## 11. Disk / Raw Retention / Cleanup

- Compressed raw BI5は5年取得完了まで**すべて保持**。Phase 1 / importer完成後も、再現性・source revisions比較・decoder再検証のため保持する方針を推奨する。license / retention rightsの確認は別途必要。
- Rawはcontent hash / immutable attempt / source day / inventory identityに紐付ける。hashだけでremote provenanceを失わない。read-only運用、disk encryption / restrictive local permissionsを推奨。
- Uncompressed whole-day tick dumpsは原則永続化しない。xz stdoutから既存parserへstreamする。
- 日別canonical 1m cacheを保存する場合はraw hash・adapter version・own hashを必須にし、missing minuteを補完しない。cacheがなければrawから再生成できる。
- Inventory / approval receipts / checkpoint / cost ledger / decode receipts / bounded logs / final dataset / preparation receiptを保持する。長いrunではrotatedログ上限を超えたら止め、silent log deletionでauditを失わない。
- Quarantine / `.partial` / orphan / `.preparing-*` / retry revisions / stale cacheのcleanupは**別途明示承認制**。raw / final / checkpointを勝手にdeleteしない。正常stagingのpublish renameはdeleteではない。
- `tmp/dukascopy/` 配下は現在Git ignore。十分なexternal diskへ移す場合はGit外の承認済みrootを選び、path containmentを再設定する。Git force-add禁止。backupは別disk容量とlicenseをreviewし、このpreflightでは作らない。

## 12. Concrete Transport Recommendation

### 推奨: AWS SDK for JavaScript v3

projectはTypeScript / Nodeで、既存transport interfaceがAsyncIterable bytesを要求する。SDKのstreaming body、typed AWS error / HTTP status / response metadata、If-Match、AbortSignal、client retry設定は、この境界に直接合わせやすい。CLI temp fileからの再コピーより、既存Foundationがraw `.partial` / hash / verified publicationの唯一のwriterである構成を維持できる。

次taskで必要なら `@aws-sdk/client-s3` とRole-profile credential providerを導入するが、**本preflightではinstall / code変更なし**。既存 **`dukascopy-pilot` Role profile** をSDKの標準profile/Role credential chain経由で使用し、static access keyをcode / app env / manifestへ保存しない。provider自身のcredential解決とapplicationによるcredential内容の表示・コピーは区別する。Access Key作成は禁止。

inventoryで凍結したkeyのみ受け付け、bucket / region / pair / profile固定、HEAD / GETだけ実装。GetObject bodyをbounded streamで返し、success metadataをverifyしてからFoundationへ渡す。ListBucket、Put、Delete、sync、arbitrary endpoint / key / custom credential入力を提供しない。TLS使用、path root / symlink / traversal検証、single writer、timeout / retry / caps / checkpoint統合が必要。

### CLI Alternative

localには `/usr/local/bin/aws` がある。CLIの利点は追加npm dependencyなし、既存Role profile認証を再利用できること。使うならhigh-level `s3 sync` / recursive `cp` ではなく**exact `s3api head-object` / `get-object`**のみ、shell=falseの `spawn/execFile` argvで固定profile / region / Requester Paysを渡す。

一方、`get-object` はoutfileへbodyを書きstdoutへmetadataを返すので、現AsyncIterable boundaryへそのまま接続しにくい。private staging file + Foundationへのcopyは二重disk I/O / temp容量 / crash orphanを増やす。`/dev/stdout`へのbodyとmetadata混在を安全なstreamと仮定しない。CLI出力error文字列解析、child kill / grandchildren、内部retryのrequest数可視性も別検証が必要。**strict streaming capsとtyped failure分類を重視してSDKを推奨**するが、SDK導入が認められない場合はCLI stagingとその容量・cleanup承認を含めて再reviewする。

## 13. Exact Next Task

**Task116 Phase 3 — Exact-Key S3 Inventory / Streaming Transport and Durable Acquisition Safety（offline implementation first）**。

最小範囲:

1. CLI/UIとは独立したNode-only SDK transportとexact-key HEAD inventory facade。固定 `dukascopy-pilot` Role profile / bucket / region / Requester Pays / frozen key whitelist。no ListBucket / no static keys / no fallback。
2. 既存sequential transferを再利用するapproval-bound runner。master plan、batch checkpoint、global attempts / bytes ledger、max3 attempts、explicit timeouts、AbortSignal、redacted errors、disk checks、source metadata一致検査。
3. lock / fsync / path containment / no-overwrite / orphan reconciliation / NO_DATA evidence reuse / DECODE_ERROR raw保持を追加し、process restartでもcapがリセットされないことをfake fixturesで検証。
4. fake AWS responsesでHEAD200 / 404 / ambiguous403 / Requester Pays failure / expired Role / 412 / mismatch / cap / retry / abrupt crash / changed raw / DECODED reuseをtest。default local planでnetwork zero。5年相当のsynthetic Phase 1 / importer memory benchmarkはsource evidenceではないことを明示して別gateとして測定。
5. **実装taskのdefaultもDRY_RUNで、live AWS requestは0**。code reviewとoffline test後に、別の「1826 exact-key metadata inventory実行承認」を得る。そのinventory approvalはGET/bulk download approvalとは別。

取得開始前の残条件: component完成、current Role resource scopeとmissing判定解決、metadata total bytes、fresh official cost estimate、32 GiBまたはinventory由来のdisk reserve、license / retention、batch approval、interruption / resume test、operatorの明示download authorization。

## 14. Regression / Git Safety

- Production / test code変更不要、実装はこの段階で行っていない。
- 既存Foundation focused tests: **30 / 30 PASS**、fail / cancelled / skipped 0。
- 既存test内のfake transfersはlocal synthetic fixturesのみ。実AWS request / downloadではない。
- compile + guarded1826-key local dry-run: **PASS、exit 0**。system `/tmp/task116-preflight.*` compiled filesは終了時に削除。
- npm test / lint / build / E2E全件は今回は再実行しない。code変更がなく、requestされたfocused regressionsに限定する。前回Pilotのfull regression PASSを今回実行結果として転載しない。
- 開始時 `git status --short`: **clean**。
- 最終 `git status --short`: **本報告書の `??` 1ファイルのみ**。
- `git diff --stat` / `git diff --cached --stat`: 出力なし、tracked / staged変更なし。
- `git diff --check`: **PASS**。untracked報告書も `git diff --no-index --check /dev/null <report>` で空白違反なしを確認した。
- `git ls-files -- tmp '*.bi5'`: 出力なし。`git check-ignore` でraw BI5 / generated pilot manifestがignoredであることを確認。
- raw / reference / generated dataset / inventory / AWS credential情報をGitへ追加しない。報告書はpublic source名・非secretのplanned keys・計算値だけを含み、account / Role identity / credentialsを含めない。
- commit / push: **なし**。

## 15. Official Sources / Verification Limits

2026-10-07に公開資料を参照した。価格数値は固定しない。

- [AWS HeadObject](https://docs.aws.amazon.com/AmazonS3/latest/API/API_HeadObject.html): GetObject permission、ListBucket有無で404 / 403、HEAD generic errors、metadata fields。
- [AWS GetObject](https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObject.html): exact key、If-Match / 412、GetObjectVersion permission、response / RequestCharged、missing error behavior。
- [AWS ListObjectsV2](https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListObjectsV2.html): ListBucket permission、prefix / max keys / bounded pagination。方式Bは提案のみで未承認・未実行。
- [AWS Requester Pays](https://docs.aws.amazon.com/AmazonS3/latest/userguide/RequesterPaysBuckets.html): 認証必須、Role所属accountへのcharge、requesterのrequest/DTOとowner storageの区別。
- [AWS S3 Pricing](https://aws.amazon.com/s3/pricing/): request / retrieval / internet transfer分類、途中中断時のAWS送信bytesとclient受信bytesが異なる場合があること。実行直前にregion / class / account eligibilityを再確認する。
- [AWS error response billing](https://docs.aws.amazon.com/AmazonS3/latest/userguide/ErrorCodeBilling.html): 4xx / 5xxと非課金exceptionの分類。missing / retry費用を成功requestだけの式に落とさない。
- [AWS Budgets](https://docs.aws.amazon.com/cost-management/latest/userguide/budgets-managing-costs.html): billing / notification遅延と通知後の追加費用。
- [AWS CLI retries](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-retries.html): internal retry設定とinitial attemptを含むmax attempts。
- [Dukascopy Historical Data Export](https://www.dukascopy.com/swiss/english/marketwatch/historical/): 公開ページは取得できたが、抽出内容では現行S3 bulk documentation / license / 全object inventoryを確認できなかった。S3 framing・daily keyは既存実Pilotの実データとFoundation契約を根拠とし、未確認の5年availabilityを公式確認済みとは記載しない。

Dukascopy wiki候補 `https://www.dukascopy.com/wiki/en/forex-cfds/historical-price-data/` も本文抽出できず、根拠に採用していない。providerの最新S3 documentation / licenseは実inventory承認前の再確認事項とする。

current IAM policy / session / billing eligibility / provider完全manifest / S3 storage class / 1825 objectsのexistence・sizeは未照会。ここを推測でREADYにしない。

**Verdict: NOT READY。Bulk Download Authorization: NOT AUTHORIZED。**