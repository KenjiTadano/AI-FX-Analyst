# Task016 AI direction × Entry move 複合分析 実装報告

実装日：2026-09-12  
検証完了日：2026-09-12  
ステータス：**実装・検証完了**  
対象リポジトリ：AI-FX-Analyst  
ブランチ：`feature/task016-ai-entry-context-analysis`  
コミット・push：未実施（禁止どおり）  
main merge：未実施

---

## 実装概要

AI分析時点の `directionSignal` と、分析参照価格→実際の Entry までの値動きを組み合わせ、

- **AI方向に進んだ後**に Entry したケース
- **AI方向と逆に動いた後**に Entry したケース
- **分析価格付近**で Entry したケース

の過去実績を振り返れるようにした。

- Task015 `directionalEntryMovePips`（**Trade side** 基準）とは別指標
- Task016 は **AI directionSignal** 基準の `aiDirectionalMovePips`
- 未来予測ではなく過去 Trade の行動分析
- OpenAI / Vision / 外部 API 追加 call **なし**
- DB migration / RLS / schema 変更 **なし**
- Task015 の period tabs / Entry Timing / Insights / Performance を維持

---

## 変更ファイル

### 新規

- `lib/trades/analysis-price.ts` — 分析参照価格 / pip ヘルパー共有（循環 import 回避）
- `lib/trades/ai-entry-context.ts` — 分類・集計・Insight 生成
- `components/trades/ai-entry-context.tsx` — 「AI方向とEntry位置」UI
- `tests/trade-ai-entry-context.test.ts` — A〜X
- `outputs/Task016-実装報告.md`

### 更新

- `lib/trades/insights.ts` — `aiEntryContextInsights` を alignment 系の後に挿入（MAX 7 維持）
- `lib/trades/entry-timing.ts` — `analysis-price` から import
- `components/trades/performance.tsx` — Entry Timing の直後にパネル追加
- `app/globals.css` — `.ai-entry-context-cards`
- `components/dashboard/dashboard.tsx` — TASK 016

---

## AI direction source

優先・唯一の方向源：**Task013 snapshot の `directionSignal`**

- `buy` / `strong_buy` → AI BUY
- `sell` / `strong_sell` → AI SELL
- `neutral` / 欠損 / 非対応 → **unavailable**（signal 本体から推測しない）

`isRichSnapshot` 未満・snapshot なし・pair mismatch も unavailable。

---

## analysis price source

Task015 既存 helper（`analysis-price.ts`）を再利用：

1. `analysisPrice`
2. なければ `marketPrice`
3. どちらもなければ unavailable

---

## aiDirectionalMovePips

JPY pair: `1pip = 0.01`（`JPY_PIP_SIZE`）

- AI BUY: `(entryPrice - analysisPrice) / 0.01`
- AI SELL: `(analysisPrice - entryPrice) / 0.01`

意味:

- `> 0` … AI が示した方向へ進んだ後に Entry
- `< 0` … AI 方向と逆へ動いた後に Entry
- `≈ 0` … 分析価格付近で Entry

**Trade side ではなく AI direction 基準。**

---

## neutral threshold

`AI_ENTRY_NEUTRAL_PIPS = 2`（定数・テスト済み）

| move | context |
|------|---------|
| `> +2` | `with_ai_direction` |
| `< -2` | `against_ai_direction` |
| `-2 … +2` | `near_analysis_price` |

---

## context分類

型: `AiEntryMoveContext`

- `with_ai_direction`
- `against_ai_direction`
- `near_analysis_price`
- `unavailable`

pure: `classifyAiEntryMoveContext(trade)` → context / aiDirection / action / prices / pips

unavailable 条件: snapshotなし / directionなし・neutral / analysis価格なし / invalid entry / pair mismatch / unsupported pair / NaN・Infinity / legacy 不足

OPEN trade: 分類自体は可能だが、成績 metrics は **closed のみ**。

---

## WAIT扱い

`action=WAIT` でも `directionSignal` が BUY/SELL なら分類可能。

UI/文面では **AI方向** と **Action** を分離。  
「WAITなのにSELLだから売るべきだった」等は出さない。

WAIT 限定の with vs against 比較は sample 双方 ≥5 のとき Insight 候補として生成。

