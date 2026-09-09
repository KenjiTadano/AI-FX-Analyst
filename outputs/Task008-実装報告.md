# Task008 実装報告

実装日：2026-09-08。対象：`/Users/tadanokenji/dev/AI-FX-Analyst`。作業ブランチ：`feature/task008-supabase-auth`。コミット・pushは行っていません。

Supabase認証、設定・取引・AIスナップショットのクラウド保存、手動のlocalStorage移行を実装しました。既存パッケージを使用し、依存パッケージ追加はありません。

**実Supabaseへの接続は未確認です。** Supabase用環境変数が未設定で、ローカルDockerも停止していたため、migration適用、メール送信、実DBのRLS試験は実行していません。以下のテスト結果を実クラウドでの動作保証と読み替えないでください。

## 変更ファイル

パスはリポジトリルートからの相対パスです。

- 認証・SSR：`lib/supabase/config.ts`、`client.ts`、`server.ts`、ルートの`proxy.ts`、`app/auth/confirm/route.ts`、`app/login/page.tsx`、`app/signup/page.tsx`。
- 認証UI：`components/auth/provider.tsx`、`form.tsx`、`status.tsx`、`app/layout.tsx`。
- DB境界：`lib/supabase/database.types.ts`、`mappers.ts`、`cloud-repository.ts`。
- 設定：`lib/settings/defaults.json`、`components/settings/cloud-settings.tsx`、`components/dashboard/risk-management.tsx`。
- 取引・ダッシュボード：`components/dashboard/dashboard.tsx`、`components/trades/journal.tsx`、`trade-form.tsx`、`performance.tsx`、`lib/trades/migration.ts`、`app/globals.css`。
- DB構成：`supabase/config.toml`、`supabase/migrations/20260908000000_initial_cloud.sql`、`supabase/templates/confirmation.html`、`supabase/README.md`。
- テスト：`tests/supabase.test.ts`、`supabase/tests/database/ownership.test.sql`。
- 環境・除外設定：`.env.example`、`.gitignore`。
- 報告：`outputs/Task008-実装報告.md`。

Task003の市場取得、Task004のファンダメンタル取得、Task005のAI判定、Task006の計算ロジック、Task007の取引検証・損益計算・ローカルRepositoryの本体は変更していません。

## DB設計・migration

`profiles` はauth.usersに紐付くid、任意のdisplay_name、作成・更新日時を持ちます。`user_settings` は所有者、現在資産、目標資産、リスク率、取引単位、更新競合検知用version、日時を持ちます。

初期設定は50,000円／100,000円／1%／1,000通貨。クラウド設定はDBから取得し、未取得時に初期値を保存済みとして表示しません。コード側の初期値はJSONにまとめ、SQLの初期値との一致をテストしています。資産は0〜1兆円、目標は0.01〜1兆円、リスク率は0より大きく10%以下、取引単位は1〜1億の整数としました。

`trades` はTask007の取引項目、user_id、analysis_snapshot、移行元local_trade_id、version、作成・更新日時を保存します。UUIDの主キー、3通貨ペア、long/short、open/closed、正の数量・価格、決済日がエントリー日以降であること、OPEN/CLOSEDに必要な項目の整合性、数値範囲をDB制約で検査します。確定損益はDBでも売買方向から計算し、銭単位へ丸めます。

登録済みAIスナップショット、所有者、登録日時、移行元IDは更新トリガーで変更を拒否します。updated_atとversionもDBトリガーで更新します。ユーザー作成トリガーでprofileとsettingsを作り、migration適用時点の既存ユーザーにも補完します。ユーザー削除時は関連データをCASCADE削除する設計です。

indexはtrades(user_id)、(user_id, opened_at DESC)、(user_id, status)、CLOSED行の(user_id, closed_at DESC)。migrationはテーブル、制約、index、トリガー、RLS、移行RPCをまとめた再現可能なSQLです。

## RLS policy

3テーブルすべてでRLSを有効化。authenticated向けFOR ALL policyに、profilesは`auth.uid() = id`、settings/tradesは`auth.uid() = user_id`のUSINGとWITH CHECKを設定しました。SELECT・INSERT・UPDATE・DELETEすべてに所有者条件が適用されます。anon/PUBLICのテーブル権限も取り消しています。

ユーザー初期化トリガーだけがSECURITY DEFINERで、search_path固定・スキーマ修飾・外部実行権限の取り消しを行います。移行RPCはSECURITY INVOKERであり、RLSを迂回しません。フロントエンドの絞り込みだけには依存しません。

