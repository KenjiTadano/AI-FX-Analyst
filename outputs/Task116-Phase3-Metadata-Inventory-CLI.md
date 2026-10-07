# Task116 Phase 3: Metadata Inventory Operator CLI

- 実施日: 2026-10-07
- Branch: `feature/v1.2-task116-metadata-inventory-cli`
- Verdict: **PASS**（offline CLI / fake AWS / regressionの範囲。live実行許可ではない）
- **Real AWS / nonfake network requests = 0**（npm registry / local E2E通信は別）
- **Metadata Inventory Authorization: NOT AUTHORIZED**
- **Bulk Download Authorization: NOT AUTHORIZED**

## 1. Audit / Architecture

production / durable / runner / acquisition / 既存production testsを確認した。CLIのproduction入口は **既存 `runDukascopyInventory` のみ**。legacy Foundation transfer APIを直接呼ばず、既存approval validation、immutable snapshot、request classification、retry/deadline、ledger、progress/resume、lock/path安全性を再利用する。

追加は以下のthin operator layerのみ:

- [scripts/dukascopy-s3-inventory.mjs](../scripts/dukascopy-s3-inventory.mjs): 既存`.mjs`慣習に合わせたNode launcher。local TypeScript compilerでCLI entryと依存だけをsystem/tmpへcompileし、child Nodeへarguments/stdin/stdout/signalsを渡し、終了時に今回のcompiled filesだけをcleanupする。
- [lib/backtest/dukascopy-inventory-cli.ts](../lib/backtest/dukascopy-inventory-cli.ts): command/batch、TTY/exact phrase、approval custody、HEAD-only session、summary/exit code、lifecycle。
- [tests/dukascopy-inventory-cli.test.ts](../tests/dukascopy-inventory-cli.test.ts): fake stdin/AWS/signals、network prohibition、operator safety。
- [package.json](../package.json): `historical:inventory` script追加だけ。

dependency追加・lock変更なし。既存production layer / baseline / BI5 / Phase 1 / importer / strategy / DB / migrationは無変更。app API route/browser/automatic schedulerへ登録していない。

## 2. Safe CLI Commands

実行済みのsafe smoke:

```bash
npm run historical:inventory
npm run historical:inventory -- --dry-run
```

両方 **DRY_RUN / exit 0**。引数なしでもnetwork 0、SDK sessionを作成・activateせず、credential providerをresolveしない。approvalを読まず、store/ledger/snapshotを作らない。

利用できるcommandは **plan / inventory** のみ。以下もDRY_RUNで利用可能（plan確認例）:

```bash
npm run historical:inventory -- plan
npm run historical:inventory -- plan --dry-run --start 2021-01-01 --end-exclusive 2026-01-01
```

GET/download/decode/Phase1/import/LIST/sync commandは提供しない。bucket/region/pair/profile/endpoint/credentials option、unknown/duplicate flagsは拒否する。

DRY_RUN summaryはmaster count/hash/first-last key、選択batch、live cap、承認/確認要件、固定source、ignored output locationsを表示する。GET/LIST/downloadは常にdisabled。full masterのDRY_RUN確認は可能だが、full live inventoryへ切り替えられるわけではない。

## 3. Frozen Source / Batch

変更不能なsource:

- bucket: **cfg-public-proper-wallaby**。
- region: **eu-west-1**。
- instrument/pair: **USDJPY**。
- profile: **dukascopy-pilot**。
- Requester Pays: **requester**。
- master range: **[2021-01-01, 2026-01-01)**。
- master count: **1826 deterministic UTC-day keys**。
- ordered-key hash: **c8731ac9b80e8a83373f295e9f8834abaa611fdf08297a9552d3d9346c758302**。
- first/last: **USDJPY/2021/00/01_ticks.bi5** / **USDJPY/2025/11/31_ticks.bi5**。

masterは既存production plannerから再生成し、その既知hashをruntimeで検証する。CLIはUTC `--start` / `--end-exclusive`でsubsetを選択し、range外・invalid date・empty rangeを拒否する。

default selected batchは **[2021-01-01, 2021-01-08)** = **7 keys**。liveには両dateの明示指定が必須。live batch最大7 keys、approval/global maxObjects最大7、HEAD attempts最大21（初回+最大2 retries/key）、GET/bytes/verified capsは0を要求する。8-key以上はrequest前に拒否。将来のcap拡張には別code/review/approvalが必要。

## 4. Future Live Activation（今回は未実行）

将来liveには全条件が必要:

1. `inventory --live --approval <path> --start <date> --end-exclusive <date>`。
2. input/outputともTTY、CIではないこと。
3. ignored/untracked local approval file、hash integrity、existing approval model、plan/date/keys/caps/expiryが一致すること。
4. operatorがexact phraseを入力し、EOF/cancelでないこと。
5. 確認後にapprovalを再読込して不変を確認すること。その後初めてLIVE sessionを生成する。

