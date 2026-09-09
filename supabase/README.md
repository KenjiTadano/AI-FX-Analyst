# Task008 Supabaseセットアップ

既存のパッケージを使用。サービスロールキーは不要です。この手順はDB・認証の接続後に実行してください。今回の実装時点ではリモート接続およびSQL実行を確認していません。

## クラウドプロジェクト

1. Supabaseプロジェクトを用意し、CLIで `supabase login` → `supabase link --project-ref <project-ref>` を実行します。認証情報をファイルやコマンド履歴へ直書きしないでください。
2. 接続先を確認し、`supabase db push --dry-run` で対象を確認後、`supabase db push` で `migrations/20260908000000_initial_cloud.sql` を適用します。既存テーブルのある別用途プロジェクトでは実行しないでください。
3. `.env.local` に `NEXT_PUBLIC_SUPABASE_URL` と `NEXT_PUBLIC_SUPABASE_ANON_KEY` を設定します。後者はanonキーまたはpublishableキーです。Service Role / `sb_secret_` は設定しません。既存APIキーは変更不要です。
4. Supabase Authでメール確認を有効にし、URL ConfigurationのSite URLを本番origin（開発時は `http://localhost:3000`）へ設定。Redirect URLsに `http://localhost:3000/auth/confirm`、必要な開発origin、`https://<本番ホスト>/auth/confirm` を個別追加します。本番に広いワイルドカードを設定しないでください。
5. Auth → Email Templates → Confirm signupの本文を `templates/confirmation.html` に合わせます。リンクは `{{ .RedirectTo }}?token_hash={{ .TokenHash }}&amp;type=email&amp;next=/`。標準のConfirmationURLも利用できます（PKCE codeをセッションへ交換）。別ブラウザ等で交換できない場合はログインへ案内します。token_hash方式は登録元のPKCE cookieに依存しません。signup側は現在originの `/auth/confirm` をemailRedirectToに指定します。
6. 本番のメール送信はSMTP設定・送信上限を確認します。メールスキャナー等による使用済みリンクはログイン画面で失敗を表示します。確認メールのURLやJWTをログへ保存しないでください。
7. 環境変数設定後にアプリを再ビルド・再起動し、新規登録→メール確認→ログイン→再読込→ログアウトを確認します。

## ローカルCLI検証

Dockerを起動してから、リポジトリルートで `supabase start`。新規ローカル環境へmigrationが適用されます。既存のローカルデータを保つには `supabase migration up --local` を使用し、リセットは不要です。

`supabase test db` で `tests/database/ownership.test.sql` を実行します。テストはトランザクション内の架空ユーザー2名を用い、最後にロールバックします。**共有・本番DBにはテストを直接流さないでください。** ローカル検証にも接続情報を `.env.local` に設定します。メール確認はローカルメールUI（54324）を利用します。接続キーを報告書やGitへ貼り付けないでください。

## 型の更新

現状の `lib/supabase/database.types.ts` はmigrationに合わせた型定義で、DBからの自動生成ではありません。接続後 `supabase gen types typescript --local > /tmp/task008-database.types.ts`（クラウドは `--linked`）で生成し、差分確認後に反映してください。`TradeRow` 等の別名を生成型から導く形へ保ち、mapper・lint・build・testを再実行します。

## 接続後の受入確認

- ユーザーAで設定4項目を変更し、再読込・別ブラウザで同じ値を確認。
- 各通貨ペアで登録→編集→決済→削除。AIスナップショットが現在のAIに上書きされないことを確認。
- ユーザーBからAのprofiles/settings/tradesのSELECT・INSERT・UPDATE・DELETEを直接APIでも拒否／非表示とすることを確認。未認証でもアクセス不可を確認。
- Task007を使用した**同じorigin・ブラウザ**でログインし、移行ボタンでコピー。再実行・途中失敗後の再試行で重複しないこと、元localStorageが残ることを確認。
- 通信遮断時に保存失敗を表示し、保存済み扱いしないことを確認。
- 同時編集はversionで競合を検出。競合時は再読込してから編集し直します。

## データ境界と制限

初期設定はDBから取得し、仮の初期値をクラウド保存済みとして表示しません。コード側のデフォルトは `lib/settings/defaults.json` に集約し、SQLとテストで一致を検査します。

資金設定は入力から600ms後に保存。入力途中・失敗時は未保存表示、ページ離脱前に保存済み表示を確認してください。リアルタイム同期はありません。他端末の変更は再読込で取得します。

取引取得は500件ずつ、最大5,000件。上限を超える場合は一部だけを成績として表示せず取得失敗とします。移行は100件単位のトランザクションで、全体失敗でも成功済みバッチは残ります。再試行時は所有者と元IDのユニーク制約で重複を防ぎ、既存行を上書きしません。

旧localStorageは未認証では表示・編集せず、ログイン後に利用者自身がコピー先を確認します。削除機能は追加しません。移行後にクラウド行を削除しても旧ローカル行は残るため、再読込すると再び移行対象に出ることがあります。削除履歴（tombstone）と移行元の片付けは後続課題です。

ユーザー設定削除のUIはありません。直接DB/APIで自分の設定行を削除した場合、取得エラーとなり、自動再作成しません。

## 参照した公式資料

- [Supabase SSR / Next.jsクライアントとProxy](https://supabase.com/docs/guides/auth/server-side/creating-a-client?framework=nextjs)
- [メールテンプレート](https://supabase.com/docs/guides/auth/auth-email-templates)
- [RLS](https://supabase.com/docs/guides/database/postgres/row-level-security)
- [ローカルDBテスト](https://supabase.com/docs/guides/local-development/testing/overview)
