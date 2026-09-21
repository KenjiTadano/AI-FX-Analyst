# AI-FX-Analyst v1 Release Validation

対象ブランチ: `feature/task035-v1-release-validation`
起点: `6c35d91`（task34完了）。作業開始時の `git status` / `git diff` は空。
commit / push: していない。
Round 1 で `20260916210000` のみ `supabase db push --linked` 済み。既存 migration ファイルは書き換えていない。

## Release verdict

**PASS**

AI-FX-Analyst v1.0 Release Candidate

Round 1 の release blocker 2件（remote `exit_plan` migration、ライブ `invalid_response`）は解消済み。
Final Local Supabase Validation で Auth / 2ユーザー RLS / Trade CRUD / snapshot / exit_plan をローカル disposable 上で PASS。

本番 remote へ test user / test trade は作成していない。
Economic Calendar（EODHD `forbidden`）と OpenRouter 未設定は v1.1 / 非blocker のまま。

初回の FAIL 理由と Final Supabase（Docker 未起動時）の BLOCKED 記録は履歴として残す。最終判定は本節と **Final Local Supabase Validation**。


## Automated validation

初回（コード変更前）は Unit 1019 / E2E 332。Round 1 後の再計測は Final metrics。baseline は下げていない。

| 項目 | 初回 | Round 1 後 |
| --- | --- | --- |
| lint | PASS（exit 0） | PASS（exit 0） |
| Unit | PASS 1019 / fail 0 | PASS 1020 / fail 0 |
| E2E | PASS 332（mock。実APIではない） | PASS 332（port 3010 の `next dev`。mock。実APIではない） |
| build | PASS（Next.js 16.3.4） | PASS（修正後に再ビルド。compile warning なし） |
| git diff --check | PASS（作業ツリーは空だった） | PASS（exit 0） |

`next start` 時に Rosetta 2 の Node 警告が出た。アプリコードの warning ではない。

## Environment

`.env.local` は存在し、git 追跡は `.env.example` のみ。値は書いていない。

| 変数 | 状態 |
| --- | --- |
| TWELVE_DATA_API_KEY | configured |
| FINNHUB_API_KEY | configured |
| FRED_API_KEY | configured |
| AI_PROVIDER | missing（コード既定は openai） |
| OPENAI_API_KEY | configured |
| OPENAI_ANALYSIS_MODEL | missing（コード既定 `gpt-4.1-mini`） |
| OPENAI_CHART_MODEL | missing（テキストモデルへフォールバック。画像可扱い） |
| OPENROUTER_API_KEY | missing |
| OPENROUTER_MODEL | missing |
| OPENROUTER_CHART_MODEL | missing |
| OPENROUTER_BASE_URL | missing |
| NEXT_PUBLIC_SUPABASE_URL | configured |
| NEXT_PUBLIC_SUPABASE_ANON_KEY | configured |
| EODHD_API_TOKEN | configured |
| TRADING_ECONOMICS_API_KEY | missing |
| FINNHUB_CALENDAR_ENABLED | missing（`true` ではないのでカレンダー無効） |
| FINNHUB_CALENDAR_TIMEZONE | missing |
| EODHD_EUR_COUNTRY | missing |
| EODHD_CALENDAR_TIMEZONE | missing |
| AI_ANALYSIS_HOURLY_LIMIT / DAILY_LIMIT | missing（コード既定 20 / 100） |
| AI_VALIDATION_DEBUG | missing |
| SUPABASE_SERVICE_ROLE_KEY | missing |

実効 AI provider は OpenAI。テキスト / チャートの実効 model ID は `gpt-4.1-mini`。

## Real API validation

本番 `next start`（port 3000）の route 経由。秘密は出していない。

### AI provider — Round 1 で解消

初回（修正前の `next start` port 3000）:

