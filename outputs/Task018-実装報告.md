# Task018 E2E Regression / Playwright 回帰テスト 実装報告

実装日：2026-09-15  
検証完了日：2026-09-15  
ステータス：**実装・検証完了**  
対象リポジトリ：AI-FX-Analyst  
ブランチ：`feature/task018-e2e-regression`  
コミット・push：未実施（禁止どおり）

---

## 実装概要

Task001〜Task017 の主要 UI を、外部 API に依存せず壊さないための **Playwright E2E 回帰** を追加した。新機能ではない。

- Playwright Chromium のみ
- `/api/analysis` `/api/market` `/api/fundamental` `/api/chart-analysis` と Supabase Auth/REST を deterministic fixture へ差し替え
- OpenAI / Vision / Twelve Data / Finnhub / FRED / EODHD の実 call なし
- 本番 auth backdoor（`?e2e=true` 等）なし
- `npm test`（unit/integration）は維持
- 26 E2E すべて green

---

## Playwright version / setup

| 項目 | 内容 |
|------|------|
| パッケージ | `@playwright/test` **^1.63.0**（devDependency） |
| Browser | Chromium のみ（Firefox/WebKit は未導入） |
| 導入済み binary | Chrome for Testing 153.0.8010.12（Playwright chromium v1243） |
| 付属 | FFmpeg v1011、Chrome Headless Shell、Winldd |
| 導入コマンド | `npx playwright install chromium`（sudo / システム変更なし） |
| 設定 | `playwright.config.ts` |

既存の Playwright 構成はなかったため、新規導入。別 E2E フレームワークは追加していない。

---

## 変更ファイル

### 新規

- `playwright.config.ts`
- `e2e/env.ts`
- `e2e/helpers/mock.ts` / `e2e/helpers/goto.ts`
- `e2e/fixtures/{ids,auth,analysis,market,fundamental,trades}.ts`
- `e2e/{dashboard,daily-plan,performance,responsive}.spec.ts`
- `outputs/Task018-実装報告.md`（本報告）

### 更新

- `package.json` / `package-lock.json` — scripts と Playwright
- `.gitignore` — `playwright-report/` `test-results/` `blob-report/` `playwright/.cache/`
- `tsconfig.json` / `eslint.config.mjs` — e2e と Playwright 成果物を exclude
- `README.md` — `npm run test:e2e` の短い実行方法
- `components/dashboard/panels.tsx` — 任意 `data-testid`
- `components/dashboard/daily-plan.tsx` — `daily-plan` / `daily-plan-today-closed`
- `components/trades/performance.tsx` — `performance-period-${id}`

---

## scripts

```json
"test": "node scripts/test.mjs",
"test:e2e": "playwright test",
"test:e2e:headed": "playwright test --headed"
```

`npm test` は unit/integration のまま。壊していない。

---

## config

`playwright.config.ts`

- `baseURL`: `PLAYWRIGHT_BASE_URL` → なければ `http://localhost:${E2E_PORT ?? PORT ?? 3000}`
- ポート 3000 固定ではない
- `webServer`: `npx next dev --port ${port}`
- `reuseExistingServer: !CI`（ローカルで既存 `next dev` を再利用）
- Chromium project のみ
- `screenshot: "only-on-failure"`
- `trace: "retain-on-failure"`
- `video: "off"`
- retries: local 0 / CI 2
- 公開ダミー `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` は、未設定時のみ webServer env へ注入（`sb_publishable_e2e_not_a_secret`。本物の secret ではない）

Next.js 16 は同一リポジトリで `next dev` を二重起動できない。既存サーバーがある場合は再利用する。

---

## fixture strategy

`e2e/fixtures/` に本番型を import して作成。

| fixture | 内容 |
|---------|------|
| `analysis.ts` | sell-wait / buy-wait / review-buy / review-sell / stale / chart-evidence / long-condition / no-sl-tp |
| `market.ts` | USD/JPY・EUR/JPY・GBP/JPY のレートと確定足 |
| `fundamental.ts` | USD/JPY のみ upcoming 米CPI。FRED `data: []`。actual を未来イベントにしない |
| `trades.ts` | 今日 OPEN、今日 CLOSED（損失）、昨日 CLOSED、5d/45d/120d、WAIT+SELL snapshot、contrary |
| `auth.ts` | 偽 JWT セッション（署名秘密なし） |

