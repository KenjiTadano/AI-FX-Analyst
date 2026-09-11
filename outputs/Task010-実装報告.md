# Task010 チャート画像解析 実装報告

実装日：2026-09-11  
対象リポジトリ：AI-FX-Analyst  
ブランチ：`feature/task010-chart-image-analysis`  
コミット・push：未実施

---

## 実装概要

ユーザーがFXチャートのスクリーンショットをアップロードし、OpenAI Vision（Responses API + Structured Output）で解析できるようにした。

- 既存の市場データ / ニュース / Calendar / FRED / AI総合分析とは独立して動作する
- 解析結果は `ChartImageAnalysis` 型として独立
- Task005 `AnalysisInput.chartImageAnalysis?` へ任意で渡せる構造を追加
- 画像だけでは BUY / SELL / WAIT を最終決定しない
- 画像はサーバーへ永続保存しない（DB / Supabase Storageなし）

---

## 変更ファイル

### 新規

- `lib/chart-analysis/types.ts`
- `lib/chart-analysis/validate.ts`
- `lib/chart-analysis/normalize.ts`
- `lib/chart-analysis/openai-vision.ts`
- `lib/chart-analysis/service.ts`
- `lib/chart-analysis/client.ts`
- `app/api/chart-analysis/route.ts`
- `components/dashboard/chart-analysis.tsx`
- `tests/chart-analysis.test.ts`
- `outputs/Task010-実装報告.md`

### 更新

- `components/dashboard/dashboard.tsx`：ナビに「チャート読取」追加
- `lib/ai/types.ts`：`chartImageAnalysis?` を AnalysisInput へ追加
- `lib/ai/input.ts`：pair一致・品質OK時のみ technical evidence へ添付
- `lib/ai/openai.ts`：画像は補助Evidenceである旨を Prompt 追加
- `app/globals.css`：チャート読取UIスタイル
- `.env.example`：`OPENAI_CHART_MODEL=` 追加

---

## UI

既存ナビへ「チャート読取」タブを追加（analysis / chart / trades / performance）。

操作：

1. 通貨ペア選択（USD/JPY, EUR/JPY, GBP/JPY）
2. 画像アップロード
3. プレビュー（ファイル名 / サイズ / 画像 / 削除 / 解析）
4. 「チャートを解析」
5. 結果表示

結果表示順：

1. トレンド
2. 時間足
3. Market Structure
4. Support
5. Resistance
6. Pattern
7. Indicator
8. AI Observations
9. Warning
10. Data Quality

明示文言：

- 画像だけでは売買判断を確定しません
- 画像は解析に使用し、このアプリでは保存しません

---

## API

`POST /api/chart-analysis`（multipart/form-data）

入力：

- `pair`
- `image`

成功：

```json
{ "ok": true, "analysis": { ...ChartImageAnalysis }, "error": null }
```

失敗：

```json
{ "ok": false, "analysis": null, "error": { "code": "...", "message": "..." } }
```

---

## OpenAI Vision

- 既存 Responses API 方式を再利用
- `input_text` + `input_image`（data URL）
- Structured Output（json_schema / strict）
- 使用モデル：`OPENAI_CHART_MODEL` → なければ `OPENAI_ANALYSIS_MODEL` → 既定 `gpt-4.1-mini`
- APIキー：既存 `OPENAI_API_KEY`（新規キー不要）
- タイムアウト：45秒
- store: false

---

## ChartImageAnalysis型

主要フィールド：

- `pair`（ユーザー選択）
- `detected.pair / timeframe / chartType / currentPrice`
- `trend.direction / confidence / reason`
- `structure`（HH/HL/LH/LL, null可）
- `levels.support / resistance`
- `patterns[]`
- `indicators[]`
- `observations[]`
- `warnings[]`
- `dataQuality.score / imageReadable / pairDetected / timeframeDetected`
- `pairMismatch`
- `source: "chart_image"`
- `analyzedAt`
- `model`

将来 Trade Journal の `trade.chartAnalysisSnapshot` としても使える独立型。

---

## File validation

許可：PNG / JPEG / WebP  
拒否：PDF / SVG / 実行ファイル / 動画など  
最大：5MB  
空ファイル拒否  
マジックバイト検証  
対応外pair拒否  

