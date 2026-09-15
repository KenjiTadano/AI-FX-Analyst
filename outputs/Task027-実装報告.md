# Task027 MTF Snapshot / エントリー時マルチタイムフレーム保存 実装報告

実装日：2026-09-15  
検証完了日：2026-09-15  
ステータス：**実装・検証完了**  
対象リポジトリ：AI-FX-Analyst  
ブランチ：`feature/task027-mtf-snapshot`  
コミット・push：未実施（禁止どおり）

---

## 実装概要

Task027 は新しい売買判断ではない。Task026 の **Live MTF** を、Trade 登録ボタンを押した時点の市場構造として **immutable snapshot** に残し、Journal / Post-Trade Review で見返せるようにした。

対象フロー:

```
1D / 4H / 1H / 15m
        ↓
Live MTF
        ↓
AI Direction / Action
        ↓
Pre-Trade Review
        ↓
Trade登録
        ↓
MTF Snapshot  ← 本 Task
        ↓
Journal / Post-Trade Review
```

保存するのは Live MTF と同じ **summary** だけ（trend / structure / bias / alignment / conflicts / 指標数値）。OHLC candles は保存しない。MTF helper 自身は引き続き BUY / SELL / WAIT を出さない。

最重要原則：**OUTCOME MUST NOT REWRITE CONTEXT.** 利益でも損失でも alignment は書き換えない。現在の Live MTF を過去 Trade に当てない。

---

## 変更ファイル

### 新規

- `lib/trades/mtf-snapshot.ts` — capture / stored helper / 表示文言
- `components/trades/mtf-snapshot.tsx` — Journal / Post-Trade 用 compact 表示
- `tests/mtf-snapshot.test.ts` — A–V
- `e2e/mtf-snapshot.spec.ts` — Playwright 13 本
- `outputs/Task027-実装報告.md`（本報告）

### 更新

- `lib/trades/types.ts` — optional `multiTimeframeAnalysis`
- `lib/trades/snapshot.ts` — create 時に Live MTF を添付。不正ならフィールドだけ null
- `lib/trades/service.ts` — `CreateTradeOptions.market`
- `components/dashboard/dashboard.tsx` — 表示中 `market` を Journal へ渡す
- `components/trades/journal.tsx` — create 時に pair 一致の market のみ渡す
- `components/trades/trade-form.tsx` — トグル ON 時の compact preview
- `components/trades/trade-list.tsx` — OPEN 詳細に保存済み MTF
- `components/trades/post-trade-review.tsx` — CLOSED Review に保存済み MTF
- `app/globals.css` — `.mtf-snapshot*`（1カラム / overflow-wrap）
- `e2e/helpers/mock.ts` — `setMarket({ mtf })` で登録後の Live 変化を再現
- `lib/supabase/database.types.ts` — JSONB コメントのみ
- `tests/multi-timeframe.test.ts` — BJ を「Live helper は自分で persist しない」へ更新

大規模 refactor なし。Task013 snapshot `version: 1` と必須フィールドは維持。migration / RLS / 新 table なし。

---

## snapshot schema

既存 `TradeAiAnalysisSnapshot` の optional sibling（Task022 `preTradeContext` と同型）:

```ts
multiTimeframeAnalysis?: MultiTimeframeAnalysis | null
```

`MultiTimeframeAnalysis` は Task026 の summary 型を再利用する。

| 項目 | 内容 |
|---|---|
| pair | Trade pair。不一致は fail closed |
| analyzedAt | 表示中 market の取得時刻（daily / price `fetchedAt`。無ければ登録 `capturedAt`） |
| timeframes[4] | 1D / 4H / 1H / 15m の trend / structure / SMA / RSI / dataPoints |
| higherTimeframeBias | 1D+4H。片方欠落は unavailable |
| alignment | 4/4 のみ aligned_*。1つでも unavailable → insufficient |
| conflicts | 最大 3。raw candles なし |
| candles / values | **禁止**。sanitizer がトップレベルにあればフィールド全体を落とす |

親 snapshot の `version` は **1 のまま**。必須 AI フィールドは変えていない。

---

## source of truth

登録時: Dashboard が表示している `MarketData`（`useMarket(selectedPair)`）をコピーする。追加 Twelve Data fetch はしない。AI `AnalysisInput.multiTimeframeAnalysis` からは取らない（AI cache と Live の時刻がずれうるため）。

表示時: `trade.analysisSnapshot.multiTimeframeAnalysis` のみ。表示前に `sanitizeMultiTimeframeAnalysis(raw, trade.pair)` を通す。

現在の Live MTF / 再分析 / 決済損益からは再計算しない。

---

## capture 経路

`createTrade` → `captureTradeAiSnapshot` → `captureMultiTimeframeSnapshot(market, pair, analyzedAt)` → `sanitizeMultiTimeframeAnalysis`

`editTrade` / `closeTrade` は既存どおり `analysisSnapshot` を置き換えない。DB UPDATE も `analysis_snapshot` を変更できない（Task013 trigger）。

Journal は `market.symbol === draft.pair` のときだけ渡す。Dashboard 選択 pair と記録 pair が違う場合は MTF なし（他 pair の構造を混ぜない）。

---

## トグル / AI なし

Task013 と同じトグル「現在のAI分析をこの取引に保存」に乗る。

| 条件 | AI snapshot | MTF snapshot |
|---|---|---|
| トグル ON + AI pair 一致 + market pair 一致 | 保存 | 保存（unavailable 足も含む事実） |
| トグル ON + AI あり + market なし / pair 不一致 | 保存 | `null` |
| トグル OFF | なし | なし |
| AI なし | なし | なし |