Trade は `pnl()` と ISO ミリ秒日時、UUID を本番 validation に合わせた。  
日付は `localDayOffset` で実行時のローカル暦日に合わせ、深夜落ちを避ける。production の date logic は未変更。

---

## auth strategy

Dashboard の成績・Trade Journal・クラウド設定はログイン必須。

優先度 1 を採用：

1. `@supabase/ssr` の cookie セッション（`sb-<project-ref>-auth-token`、`base64-` 付き）を Playwright `addCookies` + `addInitScript` で注入
2. `/auth/v1/user` と `/rest/v1/*` を route mock
3. 一時 Supabase ユーザーは未使用

`?e2e=true` などの本番 backdoor は作っていない。  
本物ユーザー・本物 Trade は使わない。

---

## API mocking strategy

Playwright `context.route` で差し替え：

- `/api/analysis` → analysis fixture（pair query / POST body）
- `/api/market` → market fixture
- `/api/fundamental` → fundamental fixture
- `/api/chart-analysis` → Vision 未実行の JSON

ホスト単位で abort：

- openai.com / twelvedata.com / finnhub.io / stlouisfed.org / eodhd.com / tradingeconomics.com

`page.on("request")` で上記ホストへの到達を `leaks` として検出。Dashboard smoke で `leaks === []`。

**注意：** `page.route("**/*")` や関数 predicate の全件 intercept は Next.js HMR WebSocket（`/_next/hmr`）を壊し、ハイドレーションが止まる。特定パスのみ route する。

---

## Supabase strategy

Mock 優先。

- Auth: cookie セッション + `/auth/v1/**` fulfill
- REST: `/rest/v1/user_settings`（`.single()` 用 object）、`/rest/v1/trades`（配列 + content-range）
- Realtime: `*.supabase.co/**/realtime/**` を abort
- 実プロジェクトへはブラウザから飛ばさない
- service_role / 本物 refresh token は fixture に入れない

webServer 再利用時は `.env.local` の **公開** URL/anon key で client が作られる。cookie 名は hostname の project ref から算出。値は E2E 偽セッションのみ。

---

## SELL+WAIT

fixture: `directionSignal=sell`, `action=WAIT`

確認：

- AI方向 **SELL**
- 現在Action **WAIT**
- 「今はエントリーせず待つ」
- 「下方向」note
- 「今すぐ売る」は 0 件

---

## BUY+WAIT

同様。WAIT 維持。「今すぐ買う」なし。

---

## pair switching

USD/JPY の SELL 条件（`156.20を下抜けた場合`）を表示したあと EUR/JPY へ切替。

EUR/JPY analysis は fixture 上 `unavailable`。

確認：

- pair EUR/JPY
- 「AI分析を実行すると今日の計画を表示できます」
- direction NEUTRAL / action —
- USD/JPY の entry / chart badge が Daily Plan に残らない
- USD/JPY analysis を fallback しない

GBP/JPY は smoke（表示 pair が GBP/JPY）。

---

## stale

`analyzedAt = now - 10分`（閾値 5分）。BUY action でも main message は「分析から時間が経過しています」。status「分析期限切れ」。

---

## Daily Loss Limit

localStorage `ai-fx-analyst.daily-loss-limit-percent:<userId>` = 1（資金 50,000 の 1% = 500）。  
今日 CLOSED の realized loss が約 800 で到達。

「設定したDaily Loss Limitに到達しています」  
「取引禁止」コピーなし。

---

## Today's Results

- todayTradeCount = 2（OPEN + CLOSED）
- todayClosedCount = 1
- todayRealizedPnl は 0 円ではない（OPEN と昨日は含めない）
- 「全通貨ペア」表示
- 日時は実行時ローカル日

---

## mobile / desktop

| viewport | 確認 |
|----------|------|
| 390×844 | Daily Plan、pair、Action、main message、AI方向、長文 Entry、`scrollWidth <= clientWidth` |
| 1280×900 | Hero、Entry/Risk カード、横 overflow なし |

pixel-perfect screenshot 比較は未実施（非必須）。

---

## Performance

成績タブ：

- トレード振り返り（Trading Review Insights）
- 分析時点からEntryまで（Entry Timing）
- AI方向とEntry位置（AI Entry Context）

---

## period filter

全期間 → 直近30日 → 直近90日。同じ fixture set で件数テキストが変わる。  
reload で全期間に戻る仕様は維持。localStorage 化なし。

---

## Entry Timing

Task015。`Trade side基準` と `directionalEntryMovePips` を確認。期間切替後もセクション残る。