---

## contrary扱い

alignment（aligned / contrary / wait_override …）とは独立に、  
**AI direction 基準で move context を分類**する。

contrary（例: AI SELL + BUY Entry）でも、価格が AI SELL 方向へ動いていれば `with_ai_direction` になり得る。  
クロス集計は Insight 材料用（UI一覧化なし）。

---

## group metrics

closed trade のみ、各 context で:

- count / wins / losses / break-even（draws）
- win rate / realized P/L / average P/L

`summarize` 再利用。P/L=0 → break-even。

双方 `MIN_INSIGHT_SAMPLE_SIZE`（5）を満たす場合のみ **with vs against** 比較 Insight。

---

## period integration

Task015 `filteredTrades` をそのまま渡す。独自 period filter **なし**。

全期間 / 30D / 90D 変更時に AI Entry Context・Insights・Entry Timing・Performance が同一集合。

---

## Insight integration

`generateTradingInsights` 内で alignment 系の後に `aiEntryContextInsights` を挿入。

優先イメージ: WAIT override → contrary → aligned vs contrary → **AI Entry Context** → DQ / Chart / Confidence / Pair·side / Entry timing

最大 **7件** 維持。断定・因果表現は禁止ワード検査。

---

## UI

Performance 内、Entry Timing 直後に「AI方向とEntry位置」:

- 3カード: AI方向に進んだ後 / 逆に動いた後 / 分析価格付近
- 説明: Trade方向基準（Task015）と AI direction 基準（Task016）の違い
- Disclaimer: 過去振り返りであり将来予測ではない
- empty: 「この期間にはAI方向とEntry位置を比較できる取引がありません」
- partial: 「比較可能なAI分析スナップショットがまだありません」

避けた語: 追いかけ / 逆張り / 押し目 / 戻り売り

---

## Mobile / Desktop

| Viewport | 結果 |
|----------|------|
| 390×844 | 1カラム相当・横スクロールなし |
| 1280×900 | 3カード横並び可・overflowX なし |

色だけで良し悪しを付けない。カテゴリ名を文字表示。

---

## API cost / Privacy

Task016 表示の追加 API call: **0**（OpenAI / Vision / FRED / Finnhub / Twelve Data）

Supabase は既存取得済み Trade のみ。validated snapshot fields のみ使用。外部送信なし。migration / 永続化追加なし。

---

## Tests

`tests/trade-ai-entry-context.test.ts`（A〜X）

**test件数: 309 pass**（Task015 時点 284 から +25）

既存 Task015 系を含む全スイート green。

---

## Browser

一時ユーザー fixture（BUY↑/BUY↓/SELL↓/SELL↑/near/WAIT+SELL方向/contrary/nosnap/60d旧データ）で確認後 **cleanup**（trades 24件削除・ユーザー削除・秘密ファイル削除）。

実測:

| 期間 | trades | 比較可能 |
|------|--------|----------|
| 全期間 | 24 | 23 |
| 直近30日 | 22 | 21 |
| 直近90日 | 24 | 23 |

確認: with / against / near カード、disclaimer、Insights 比較文、Entry Timing 維持、390/1280 横スクロールなし。

---

## lint / build

- `npm run lint` — pass
- `npm test` — **309 pass**
- `npm run build` — pass
- `git diff --check` — pass

---

## 既知の制限

- 期間は session state（reload で全期間に戻る）
- AI Entry Context × confidence のクロスは UI 非表示（必須外）
- pip magnitude bands（0-5 / …）の UI は Task015 Entry Timing との重複回避のため未追加
- empty / sample不足の一部はユニットテストで担保（fixture は比較可能な件数多め）

---

## Task017候補

- 期間選択の localStorage 永続化
- AI Entry Context × confidence / alignment の詳細クロス UI（任意）
- Playwright での成績タブ回帰固定化
- 30D vs 全期間の差分ハイライト

---

## 完了条件との対応

| 条件 | 状態 |
|------|------|
| snapshot direction → analysis price → Entry → AI move → context → closed metrics | **完了** |
| 同一 period filter | **完了** |
| Task015 UI 維持 / 追加 API 0 / migration なし | **完了** |
| lint / test / build | **pass** |
| commit / push | 未実施（禁止どおり） |
