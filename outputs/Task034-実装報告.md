# Task034 実装報告 — Production Readiness

対象ブランチ: `feature/task034-production-readiness`  
起点コミット: `fd1040c`（「３４完了」。本Taskの変更はその上の未コミット差分）  
commit / push: 実施していない  
本番DBへの migration 実行: していない

検証コマンドはすべて成功した。未解消のリスクが残るため、本報告では Production Ready とは断定しない。

## 実測（最終レビュー後）

| 項目 | 結果 |
| --- | --- |
| Unit | **1019 pass / 0 fail**（baseline 1010 + 9） |
| E2E | **332 passed**（baseline 329 + 3） |
| lint | PASS（exit 0） |
| build | PASS（Next.js 16.3.4 / Turbopack。Compiled successfully。warning 行なし） |
| git diff --check | PASS（exit 0） |
| 外部API追加 | 0 |
| Supabase query 追加 | 0 |
| polling 追加 | 0 |
| migration 追加 | 0 |
| 自動 retry 追加 | 0 |

## 最終レビューで追加した修正

### 1. provider-aware 未設定メッセージ

- `aiMessage(code, provider)`（`lib/ai/engine.ts`）
- `chartNotConfiguredMessage(provider)`（`lib/chart-analysis/types.ts`）
- OpenAI: 「OpenAI API設定が不足しています…」
- OpenRouter: 「OpenRouter API設定が不足しています…」
- env 変数名（`OPENAI_API_KEY` 等）と secret 値は UI に出さない
- `createAnalysisService` / chart service に `provider` を配線

### 2. Chart AI の Retry-After 保持

- `ChartVisionError` に optional `detail` を追加
- HTTP 非OK時に `http_401` / `http_402` / `http_408` / `http_429` / `http_N` と、秒数として妥当な `Retry-After` を `detail` に保持（例: `http_402:retry_after_45`）
- `ChartAnalysisResponse.error.detail` へ伝播
- **自動 retry / 新規 polling は追加していない**（fetcher は1回）

### 3. AI unavailable/error と Action WAIT の区別

- **semantic は変更していない**: AI unavailable/error 時の Action WAIT（既存 `finalizeAnalysis`）はそのまま
- UI のみ最小修正:
  - `data-testid="ai-status"` で `unavailable` / `error` を Action と別に表示
  - AI 未取得時の WAIT 脚注を「AI が WAIT と判断したわけではない」と明示（`data-testid="ai-wait-footnote"`）
  - fallback 注記（`data-testid="ai-fallback-note"`）でも暫定扱いであることを明示
- Unit: Action=`WAIT` と `ai.status=unavailable` が同時に存在するが、summary は「AI統合は未取得」であり「AIがWAITと判断」ではないことを確認
- E2E: API unavailable 時、日次計画 status は「未取得」、BUY/SELL にならない、「AIがWAITと判断」文言が無い

## 監査対象

- `package.json` / lockfile 方針（依存は既存のまま）
- `.env.example` / `.gitignore`
- `app/api/analysis` `app/api/chart-analysis` `app/api/market` `app/api/fundamental`
- `lib/ai/**` `lib/chart-analysis/**` `lib/market/**` `lib/fundamental/**` `lib/economic-calendar/**`
- `proxy.ts` / Supabase client・RLS・migrations
- Trade repository（localStorage）と既存 persistence
- fetch timeout / cache / 既存テスト

新機能（新シグナル、新指標、新成績、新判定、新経済プロバイダ、新polling、新DB機能）は追加していない。

## AI provider 現状

OpenAI SDK パッケージは無い。呼び出しは `fetch` のみ。

| 経路 | ファイル | 既定 |
| --- | --- | --- |
| テキスト総合分析 | `lib/ai/openai.ts` `createOpenAI` | `https://api.openai.com/v1/responses` |
| チャート画像 | `lib/chart-analysis/openai-vision.ts` `createChartVision` | 同上 |
| 配線 | `lib/ai/client.ts` / `lib/chart-analysis/client.ts` | `lib/ai/provider.ts` の解決結果を渡す |

OpenAI 直接呼び出しは残している。`AI_PROVIDER` 未設定または `openai` のとき、URL は従来の Responses API、モデル未指定時のみ `gpt-4.1-mini`。既存テストがこの URL を固定しているため削除していない。

## OpenRouter 対応

`lib/ai/provider.ts` が server-only 境界。

- `AI_PROVIDER=openrouter` のときだけ OpenRouter
- API key: `OPENROUTER_API_KEY`
- テキストモデル: `OPENROUTER_MODEL`（空なら `enabled=false`。モデルIDはコードに無い）
- チャートモデル: `OPENROUTER_CHART_MODEL`（空なら `imageCapable=false` かつ `enabled=false`）
- base: `OPENROUTER_BASE_URL` または `https://openrouter.ai/api/v1`
- transport: `chat` → `{base}/chat/completions`
- OpenAI: transport `responses`、key `OPENAI_API_KEY`、モデル `OPENAI_ANALYSIS_MODEL`