Promptは **HEAD INVENTORY ONLY / USDJPY / bucket / region / batch dates / exact keys / max HEAD attempts / Requester Pays enabled / GET disabled / LIST disabled / Download disabled** を表示する。

初期7-keyのexact phrase:

```text
HEAD INVENTORY USDJPY 2021-01-01 2021-01-08 7
```

**以下は文書のみの将来例。承認がない現在は実行禁止。**

```bash
npm run historical:inventory -- inventory --live --approval tmp/dukascopy/s3-production/approvals/initial.json --start 2021-01-01 --end-exclusive 2021-01-08
```

本Taskのtestsはこのactivation条件をfake stdin/fake senderで検証しただけで、上記live shell commandを実行していない。

## 5. Approval Validation / Custody

既存 **AcquisitionApproval** とdurable **hash-wrapped document `{ hash, data }`** を使用する。独自の弱いapprovalを作っていない。`id`（approval ID）、batchId、operation=INVENTORY、planHash、inventoryRevision=null、batch UTC range、explicit ordered keys、caps/globalCaps、minimumFreeBytes、expiresAtを既存validatorへ渡す。

fileはfixed ignored directory **tmp/dukascopy/s3-production/approvals/** のJSON basenameのみ。Gitでignoredかつuntrackedであることをlocal git commandsで確認し、outside path、traversal、encoded path、symlink escape、tracked approvalを拒否する。

missing/expired/modified/wrong hash/wrong keys/range mismatch/duplicate/over-cap approvalはrequest前にFAIL。確認中の改変は再読込で拒否し、各HEAD送信前にもapprovalを再検証する。CLIにapproval自動作成やapproval生成→即live実行機能はない。作成・review・実行を分離する。

integrity hashはsignatureではなく、trusted local operator custodyが前提。初回実行前にapprovalとhashを両方書き換えられるprivileged actorを防ぐ外部署名認可serviceではない。既存ledgerの同approval ID bindingも継続して適用する。

## 6. Output / Redaction / Stop

snapshotは既存immutable inventory revisionとして **tmp/dukascopy/s3-production/inventories/** に保存する。ledger/progressも既存storeとignored rootを使う。

summaryはapproval ID / batch / planned count / PRESENT / CONFIRMED_ABSENT / UNKNOWN / ERROR（AMBIGUOUS_ACCESS含む）/ batch bytes if complete / master actual bytes if complete / revision / elapsed / HEAD attemptsだけをallowlist化する。

7-key batchが完了してもmaster1819 keysがUNKNOWNなら **actualFiveYearBytes=null**。batch bytesとmaster actual bytesを区別する。HEAD attemptsはdurable gateのbudget attempt値であり、request前abort等も含む保守的な計数。AWS請求request数の直接証明ではない。

403/Requester Pays/session/redirect/region/approval/plan/store/ledger/unknown responseは停止。403を404/NO_DATAへ変換しない。既存runnerが可能な範囲でpartial snapshot/progress/ledgerをpersistする。storage自体が書込不能・破損の場合はnonzeroで停止し、保存を保証したとは扱わない。

- **0**: DRY_RUN/plan確認、または承認されたselected batchの全keysがPRESENT/CONFIRMED_ABSENTとして完了。
- **2**: partial inventory / interruption、確認済みentriesを保持。
- **1**: blocked approval/confirmation/options/store/unknown operator failure。

credential/session token/account ID/Role ARN/signed headers/Authorization/raw AWS exceptionを表示しない。unexpected exceptionsもfixed OPERATOR_ERRORでredactする。

## 7. Signal / Resource Cleanup

coreはSIGINT/SIGTERMをAbortControllerへ接続し、runnerにAbortSignalを渡す。finallyでstore.release() / session.destroy()、signal handlers除去を行う。launcherもSIGINT/SIGTERMをchildへ転送し、終了後に今回のcompiled tempだけをcleanupする。

fake SIGINT/SIGTERMでpending HEADをabortし、partial nonzero、snapshot/ledger保全、lock release、session destroy、listener除去を確認した。resumeは既存progressを使い、同じapprovalのPRESENT/CONFIRMED_ABSENTを再HEADしない。

SIGKILL/power loss等で残ったstale lockの自動削除/自動reclaim optionはCLIへ追加していない。既存durable storeのexplicit token/dead-PID reviewが別途必要。snapshot/approval/rawの自動cleanupはしない。

## 8. GET / LIST Unreachable Evidence

CLI coreには`runDukascopyDownload`、legacy transfer、GetObjectCommand、ListObjects commandsのimport/callなし。唯一呼ぶproduction入口は **runDukascopyInventory**。

session subclassでも **HeadObjectCommandのみ**を許可し、既存SDK sessionへ渡す前に拒否する。approvalのGET/network/verified capsも0。CLI parserはGET/download/decode/Phase1/import/LIST/ListObjects/ListObjectsV2/syncをrejectする。fake senderは全呼出しがHeadObjectCommandであることをassertし、static source checkでも禁止call/importがないことを確認した。

## 9. Offline Tests / Network

focused tests **28/28 PASS**。default/explicit DRY_RUN、1826 master、7-key selection、8-key live拒否、master範囲外、wrong plan、missing/expired/modified/range/keys/duplicate approval、確認不一致/EOF/noninteractive/CI、HEAD200/confirmed404/403/Requester Pays/session/redirect/region/transient、partial nonzero、SIGINT/SIGTERM cleanup、PRESENT/ABSENT resume、redaction、GET/LIST unreachable、corrupt ledger、tracked/symlink approvalを検査。

fake stdinはReadable/readline、fake signalsはEventEmitter。http/https/net/tls/fetchをblockし、**real nonfake network calls 0**をassertした。real SDK/profileはactivate/resolveしていない。tracked approval拒否testのGit index操作はsystem/tmpのfake repositoryだけで、projectのapprovalはstage/trackしていない。

## 10. Security / Regression

- `npm audit --omit=dev --json`: **all severity 0 / exit 0**。
- full `npm audit --json`: **Critical 0 / High 5 / exit 1**、known dev-only **GHSA-vfj7-8cjw-p6xm** の1 unique advisoryのみ。新規Critical/Highなし。Security MaintenanceのPARTIALをPASSへ変更したとは扱わない。
- new dependency **0**、package-lock無変更。
- focused tests **28/28 PASS**。
- `npm test`: **1403/1403 PASS**、fail/cancelled/skipped0、legacy market regressionsもPASS、exit0。
- `npm run lint`: **PASS**、error/warning0。
- `npm run build`: **PASS**、既存Apple Silicon/Rosetta性能警告のみ。
- `npm run test:e2e -- --workers=1 --reporter=dot`: **362/362 PASS、4.7分、workers=1、exit0**。
- actual npm launcherの引数なし/explicit DRY_RUN smoke: **PASS**。
- `git diff --check`: **PASS**、untracked new core/launcher/test/reportもno-index checkで空白違反なし。

## 11. Git / Scope Safety

開始worktreeはclean。変更はpackage scriptとnew core/launcher/tests/report。既存production/durable/runner/acquisition、BI5 parser、Phase1/importer、baseline、DB/migration、lockfileは無変更とgit diffで確認した。

最終 `git status --short` は **package.jsonのM 1ファイルとnew core/launcher/test/reportの?? 4ファイルのみ**。`git diff --stat` はtracked 1 file / 2 insertions / 1 deletion（new filesは対象外）。`git diff --cached --stat` は出力なし、staged変更0。`git ls-files -- tmp '*.bi5'` も出力なし。

approval/snapshot/ledger/checkpoint/AWS response/raw BI5/credentials/generated datasetのproject Git追加なし。回帰/audit logsとreal rawはGit ignoreも確認。test artifactsはsystem/tmpのfake repoで作成してtest終了時にcleanupした。final raw SHA-256は **1304f89abecdf1808997a16d3856b7d94c16530cdea97b0eab5ef1e33fb90d01** で不変。commit/pushなし。

## 12. Limitations / Exact Next Step

- offline CLI検証のみ。実Role session/IAM/metadata/pricing/disk/source availabilityは未確認。
- trusted local operatorとreview済みapproval custodyが前提。hashは秘密署名ではない。
- launcherはlocal TypeScriptを必要とするので、projectのdev toolingを含むinstallが必要。新dependencyを追加したものではない。
- stale-lock recoveryやfull inventory cap拡張は別review。7-key以上のlive batchはこのCLIから許可しない。
- root以外へのsnapshot export、arbitrary output/profile/endpoint optionsは提供しない。
- live費用/credentials/session validation、actual master bytes、5年coverageを推測でPASSにしていない。

Exact next step: offline CLI/approval custody/capsをreviewし、別途**初期7-key HEAD inventoryのみ**の実行を明示承認する。その前にcurrent Role scope/session、Requester Pays費用、approval expiration/store/diskをoperatorが確認する。今回のPASSはその許可ではない。full inventoryへの拡張は別code/review/approval、GET/5年downloadはさらに別承認が必要。

**Metadata Inventory Authorization: NOT AUTHORIZED**

**Bulk Download Authorization: NOT AUTHORIZED**
