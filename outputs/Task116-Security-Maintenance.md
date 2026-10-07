# Task116 Dependency Security Maintenance

- 実施日: 2026-10-07
- Branch: `feature/v1.2-task116-security-maintenance`
- Verdict: **PARTIAL**
- Critical remaining: **0**。
- High remaining: **5 package findings / 1 unique advisory**、dev dependency chainのみ。
- **AWS live requests = 0**。
- **Metadata Inventory Authorization: NOT AUTHORIZED**
- **Bulk Download Authorization: NOT AUTHORIZED**

## 1. Conclusion

Next.js Criticalと修正版のあるtransitive vulnerabilitiesを最小patch/refreshで解消した。**production-only npm auditは0件**。しかし、upstream修正版のない `braces` advisoryがESLint chainへ伝播したHigh 5 findingsが残るため、ユーザーのaudit gateに従いPASSにはしない。

変更は [package.json](../package.json) / [package-lock.json](../package-lock.json) と本報告書のみ。application / tests / Next config / proxy / DB / migration / strategy / Signal Engine / Backtest / Simulator / Task116 validation/OOS / BI5 parsing / MID / Phase 1 / S3 acquisition safetyは無変更。React / Supabase / Playwright / AWS SDKをまとめて更新していない。

`npm audit fix --force`、unrelated major upgrade、overrides、advisory ignore設定は行っていない。AWS/S3 request、metadata inventory、BI5 download、Access Key操作、credentials / `~/.aws` 参照・表示、commit/pushなし。npm registry / 公開advisory資料の参照だけを行った。

## 2. Before Audit / Counting

変更前に `npm audit --json` と `npm outdated --json` を実行した。audit/outdatedともexit 1。開始worktreeはclean。

- Before: **9 package findings、Critical 1 / High 8、Moderate/Low 0**。
- auditの`via` objectsをadvisory URLで重複除去すると **7 unique GHSAs**。
- brace-expansionの同じGHSAが1.x / 5.xの2rangeで記録され、さらに親packageが子の問題をmetavulnerabilityとして報告する。
- **9 findings = 9種類の脆弱性ではない**。残存5 findingsも単一braces advisoryのchain伝播である。
- AWS SDK関連finding: **0**。

outdatedにはNext/config 16.4.0、React 19.3.0、Supabase 2.117.2、ESLint 10.x、TypeScript 7.x等があったが、security scopeと関係のない更新は採用しなかった。

## 3. Findings / Classification

分類: **A** same-major safe patch/minor、**B** 許容range内dependency refresh、**C** breaking/major案のみ、**D** upstream fixなし、**E** 本appの到達性が限定的だがriskを無視しない。

### Next.js: Direct Production / Critical / A

