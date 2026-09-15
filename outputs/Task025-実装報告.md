# Task025 Post-Trade Review / 決済後トレードレビュー 実装報告

実装日：2026-09-15  
検証完了日：2026-09-15  
ステータス：**実装・検証完了**  
対象リポジトリ：AI-FX-Analyst  
ブランチ：`feature/task025-post-trade-review`  
コミット・push：未実施（禁止どおり）

---

## 実装概要

Task025 は新しい売買判断ではない。決済済み Trade の Journal 詳細に **POST-TRADE REVIEW / 決済後レビュー** を追加し、エントリー時に保存された事実と、実際の取引結果を同じ場所で見返せるようにした。

最重要原則：**OUTCOME MUST NOT REWRITE CONTEXT.**

- 利益だから「良い Entry」とは判定しない
- 損失だから「悪い Entry」とは判定しない
- WAIT を違反扱いしない
- MET を遵守扱いしない
- 5/5 を Entry OK 扱いしない
- Event unavailable を LOW にしない
- not_met + distance 0 を MET に書き換えない
- 現在の market / AI / Daily Plan / Readiness / Trigger Watch / Pre-Trade Review から過去 Trade を再評価しない

OpenAI / Vision / 外部 API / Supabase extra query / 新 timer / polling / DB migration / RLS / schema 変更はしていない。snapshot は close 後も UPDATE しない。

---

## 変更ファイル

### 新規

- `lib/trades/post-trade-review.ts` — `buildPostTradeReview` / duration helper / context labels
- `components/trades/post-trade-review.tsx` — CLOSED Trade 用 Review UI
- `tests/post-trade-review.test.ts` — A–AZ ほか
- `e2e/posttrade-review.spec.ts` — Playwright 25 本
- `outputs/Task025-実装報告.md`（本報告）

### 更新

- `components/trades/trade-list.tsx` — CLOSED に Review。OPEN は既存 Task022 表示を維持
- `components/trades/pre-trade-context.tsx` — sanitizer 経由。分析 / DLL / Risk 表示を Task024 用語に寄せる
- `app/globals.css` — `.posttrade-review*`（1カラム / desktop 2〜3列 / overflow-wrap）
- `e2e/helpers/mock.ts` — `tradeSet: "posttrade-review"`
- `e2e/fixtures/trades.ts` — Task025 fixture + `closedTrade` の notes 対応

`closeTrade` / `editTrade` / capture / sanitizer 本体 / Task023 集計は未変更。

---

## source of truth

Entry context：`trade.analysisSnapshot.preTradeContext` のみ（Task022 snapshot）。表示前に `sanitizePreTradeContext(raw, trade.pair)` を通す。

結果：既存 Trade フィールド

- `status`
- `realizedPnl`（再計算しない）
- `openedAt` / `closedAt`
- `entryPrice` / `exitPrice`（既存 detail に既出のため Review では重複しない）
- `side` / `quantity` / `pair`

現在の AI analysis / market / Daily Plan / Readiness / Trigger Watch / Pre-Trade Review は参照しない。

---

## CLOSED only

`buildPostTradeReview(trade)` は `trade.status !== "closed"` なら `null`。OPEN には Post-Trade Review を出さない。未実現損益レビューは作っていない。

---

## realized P/L

`trade.realizedPnl` をそのまま表示。既存 `money()` を再利用（`+820円` / `-450円` / `0円`）。Review 内で pnl を再計算しない。

---

## result terminology

`realizedPnl > 0` → profit / **利益**  
`< 0` → loss / **損失**  
`=== 0` → flat / **損益なし**

Task014/023 と同じ符号判定。成功 / 失敗 / 良い取引 / 悪い取引は出さない。色（既存 Profit/Loss tone）は補助で、結果ラベルはテキストでも明示する。

---

## holding duration

`totalMinutes = floor((closedAt - openedAt) / 60000)`。ISO 同士の elapsed duration。timezone 表示差は使わない。

- 59秒 → 0分
- 59分59秒 → 59分
- 60分 → 1時間
- 35分 / 2時間35分 / 1日3時間 / 2日4時間15分

秒単位は出さない。0 の単位は省略（全部 0 なら「0分」）。

---

## invalid duration

`closedAt` なし / invalid date / `closedAt < openedAt` → **—**。推測や absolute 変換はしない。

---

## Trade side

上部 identity：`USD/JPY` + 実 Trade side（`BUY` / `SELL`）。`long` → BUY、`short` → SELL。AI Direction と別フィールド。

---

## AI Direction

snapshot の `direction`：BUY / SELL / NEUTRAL / 未取得。Trade side と混同しない。BUY Trade + AI SELL も両方そのまま表示。

---

## Action

エントリー時 Action：BUY / SELL / WAIT / 未取得。WAIT を違反扱いしない。Action null の context label は skip（Task023 `unavailable` と同じ）。

---

## Readiness

Task019 固定 5。`5 / 5` / `4 / 5`。Trigger を 6 項目目にしない。5/5 を Entry OK / 準備万全だったへ変換しない。

---

## Trigger