- provider: openai（`AI_PROVIDER` 未設定）
- text model: `gpt-4.1-mini`
- `GET /api/analysis?pair=USD/JPY`: HTTP 200、`success=true`、`ai.status=error`、`ai.code=invalid_response`、`action=WAIT`、`directionSignal=buy`、`signal=wait`
- `GET /api/analysis?pair=EUR/JPY`: HTTP 200、`cached=false`、約 12.4s、同じく `invalid_response`、`action=WAIT`、`directionSignal=wait`
- 材料なしの `createOpenAI` 直接呼び出しは約 7.1s で schema 通過（factors 5）

原因と修正後の route smoke は Round 1。BUY/SELL を出す調整はしていない。

### chart model — PASS（OpenAI フォールバック）/ OpenRouter は BLOCKED

- `OPENROUTER_CHART_MODEL` は未設定。OpenRouter チャートは未実施。
- 実効モデル `gpt-4.1-mini` で `POST /api/chart-analysis` を 1x1 PNG で1回。HTTP 200、`ok=true`、schema 通過、`pair=USD/JPY`、`pairMismatch=false`、応答に画像 payload なし。
- 非チャート画像でも `trend=strong_up` が返った。売買品質の評価はしない。画像の永続化コードは route に無い。

### Twelve Data — PASS

3ペアとも `GET /api/market`。HTTP 200、価格は有限、stale なし、provider error なし。15m / 1h / 4h / daily の OHLC は有限。最終足時刻は 2026-09-21（daily は 2026-09-20）。ペア名はそのまま。反復取得は避け、GBP/JPY はアプリ内の分次上限を避けるため待ってから1回。

### Finnhub — PASS

`GET /api/fundamental?symbol=USD/JPY`。news `status=ok`、1件、`publishedAt=2026-09-21T03:48:12.000Z`。error ではない。空を中立にはしていない。UI も「価格への影響方向は未評価」。

### FRED — PASS

同一応答の macroeconomic `status=ok`、8系列。値は有限で 0 埋めではない。観測日あり。8件とも `stale=true`。UI に「観測日が古めです。最新速報として扱わないでください。」

### economic calendar — FAIL（v1.1。今回の主 blocker とは別）

チェーンはコード上 EODHD → Trading Economics → Finnhub calendar。今回有効なのは EODHD のみ（token configured、他は未設定または無効）。結果は `status=error`、`code=forbidden`、provider `EODHD`。UI は「契約プランに取得権限がありません」。偽カレンダーは作っていない。provider 変更はしていない。

## Supabase

### connection — PASS

anon key で REST に到達した。

### migration — Round 1 で解消（列の存在のみ）

適用前: remote は `20260908000000` と `20260911220000` のみ。`20260916210000` は local だけ。anon の `select=exit_plan` は HTTP 400、`42703 column trades.exit_plan does not exist`。

適用: dry-run の対象は `20260916210000_add_trade_exit_plan.sql` のみ。続けて `supabase db push --linked`。`db reset` / drop / truncate / schema 再作成はしていない。SQL ファイルは書き換えていない。

適用後の `supabase migration list --linked`:

| migration | local | remote |
| --- | --- | --- |
| 20260908000000 | あり | あり |
| 20260911220000 | あり | あり |
| 20260916210000 | あり | あり |

`trades.exit_plan` の読み取り確認:

- anon `GET /rest/v1/trades?select=id,exit_plan&limit=1` は HTTP 401、`42501 permission denied`。適用前の `42703`（列が無い）ではなくなった。行は返していない。
- OpenAPI `GET /rest/v1/` は HTTP 401 で schema 定義は返らなかった。これでは列の有無は判定できない。
- 接続済み project への read-only な `information_schema.columns` 照会は `column_name=exit_plan`、`data_type=jsonb`。trade 行は読んでいない。

認証付きの書き込み・更新はしていない。CRUD は BLOCKED のまま。

### auth — BLOCKED

ログイン可能なテストユーザーを用意していない。新規ユーザーは service role が無く削除できないため作っていない。未ログイン画面は「取引履歴を保存するにはログインしてください」。anon の `trades` / `profiles` は HTTP 401、`42501 permission denied`。signup / session restore / logout の実操作は未実施。

