# AI-FX-Analyst Git引き継ぎ — 2026-10-08 JST

## 対象と監査
元PC: `/Users/tadanokenji/dev/ai-fx-analyst`（指定された大文字パスの実体）。branch `main`、監査開始HEAD `825bed7`、origin `git@github.com:KenjiTadano/AI-FX-Analyst.git`。
未コミット変更: README、backtest実装5ファイル、既存テスト2ファイル。新規: classified retryテスト1ファイル、Task116レポート17ファイル。本レポートもGit対象。変更はdurable journal/crash recovery、campaign cap/child preparation、classified-error retry foundationを含む。
既存tracked変更の `git diff --check` PASS。ステージ済み全差分では既存新規レポート `Task116-Campaign-Cap-Expansion-Foundation.md` の3・4行にMarkdown改行用の末尾スペース警告2件あり、原記録を保持。Git対象全ファイルに対するAWS access key、GitHub token、private key、代表的なsecret assignmentのパターン検査は検出0。5MiB超のGit対象ファイルおよびproduction state/DB/rawデータのGit登録も検出0。パターン検査は秘密不在の完全な証明ではない。秘密値の表示・転送は行っていない。

## ProductionはGitで移行されない
ローカル台帳を読み取り専用で確認: HEAD10/cap44/generation1、active=null、campaign `task116-usdjpy-20210108-20210207` STOPPED、Child1 STOPPED/ERROR、normal1/30、recovery0/5。ledger wrapper hash検証PASS。ledger hash `6ca217a2fff58ad802602cbfe6bbf774b1494c1fde2fbb6266ef1db169f86707`。
`tmp/dukascopy/s3-production`は44ファイル。retry-authorizations/retry-approvals/cap-revisions/retry-transitionsは存在しない。`Task116-Production-Retry-Cap-Amendment-Preparation.md`は存在せず、44→45準備完了は未確認。
現時点の独立監査manifest hashは `f1d4a619f503721d868ae2e991497e62827f78edaf0e5fc19947ae121067f65c`。定義: root相対パス順に `path:SHA256(file bytes)\n` を連結しSHA256。過去レポートのfingerprint `55332f...`とは算出方法が確定していないため直接比較しない。移行時はこの明示した方法で比較する。
AWS HEAD/GET、credential resolution、Production apply、retry、cap変更、承認作成は今回実施しない。コードのcloneだけでProductionを再開できると解釈しない。

## 未移行ローカル状態
- `.env.local`（610 bytes）: Git無視。移行先で必要な値を承認済みの秘密管理手段から別途設定する。
- AWS credentials/profile/session: 未転送・未解決。新PCで別途ログインが必要。credentialファイルをGitに入れない。
- `tmp/`全体: 88ファイル、6,715,727 bytes。production evidenceのほかpilot raw `tmp/dukascopy/s3-pilot/2025-01-06/USDJPY_2025-01-06_ticks.bi5`等。Git対象外。
- `supabase/.temp/`（11ファイル、27,414 bytes）、`.branches/`（1ファイル、4 bytes）: CLIローカル状態、未移行。
- node_modules/.next/test-results/playwright-report/tsbuildinfo: 再生成対象。ローカルDB拡張子db/sqlite/sqlite3は監査で検出なし。
- 対象リポジトリ外のDBや秘密ストアは監査対象外。

## 別PCのソース復元
```sh
git clone git@github.com:KenjiTadano/AI-FX-Analyst.git
cd AI-FX-Analyst
git checkout main
git pull --ff-only origin main
git status --short
git log -1 --oneline
npm ci
npm test
npm run test:e2e -- --workers=1 --reporter=dot
```
既存cloneの場合はcloneを省略し、ローカル変更を確認してからpullする。reset/clean/force pushは使用しない。今回のpush済みコミットIDと `git rev-parse HEAD`を照合する。Nodeは既存E2E記録のv22.23.2を基準にする。ブラウザ未導入なら `npx playwright install chromium`。検証はローカルfixture/mockを使い、live inventoryを起動しない。
E2Eの既存記録は362/362 PASS・4.9分。この引き継ぎでE2Eは再実行していない。今回の `npm test` は1,561/1,561 PASS、失敗0（約148秒）、legacy market検証もPASS。前後のProduction44ファイルはbyte hashが全件一致。

## Durable stateの別途移行案（未実施）
Production writerを旧PCで停止し、同時書き込みがないこととactive attempt/writer lockの状態を確認する。44ファイルを選別せずroot全体として暗号化したアーカイブにし、承認した経路で転送する。ledgerだけのコピーや新規初期化で代用しない。approval/snapshot/progress/journal/quarantine/released lock evidenceを保持する。
暗号鍵はアーカイブと別経路で管理し、リポジトリ・チャット・公開ストレージに入れない。この作業は別途承認してから行う。
移行先に既存production rootがあれば上書き/マージせず停止して確認する。空の対象rootへ復元し、ファイル数44、各ファイルbytesのhash、上記manifest hash、ledger wrapper hash、参照整合性、HEAD10/cap44/generation1、STOPPED/ERRORをオフラインで検証する。旧PCを唯一の原本として保持し、新PCで検証が完了するまで消去しない。
過去の承認の有効期限と現state bindingを再確認する。コピーした承認は新しい実行許可を意味しない。44→45 preparationの結果をレビューすることが次の工程であり、Production applyやretryは別途明示的承認が必要。