2ユーザーとanonを使うPostgreSQL検証を用意しましたが、**今回このSQLは未実行**です。接続後に`supabase test db`で確認してください。

## 認証フロー・SSR

新規登録はメールとパスワードによるsignUp、ログインはsignInWithPassword、ログアウトは現在のブラウザのsignOutです。証券会社の認証情報を入力しない旨を画面に明記しています。

Browser ClientとServer Clientを分離し、@supabase/ssrのCookieセッションを利用します。Next.js 16の`proxy.ts`でgetClaimsを呼び、更新Cookieをリクエストとレスポンスへ反映します。ブラウザの認証状態と各Repository操作ではgetUserでユーザーを確認します。getSession内のユーザー情報だけを認可に使っていません。

認証状態の変更時はアカウントに紐付くUIを切り替え、設定・取引コンポーネントをuserIdごとに再生成します。未ログインでは市場分析を表示し、設定・取引・成績にはログイン導線を表示します。

確認メールは現在のoriginの`/auth/confirm`へ戻り、token_hashをverifyOtpで検証。成功時はトップ、失敗時は`/login?error=confirmation`へ遷移します。任意の外部next URLは受け付けません。応答はno-store、確認ルートはno-referrerとしています。

ローカル用メールテンプレートを同梱しました。クラウドではSupabaseのConfirm signupテンプレートも同内容に設定する必要があります。Site URL、Redirect URLs、テンプレート、環境変数、migrationの手順は`supabase/README.md`に記載しました。

## Repository・DB ↔ Domain mapper

UIからSQLやSupabaseのクエリを直接組み立てず、CloudTradeRepositoryのload/create/update/remove/importTradesを使います。Task007のcreateTrade/editTradeと既存validation・集計処理を再利用しました。ローカルRepositoryは削除せず移行元の読み取りに利用します。

DBのsnake_caseとドメインのcamelCaseをmapperで変換。numericはnumberまたは通常の10進文字列を受け付け、空文字、NaN、Infinity、計算範囲外を拒否します。日時はISO形式へ正規化し、所有者とTrade全体を検証します。analysis_snapshotも既存の厳格なTypeScript検証を通します。

DB型はmigrationに沿った手書きの契約です。実DBからの自動生成は未実施で、接続後のCLI生成手順をREADMEに記載しています。

取得は500件ずつ、最大5,000件。登録・編集・決済・削除はDB成功応答の後だけ一覧を更新します。編集・削除と設定更新はversion条件を付け、別端末の変更を無言で上書きしません。競合時は再読込して編集し直す導線があります。

## localStorage移行・重複防止

未認証で旧ローカル記録を表示・編集するモードは残していません。アカウントごとのクラウド記録と混在させず、コピー先を利用者が判断できるようにするためです。ただし旧localStorageは削除も上書きもしていません。

ログイン後、同じブラウザ・originにある旧記録を検証し、未移行分があれば「クラウドへ移行」ボタンを表示します。共用端末では自分の記録であることを確認する案内を表示します。自動アップロードは行いません。

元の取引IDをlocal_trade_idとして残し、クラウド主キーは新しいUUIDにします。`UNIQUE(user_id, local_trade_id)`と`ON CONFLICT DO NOTHING`により、繰り返し操作でも同じ所有者の同じ元記録を二重登録しません。既存クラウド行は上書きしません。元IDがUUID以外だったケースにも対応します。

全件をTypeScriptで検証してから100件ずつ送ります。各バッチは原子的ですが、移行全体は複数バッチです。途中失敗時に成功済み分は残り、再試行時は重複を避けます。移行後に再取得し、元IDの存在を確認した後で完了表示を出します。成功・失敗のいずれでもローカル記録を残します。

壊れたJSON、未対応schemaVersion、不正Trade、不正snapshot、元ID重複は移行を止めます。保存済みフラグだけを根拠にしません。

## 設定同期・エラーハンドリング

設定4項目をログイン時に取得し、入力から600ms後に保存します。入力途中は「未保存」、通信中は「保存中」、応答確認後のみ「クラウド保存済み」です。失敗は明示し、再試行・クラウドから再読込できます。保存中は設定入力を一時的に無効にし、同一画面の保存順序を保ちます。

通信・認証・所有者・不正データ・競合エラーは画面で扱えるResultに変換します。DBエラーの詳細やトークンをそのまま画面・ログへ出しません。成功後の応答が失われた場合など、DBでは保存されていてもUIでは完了を確認できないケースは再読込を案内します。

