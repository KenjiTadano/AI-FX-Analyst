# Task116 Phase 3: S3 Production Transport / Durable Acquisition Safety

- 実施日: 2026-10-07
- Branch: `feature/v1.2-task116-s3-production-transport`
- Verdict: **PASS**（offline implementation / fake AWS / regressionの範囲）
- **Live AWS requests = 0**。S3 / STS / SSO / 認証付きAWS CLI requestなし。
- **Metadata Inventory Authorization: NOT AUTHORIZED**
- **Bulk Download Authorization: NOT AUTHORIZED**

## 1. Audit / Scope

Foundation acquisition / BI5 adapter / Phase 1 / local importer / Foundation tests / preflight reportを実装前に照合した。記載Gapとcodeは一致し、audit差異なし。concrete transport、inventory、persistent ledger、retry/timeout/cancel、confirmed NO_DATA reuse、decode-failed raw保持、crash reconcile、single writer/path containmentが不足していた。

今回実装したのはoffline取得制御層。HEAD / GETはfake senderのみで、live HEAD / GET / LIST / BI5 download / 5年取得は0。package install / npm auditはnpm registryアクセスであり、AWS認証やdata bucketアクセスではない。Access Key作成、static AWS key追加、credentials / profile内容 / `~/.aws` の表示・コピー・ログ、DB / migration、commit / pushなし。

Task113 Signal Engine / Task114 replay / Task115 simulator / Task116 validation/OOS、BI5 record parsing / MID / Export CSV adapter / Phase 1 OHLC / missing-minute semantics / local importerは無変更。凍結対象はgit diffで照合した。

## 2. Architecture / Changes

```text
existing local planner -> frozen 1826 keys / known hash
  -> INVENTORY approval -> exact HEAD -> immutable allowlisted snapshot
  -> separate DOWNLOAD approval
  -> persistent attempts / full-size reservation / disk guard
  -> fixed HEAD/GET-only SDK -> validated AsyncIterable body
  -> existing Foundation writer + durable filesystem hooks
  -> .partial / hash / journal / no-overwrite publication
  -> existing BI5 decoder -> DECODED checkpoint -> resume/reconcile
```

- [lib/backtest/dukascopy-s3-production.ts](../lib/backtest/dukascopy-s3-production.ts): SDK factory/session、frozen plan、approvals、HEAD/snapshot、GET validation、classification/deadline/backoff。
- [lib/backtest/dukascopy-s3-durable.ts](../lib/backtest/dukascopy-s3-durable.ts): single-writer store、ledger、immutable documents、reservation/disk、journals/publication/quarantine。
- [lib/backtest/dukascopy-s3-runner.ts](../lib/backtest/dukascopy-s3-runner.ts): default DRY_RUN、inventory/download approvals、Foundation integration、resume/reconcile、decode evidence。
- [lib/backtest/dukascopy-s3-acquisition.ts](../lib/backtest/dukascopy-s3-acquisition.ts): optional safe writer / checkpoint hooks、confirmed-absence revision reuse、追加failure codes。旧Foundation APIは互換維持。
- [tests/dukascopy-s3-production.test.ts](../tests/dukascopy-s3-production.test.ts): fake AWS / network prohibition / safety / scale tests。
- [scripts/test.mjs](../scripts/test.mjs): system/tmp compiled JSからrepo node_modulesを解決する子NodeのNODE_PATHだけを補強。

取得機能をbrowser / API route / schedulerへ登録していない。operator向けlive実行CLIも追加していない。productionは新approval-bound runnerを入口とし、legacy Foundation direct APIだけでlive取得してはならない。

## 3. Dependencies / Node-Only

Direct追加は **@aws-sdk/client-s3 3.1147.0** と **@aws-sdk/credential-providers 3.1147.0**。transitiveを含め27 packages追加。lock比較で既存package version変更0。

固定configはbucket `cfg-public-proper-wallaby`、region `eu-west-1`、instrument `USDJPY`、profile **dukascopy-pilot**、RequestPayer=requester、fixed HTTPS endpoint、followRegionRedirects=false、maxAttempts=1。lazy `fromIni` Role-profile providerを使用し、applicationでcredential値を取得・保存・表示しない。future SDK/provider内部の認証解決とcredential内容のapplication出力は区別する。