### RLS — BLOCKED

2ユーザーでの SELECT/INSERT/UPDATE/DELETE は未実施。mock と repo 内 `supabase/tests/database/ownership.test.sql` の存在だけでは PASS にしない。この SQL はローカル disposable DB 用で、今回は実行していない。service role は未設定。RLS bypass は追加していない。

### Trade CRUD — BLOCKED

実ユーザーが無いため CREATE/READ/UPDATE/CLOSE/DELETE のクラウド往復は未実施。

## Core workflow

実ブラウザ（`http://127.0.0.1:3000/`、未ログイン）と、mock E2E を分けて書く。

| 項目 | 実画面 | mock E2E |
| --- | --- | --- |
| Market | PASS。USD/JPY レートと 15m/1h/4h。MTF は中立/混在。Regime は「移行・不明瞭」で bullish 捏造なし | PASS（既存 suite） |
| Analysis | 初回画面は修正前サーバーで `AI status: error`。Round 1 の route smoke は schema PASS。修正後の画面操作はしていない | PASS |
| Daily Plan | 表示あり。Action WAIT。status は分析期限切れ（AI 失敗時の有効期限が短い既存動作）。Event Risk は不明。DLL 入力は未設定のまま | PASS |
| Readiness | 5項目のまま（AI分析 / AI方向 / Data Quality / Risk / Event Risk）。6個目は無い。2/5 | PASS |
| Trigger | 未ログインのこの表示では Entry 条件なし。「条件成立の自動判定はしていません」。GO / BUY NOW / ENTRY OK / 推奨は出ていない | PASS |
| Watch | この未ログイン操作では専用の追加 polling は観測していない。市場更新は既存60秒。新規 polling はコード追加していない | PASS |
| PreTrade | 実ログインが無く登録フローは未実施 | PASS |
| Entry Context / Journal / PostTrade / Performance | 未ログインでは「ログインしてください」。実データでの OPEN/CLOSED や成績は BLOCKED | PASS |

AI 失敗時の画面文言（実測）:

- `AI status: error`
- Action 表示は「今はエントリーしない」/ 計画の Action は WAIT
- 「Action の WAIT と AI status（unavailable / error）は別状態です。AI が WAIT と判断したわけではありません。」

「AIがWAITと判断した」という文は出ていない。

## Historical integrity

実クラウドの登録後書き換えは BLOCKED。列は Round 1 で存在するが、ログインユーザーでの書き込み往復はしていない。mock E2E と unit は PASS。実DBの snapshot 保全は PASS にしない。

## Exit Plan / R

Unit（`tests/exit-plan.test.ts` と `tests/performance-intelligence.test.ts`、全体 1019 に含まれる）:

- `R <= -1` → `r_le_minus_1`
- `-1 < R < 0` → `r_minus_1_to_0`
- `0 <= R < 1` → `r_0_to_1`（0R を含む）
- `1 <= R < 2` → `r_1_to_2`
- `R >= 2` → `r_ge_2`
- break-even 0R、負の R、planned R の表示テストあり

クラウド round-trip は BLOCKED。列は remote にある。認証付きの保存・読戻しはしていない。PASS にしない。

## Desktop

実画面 1280x900。`scrollWidth === clientWidth`（1265。スクロールバー分）。横オーバーフローなし。分析 / トレード / 成績ボタンは操作できた。トレードと成績はログイン要求。通貨ペアは USD/JPY のまま。コンソールの例外収集はしていない。エラーオーバーレイは出ていない。

mock E2E の 1280x900 overflow テストは PASS。

## Mobile

実画面 390x844。`scrollWidth === 390`、はみ出し要素なし。ナビボタン幅は 分析 60 / チャート読取 112 / トレード 86 / 成績 60。ペア表示は USD/JPY。

mock E2E の 390x844 は PASS。ログイン後の Journal / Performance の実機操作は BLOCKED。

## Accessibility

実画面のスモークのみ。