`NEXT_PUBLIC_` には載せていない。client bundle へ key を出していない（`lib/ai/client.ts` と `lib/chart-analysis/client.ts` は `server-only`）。

Gemini 2.5 Flash や `openrouter/free` は仮定していない。パーサはモデル名を見ない。Responses の `output[].content[].output_text` と Chat の `choices[0].message.content` だけを読む。

## 画像モデル

`imageCapable === false` のとき `createChartVision` は fetch せず `ChartVisionError("openai_unavailable")`。結果は作らない。  
OpenRouter で画像分析するには `OPENROUTER_CHART_MODEL` が必要。テキスト用モデルが画像対応かは実行時に問い合わせない。未設定を非対応として扱う。

## structured output

- テキスト: JSON schema（Responses は `text.format`、Chat は `response_format.json_schema`）。`stripFence` のあと `JSON.parse` → 既存 `validateInterpretation`。不正は `invalid_response`。信号にはしない。
- チャート: 同様の schema。パース失敗は `invalid_ai_response`。チャート経路は fence 除去をしない。fence 付きは不正応答として捨てる（捏造しない）。
- サイズ上限: テキスト 25_000 文字。超えたら `invalid_response`。

## timeout / retry / HTTP

| 経路 | timeout | retry |
| --- | --- | --- |
| テキストAI | 25s（`AbortSignal.timeout`） | 0。fetcher は1回 |
| チャートAI | 45s | 0 |
| クライアント分析 fetch | 45s | 既存の60秒再取得は維持。新規pollingなし |
| クライアントチャート fetch | 60s | 同上 |
| クライアント市場 fetch | 20s（Task034追加。既存60秒更新は維持） | なし |
| Twelve Data | 12s | なし。429 は `blockedUntil` +60s |
| Finnhub / FRED / EODHD / Trading Economics | 10s | なし |
| クライアント材料 fetch | 25s | 既存60秒 |

分類（`classifyProviderHttp`）:

- 429 → `rate_limited`
- 408 → `timeout`
- 401 → `api_error` / `http_401`
- 402 → `api_error` / `http_402`
- その他 → `api_error` / `http_N`

`Retry-After` は秒数かつ 0〜86400 の有限値だけ認識する。テキスト・チャート双方の失敗 `detail` に `retry_after_N` を付けられる。自動再送はしない。

402 / `in_flight_budget_exhausted` 相当は `api_error`（チャートは `openai_unavailable`）で1回で終わる。連打再送ループは無い。

## AI失敗と WAIT（semantic 維持）

AI失敗は `ai.status` が `unavailable` または `error`。解釈JSONは作らない。

既存 `finalizeAnalysis` は、AIが無いとき決定理由にエラー文を足し、総合 `action` を `WAIT` にする。これは Task034 で足した判定ではない。deterministic 側の既存動作であり、AIの BUY/SELL/WAIT を捏造してはいない。

UI では Action と AI status を別表示し、「AIがWAITと判断した」誤認を避ける注記を出した。semantic 自体は変更していない。

## Twelve Data / Finnhub / FRED / cache

前回報告と同じ。TTL短縮なし、空ニュースを中立にしない、FRED欠損を0埋めしない、stale は stale として表示。経済プロバイダ差し替えなし。

## Supabase / RLS / Task031

- service_role / `sb_secret_` を client に出さない（既存検証維持）
- `proxy.ts` の `getClaims` 失敗は公開ページ続行（既存方針）。DB は RLS
- migration `20260916210000_add_trade_exit_plan.sql` はリポジトリにある。本番適用はしていない

## env（値は書かない）

