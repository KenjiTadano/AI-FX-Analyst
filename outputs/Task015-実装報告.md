# Task015 Performance期間分析 + Entry Timing分析 実装報告

実装日：2026-09-12  
検証完了日：2026-09-12  
ステータス：**実装・検証完了**  
対象リポジトリ：AI-FX-Analyst  
ブランチ：`feature/task015-performance-period-analysis`  
コミット・push：未実施（禁止どおり）  
main merge：未実施

---

## 実装概要

Performance / Trading Review Insights を **期間別** に切り替え可能にし、さらに分析時点価格→Entry価格の距離を **Entry Timing** として振り返れるようにした。

- 期間: 全期間 / 直近30日 / 直近90日（rolling、`openedAt` 基準）
- `filteredTrades` を Performance・Insights・Entry Timing で共有
- OpenAI / Vision / 外部API 追加 call **なし**
- DB migration / RLS / schema 変更 **なし**
- Task014 Insights を削除せず、期間ラベル付きで連携

---

## 変更ファイル

### 新規

- `lib/trades/performance-period.ts` — `filterTradesByPeriod` / period labels / counts
- `lib/trades/entry-timing.ts` — directional move / absolute bands / timing insights
- `components/trades/entry-timing.tsx` — Entry Timing UI
- `tests/trade-period-timing.test.ts` — A〜W
- `outputs/Task015-実装報告.md`

### 更新

- `components/trades/performance.tsx` — period tabs + 共通 filteredTrades
- `components/trades/insights.tsx` — `periodLabel` 表示
- `app/globals.css` — period tabs / timing layout
- `components/dashboard/dashboard.tsx` — TASK 015

---

## Period filter

型: `PerformancePeriod = "all" | "30d" | "90d"`

UI: `[全期間] [直近30日] [直近90日]`（`type="button"` / `aria-pressed`）

日付基準: **`trade.openedAt`（Entry日時）**。createdAt は使わない。

境界: rolling `now - N*24h` **以上を含む**（inclusive）。DST依存の日付丸めは使わない。

`now` は injectable（テスト固定） / UI はマウント時固定。

---

## filteredTrades 共有

期間変更時に同一集合を参照:

- 損益サマリー / equity / カレンダー
- AI alignment / signal / Chart / Confidence / Pair
- Trading Review Insights
- Entry Timing

期間0件時は「この期間には取引記録がありません」（全期間へ自動fallbackしない）。

---

## Insights integration

`generateTradingInsights(filteredTrades)` のみ。Insight engine内の独自period filterは追加していない。

対象期間ラベルを見出しに表示。最近期間で closed < 5 のとき不足メッセージ。

---

## Entry Timing

再利用: Task014 `analysisReferencePrice`（analysisPrice → marketPrice） / `priceDeltaToPips`（JPY 0.01=1pip）

追加:

- `rawMove = entryPrice - analysisPrice`
- `absolutePips`
- `directionalEntryMovePips`（Trade side基準）
  - BUY: `(entry - analysis) / 0.01`
  - SELL: `(analysis - entry) / 0.01`

Bands（半開区間）:

- `[0,5)` / `[5,10)` / `[10,20)` / `[20,∞)`

除外: snapshotなし / 価格なし / pair mismatch / invalid price / legacy（analysisPriceなし）

Disclaimer: 「エントリーの良し悪しを直接判定するものではありません。」

---

## Sample size

`MIN_INSIGHT_SAMPLE_SIZE = 5`（Task014）を再利用。不足時は強い timing band insight を出さない。

---

## UI / Mobile / Desktop

順序: 表示期間 → Insights → Entry Timing → 既存Performance

| Viewport | 結果 |
|----------|------|
| 390×844 | period 等幅3ボタン、横スクロールなし |
| 1280×900 | overflowX なし |

Browser実測（一時ユーザー）:

- 全期間 17 / 30日 12 / 90日 15
- Entry Timing bands・Insights期間ラベル確認後 cleanup

---

## API cost / Privacy

期間切替・Entry Timing表示の追加 API call: **0**  
Trade は既存取得分をクライアント filter。外部送信なし。

---

## Tests

`tests/trade-period-timing.test.ts` A〜W。

**test件数: 284 pass**（Task014 時点 261 から +23）

---

## lint / build

- `npm run lint` — pass
- `npm test` — **284 pass**
- `npm run build` — pass
- `git diff --check` — pass

---

## 既知の制限

- 期間は session state（reloadで全期間に戻る）
- AI direction × price move の複合分析は未実装（Task016候補）
- カレンダー月切替は期間filter後の決済集合上で動作
- empty period の Browser はユニットで担保（fixtureは0件期間なし）

---

## Task016候補

- AI direction と Entry move の複合比較
- 期間の localStorage 永続化
- 30D vs 全期間のカード差分 UI 強化
- Playwright 固定化

---

## 完了条件との対応

| 条件 | 状態 |
|------|------|
| Period filter → 共通 filteredTrades → Performance/Insights/Entry Timing | **完了** |
| 追加 API call なし | **完了** |
| migration なし / Task014維持 | **完了** |
| lint / test / build | **pass** |
| commit / push | 未実施（禁止どおり） |