- ナビボタンに名前があり、クリック後に focused / current
- h1 → h2 → h3 → h4
- 市場・カレンダー・AI は status テキストがある
- 上昇/下降は色だけでなく「中立」などの文字がある
- details の「分析の詳細」「概要・関連性を見る」がある
- 同じ名前の「指標」ボタンが複数ある（軽微。blocker ではない）
- 全キーボード順の監査はしていない

## Security

- `.env.local` は未追跡
- ソースの `sk-` はテスト用の偽文字列のみ。実キーの hard-code は見当たらない
- `console.log` は `tests/market.mjs` の PASS 行のみ
- TODO / FIXME は無し
- service role は未設定。client へ出していない
- 報告書・コマンド要約に API key は出していない
- anon は trades を読めない（42501）
- 2ユーザー RLS は未証明

## Release blockers

Round 1 で解消:

1. `20260916210000` を remote に適用し、`trades.exit_plan`（jsonb）の存在を確認した。
2. ライブ材料の `/api/analysis` は USD/JPY と EUR/JPY で schema を通過した（`ai.status=available`）。

残っているのは blocker ではなく、未検証または v1.1。

次は blocker ではない。

- EODHD カレンダー 403
- OpenRouter 未設定
- 実ログイン / 2ユーザー RLS / クラウド CRUD 未実施
- 1x1 画像でもチャート trend が付く
- Rosetta 警告

## Non-blocking known limitations

- AI 未取得時の Action WAIT は既存 semantic。画面上は AI status と分けている。
- 日次計画は「AI方向は上方向ですが、現在のActionはWAITです」。AI が error でも direction はテクニカルスコア由来になり得る。
- AI 失敗時の分析有効期限は約60秒で、すぐ「分析期限切れ」になる。
- ニュースはこの実行では1件。失敗扱いはしていない。
- FRED 8系列はすべて stale 表示。
- 市場環境（sentiment）は未接続で、中立補完をしていない。
- チャート画像はアプリに保存しない、と画面に書いてある。
- 単一プロセスの cache / 分8回の Twelve ガードは複数インスタンスでは共有されない。

## v1.1 backlog

今回は実装していない。

- economic indicator / calendar provider の差し替え（今回 EODHD は forbidden）
- individual timeframe performance
- SMA/RSI performance buckets
- independent MTF persistence
- explicit snapshot replacement
- broader notification / watch UX
- historical backfill
- partial / multi-exit R
- fees / swap / spread を含む money-R

## Changed files

- `lib/ai/openai.ts`（Round 1: factor coalesce に MTF/regime）
- `tests/ai.test.ts`（Round 1: 回帰1件）
- `supabase/config.toml`（ローカルポートを 5532x 系へ。remote は未変更）
- `eslint.config.mjs`（`supabase/.temp/**` を ignore）
- `outputs/Task035-v1-Release-Validation.md`

## Final metrics

| 項目 | 値 |
| --- | --- |
| lint | PASS（exit 0） |
| Unit | 1020 pass / 0 fail（初回 1019 + 1） |
| E2E | 332 pass（mock。port 3010） |
| build | PASS |
| git diff --check | PASS（exit 0） |
| 外部API | 既存 provider。新規 provider 0。テキスト分析を修正後サーバーで再smoke |
| Supabase | remote: exit_plan migration 適用済み。local disposable: Auth/RLS/CRUD/snapshot/exit_plan PASS 後 cleanup。remote へ test 書き込み 0 |
| polling 追加 | 0 |
| migration ファイルの書き換え | 0 |
| Release verdict | PASS（v1.0 Release Candidate） |

Final Local Supabase Validation 完了後の verdict。OpenRouter と EODHD は blocker にしていない。

## Round 1 — blocker fix

commit / push はしていない。新機能と v1.1 は実装していない。

### BLOCKER 1 — exit_plan migration

SQL 再監査（`supabase/migrations/20260916210000_add_trade_exit_plan.sql`、未変更）:

