# Task012 AI分析の説明力・エントリー判断強化 実装報告

実装日：2026-09-11  
対象リポジトリ：AI-FX-Analyst  
ブランチ：`feature/task012-ai-decision-explanation`  
コミット・push：未実施

---

## 実装概要

Task011までの AI 総合分析フローを維持したまま、分析結果を「今何をすべきか」が一目で分かる UI に強化した。

- **相場方向（direction）** と **今の行動（action）** を視覚的に分離
- 「今やること」「Entry条件」「なぜ？」「Evidence分類」「Data Quality」「分析時刻 / stale」を既存レスポンスから構成
- OpenAI / Vision の追加呼び出しはしない
- Structured Output への大量 field 追加はしない
- 価格・イベントの捏造なし

---

## 変更ファイル

### 新規

- `lib/ai/decision-ui.ts` — 表示ラベル / WAIT分類 / 今やること / Evidence整理 / stale / 推奨ポジション（Task006再利用）
- `tests/decision-ui.test.ts` — 要件 A〜J
- `outputs/Task012-実装報告.md`

### 更新

- `components/dashboard/ai-analysis.tsx` — AI判断ヘッダー / 今やること / Entry / WAIT / stale / 再分析CTA / Evidence UI
- `components/dashboard/dashboard.tsx` — 現在レート連携、再分析、TASK 012 バッジ
- `app/globals.css` — decision UI スタイル（mobile / desktop）
- `lib/ai/openai.ts` — chart 付き時の technical 重複を最小 coalesce（Task011 実運用の invalid_response 対策）
- `tests/ai.test.ts` — coalesce 回帰テスト

---

## AI判断UI

AI分析カード最上部に以下を表示：

- 通貨ペア
- 現在レート（リアルタイム）と分析時点レートの分離
- AI判断（5段階：すごく買い〜すごく売り）
- 方向感
- 現在の行動
- 確信度（数値 + progress）
- Quick Summary（既存 `summary`）
- 「AI総合分析を更新」CTA

---

## direction / action 分離

例（実API）：

- AI判断：待った
- 方向感：売り寄り（`directionSignal=sell`）
- 現在の行動：今はエントリーしない（`action=WAIT`）
- Action ラベルも併記（アクセシビリティ）

「売り方向だから今すぐ売る」誤解を防ぐ。

---

## 今やること

`whatToDoNow()`：

1. 重要イベント接近 → 発表後まで待つ（既存 economicRisk のみ）
2. scenario.condition があればそのまま表示
3. WAIT理由から安全に導出
4. それ以外 → 「条件が整うまで待つ」

価格の推測生成はしない。

---

## Entry scenarios

既存 `scenario` がある場合のみ Entry / SL / TP / RR を表示。  
無い場合は「条件未設定」「UI側で生成しません」。

BUY / SELL / WAIT のシナリオ状態は `scenarioStance()` で既存信号から表現（新しい confidence 数値は生成しない）。

---

## 判断理由 / Evidence

- 「なぜ？」：factors 最大5件、カテゴリラベル付き
- BUY材料 / SELL材料 / WAIT材料へ UI 層で分類
- conflict 時：「材料が割れています」または「チャート画像とリアルタイム指標が一致していません」
- Task011 の両 Evidence 保持は変更なし

---

## Economic Event risk

`economicRisk.active` 時に警告バナー。  
架空イベントは生成しない。Calendar 未取得時は「利用不可: Economic Calendar」と明示。

---

## Data Quality / Chart Evidence

- 充足度 % と使用データ（Market / Technical / News / FRED / Calendar / Chart Image）
- `chartEvidence.used=true` 時のみ短く表示（時間足・trend・品質）
- 画像解析全文は再表示しない

---

## timestamp / stale

- 分析時刻・有効期限を表示
- `ANALYSIS_STALE_MS = 5分` 超過で再分析推奨メッセージ
- 複雑なレート差判定は未実装（仕様どおり時間ベース）

---

## Risk連携

- `action=WAIT` → 推奨ポジション 0 / 新規エントリーなし
- それ以外で scenario がある場合のみ Task006 `analysisPlan` + `positionSize` を再利用して「この条件なら最大○通貨」
- 新規 sizing ロジックは追加しない

---

## fallback

`ai.status !== "available"` 時：

- 「AI分析：一部利用不可。技術分析ベースの暫定判断です。」
- 通常 OpenAI 成功結果と同じ見た目にしない

API失敗時は「分析に失敗しました」+ 再分析ボタン。Chart Evidence active は dashboard state で維持。

---

## Mobile / Desktop

- 390：横スクロールなし（`scrollWidth === clientWidth`）
- 上部で pair / rate / AI判断 / direction / action / 今やること を確認可能
- 1280：decision / scenario と reasons の既存グリッドへ自然統合

---

## Tests

- `tests/decision-ui.test.ts`：A〜J
- `tests/ai.test.ts`：chart 付き technical 重複の coalesce
- 合計 **226** tests pass（Task011 の 215 を維持・拡張）

---

## 実API

環境：`http://127.0.0.1:3013`  
ペア：USD/JPY  
チャート：Task011 と同じローカル画像

### A. GET（chartなし）

- success / OpenAI available / gpt-4.1-mini
- signal=wait / directionSignal=sell / action=WAIT
- confidence=63 / chartEvidence=null
- secret leak なし

### B. POST（chart付き）

- Vision ok（米ドル/円, 15分足, down, score 90）
- coerce 後：OpenAI available
- signal=wait / directionSignal=sell / action=WAIT
- chartEvidence.used=true
- invalid_response なし / secret leak なし

補足：coerce 前は model が technical を二重出力し `invalid_response` になることがあった。schema 追加ではなく最小 coalesce で吸収。

---

## Browser確認

- 390x844 / 1280x900（CDP DeviceMetrics）
- direction=売り寄り / action=今はエントリーしない が別表示
- summary / 今やること / Entry未設定文言 / なぜ？ / BUY・SELL・WAIT材料 / Data Quality / 分析時刻
- 横スクロールなし
- スクリーンショットツールが timeout する場面あり。DOM snapshot + scrollWidth で確認

---

## lint / build

- `npm run lint`：pass
- `npm test`：226 pass
- `npm run build`：pass（実装時点）
- `git diff --check`：pass

---

## 既知の制限

- Economic Calendar 契約権限がない環境では Event Risk バナーは出ない（データがないため）
- stale は時間ベースのみ（レート乖離判定なし）
- Strong signal + event の WAIT 優先は既存 engine / economicRisk に依存（UI は表示分離）
- Next.js hydration warning（`toLocaleString` 等）は既存箇所由来の可能性
- Playwright 本格導入なし

---

## Task013への引継ぎ

- Trade Journal への chartAnalysisSnapshot 保存
- 分析履歴 / pair別 chart 保持
- stale の価格差判定
- Calendar 取得復旧後の Event Risk UX 強化
- 自動売買・broker 連携は引き続き非対象