Task022 保存値だけ。現在価格で再評価しない。

| 保存 status | 表示 |
|---|---|
| met | 条件成立 |
| not_met | 条件未成立 |
| unavailable | 判定データ不足 |
| invalid | 構造化条件利用不可（model）。UI 再利用の Task022 formatter は「利用不可」 |
| null | Triggerなし |

---

## equality

`not_met` + distance 0 のまま **条件未成立**。利益 Trade でも MET へ書き換えない。

---

## distance

保存済み `distanceToTriggerPips` がある場合、**条件未成立時のみ**「条件まであと N pips」（0 pips 可）。現在価格との差は計算しない。

---

## checkedAt

保存済み `checkedAt` があれば「判定確認時刻」（Task022 `PRE_TRADE_CHECKED_AT_LABEL`）。candle close time とは呼ばない。

---

## Event Risk

保存値のみ：LOW / MEDIUM / HIGH / 未取得。`available: false` や `unknown` を LOW にしない。現在の economic calendar で再判定しない。

---

## Freshness

`analysisStale: false` → 最新分析  
`true` → 期限切れ分析  

損失の原因説明は書かない。

---

## Risk

保存済み `riskPerTrade` / `riskPercent` のみ。例：`500円 / 1.0%`。現在の capital/risk settings で再計算しない。R multiple（`realizedPnl / riskPerTrade`）は計算しない。

---

## DLL

`dailyLossLimitReached` を「未到達 / 到達」で表示。到達後に取引したのでルール違反、とは書かない。

---

## Context labels

下部「この取引のContext」。pure deterministic。最大 5。欠落は skip。

推奨順：

1. Trigger
2. Action
3. Freshness
4. Event
5. DLL

例：

- Trigger条件成立時に登録
- Action WAIT時に登録
- 最新分析時に登録
- Event Risk LOW時に登録
- Daily Loss Limit未到達時に登録

Task022 helper `triggerStatusAtEntry` / `actionAtEntry` / `eventRiskAtEntry` を再利用。Fresh / stale / DLL も snapshot から。Task023 と同じ classification semantics。

禁止：Trigger遵守 / WAIT無視 / リスク管理成功 / 高品質Entry / 悪条件Entry / 勝ちパターン。

Trigger なし（context はあるが trigger null）は「Triggerなしで登録」。legacy context なしとは区別する。

---

## causal inference禁止

以下は生成しない。

- Trigger成立が利益につながった
- WAIT中に入ったため損失になった
- Event HIGHが敗因
- stale分析が損失原因

AI 総評 / 改善点 / 反省点 / 次回アドバイスも生成しない。事実レビューのみ。

---

## outcome bias防止

同じ context（SELL / WAIT / 5/5 / MET / LOW / fresh）でも：

- +820円 → 利益。context は WAIT / 条件成立 / 5/5 のまま
- -820円 → 損失。context は完全に同じ

利益→良いEntry、損失→WAIT違反 / MET失敗 / 悪いEntry へ変換しない。

---

## legacy

CLOSED だが `preTradeContext` なし：Review 自体は表示。実現損益と保有時間は出す。Entry Context は「エントリー時の判断状況は保存されていません」。`no_trigger` へ変換しない。推測 backfill しない。

---

## Task013-only legacy

Task013 AI snapshot はあるが Task022 context なし：Post-Trade Review の Context はなし（保存されていません）。既存「エントリー時AI分析」は従来どおり別表示。Task022 context を推測生成しない。

---

## pair safety

`preTradeContext.pair` と trade pair が不一致、または sanitizer が null を返す場合：context を出さない。結果だけ表示。

- クライアント上で raw が残っている場合：「エントリー時の判断状況は確認できません」
- cloud load 経由では `sanitizePersistedSnapshot` が不正 context を先に落とすため、E2E 上は「保存されていません」になる（raw broken object は出さない）

---

## sanitizer

component は raw `preTradeContext` を直接信用しない。Task022 `sanitizePreTradeContext` を通す。builder は Trade / snapshot を mutation しない。

---

## Task022 UIとの統合

- **OPEN**：既存「エントリー時の判断状況」を details 内に維持。Post-Trade Review なし
- **CLOSED**：同じ `PreTradeContextDetail` を Post-Trade Review 内へ移動。独立した第二カードとしては出さない
- Task013「エントリー時AI分析」は残す（置き換えない）

Entry/exit 価格は既存 Trade 基本情報のまま。Review では重複しない。

---

## Task023との関係

Performance 集計ロジックは未変更。個別 Review に「Trigger成立時の平均勝率」等の全体集計は出さない（推奨に見えやすいため）。

Performance 導線（「エントリー判断状況別の成績を見る」）は **Task025 では見送った**。Journal 詳細から Performance タブへ切替える自然な既存 UI が薄いため。新しい query/API は作っていない。

---

## close flow

決済時は既存どおり `exitPrice` / `closedAt` / `realizedPnl` 等の結果フィールドのみ。Task025 用の保存は 0。`closeTrade` は `analysisSnapshot` を触らない。