- `DELETE` / `DROP` / `TRUNCATE` は無い
- 既存 Trade 行を消す文は無い。`exit_plan` は nullable jsonb の追加で、既存行は NULL のまま
- `check_trade` は UPDATE 時に `exit_plan` も凍結する。RLS policy は変えていない
- `import_local_trades` は `exit_plan` を含める。`security invoker`、`auth.uid()`、conflict は do nothing、public/anon は revoke、authenticated のみ grant
- 既存 migration は書き換えていない

適用前後は上の migration 節。remote の3版は local と一致。`trades.exit_plan` は jsonb として存在する。

### BLOCKER 2 — live invalid_response

診断（`AI_VALIDATION_DEBUG=1`。出したものは field code のみ）:

- ライブ材料の失敗コードは `factor_1_duplicate_category:technical`
- OpenAI の JSON schema は factor 5件を要求できるが、category の一意までは要求できない
- テキスト route の材料には `technical:mtf` と `technical:regime` がある。チャート画像は付かない
- モデルは schema 上は通る5件を返すが、そのうち2件が `technical` で、別 category が欠ける
- アプリの `interpretationFailureReason` がその重複を拒否する
- 区別: OpenAI の structured output は期待どおりの一意 category ではない。HTTP 失敗ではない。アプリ validator が、schema では表現できない一意制約で落ちていた
- 材料なしの直接呼び出しは MTF / regime evidence が無く、重複 `technical` が出ないため schema PASS だった
- 既存の coalesce は `technical:chart_image` があるときだけ動いていた

修正:

- coalesce の入口だけを `technical:chart_image` / `technical:mtf` / `technical:regime` のいずれがある場合に広げた
- 5件、重複が technical だけ、欠けた category 数と余分な technical 数が一致するときだけ統合する
- 欠けた category は direction `unknown`、evidence 空。方向は作らない
- その後も従来の `interpretationFailureReason` を通す。重複のまま成功にはしない
- prompt と enum は変えていない。BUY/SELL 誘導はしていない

追加 test:

- `live MTF and regime evidence coalesces a duplicate technical factor without inventing direction`
- 生のオブジェクトは `factor_1_duplicate_category:technical`
- `validateInterpretation` 後は category 5種が1つずつ。欠けた `market_environment` は `unknown` かつ evidence 空。technical は `technical:mtf` を保持。`action` フィールドは無い
- split evidence を外した既存ケースは、これまでどおり throw する

### AI smoke（修正後の `next start`、port 3020）

port 3000 は修正前ビルドのままなので使っていない。秘密と本文は出していない。model は `gpt-4.1-mini`。成功時の status はコード上 `available`（`ok` という値は無い）。

USD/JPY（キャッシュなし、1回）:

- HTTP 200、`success=true`、`cached=false`、11844ms
- `ai.status=available`、`ai.code=null`
- `action=WAIT`、`directionSignal=buy`、`signal=wait`
- サーバーログに `invalid_response` は出ていない

EUR/JPY:

- USD/JPY の直後の1回は HTTP 200、`success=true`、`cached=false`、365ms、`ai.status=unavailable`、`ai.code=insufficient_data`。OpenAI には到達していない。直前の市場取得が単一プロセスの分次上限に当たったためで、schema 失敗ではない
- 上限と失敗キャッシュ（約60秒）の後の再実行: HTTP 200、`success=true`、`cached=false`、8734ms、`ai.status=available`、`ai.code=null`、`action=WAIT`、`directionSignal=wait`、`signal=wait`
- この再実行が EUR/JPY の schema smoke。`invalid_response` ログは無い

Direction / Action の良し悪しは評価していない。

### まだ BLOCKED

安全なテストユーザーが無い。本番ユーザーは作っていない。

- Auth（signup / login / session / logout）
- 2ユーザー RLS
- Cloud Trade CRUD
- historical snapshot のクラウド往復
- `exit_plan` のクラウド書き込み往復

anon が trades を読めないこと（42501）は、2ユーザー RLS の PASS ではない。

### まだ FAIL

- economic calendar: EODHD `status=error` / `code=forbidden`。v1.1。provider は変えていない。