無効な場合 OpenAI へ送らない。

ブラウザ側で最大辺1600pxへ縮小してから送信（追加画像ライブラリなし）。

---

## Privacy

- サーバー永続保存なし
- Supabase Storageなし
- APIキーをクライアント・ログ・エラーへ出さない
- UIに非保存の説明を表示

---

## Pair mismatch

Visionの検出文字列は比較前に `normalizeDetectedPair()` で canonical pair へ正規化する。

- 戻り値：`"USD/JPY" | "EUR/JPY" | "GBP/JPY" | null`
- 曖昧・未対応は `null`（推測で決めない）
- UIの「検出ペア」は Vision 生文字列を表示してよい
- `pairMismatch` は canonical 同士の比較のみ
  - 例：選択 `USD/JPY` × 検出 `米ドル/円` → canonical 一致 → `pairMismatch=false`
  - 例：選択 `EUR/JPY` × 検出 `米ドル/円` → canonical 不一致 → `pairMismatch=true`
- unknown（canonical=null）は **明確不一致にしない**（`pairMismatch=false`）。ただし自動attachもしない

対応エイリアス（最低限）：

- USD/JPY：`USD/JPY` / `USDJPY` / `USD-JPY` / `米ドル/円` / `米ドル円` / `ドル円` / `US Dollar/Japanese Yen` など
- EUR/JPY：`EUR/JPY` / `EURJPY` / `EUR-JPY` / `ユーロ/円` / `ユーロ円`
- GBP/JPY：`GBP/JPY` / `GBPJPY` / `GBP-JPY` / `英ポンド/円` / `ポンド/円` / `ポンド円`

大文字小文字・空白・全角/半角（NFKC）も吸収する。

明確 mismatch 時：

- 解析自体は実施可
- warningを付与
- `pairMismatch=true`
- Task005 AI総合へ自動統合しない（`canAttachToPairAnalysis` が false）

---

## Task005 AI統合

- `AnalysisInput.chartImageAnalysis?: ChartImageAnalysis`（optional）
- `buildInput(..., chartImageAnalysis?)` 第5引数
- 添付条件：同一pair（canonical）・明確mismatchなし・readable・score>=40
  - 検出ラベルが選択pairへ正規化できる場合、または検出ラベルなしの場合にattach可
  - unknownラベルは mismatch警告なし・attachなし
- evidence id：`technical:chart_image`
- Prompt：画像はスナップショットで市場データを上書きしないこと、画像だけで売買確定しないこと

未解析時は従来どおり動作。

---

## Data Quality

Vision出力の score を正規化し、UIでは 高 / 中 / 低 を表示。

- 高：80以上
- 中：50以上
- 低：それ未満

Vision confidence を絶対真実としては扱わない。

---

## Error handling

| code | 用途 |
|---|---|
| invalid_file | 空・破損など |
| unsupported_file | MIME/拡張子不一致 |
| file_too_large | 5MB超 |
| invalid_pair | 非対応ペア |
| not_configured | OPENAI_API_KEY未設定 |
| openai_unavailable | 上流障害 |
| openai_timeout | タイムアウト |
| invalid_ai_response | JSON検証失敗 |
| analysis_failed | その他 |
| rate_limited | 429 |

---

## Cost control

- 解析中の二重送信防止
- 同一pair+同一画像fingerprintのブラウザsession内結果再利用
- 送信前に縮小
- 大規模server cacheは未実装（要件どおり）

---

## テスト

追加：`tests/chart-analysis.test.ts`

- file validation（PNG/JPEG/WebP OK、PDF/SVG/empty/oversize NG）
- normalize（pair/timeframe/trend/structure/levels/pattern/indicator/null保持）
- pair alias canonical 化（`USD/JPY` vs `米ドル/円` / `ドル円` など → match）
- clear mismatch（`USD/JPY` vs `EUR/JPY` / `ユーロ/円`）
- unknown pair（`EUR/USD` など）→ canonical null・`pairMismatch=false`・attachなし
- AI attach / non-attach（日本語USD/JPYラベルでも technical evidence へattach）
- OpenAI mock（HTTP失敗・timeout・invalid JSON・valid JSON）
- serviceが不正ファイルをOpenAIへ送らないこと

