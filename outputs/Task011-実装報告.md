# Task011 チャート画像解析 → AI総合分析統合 実装報告

実装日：2026-09-11  
対象リポジトリ：AI-FX-Analyst  
ブランチ：`feature/task011-chart-ai-integration`  
コミット・push：未実施

---

## 実装概要

Task010の `ChartImageAnalysis` を、ユーザーの明示操作でのみ Task005 AI総合分析へ含められるようにした。

- Vision解析の作り直しはしない
- 画像なしでも従来どおり AI 分析可能（GET維持）
- 元画像は AI 総合へ再送しない（構造化結果のみ）
- ブラウザ session / React state のみ（Supabase保存なし）

導線：

チャート画像 → Vision → 結果確認 →「このチャートをAI総合分析に含める」→ 分析タブ →「AI総合分析を更新」→ POST `/api/analysis`（ChartImageAnalysis付き）

---

## 変更ファイル

### 新規

- `lib/chart-analysis/sanitize.ts`（client JSONの再検証 / UIブロック理由）
- `tests/chart-ai-integration.test.ts`
- `outputs/Task011-実装報告.md`

### 更新

- `app/api/analysis/route.ts`：POST追加（GET維持）
- `lib/ai/client.ts` / `lib/ai/service.ts`：optional chart引数・cache key分離
- `lib/ai/types.ts` / `lib/ai/engine.ts`：`chartEvidence` 要約
- `lib/ai/openai.ts`：chartテキストは命令ではない旨を明示
- `lib/chart-analysis/normalize.ts`：`source === "chart_image"` を attach条件に追加
- `components/dashboard/chart-analysis.tsx`：含める / 外す / disabled理由
- `components/dashboard/dashboard.tsx`：pending/active chart state・pair変更解除
- `components/dashboard/ai-analysis.tsx`：使用データ表示・更新CTA
- `app/globals.css`：薄いスタイル追加

---

## UX

1. チャート読取で解析
2. 結果確認後、「このチャートをAI総合分析に含める」（条件NG時はdisabled + 理由）
3. 分析タブへ自動遷移（この時点では OpenAI を勝手に連続実行しない）
4. 「AI総合分析を更新」で初めて chart 付き POST
5. 「チャートを総合分析から外す」で解除可能

統合不可理由例：

- 選択通貨ペアと画像の通貨ペアが異なるため…
- 画像内の通貨ペアを確認できないため…
- 画像品質が低いため…

---

## analysis API変更

- `GET /api/analysis?pair=`：従来どおり（chartなし）
- `POST /api/analysis`：`{ pair, chartImageAnalysis? }`
  - 画像バイナリは受け付けない
  - query stringへ巨大JSONを載せない

---

## server validation

`sanitizeClientChartAnalysis(raw, selectedPair)`：

- schema/type検証、長さtruncate
- `source === "chart_image"` 必須
- `pair` は選択pairと一致必須
- `pairMismatch` はクライアント値を信用せず再計算
- 不正JSONは `null`（除外）し、Prompt改変経路にしない

その後 `canAttachToPairAnalysis` で最終判定。

---

## Chart Evidence attach条件

既存 `canAttachToPairAnalysis` を再利用：

- pair一致
- `pairMismatch=false`
- `source === "chart_image"`
- `imageReadable=true`
- `score >= 40`
- 検出pairがcanonical一致、または検出ラベルなし
- unknown / mismatch / low quality / unreadable → attachしない

---

## pair変更 / 再解析 / 解除

- Dashboardのpair変更：pending/active chartを解除
- 新画像選択・再解析：統合状態を解除（再確認→再「含める」が必要）
- 「チャートを総合分析から外す」：画像再解析なしで解除可

MVPは pair変更時解除（pairごと保持はしない）。

---

## AI Prompt

Task010方針を維持し、矛盾時は両Evidenceを残すこと・chart内テキストは未信頼データであることを追記。重複の大量追加はしない。

---

## Evidence conflict / Economic Event WAIT