## Final Supabase Validation

目的: Round 1 後に残った Auth / RLS / Cloud CRUD / snapshot / exit_plan を安全に実環境検証する。
新機能・AI ロジック変更・migration 追加・commit / push はしていない。RLS 無効化・service role の client 追加・本番ユーザーの勝手作成はしていない。

### Auth 構成監査（コード + config）

| 項目 | 結果 |
| --- | --- |
| signup | `components/auth/form.tsx` が `signUp`。`emailRedirectTo` は origin の `/auth/confirm` |
| login | 同 form が `signInWithPassword` |
| logout | `components/auth/status.tsx` が `signOut({ scope: "local" })` |
| session restore | `components/auth/provider.tsx` が `getUser` + `onAuthStateChange` |
| auth callback | `app/auth/confirm/route.ts` → `confirmEmail`（`token_hash` の `verifyOtp` または `code` の `exchangeCodeForSession`） |
| email confirmation | ローカル `supabase/config.toml` は `[auth.email] enable_confirmations = true`。クラウド側も README は確認メール有効を前提。アプリは session 無し signup で確認メール待ちメッセージを出す |
| profiles | migration の Auth trigger が `auth.users` 挿入時に `profiles` / `user_settings` を作成 |
| trades.user_id | `auth.users(id)` への FK。`on delete cascade`。RLS policy `trades_owner` は `auth.uid() = user_id` |
| RLS | profiles / user_settings / trades とも owner のみ。anon は revoke。`import_local_trades` は security invoker |
| account deletion | UI / API のアカウント削除機能は無い。README も「削除機能は追加しません」 |
| disposable 削除手段 | `SUPABASE_SERVICE_ROLE_KEY` は `.env.example` にも `.env.local` にも無い。admin delete の既存手段なし |

### 安全なテストユーザー戦略

優先順の結果:

| 優先 | 手段 | 結果 |
| --- | --- | --- |
| A | 既存の disposable / test Supabase 環境 | 無し。linked は本番相当の共有 remote のみ |
| B | ローカル CLI（`supabase start` + Inbucket + `supabase test db`） | **不可**。Docker Desktop はインストール済みだが daemon が起動しない（`docker desktop start` / `open -a Docker` 後も `Cannot connect to the Docker daemon`）。`supabase status` も Docker 依存で失敗。local Auth / ownership.test.sql は未実行 |
| C | 既存の安全な実ユーザー / test user | 利用可能な資格情報なし。本番ユーザーの流用はしていない |
| D | temporary user を作って検証後削除 | **不可**。アカウント削除 UI 無し、service role 無し。本番に削除不能ユーザーを残す作成は禁止どおり実施していない |

結論: 安全な User A / User B を用意できない。推測でのユーザー作成はしていない。

### 項目判定

| 項目 | 判定 | 根拠 |
| --- | --- | --- |
| environment used | BLOCKED | 使える disposable 環境が無い。linked remote への一時ユーザー作成は削除不能のため未実施 |
| Auth | BLOCKED | signup / login / session / logout / 再 login の実操作未実施。email confirmation を完了する安全経路が無い |
| User A own CRUD | BLOCKED | 認証ユーザー無し |
| User B own CRUD | BLOCKED | 同上 |
| A → B RLS | BLOCKED | 2ユーザー無し。anon の 42501 は 2ユーザー RLS の代替にしない。`ownership.test.sql` は local disposable 専用で、本番には流していない |
| B → A RLS | BLOCKED | 同上 |
| snapshot round-trip | BLOCKED | クラウドへの認証付き保存・読戻し未実施 |
| exit_plan round-trip | BLOCKED | 列は remote に存在するが、exit_plan 付き Trade の認証付き INSERT / SELECT は未実施 |
| exit_plan immutability | BLOCKED | DB trigger の SQL 監査は Round 1 済み。認証セッションでの書き換え拒否の実測は未実施 |
| cleanup | PASS | temporary user / test trade を作成していない。削除漏れなし。Docker 起動試行のみでコンテナは立ち上がっていない |
| authenticated desktop | BLOCKED | ログイン不可のため Trade / Journal / Performance の実ブラウザ操作未実施 |
| authenticated mobile | BLOCKED | 同上。未ログインの overflow は初回 Task035 で確認済みだが、本項目の代替にはしない |