---

## AI Entry Context

Task016。カテゴリ：

- AI方向に進んだ後
- AI方向と逆に動いた後
- 分析価格付近

`AI directionSignal 基準` / `Task015の「Trade方向に対する値動き」とは別指標` を確認。

---

## WAIT snapshot

WAIT + SELL direction の snapshot 付き CLOSED trade を含む。  
WAIT を SELL action に変換しない。AI Entry Context の「AI方向に進んだ後」が表示される。

---

## contrary

AI SELL + Trade BUY + 価格が SELL 方向へ動いた fixture。  
Task016 では AI direction 基準で `with_ai_direction` になり得る。alignment と混同しない文言を確認。

---

## regression対象

DOM 上に残ること：

- 今日のトレード計画
- AI総合判定
- 資金・リスク管理
- テクニカル分析（TWELVE DATA / CLOSED CANDLES）
- マーケット材料
- なぜ？
- チャート読取 / トレード記録 / 表示期間（成績）

---

## secrets / privacy

- fixture に API key / Supabase secret / 本物 token なし
- dummy anon は `sb_publishable_e2e_not_a_secret`
- 偽 JWT の signature は `"e2e"`
- `.env.local` を report に出力していない
- Playwright HTML report / trace は gitignore

---

## production code変更

ビジネスロジック変更なし。locator 用の最小追加のみ。

| ファイル | 理由 |
|----------|------|
| `panels.tsx` | 任意 `data-testid`（UI 非変更） |
| `daily-plan.tsx` | `daily-plan` と `daily-plan-today-closed` |
| `performance.tsx` | `performance-period-all/30d/90d` |

DB migration / RLS / OpenAI call / 外部 API 追加なし。

---

## unit test結果

```
npm test
# tests 343
# pass 343
# fail 0
```

Task017 の 343 pass を維持。

---

## E2E test結果

```
npm run test:e2e
26 passed
```

所要時間 約 13 秒（8 workers、既存 `next dev` 再利用）。

必須 20 ケースは spec 名に番号を付けてカバー（Dashboard smoke、SELL+WAIT、BUY+WAIT、review BUY/SELL、pair fail-closed、stale、Daily Loss Limit、Today's Results、chart evidence、390/1280 overflow、Performance、period 30d/90d、Entry Timing、AI Entry Context、WAIT snapshot、contrary、既存 Dashboard regression）。GBP/JPY smoke と disclaimer / Event Risk / SL-TP も追加。

---

## build

```
npm run build
```

pass。Playwright は Next production build に影響しない（tsconfig で e2e exclude）。

---

## git diff check

```
git diff --check
```

green（whitespace error なし）。commit / push は未実施。

---

## browser install

未導入だったため `npx playwright install chromium` を実行。  
ユーザー領域の Playwright cache へダウンロード。sudo なし。

再実行時、未導入環境では README どおり：

```
npx playwright install chromium
npm run test:e2e
```

---

## 既知の制限

- GitHub Actions は未追加（Task018 非必須）
- Chromium のみ。他ブラウザ未カバー
- 既存 `next dev` があると同じ `.next` で第二インスタンスを起動できない（Next 16）。E2E は reuse
- HMR WebSocket 失敗は開発サーバー由来のことがあり、pageerror では無視
- sentiment fixture は `data: null` 必須。空配列 `[]` は truthy で本番 `FundamentalPanel` が `.market.value` 参照して落ちる。これは fixture 側で本番契約に合わせた（仕様変更なし）
- 期間フィルタの localStorage 永続化はしない（Task015 どおり）
- チャート画像 upload / Vision 実 call は対象外（badge のみ）
- pixel-perfect screenshot 比較なし
- 実 FRED/OpenAI 通信の CI ネットワーク監視は、ホスト abort + leaks 配列まで

---

## Task019候補

- GitHub Actions で `npm run test:e2e`（Playwright cache + Chromium）
- E2E 専用 `distDir` / ポートで `next dev` 二重起動を避ける
- login / signup / チャート upload の smoke（実 Vision なし）
- 必要なら Firefox 1 本だけ（容量と相談）
- Next overlay / HMR を E2E から完全に切る `next start` + fixture サーバー（production に近いが起動が重い）

---

## Validation

| コマンド | 結果 |
|----------|------|
| `npm run lint` | green |
| `npm test` | 343 pass |
| `npm run test:e2e` | 26 pass |
| `npm run build` | green |
| `git diff --check` | green |