- Installed **16.3.4**、vulnerable **>=16.2.0 <16.3.6**、fixed **16.3.6**、after **16.3.6**。
- [GHSA-vcvr-r3jv-pc5j](https://github.com/advisories/GHSA-vcvr-r3jv-pc5j): Node.js `next/og ImageResponse` がattacker-controlled SVG content/attributes/stylesを扱う場合のRCE。
- Path: application → next。Next runtime/serverに影響し、browserで直接実行されるadvisoryではない。Edge ImageResponseはadvisory対象外。
- source検索では`next/og` / `ImageResponse`の使用なし。確認したapp routeから、この前提を満たす直接経路は見つからなかった。ただしpackage Criticalを放置する理由にはせずpatch更新した。
- 16.3.6 releaseはこのsecurity修正を明示。React peer rangeは継続して19.x対応。minor/major変更よりriskが小さい同minor patchを選び、build/E2Eでruntime regressionを確認する。

### sharp: Transitive Production / High / B + E

- Installed **0.35.4**、vulnerable **<0.35.5**、fixed/after **0.35.5**。
- [GHSA-wq5f-xc86-pv6w](https://github.com/advisories/GHSA-wq5f-xc86-pv6w): librsvg memory vulnerability、特定runtime条件のglibc Linuxでpossible RCE。
- Path: application → next → optional sharp。Next server image processingに影響し、browser dependencyではない。
- applicationのdirect sharp / next/image importは見つからず、chart upload routeはAI clientへbytesを渡す。Next configでdangerouslyAllowSVGを有効にしていない。ただし別deployment platformやframework内image処理の存在を除外できないため更新した。
- Nextの許容range内patch refresh。sharp同梱native/libvips packagesも整合更新。native smokeでsharp **0.35.5** / librsvg **2.63.2** / PNG生成PASS。

### source-map-js: Transitive Production + Build / High / B + E

- Installed **1.2.1**、vulnerable **>=1.0.0 <1.2.2**、fixed/after **1.2.2**。
- [GHSA-68fv-2mgg-jv7q](https://github.com/advisories/GHSA-68fv-2mgg-jv7q), CVE-2026-93749: indexed source-map sectionのoffset値によるevent-loop DoS。
- Paths: application → next → postcss → source-map-js、およびdev @tailwindcss/postcss → @tailwindcss/node / postcss → source-map-js。shared hoisted nodeはlock上production属性も持つ。
- 主にserver/build tooling。appでsource-mapをuntrusted request inputとしてparseする経路は見つからず、browserでこのpackageを直接呼ぶ実装もない。ただしbuild inputsは無条件にtrustedとはせずpatch refreshした。
- 同major patchで親のrangeを変えず解消。source-map semanticsのapp code変更なし。

### brace-expansion: Transitive Dev / Aggregate High / B + E

- Installed **1.1.18 / 5.0.9** → after **1.1.21 / 5.0.12**。
- Paths: dev eslint **9.39.5** → minimatch **3.1.5** → brace-expansion **1.x**。dev eslint-config-next → typescript-eslint **8.70.0** → @typescript-eslint/typescript-estree → minimatch **10.2.6** → brace-expansion **5.x**。
- [GHSA-q2hr-2g5m-vwhr](https://github.com/advisories/GHSA-q2hr-2g5m-vwhr), CVE-2026-102277: quadratic CPU DoS。Moderate、vulnerable **<1.1.21 / >=4 <5.0.12**、fixed **1.1.21 / 5.0.12**。
- [GHSA-qhr7-859c-m2p7](https://github.com/advisories/GHSA-qhr7-859c-m2p7), CVE-2026-102278: nested brace stack exhaustion。High、vulnerable **<1.1.20 / >=4 <5.0.11**、fixed **1.1.20 / 5.0.11**。
- [GHSA-6j4f-fj2g-mc7p](https://github.com/advisories/GHSA-6j4f-fj2g-mc7p), CVE-2026-102276: parseCommaParts recursion exhaustion。High、vulnerable **<1.1.19 / >=4 <5.0.10**、fixed **1.1.19 / 5.0.10**。
- after versionsは上記3 advisoryすべての修正境界を満たす。dev lint/glob処理に影響する。HTTP inputをこれらのdev parsersへ渡すapp routeは見つからないが、untrusted repository/glob inputを扱うCIは注意が必要。
- 既存親range内refreshで、1.xから5.xへのmajor切替はしていない。

### braces: Transitive Dev / High / D + E（残存）

- Installed/after **3.0.3**、vulnerable **<=3.0.3**、**published patched versionなし**。
- [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm), CVE-2026-93687: recursive AST walkersのdeeply nested patternでstack-exhaustion DoS。
- Path: dev eslint-config-next **16.3.6** → @next/eslint-plugin-next **16.3.6** → fast-glob **3.3.1** → micromatch **4.0.8** → braces **3.0.3**。
- registry latestも3.0.3。advisoryのPatched versionsはNone。安全な同major patchを取得できない。
- sourceでbraces/micromatch等のdirect app importなし。runtime/browser HTTP inputからこのdev-only chainへ到達する経路は見つからない。lint対象repositoryやglob settingsを攻撃者が変更できる環境ではriskが残る。
- mitigation: untrusted glob inputをserviceへ渡さない。untrusted PR/repositoryのlintはisolated CI・timeouts/resource limits・reviewで扱う。これは運用提案で、本TaskでCI設定を変更したわけではない。advisoryをignoreしない。

### Chain Metavulnerabilities: 4追加Package Findings / High（残存）

次の4 findingsは独立advisoryではなく、上のbraces advisoryの伝播:

- **micromatch 4.0.8**: transitive dev。audit propagated range `>=0.2.0`、via braces。runtime exploitabilityとsurfaceは同じdev glob chain。分類D/E。
- **fast-glob 3.3.1**: transitive dev。audit propagated range `*`、via micromatch。分類D/E。
- **@next/eslint-plugin-next 16.3.4 → 16.3.6**: transitive dev。audit propagated range `>=14.3.0-canary.0`、via fast-glob。parent patchと整合更新したがchainは残る。分類A（version整合）+D/E（残存）。
- **eslint-config-next 16.3.4 → 16.3.6**: direct dev。audit propagated range `>=14.3.0-canary.0`、via plugin。Nextと同patchへ更新したがbracesは未解消。分類A（整合）+D/E。

npm auditの`fixAvailable`は**eslint-config-next 14.2.35へのbreaking downgrade**を示した（分類C）。Next16との整合を崩すため採用しない。同major最新plugin **16.4.0**もfast-glob **3.3.1**を保持するとregistryで確認できたため、16.4への無目的更新では残存chainを解消できない。改変forkや根拠のないoverridesも採用しない。

## 4. Exact Changes / Version Control

Direct manifest変更は2つだけ:

- Next **16.3.4 → 16.3.6**、exact pin。
- eslint-config-next **16.3.4 → 16.3.6**、exact pin。

実施commandはmanifestの上記patch変更後の `npm install`、続いて **`npm update brace-expansion sharp source-map-js`**。親rangeを維持したtargeted refreshであり、無条件の全dependency updateではない。

lock更新: Next同梱@next/env / platform SWC **16.3.4 → 16.3.6**、plugin **16.3.4 → 16.3.6**、brace-expansion **1.1.18 → 1.1.21 / 5.0.9 → 5.0.12**、sharpとplatform native packages **0.35.4 → 0.35.5**、sharp-libvips packages **1.3.3 → 1.3.4**、source-map-js **1.2.1 → 1.2.2**。all-platform optional entriesを含め **42 lock entries**のversion変化であり、42種類のdirect更新ではない。

scriptで上記families以外のversion変化が0であることをassertした。React/React DOM **19.2.8**、Supabase、Playwright、AWS SDK **3.1147.0**、TypeScript、ESLint本体は据え置き。overrides/advisory-ignore/major upgradeなし。

Application code変更: **0**。deprecated API抑制、proxy/auth修正、Next config追加なし。

## 5. Final Audit Gate

- Full `npm audit --json`: **Critical 0 / High 5 / Moderate 0 / Low 0、exit 1**。
- Residual unique advisory: **1**、braces GHSA-vfj7-8cjw-p6xm。
- `npm audit --omit=dev --json`: **全severity 0、exit 0**。
- AWS SDK findings: **0**。
- E2E完了後にもfull/production auditを再実行し、同じ結果を確認した。残存nodesはlock上すべてdev=true。解消unique advisory数は **6 / 7**。
- Critical修正済みでもHigh残存のため **Verdict PARTIAL**。production-only audit 0をfull audit 0と混同しない。

## 6. Application Regression / Boundary

- `npm test`: **1375/1375 PASS**、fail/cancelled/skipped 0、legacy market regressionsもPASS、exit 0。historical/backtest/S3 fake testsを含む。
- `npm run lint`: **PASS**、errors/warnings 0、exit 0。
- `npm run build`: **PASS**、exit 0。Next16.3.6のApp Router pages / auth endpoints / AI/API routes / proxy生成を確認。既存Apple Silicon/Rosetta性能警告のみ。
- sharp native smoke: **PASS**、sharp0.35.5 / librsvg2.63.2、2x2 PNGをmemoryで生成、92 bytes。
- E2E `npm run test:e2e -- --workers=1 --reporter=dot`: **362/362 PASS、4.8分、workers=1、exit 0**。既存baselineのapplication workflowsにregressionなし。
- browser/server boundary: TypeScript ASTで**31 use-client roots / 104 reachable source modules**のruntime importsとliteral dynamic importsを追跡し、S3 acquisition / production / runner / durable modulesおよびAWS SDK importへの到達0。
- `.next/static` の**16 JS files**を検査し、AWS SDK/provider・Dukascopy bucket/profile markersのhits **0**。SDK / credentials providerをclient bundleに入れていない。
- 補助version表示の初回のみ、sharpのpackage export制限で`require('sharp/package.json')`が拒否された。公開`sharp.versions`へ診断commandを修正してnative smokeを再実行しPASS。app code/buildはそのエラーで失敗していない。
- source/lock/bundle検査は現時点のcodeとbuildの証拠であり、全future dynamic importやdeployment環境を保証するものではない。live Supabase/AI/provider疎通やAWS認証は行っていない。

## 7. Git / Scope Safety

開始statusはclean。最終 `git status --short` は **package manifest/lockのM 2ファイルと本報告書の?? 1ファイルのみ**。`git diff --stat` はtracked 2 files / 177 insertions / 177 deletions（新規報告書はstat対象外）。`git diff --cached --stat` は出力なし、staged変更0。`git diff --check` は **PASS**、untracked報告書もno-index checkで空白違反なし。

`git ls-files -- tmp '*.bi5'` は出力なし。`git check-ignore` でaudit JSONとraw BI5のignoredを確認。変更scopeをscriptでassertし、protected source・DB・S3 safety等のcode変更0を確認した。

audit/outdated/regression logsはignored `tmp/dukascopy/`。raw BI5 / inventory / ledger / credentials / generated historical datasetのGit追加なし。commit/pushなし。**AWS live requests = 0**、metadata inventory / download 0。

## 8. Remaining Risks / Exact Next Step

未修正braces dev-tool DoSは残存する。安全なpublished patchまたは同major親のchain除去releaseを監視し、提供された時点でtargeted lock refresh → audit → lint/build/E2Eを再実施する。現在はbreaking downgrade/unknown forkを自動適用しない。untrusted repository/patternをlintするCIにはisolationとresource/time limitsをreviewする。

audit advisoryとregistryは2026-10-07時点の観測。更新で未知の将来advisoryが発見されない保証はなく、Linux native deploymentを本macOS smokeだけで安全と断定しない。source-map/画像処理/OG等に新たなuntrusted入力経路を追加するときは再reviewする。

Exact next step: braces upstream fix / ESLint同major親の安全なchain変更を確認してdev Highを解消する独立follow-up。**High 0になるまでsecurity maintenanceをPASSへ変更しない**。それまでmetadata inventory / bulk acquisitionの承認は別途のままで、本Taskからlive実行へ進まない。

**Metadata Inventory Authorization: NOT AUTHORIZED**

**Bulk Download Authorization: NOT AUTHORIZED**