Supabase障害・未設定は認証とクラウド領域の状態として表示し、市場データやAI分析の取得を巻き込まない構造です。

## セキュリティ

Service Roleは使用しません。公開設定にsb_secret_またはservice_roleのJWTを渡した場合は設定検証で拒否します。公開環境変数はビルドへ埋め込まれるため、そもそも秘密キーをNEXT_PUBLIC_に設定しないことが前提です。

`.env.example`には空欄と注意書きのみ追加しました。実際の`.env.local`と既存APIキーは変更していません。`.env.local`がGit除外対象であることを確認し、Supabase CLIの一時状態も除外しました。生成されたブラウザ用静的アセットに、設定済みの既存サーバーAPIキーの実値が含まれないことも検査しました。JWTや確認tokenのログ出力は追加していません。

証券会社のID・パスワード・暗証番号・API秘密鍵の保存項目、発注・自動売買・決済サービス連携は追加していません。

## 検証結果

- `npm run lint`：成功、警告・エラー0件。
- `npm test`：**123件成功、失敗0件、スキップ0件**。既存102件＋Task008追加21件。既存の市場データ検証スクリプトも成功。
- `npm run build`：成功。Next.js 16.3.4でTypeScript検査と本番ビルドを完了。環境のRosetta実行に関する警告のみあり、ビルドエラーはありません。
- `git diff --check`：成功。

追加テストはDB往復変換、numeric、不正Trade・snapshot、所有者、設定範囲・初期値一致、公開設定、ログイン／未ログイン、CRUD、競合、通信失敗、移行重複・破損・バッチ分割、処理中のユーザー変更、ページ分割取得を確認します。Repositoryテストは模擬通信、SQLのRLSに関する単体テストは静的契約検査です。実DBでの認可検証ではありません。

ブラウザの本番ビルドを390×844のスマートフォン幅と1280×900のPC幅で確認しました。USD/JPY・EUR/JPY・GBP/JPYの切り替え、未認証のトレード・成績、未設定のlogin/signup、無効な確認リンクからのエラー遷移を確認。スマホの確認画面に横方向のはみ出しはなく、ログイン画面も既存ダークテーマを維持しています。取得したブラウザコンソールに警告・エラーはありませんでした。

USD/JPY・EUR/JPYではレート表示を確認。GBP/JPYはTwelve Dataの利用上限メッセージとなり、画面全体が継続して表示されることを確認しました。GBP/JPYの実レート成功を今回確認したとはしていません。

## 実Supabase確認状況・未確認項目

実Supabaseで確認できた項目：**なし**。Supabase接続情報が未設定、Docker daemonに接続できないためです。CLI構成と検証SQLは追加していますが、migration・SQLテストは未実行です。

未確認：実プロジェクトでのsignup、確認メール送信・成功、login/logout、セッション更新・再読込・別端末、設定保存、取引CRUD、実localStorage移行、2ユーザー間のRLS、anon拒否、実DBのトリガー・制約、ネットワーク遮断時のブラウザ操作。READMEの受入手順で接続後に確認してください。

## 既知の制限・Task009への引き継ぎ

1. まずmigration適用、URL・メールテンプレート・公開キー設定、実RLS試験と2ユーザーの受入確認を行ってください。DB型もCLI生成結果との照合が必要です。
2. リアルタイム同期は未実装。他端末の更新は再読込で取得します。競合検出時は入力を見直して保存します。
3. 設定の入力直後や未保存状態でページを閉じると、その変更は残りません。保存済み表示を確認してください。
4. 5,000件を超える取引のページングUI・集計を今後検討してください。現状は一部のみで成績を表示せず取得エラーにします。
5. 移行後のクラウド行を削除しても元ローカル記録は残るため、再読込時に再び移行対象になる場合があります。削除履歴とローカル記録の整理・エクスポート操作は後続課題です。
6. 成績の資産推移は設定された資産を起点とする既存の参考計算です。証券口座残高や入出金との同期はありません。
7. 本番SMTP、メール送信制限、パスワードリセット、バックアップ・アカウント削除の運用整備は今後の作業です。

## 参照

SSRの構成は[Supabase公式Next.jsガイド](https://supabase.com/docs/guides/auth/server-side/creating-a-client?framework=nextjs)と、インストール済みNext.jsのProxyドキュメントを確認しました。DBの認可は[Supabase公式RLSガイド](https://supabase.com/docs/guides/database/postgres/row-level-security)、接続後のSQL試験は[公式ローカルテストガイド](https://supabase.com/docs/guides/local-development/testing/overview)に沿って用意しました。