Node fs/crypto/streamsを使うNode-only module。browser client生成は拒否。任意endpoint/bucket/region/pair/credentialsをconstructor APIへ渡せない。単独SDK factoryはdisarmedで、private LIVE session activation以外ではrequest不可。OFFLINE_TESTへreal SDK senderを注入することも拒否。factory生成とdestroyはnetwork guard下でrequest 0を確認した。実profileを読んで認証してはいない。

## 4. Exact-Key Whitelist

既存plannerで `[2021-01-01, 2026-01-01)` の1826 UTC-day keysを再生成し、unique countとordered JSON hashを照合する。

```text
c8731ac9b80e8a83373f295e9f8834abaa611fdf08297a9552d3d9346c758302
```

first `USDJPY/2021/00/01_ticks.bi5`、last `USDJPY/2025/11/31_ticks.bi5`。zero-index month / UTC dayを確認。../、encoded traversal、alternate source、range外、malformed key、duplicate approval entries、unapproved exact key、plan/revision hash mismatchはrequest前に拒否する。remote keyをlocal pathに直接使わず、FoundationのobjectId hash prefix / raw hash / attempt名を使う。

## 5. HEAD Inventory / Snapshot

HEADはapproved exact key / fixed bucket-region / RequestPayer=requesterのみ。persistするmetadataはkey / UTC day / status / ContentLength / ETag / LastModified / StorageClass / ChecksumType・standard checksum fields / RequestCharged / checkedAt / attemptsに限定する。Authorization / signed headers / raw AWS response / account / Role ARN / credential/debugは保存しない。

- 200: allowlisted metadata、region、RequestChargedを検査してPRESENT。
- confirmed 404 / NoSuchKey / NotFound: region/delete-marker等に矛盾がなければCONFIRMED_ABSENT。
- 403: AMBIGUOUS_ACCESS、inventory停止。NO_DATAへ変換しない。
- Requester Pays / expired session / redirect / alternate region / unknown response: ERRORで停止。
- selected transientだけ最大3 attempts。request前cap拒否を通信失敗として加算しない。

snapshotはplanHash / range / bucket-region-requesterPays / ordered keys / metadata / createdAt / revision hashをbindしたimmutable content-addressed document。partial snapshotでもconfirmed/UNKNOWNを分離し、**全1826がPRESENTまたはCONFIRMED_ABSENTになるまでactualTotalBytes=null**。

progressはplan/approval hashへbindし、同じapprovalのrestartで既知PRESENT/CONFIRMED_ABSENTを再HEADしない。403等で停止したsnapshotはpersist/returnされるが、完成inventoryではない。callerはstatus completenessをreviewする必要がある。

## 6. GET Streaming / Requester Pays

inventory PRESENTかつDOWNLOAD approvalのkeyだけを受け付ける。IfMatch=inventory ETag、RequestPayer=requester。SDK transportは別raw fileを作らず、AsyncIterable bodyをFoundation writerへ渡す。default concurrency=1。

response ETag / ContentLength / region / RequestChargedを照合。412 / missing-after-inventory / ETag-size mismatchはSOURCE_CHANGED、403やRequester Pays異常は停止。body shorter/longer/invalid chunkを拒否し、途中bytesもledgerに保持する。Bodyは完了/失敗/timeout/cancel時に解放する。missingを勝手にNO_DATAへ変更しない。

ETagをSHA-256とみなさない。FULL_OBJECT SHA-256がHEADで提供された場合のみsource checksumを照合し、それ以外はlocal SHAをraw identity/reuse検証として保持する。local hash生成だけを独立provider checksum検証とは呼ばない。

## 7. Retry / Timeout / Cancellation

SDK maxAttempts=1。applicationはinitial+max2 retries、最大3 attempts/key/operation。global ledgerでrestart/batchをまたいで保持し、4回目はrequest前に拒否する。

selected 429 / 500 / 502 / 503 / 504、ETIMEDOUT / ECONNRESET等だけbounded exponential backoff+jitter。403 / Requester Pays / checksum / source change / decode / invalid response / approvalはretry禁止。testではbackoff短縮可能。