AI なしでも Trade 自体は成功する。MTF だけ独立保存する schema は作っていない（既知の結合）。

---

## sanitizer

Task022 と同じ fail-soft:

- 不正 MTF / pair mismatch / raw candles → **フィールドだけ null**。Task013 snapshot 全体は落とさない
- 親の secret scan は MTF を除外し、壊れた MTF で AI snapshot を殺さない
- sanitizer 後の MTF に secret-like 文字列があれば MTF だけ null

---

## UI

### 登録フォーム

トグル ON 時の snapshot-card に compact 1 行:

`市場構造：上向き · すべての時間軸が上向きです`

Live MTF カードの巨大複製はしない。Pre-Trade Review コンポーネントにも MTF カードを埋め込まない。

### OPEN Journal

エントリー時AI分析の詳細内に compact「エントリー時の市場構造」。4 行の trend / structure と conflict。SMA 表は出さない。

### CLOSED Post-Trade Review

利益・損失の下、Context の後に同じ compact 表示。現在の Live MTF は出さない。

文言:

- 保存なし: `エントリー時のマルチタイムフレーム分析は保存されていません`
- 壊れている / pair mismatch: `エントリー時のマルチタイムフレーム分析は確認できません`
- note: `取引登録時に保存されたマルチタイムフレーム分析です。現在の市場や取引結果では再評価していません。`
- disclaimer: `各時間軸は確定足のSMA並びから計算した市場状態です。売買の推奨ではありません。`

---

## 禁止事項（遵守）

- 新しい OpenAI / Vision / Twelve Data / 外部 API call なし
- 新 polling / timer なし（既存 60 秒 market refresh のみ）
- migration / RLS / 新 table / snapshot version bump なし
- 過去 Trade の backfill / live 推測なし
- close 時の snapshot UPDATE なし
- MTF から Action / Direction を再生成しない
- aligned_bullish を Entry OK / 買い推奨にしない
- 利益で mixed を aligned に書き換えない
- Task023 Performance に MTF 分類を足さない
- Pre-Trade Review へ巨大 Live カードを複製しない
- raw OHLC を JSONB に入れない

---

## 既存機能の維持

Live MTF（Task026）、AI Direction / Action、Pre-Trade Review、Task013 AI snapshot、Task022 PreTrade snapshot、Post-Trade Review、Task023 Performance、Daily Plan、Readiness、Trigger、Watch、Journal CRUD。

Task003 の 15m/1h/4h テクニカル重みと DQ 分母 3 は未変更。

---

## テスト

### Unit `tests/mtf-snapshot.test.ts`（A–V、22）

| ID | 内容 |
|---|---|
| A | all-bullish 保存 |
| B | all-bearish 保存 |
| C | mixed + conflict。Action なし |
| D | market なし → MTF null、AI は残る |
| E | 他 pair market をコピーしない |
| F | トグル OFF → snapshot 全体 null |
| G | AI なし → snapshot null |
| H | candles / values 非保存 |
| I | edit 不変 |
| J | close 不変（利益でも aligned_bullish のまま） |
| K | 利益でも mixed を書き換えない |
| L | candles 混入はフィールドだけ落とす |
| M | secret-like conflict は MTF だけ落とす |
| N | stored helper の pair mismatch → unreadable |
| O | legacy に field なし |
| P | capture の fail closed |
| Q | 欠落足は unavailable のまま保存 |
| R | alignment から BUY/SELL/WAIT を作らない |
| S | 推奨文言なし |
| T | fetch / OpenAI / Twelve Data なし |
| U | version 1 維持 |
| V | 後から bearish になっても保存値は bullish |

Task026 BJ は「Live helper は persist しない」へ更新（本 Task が snapshot を所有するため）。

### E2E `e2e/mtf-snapshot.spec.ts`（13）

1 preview / 2 all-bullish Journal / 3 mixed + conflict / 4 トグル OFF / 5 pair mismatch / 6 edit 不変 / 7 close → Post-Trade に保存値（利益でも上向き） / 8 Live が下向きに変わっても Journal は上向き / 9 legacy missing / 10 推奨文言なし / 11 外部通信なし / 12 390 overflow / 13 1280 overflow

---

## 検証結果

| コマンド | 結果 |
|---|---|
| `npm test` | **727 pass / 0 fail**（前回 Task026 完了時 705。本 Task +22） |
| `npm run test:e2e` | **187 passed**（前回 174。本 Task +13） |
| `npm run lint` | 成功 |
| `npm run build` | 成功 |
| `git diff --check` | 問題なし |

実 Supabase / 実 Twelve Data / 実 OpenAI へは通していない。E2E は既存 mock（in-memory trades、PATCH 時 snapshot 不変）で登録〜決済まで確認した。

---

## 既知の結合 / 非対象

1. MTF snapshot は Task013 AI snapshot に同梱する。AI なし / トグル OFF では MTF も残らない
2. 過去 CLOSED Trade の backfill はしない（「保存されていません」）
3. Task023 に MTF alignment 別成績は足していない
4. Pre-Trade Review 本体へ MTF カードは複製していない（登録カードの 1 行 preview のみ）
5. OPEN の巨大 Live カードと Journal compact は別 UI。Live は現在値、Journal は登録時

---

## 次タスク候補

- Task023 に保存済み MTF alignment 別の成績グループ（品質ラベルなし）
- AI なしでも MTF だけ保存する独立フィールド
- 明示操作での snapshot 差し替え（自動更新はしない）