| 名前 | 区分 |
| --- | --- |
| `TWELVE_DATA_API_KEY` | 市場を使うなら REQUIRED |
| `FINNHUB_API_KEY` | ニュースを使うなら REQUIRED |
| `FRED_API_KEY` | マクロを使うなら REQUIRED |
| `OPENAI_API_KEY` | 既定プロバイダ openai なら REQUIRED |
| `OPENAI_ANALYSIS_MODEL` | OPTIONAL（空なら `gpt-4.1-mini`） |
| `OPENAI_CHART_MODEL` | OPTIONAL |
| `AI_PROVIDER` | OPTIONAL（既定 openai） |
| `OPENROUTER_API_KEY` | openrouter なら REQUIRED |
| `OPENROUTER_MODEL` | openrouter テキストなら REQUIRED。空だと無効 |
| `OPENROUTER_CHART_MODEL` | openrouter 画像なら REQUIRED。空だと画像呼び出ししない |
| `OPENROUTER_BASE_URL` | OPTIONAL |
| `AI_ANALYSIS_HOURLY_LIMIT` `AI_ANALYSIS_DAILY_LIMIT` | OPTIONAL |
| `FINNHUB_CALENDAR_ENABLED` `FINNHUB_CALENDAR_TIMEZONE` | OPTIONAL |
| `TRADING_ECONOMICS_API_KEY` | OPTIONAL |
| `EODHD_API_TOKEN` `EODHD_EUR_COUNTRY` `EODHD_CALENDAR_TIMEZONE` | OPTIONAL |
| `NEXT_PUBLIC_SUPABASE_URL` `NEXT_PUBLIC_SUPABASE_ANON_KEY` | クラウド同期なら REQUIRED。秘密ではない公開鍵のみ |
| `AI_VALIDATION_DEBUG` | OPTIONAL。`.env.example` に無い。production で `1` のとき検証コードだけ console.warn |
| `NODE_ENV` `CI` `E2E_PORT` `PORT` `PLAYWRIGHT_BASE_URL` | 実行環境。アプリ秘密ではない |

LEGACY: OpenAI 経路（`OPENAI_*` と Responses URL）。git 追跡 env は `.env.example` のみ。

## secret / logging

- ソースに API key の実値は無い
- 本番ログで残しているのは条件付き `console.warn("[ai] invalid_response", …)`（フィールドコードのみ）
- 402/429 テストは detail にキー文字列が含まれないことを確認
- FRED だけ query に key が付く（プロバイダ仕様）

## 変更ファイル（最終）

- `lib/ai/provider.ts`（新規）
- `lib/ai/openai.ts` `lib/ai/client.ts` `lib/ai/engine.ts` `lib/ai/service.ts` `lib/ai/decision-ui.ts`
- `lib/chart-analysis/openai-vision.ts` `lib/chart-analysis/client.ts` `lib/chart-analysis/service.ts` `lib/chart-analysis/types.ts`
- `components/dashboard/market.tsx` `components/dashboard/ai-analysis.tsx`
- `.env.example`
- `tests/production-readiness.test.ts`（9 tests）
- `e2e/helpers/mock.ts` `e2e/production-readiness.spec.ts`（3 tests）
- `outputs/Task034-実装報告.md`

Unit 追加 9。E2E 追加 3。

追加/強化した回帰:

- OpenRouter 設定不足 → OpenRouter 向け message（env 名なし）
- OpenAI 設定不足 → OpenAI 向け message（env 名なし）
- Chart 402 + Retry-After（1回のみ、detail 保持）
- Chart 429 + Retry-After（1回のみ、detail 保持）
- AI unavailable + Action WAIT が別状態として保持される
- E2E: 市場 503 / AI unavailable / overflow

## unresolved production risks

- 本番 Supabase への `exit_plan` migration 未適用の可能性
- 実環境でのクロスユーザー RLS 未検証
- OpenRouter 実モデルの image / structured output 対応は実行時依存
- 単一プロセス cache（市場・材料）は multi-instance で共有されない
- FRED `api_key` がホスティング側アクセスログに残る可能性
- AI 未取得時の Action WAIT は既存 semantic。UI で区別するが、ログや外部連携が Action だけを見ると誤読し得る

## Task035 で実環境確認が必要な項目

1. 本番/検証 Supabase に `20260916210000_add_trade_exit_plan.sql` が適用済みか
2. ユーザーAの JWT でユーザーBの trades を SELECT/INSERT/UPDATE/DELETE できないこと
3. `AI_PROVIDER=openrouter` 時の `OPENROUTER_MODEL` / `OPENROUTER_CHART_MODEL` をサーバ環境だけに置くこと
4. OpenRouter 402 / 429 と Retry-After が実レスポンスで detail に載ること（自動再送はしない）
5. provider-aware 未設定メッセージが実 env 不足時に UI へ正しく出ること
6. AI unavailable 時に Action WAIT と AI status が画面上で別状態として読めること
7. FRED query key のログ露出有無（ホスティング側）

## known limitations

- AI未取得時の総合 action は既存どおり WAIT。`ai.status` は unavailable/error
- チャート応答の markdown fence は不正として破棄する（テキスト側だけ除去）
- `proxy.ts` の `getClaims` 失敗は公開ページを続行する。保護は RLS
- 材料キャッシュはエラー時に直前値を stale として返さない。市場キャッシュだけ返す
- 経済プロバイダの置き換えはしていない

## 結論

lint / unit 1019 / e2e 332 / build / git diff --check は成功。外部API・Supabaseクエリ・polling・migration・自動retry の追加は 0。

最終レビュー3点（provider-aware message / Chart Retry-After / AI status と Action WAIT の区別）を反映済み。

未適用 migration、実RLS、OpenRouter 実モデルが残る。**Production Ready とは報告しない。**
