# Task014 Trading Review Insights / トレード振り返り分析 実装報告

実装日：2026-09-11  
検証完了日：2026-09-11  
ステータス：**実装・検証完了**  
対象リポジトリ：AI-FX-Analyst  
ブランチ：`feature/task014-trading-review-insights`  
コミット・push：未実施（禁止どおり）  
main merge：未実施

---

## 実装概要

Task013 で蓄積できる Trade + AI snapshot を使い、**過去の判断パターンと成績の関係を振り返る** Insights を追加した。

- OpenAI / Vision / 外部API の追加 call **なし**（API cost +0）
- DB migration **なし**（Insights は derived、非永続）
- 既存 Journal / Performance / snapshot / RLS を維持
- 少数データから強い結論を出さない（`MIN_INSIGHT_SAMPLE_SIZE = 5`）
- UI に「過去の取引結果に基づく参考情報です」を明示

---

## 変更ファイル

### 新規

- `lib/trades/insights.ts` — Insight engine（決定論的）
- `components/trades/insights.tsx` — Trading Review UI
- `tests/trade-insights.test.ts` — 要件 A〜Q 相当
- `outputs/Task014-実装報告.md`

### 更新

- `components/trades/performance.tsx` — 上部に Insights セクション追加（既存パネルは残置）
- `app/globals.css` — insight cards スタイル（mobile 1カラム）
- `components/dashboard/dashboard.tsx` — TASK 014 バッジ

---

## Insight engine

`generateTradingInsights(trades)`:

- closed trade + `realizedPnl` のみを結果分析に使用
- `summarize` / `computeAiAlignment` / Task013 集計ヘルパを再利用
- テンプレート文言のみ（LLM なし）
- 最大 `MAX_INSIGHTS = 7`
- サマリーカード最大 `MAX_SUMMARY_CARDS = 3`

型: `TradingInsight`（id / type / severity / label / title / description / sampleSize / metrics / suggestion）

---

## Minimum sample

`MIN_INSIGHT_SAMPLE_SIZE = 5`

- 5件未満: 「傾向判定は保留」
- 3件中2勝などを勝ちパターンと断定しない
- 件数不足でも数字自体はサマリー／既存パネルで確認可能

---

## Alignment / WAIT / contrary

`computeAiAlignment` を再利用。

- WAIT override: 過去実績として件数・勝率・損益を表示（「WAITを必ず守れば利益」は書かない）
- contrary / aligned: 同様に過去記録として表示
- 双方 5件以上のみ aligned vs contrary 比較（勝率差・平均損益差）

---

## Confidence / Data Quality / Chart

- Confidence 帯: 0-49 / 50-69 / 70-84 / 85-100（closed + pair一致）
- Data Quality 帯: `dataQualityScore` 同帯
- Chart Evidence: used vs unused（双方十分なときのみ比較）
- Confidence disclaimer を UI に明示

---

## Pair / Side / Price delta

- 通貨ペア別（MIN 満たすもののみ）
- BUY / SELL 比較（双方 MIN）
- `analysisPrice` / `marketPrice` → `entryPrice` の絶対差を JPY pip（0.01）へ変換
- 価格差なし（analysisPrice 欠落）は delta 分析から除外
- 「遅すぎる／追いかけすぎ」断定はしない

---

## UI

Performance 上部:

1. トレード振り返り（disclaimer + summary cards + 最近の傾向）
2. 既存の損益サマリー〜AI一致別〜Chart〜Confidence〜Pair

ラベルは色だけでなく「良い傾向 / 注意 / 参考データ / データ不足」を併記。

---

## Mobile / Desktop

| Viewport | 結果 |
|----------|------|
| 390×844 | 1カラム、横スクロールなし（DOM確認） |
| 1280×900 | 3カラム相当、overflowX なし（DOM確認） |

スクリーンショットは使わず DOM / computed size で確認。

---

## Privacy / API cost

- Trade history を OpenAI 等へ送信しない
- 既存 Supabase read のみ
- Insights 表示による追加 API request: **0**
- keys / prompts / raw responses / chart images を Insights に含めない

---

## Tests

`tests/trade-insights.test.ts` A〜Q + empty state。

**test件数: 261 pass**（Task013 時点 243 から +18）

---

## Browser確認

一時ユーザー + fixture 15 closed trades（WAIT/aligned/contrary）で成績タブを確認後 cleanup。

確認済み:

- データ十分な Insights（WAIT / contrary / comparison / DQ / Chart など）
- disclaimer / confidence disclaimer
- ラベル併記
- 次回確認ポイント
- 390 / 1280 横スクロールなし
- empty / insufficient はユニットで担保

---

## lint / build

- `npm run lint` — pass
- `npm test` — **261 pass**
- `npm run build` — pass
- `git diff --check` — pass

---

## 既知の制限

- 期間フィルタは未追加（全期間。既存 Performance と同じ trade 集合）
- Insights は DB 非保存（再計算）
- sample が偏ると参考データが中心になる
- price delta 帯比較はデータ十分時のみ
- 未来の勝率・利益を予測しない（仕様）

---

## Task015候補

- 期間フィルタ（30/90日）と Performance 共通化
- Data Quality 帯の専用カード UI
- Entry delay と損益の相関の可視化
- Playwright での Insights 回帰固定
- note 分析（手動振り返りタグ）

---

## 完了条件との対応

| 条件 | 状態 |
|------|------|
| Trade history → snapshot/alignment → deterministic insights → Performance UI | **完了** |
| OpenAI 非使用 | **完了** |
| 少数データから強い結論を出さない | **完了** |
| migration なし / 既存破壊なし | **完了** |
| lint / test / build | **pass** |
| commit / push | 未実施（禁止どおり） |