### 実施しなかったこと（意図的）

- 本番への test user 作成
- service role の生成・要求・client 追加
- RLS 無効化
- linked remote への `ownership.test.sql` 実行
- `db reset` / drop / truncate
- OpenRouter / EODHD calendar の変更
- AI ロジック変更

### Final Supabase Round 後の自動化（コード変更なし）

| 項目 | 結果 |
| --- | --- |
| lint | PASS（exit 0） |
| Unit | PASS 1020 / fail 0 |
| E2E | PASS 332（mock。port 3010） |
| build | PASS |
| git diff --check | PASS（exit 0） |

当時は Auth / RLS / Cloud CRUD が BLOCKED のため verdict も BLOCKED。その後ローカル Supabase が起動し、下の **Final Local Supabase Validation** で解消した。

## Final Local Supabase Validation

対象: AI-FX-Analyst ローカル disposable のみ（API `http://127.0.0.1:55321`、DB `55322`）。
UCHINOCO（5432x）は停止・変更していない。linked remote へ test user / test trade / ownership test は送っていない。
RLS 無効化なし。通常 CRUD に service role は未使用（cleanup の `auth.admin.deleteUser` のみ local）。
migration / AI ロジック変更なし。commit / push なし。

### config.toml（ローカルポート。恒久化は未判断）

UCHINOCO 競合回避のためローカルだけ変更。勝手に戻していない。

| 項目 | 旧 | 新 |
| --- | --- | --- |
| api | 54321 | 55321 |
| db | 54322 | 55322 |
| shadow_port | 54320 | 55320 |
| studio | 54323 | 55323 |
| inbucket | 54324 | 55324 |
| analytics | （既定 54327） | 55327 |

### 項目判定

| 項目 | 判定 | 根拠 |
| --- | --- | --- |
| local environment | PASS | `supabase status` の API/DB が 5532x。コンテナ名 `*_ai-fx-analyst` |
| migrations | PASS | local list に 20260908000000 / 20260911220000 / 20260916210000。`trades.exit_plan` は jsonb NULL可 |
| Auth User A | PASS | signup → メール確認（Mailpit）→ session → logout → login again → getUser restore。`@example.invalid` |
| Auth User B | PASS | 同上 |
| profiles/user_settings trigger | PASS | 両ユーザーに profiles / user_settings。A から B の SELECT/UPDATE は 0 rows |
| User A CRUD | PASS | CREATE / READ / UPDATE / CLOSE / DELETE |
| User B CRUD | PASS | 同上 |
| A → B RLS | PASS | SELECT 0件、UPDATE/DELETE 0件、`user_id=B` INSERT 拒否。B の行は不変 |
| B → A RLS | PASS | 逆方向も同様 |
| snapshot round-trip | PASS | analysis_snapshot に AI / preTrade / MTF / regime を保存し read back で一致 |
| snapshot immutability | PASS | CLOSE 後も snapshot 不変。書き換え UPDATE は拒否または不変 |
| exit_plan round-trip | PASS | TradeExitPlan v1 の指定フィールドが保存・復元 |
| exit_plan immutability | PASS | UPDATE が `Trade ownership, registration snapshot and exit plan are immutable` で拒否 |
| cleanup | PASS | local trades 削除。local users を admin delete。remote 未操作 |
| automated regression | PASS | lint / Unit 1020 / E2E 332 / build / `git diff --check`（最終値は Final metrics） |

補足: `eslint.config.mjs` に `supabase/.temp/**` を ignore 追加。`supabase start` の生成物が lint に入らないようにしただけ。アプリ logic ではない。

### まだ FAIL（非blocker）

- economic calendar: EODHD `forbidden`（v1.1）
- OpenRouter 未設定（非blocker）