connection timeout **5000 ms**、operation deadline default **60000 ms**。finite test override対応、0/unlimited/300000 ms超は拒否。Role認証HTTPにもfinite timeoutを指定する。AbortSignalはsend/body iterator/backoffへ適用。future driverはSIGINT等をsignalへ接続する必要がある。OS interruption後はjournal/checkpointから復旧する。

## 8. Persistent Ledger / Approval

atomic hash-wrapped ledgerにplanHash / inventoryRevision / approvalId / batchId / global caps / per-approval binding、HEAD/GET attempts、successful GETs、failed attempts、network received bytes、cumulative full-size reservations、verified artifact bytes、quarantine/known partial bytes、retry count、objects、active request、startedAt/updatedAtを保持する。

request前にHEAD/GET attempts、objects、retry、received/reserved/verified bytesを検査する。GETはContentLengthを事前reserveし、failed/interrupted reservationも戻さない。verified bytesは公開直後に加算して同じbatchの次GET前にも反映する。restartで0へ戻らない。

INVENTORYとDOWNLOAD approvalsは分離。planHash / inventoryRevision / batch UTC range / explicit keys / caps / minimumFreeBytes / expiresAtへbindし、expired/duplicate/同ID改変/範囲拡張を拒否。default DRY_RUN。LIVEはexplicit flagと有効approvalが必要。approvalはtrusted local operatorのreview済みrecordを前提とし、外部署名付きauthorization serviceではない。今回LIVEでrequestしていない。

## 9. Checkpoint / Resume / Filesystem

production checkpointにhashを付け、source contract/range/inventory/key/date/status/pathを検査する。VERIFIED/DECODEDはlocal SHA一致ならredownloadしない。DECODE_ERRORはrawを保持し停止、networkで直そうとしない。NO_DATAはCONFIRMED_ABSENT evidenceとrevision一致からだけ作り、resumeで再HEAD/GETしない。

WRITING / complete download+hash / publicationをjournal化する。download完了と公開直後checkpoint前のfault simulationは、restart後に追加GETなしでreconcileした。proof不足partial/orphanはquarantineへ保全し、自動deleteしない。

rootはacquire時にabsoluteへ固定し、containment / symlink rejection / O_NOFOLLOW / exclusive createを適用。raw publicationはexclusive hard-linkによるno-overwrite、readonly raw、file/directory fsyncを行う。complete partial aliasはcrash evidenceとして保持し、cleanupは別承認。directory fsync未サポート時はbest effort。

exclusive writer.lockでsingle writer。releaseはlock evidenceをrenameして保持。stale lockは明示tokenとPID不存在が確認できる場合のみreclaimし、live ownerを拒否。operator driverはfinallyでstore.release()/session.destroy()を呼ぶ必要がある。

## 10. Disk Guard

batch開始前・各GET前にstatfsを確認。approved inventory size sum / active ContentLength / approval.minimumFreeBytesからreserveを計算し、disk不足はGET前にDISK_FULL。preflight32 GiBをproduction requirementとしてhard-codeしていない。fake free-bytes adapterでrequest 0を確認した。OS他processの容量変動は止められず、受信中I/O failureは停止・保全する。

## 11. Fake AWS Tests / 1826 Scale

new **44 tests** + existing Foundation **30 tests** = focused **74/74 PASS**。

Coverage: HEAD200/404/403、Requester Pays、expired Role、redirect/region、transient retry、GET success/retry/403/412/missing、ETag/length mismatch、short/long body、中断/timeout/cancel、retry/global bytes/object/verified caps、expired/unapproved/duplicate/hash-revision mismatch approval、traversal/symlink/second writer/stale lock、download/publication crash、orphan partial、DECODE_ERROR/DECODED/NO_DATA reuse、restart persistence、unchanged production LZMA-Alone synthetic decode。

http.request / https.request / net.Socket.connect / tls.connect / fetchをblockし、非fake network calls **0**をassertした。factory構築・disarmed request・LIST拒否もguard下で検証した。実profile authentication/HEAD/GET/LISTは0。