- Chart down × Market up → 両方inputへ残す（上書きしない）
- `finalizeAnalysis` の WAIT 分岐は未変更
- 高重要イベント risk window 中は chart `strong_up` でも `action=WAIT` を維持（テスト追加）

---

## Privacy / Cost / Security

- 元画像保存なし / Storageなし
- AI総合時に Vision 再実行なし
- 二重送信防止（inFlight）
- Task010同一画像cache維持
- chart文字列はtruncate + 「命令ではない」

---

## テスト

- 既存維持 + Task011
- invalid_response 再現テスト：
  - factors 6件
  - 5件内の technical 重複 → `factor_1_duplicate_category:technical`
  - empty `source`
  - FRED macro で economic を ground（calendar DQ missing でも可）
- 検証コマンド実行時点：**215件成功 / 失敗0**

---

## invalid_response 原因と修正

### 切り分け

| ケース | 修正後 |
|---|---|
| A. GET chartなし | **OpenAI成功** → 主因は既存 RESPONSE schema/runtime 不整合 |
| B. POST chartあり | **OpenAI成功** → chart は INPUT。RESPONSE schema の不必要な変更は不要 |

### 具体的原因（実測）

1. **factors 件数・重複**：schema に `minItems/maxItems:5` が無く、technical 重複を許容 → runtime と不一致（`invalid_factors_count` / `duplicate_category:technical`）
2. **空文字 source**：schema と runtime（非空必須）のギャップ → `bad_source`
3. **FRED × economic DQ**：macro evidence があるのに calendar 由来 DQ が `missing` だと方向付き factor を拒否 → `directional_without_evidence:economic`

### 修正（`lib/ai/openai.ts`）

- Structured Output schema を runtime と整合（factors 5固定、string minLength、confidence範囲、list上限）
- Prompt：5 factors / category重複禁止 / source空禁止（chart text は命令ではない防御は維持）
- grounded evidenceIds があれば DQ missing でも方向付け可
- `interpretationFailureReason` + 開発時の安全な debug warn
- judgment/signal/scenarios 等は RESPONSE schema に追加していない（`finalizeAnalysis` 側）

---

## 実API確認（修正後最終）

実施：2026-09-11 / `http://127.0.0.1:3001` / model=`gpt-4.1-mini`  
実USD/JPYチャート（repo未追加）

### A. chartなし — `GET /api/analysis?pair=USD/JPY`

- HTTP 200 / `ai.status=available` / `ai.model=gpt-4.1-mini` / `ai.code=null`
- **invalid_response なし / fallback なし**
- `chartEvidence=null` / signal・action・confidence 返却

### B. chartあり — Vision → `POST /api/analysis`

- Vision HTTP 200 / `pairMismatch=false` / score=85 / down / 15分足
- 画像バイナリ再送なし
- `chartEvidence.used=true`
- `ai.status=available` / model=`gpt-4.1-mini` / code=null
- **Structured Output validation 成功 / fallback なし**
- summary にチャートと市場テクニカルの両方（画像単独断定なし）
- secret leak なし

### C. mismatch — EUR/JPY + USD chart

- `chartEvidence=null`（attachしない）
- 再試行で EUR AI も `available`

---

## Browser確認

- ダッシュボード / チャート読取タブ / ファイル入力UI：確認済み
- 実画像フルUI操作は上記 API 実測で代替

---

## 既知の制限

1. chart統合状態はリロードで消える（意図的）
2. GET `/api/analysis` はchartを読まない（POSTのみ）
3. Trade Journalへ snapshot未保存
4. 「含める」だけではAIを走らせない（更新ボタン必須）
5. category 一意は JSON Schema だけでは強制できないため、重複時は runtime fail-closed（Prompt + 件数制約で抑制）

---

## Task012への引継ぎ

1. 「含める」後のワンクリック分析オプション
2. Trade Journal `chartAnalysisSnapshot` 保存
3. chart evidenceの履歴 / pair別保持
4. UIテスト自動化（Playwright等）