全体：

- `npm test`：**204件成功 / 失敗0**

---

## 実API確認

最終確認実施日：2026-09-11（feature/task010-chart-image-analysis / pair正規化修正後）

### 結論

実OpenAI Vision疎通：**成功**（同一実チャート画像で match / mismatch を確認）

### 1. OPENAI_API_KEY 読み込み確認

`.env.local` をキー名のみ検査：

- `OPENAI_API_KEY`：**SET**
- `OPENAI_CHART_MODEL`：未設定（既定 `gpt-4.1-mini` を使用）
- `OPENAI_ANALYSIS_MODEL`：未設定
- 値は本報告・ログへ出力していない / commitしていない

### 2. ローカルサーバー

`http://127.0.0.1:3001` 上の Next.js dev 経由で `POST /api/chart-analysis` を実測。  
（port 3000 側は EMFILE 影響で不安定だったため、応答可能な 3001 を使用）

### 3. 実FXチャート画像

Downloads の実チャート：`スクリーンショット 2026-09-11 16.33.37.png`  
画面表示：通貨ペア **米ドル/円**、時間足 **15分足**、価格帯 ~154.x、RSI表示あり。  
画像ファイル自体はリポジトリへ追加していない。

### 4. 選択 USD/JPY（同一表記の一致）

| 項目 | 結果 |
|---|---|
| HTTP | 200 / `ok: true` |
| Vision検出生文字列 | `米ドル/円` |
| canonical | `USD/JPY` |
| `pairMismatch` | **false** |
| mismatch warning | **なし** |
| timeframe | `15分足` |
| trend | `down` |
| dataQuality.score | 90 |
| model | `gpt-4.1-mini` |
| Task005 attach条件 | 満たす（canonical一致・readable・score>=40） |
| secret leak | なし |

### 5. 選択 EUR/JPY（本物 mismatch）

同一画像を `pair=EUR/JPY` で再送：

| 項目 | 結果 |
|---|---|
| HTTP | 200 / `ok: true` |
| Vision検出生文字列 | `米ドル/円` |
| `pairMismatch` | **true** |
| mismatch warning | **あり**（選択ペア不一致文言） |
| Task005 attach | **しない** |
| secret leak | なし |

### 6. 捏造・品質メモ

- 検出ペア／時間足は画像上の表記と整合
- support/resistance は Vision 側が判別困難として空＋warning（無理な数値捏造は見られなかった）
- UI結果画面のブラウザ操作ログは本回は API 実測を主とし、タブUI自体は既存確認済み

---

## ブラウザ確認

- 「チャート読取」タブ・pair選択・非保存文言：既存確認済み
- 本回の pair 正規化修正は API 実測で検証（上記 USD/JPY match / EUR/JPY mismatch）
- レスポンスに APIキー漏洩なし

---

## 検証コマンド

pair正規化修正後：

- `npm run lint`：成功（警告0）
- `npm test`：204成功
- `npm run build`：成功
- `git diff --check`：成功

commit / push：未実施

---

## 既知の制限

1. 画像だけでは最終売買判断を出さない（意図的）
2. GET `/api/analysis` はまだチャートを自動読まない（構造のみ準備）。UI結果を将来POST連携可能
3. 現在価格との差分比較はMVPでは未実装
4. HEIC未対応
5. 複数画像・動画未対応
6. Trade Journalへの画像保存なし
7. サーバー側永続cacheなし
8. 開発サーバーが `EMFILE: too many open files` で不安定になることがある（本回は別portで実測）
9. 未対応pair表記は canonical=null（推測しない）。必要ならエイリアス追加で拡張

---

## Task011への引継ぎ

1. チャート解析結果をAI総合へ明示的に渡すUI（「この結果を次回AI分析に含める」）とAPI連携
2. 任意で画像価格とTask003現在レートの差warning
3. Trade Journalへの `chartAnalysisSnapshot` 保存（必要ならStorage方針も）
4. 多端末共有が必要なら解析結果の一時cache設計
5. 必要に応じて pair エイリアス拡張（他ブローカー表記）

未来値予測・自動売買・ブローカー連携・TradingView API連携は対象外。