Journal の既存 UI 更新だけで Review が出る。追加 fetch なし。

E2E：OPEN → close → Review 表示 → snapshot 文言（Direction / Action / Trigger）が close 前後で同じ、を確認。

---

## edit after close

closed Trade の exitPrice 等を編集し `realizedPnl` が更新される場合、結果 summary は最新 Trade フィールドを表示する。`preTradeContext` は不変（`editTrade` が snapshot を置き換えない既存仕様）。

---

## immutability

Task025 は read-only。Trade close 後も `analysisSnapshot` / `preTradeContext` を UPDATE しない。削除すれば Review も消える（別 table / state なし）。

---

## API追加call

OpenAI 0 / Vision 0 / Twelve Data 0 / Finnhub 0 / FRED 0 / EODHD 0。

---

## Supabase追加query

既存 Journal load / close / edit のみ。Review 専用 query なし。

---

## polling

新規 timer / polling なし。既存 refresh も増やしていない。

---

## schema

Trade schema / snapshot schema 変更なし。`PostTradeReviewModel` に score / grade / rating / quality は持たない。

---

## DB

migration 0 / RLS 変更 0 / new table 0。

---

## privacy

API key / raw OpenAI / system prompt / chart image / base64 / raw candles / Supabase secret は表示・送信しない。外部送信 0。

---

## mobile

390x844。1カラム。Result / Entry Context / Context labels / disclaimer。`overflow-wrap` + `minmax(0, 1fr)`。E2E で overflow なし。

---

## desktop

1280x900。Result summary は 800px で 2列、1100px で 3列。Entry Context は既存 Task022 grid を再利用。巨大カード化しない。E2E で overflow なし。

---

## accessibility

`aria-label="決済後レビュー"`。結果はテキストで 利益 / 損失 / 損益なし。色だけに依存しない。Context labels に `aria-label="この取引のContext"`。

必須 disclaimer：

1. 「エントリー時の情報は取引登録時に保存されたスナップショットです。取引結果によって後から変更・再評価していません。」
2. 「この表示は過去の取引事実を振り返るためのもので、判断の正誤や将来の成果を示すものではありません。」

---

## unit tests

Task024 baseline **589** を維持し、Task025 で **51** 本追加。合計 **640 pass**。

A OPEN no review / B CLOSED review / C–E profit loss flat / F realizedPnl SoT / G–I duration / J–L invalid duration / M–N Trade side vs AI Direction / O WAIT / P–Q 5/5 / R–V Trigger / W checkedAt / X–Z Event / AA–AB freshness / AC Risk / AD DLL / AE–AF labels / AG–AJ outcome bias / AK–AL wording / AM–AN legacy / AO–AQ sanitizer / AR no mutation / AS–AV no fetch / AW no schema / AX duration / AY edit / AZ close immutability。禁止文言ソース検査あり。

---

## E2E

Task024 baseline **122** を全維持。Task025 **25** 本追加。合計 **147 passed**。

Task018 fixture 方式。実 Supabase / OpenAI / Twelve Data へ通信しない。

1 OPEN no Review / 2 close → Review / 3–5 profit loss flat / 6 duration / 7–8 side vs direction / 9 WAIT / 10 5/5 / 11–13 Trigger / 14 Event unavailable / 15 stale / 16 DLL / 17 labels / 18 legacy / 19 pair mismatch context hidden / 20–21 quality wording なし / 22 snapshot unchanged after close / 23 result edit context unchanged / 24–25 overflow。

---

## regression

壊していない：

Trade create / edit / close / delete、Task013 AI snapshot、Task022 PreTrade snapshot、Task023 Performance、Task024 PreTrade Review、Daily Plan、Readiness、Trigger、Watch、Period filter、Entry Timing、AI Entry Context、Risk。

既存 Task022 E2E（close 後も Action / Trigger が表示される）は、CLOSED では Review 内の同一 renderer で semantics を維持。

---

## known limitations

1. **Performance 導線未追加**。個別 Review から Task023 へ行くボタンは見送り。
2. **R multiple 未計算**。Task006 `riskPerTrade` が actual initial risk と同義とは限らない。
3. **SL/TP 到達・計画 R:R 遵守は推測しない**。Trade に明示事実がなければ作らない。
4. **cloud load 後の pair mismatch** は sanitizer が context を落とすため、UI 上は legacy missing と同じ「保存されていません」。unit では raw 残存時の「確認できません」をカバー。
5. Trigger `invalid` の UI 文言は Task022 formatter の「利用不可」。model 側は「構造化条件利用不可」。
6. Action null の label は「Action未保存」ではなく skip。
7. 既存 `PreTradeContextDetail` の見出しは CLOSED Review 内でも残る（二重カードではないが、Task022 見出しは再利用）。

---

## Task026候補

- Journal 詳細から Performance（Task023）への導線
- 明示的な initial risk が取れるようになったあとの R multiple
- SL/TP が Trade 事実として保存されている場合の到達表示（推測なし）
- Review 内 Task022 見出しの compact 化
- 個別 Review への集計埋め込みは引き続き非推奨（推奨に見えやすい）