Synthetic focused scale: **1826 inventory entries / 60 month batch documents / 1826 keys resume scan / persistent ledger**。elapsed **759 ms**、RSS before **171139072 bytes** / after **186646528 bytes**、process peak RSS **183392 KiB**（test file全体を含むmachine-specific参考値）。RSS growth 256 MiB上限check PASS、OOMなし。実5年ticks/size/throughput/strategy evidenceではない。Phase 1/importerのreal five-year memory/timeは別途必要。

## 12. Regression / Dependency Audit

- Focused **74/74 PASS**。
- `npm test`: **1375/1375 PASS**、fail/cancelled/skipped 0、legacy market testsもPASS、exit 0。
- `npm run lint`: **PASS**、最終error/warning 0、exit 0。途中unused parameter/importは同sliceで修正・再check。
- `npm run build`: **PASS**、exit 0。既存Apple Silicon/Rosetta性能警告のみ。
- `npm run test:e2e -- --workers=1 --reporter=dot`: **362/362 PASS、4.5分、workers=1、exit 0**。
- `npm audit --json`: **exit 1、9既存指摘（8 high / 1 critical）**。SDK指摘0。対象versionはHEAD lockと同じ。
- audit対象はNext / ESLint / glob / sharp / source-map依存。Next 16.3.4のcriticalも残る。security cleanとは扱わず、unrelated audit fix/force/Next更新は行っていない。別maintenance/security Taskが必要。
- `git diff --check`: **PASS**。new code/test/report 5ファイルもuntracked用no-index checkで空白違反なし。

## 13. Git Safety

開始worktreeはclean。code/dependencies/test runner/new tests/reportが対象。途中で現れた既存Foundation testの整形と文書の末尾改行も確認し、意味変更なしとして保持した。凍結対象に差分なし、既存package versions変更0。

最終statusはtracked変更6ファイル（acquisition / package.json / lock / test runner / Foundation test整形 / Foundation文書末尾改行）と新規5ファイル（3 modules / new test / 本報告書）。`git diff --stat` はtrackedのみ6 files / 516 insertions / 39 deletionsであり、new filesはそのstatに含まれない。`git diff --cached --stat` は出力なし、staged変更0。`git ls-files -- tmp '*.bi5'` も出力なし。

raw / fake inventory / approval / ledger / AWS dump / credential / generated historical datasetのGit追加なし。回帰/audit logsとreal rawは `git check-ignore` でもignoredと確認した。test fixturesはsystem `/tmp/task116-production-tests-*` に作成してtest終了時にcleanupした。real raw/reference/datasetは無変更。final raw SHA-256は `1304f89abecdf1808997a16d3856b7d94c16530cdea97b0eab5ef1e33fb90d01` で不変。commit/pushなし。

## 14. Limitations / Exact Next Step

- offline component検証のみ。current Role/session/IAM、provider全response variants、license/retention、actual inventory/cost/disk/throughputは未確認。
- received bytesとAWS送信bytesは一致保証なし。full-size reservationも金額hard capではない。
- trusted local single-writer前提。privileged hostile process、manual ledger deletion等を防ぐOS sandboxではない。document hashは秘密署名ではない。
- byte-range resumeは行わず、complete object単位で復旧。proof不足partialは保全する。
- hard-link/O_NOFOLLOW/fsyncは現在のNode/macOS local filesystemで確認。external/network filesystemは別review。
- globalCapsは初期値へ固定し、増額やsource-changeは無言で継続しない。新reviewが必要。
- operator execution CLI/schedulerは未追加。future driverはlifecycle/signal handlingを追加する必要がある。
- 既存critical/high dependency指摘は別途解消が必要。

Exact next step: offline実装とapproval/capsをreviewし、operator driverとcurrent Role scopeを確認する。その後、**別途exact-key metadata inventory実行を明示承認**する。initial bounded inventoryとfull inventory拡張のapprovalを分離し、403で停止する。inventory metadata/cost/diskをreviewするまでGET/bulk downloadを許可しない。今回PASSをlive authorizationに読み替えない。

**Metadata Inventory Authorization: NOT AUTHORIZED**

**Bulk Download Authorization: NOT AUTHORIZED**