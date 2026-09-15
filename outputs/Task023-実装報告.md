# Task023 Pre-Trade Context Performance / エントリー判断状況別の成績分析 実装報告

実装日：2026-09-15  
検証完了日：2026-09-15  
ステータス：**実装・検証完了**  
対象リポジトリ：AI-FX-Analyst  
ブランチ：`feature/task023-pretrade-context-performance`  
コミット・push：未実施（禁止どおり）

---

## 実装概要

Task023 は新しい AI 判断ではない。Task022 で Trade に保存済みの `preTradeContext` だけを読み、期間フィルタ済みの **決済済み実現損益** を group 比較する。

- source of truth は `trade.analysisSnapshot.preTradeContext` のみ
- 現在の AI / market / Daily Plan / Readiness / Watch では再分類しない
- OPEN は結果統計にも coverage 分母にも入れない
- legacy / 不正 context は `no_trigger` へ落とさず **Contextなし**
- WAIT を違反、Trigger MET を遵守、Event unavailable を LOW にしない
- サンプル不足では比較結論を出さない
- 因果・将来勝率・discipline score を生成しない

---

## 変更ファイル

### 新規

- `lib/trades/pre-trade-performance.ts` — pure 集計 / 比較文 / PF 表示 helper
- `components/trades/pre-trade-performance.tsx` — Performance 内パネル
- `tests/pre-trade-performance.test.ts` — A–AZ ほか
- `e2e/pretrade-performance.spec.ts` — Playwright 20 本
- `outputs/Task023-実装報告.md`（本報告）

### 更新

- `components/trades/performance.tsx` — Insights の直後にパネルを挿入。`filteredTrades` と period label を渡すだけ
- `app/globals.css` — 1 カラム / overflow-wrap / 比較リスト
- `e2e/fixtures/trades.ts` — preTradeContext 付き closed fixture
- `e2e/helpers/mock.ts` — `tradeSet: pretrade-performance | pretrade-full`

大規模 refactor なし。snapshot は read-only。

---

## source of truth

`sanitizePreTradeContext(analysisSnapshot.preTradeContext, trade.pair)` が残した値のみ。

Task022 helper を再利用：

- `triggerStatusAtEntry`
- `actionAtEntry`
- `eventRiskAtEntry`

加えて snapshot の `analysisStale` / `dailyLossLimitReached`。`eventRiskHigh` は独立パネルにせず、HIGH group と snapshot 検証用。

---

## eligible trade

CLOSED かつ `realizedPnl` が finite。Task014 `summarize` と同じ win/loss 定義。

- `realizedPnl > 0` → win
- `realizedPnl < 0` → loss
- `realizedPnl === 0` → break-even（`draws`）

OPEN / NaN / Infinity は除外。

---

## coverage

分母：period 内 eligible CLOSED  
分子：その中で valid preTradeContext あり

UI：

- 分析対象 CLOSED trades N
- Pre-Trade Contextあり N
- Contextなし N
- **保存率** X.X%（勝率・成立確率ではない）

---

## legacy/no-context

`preTradeContext` なし / sanitizer 後 null / legacy snapshot は Contextなし。`no_trigger` や `unavailable` へ再分類しない。

---

## period integration

Task015 `filterTradesByPeriod` 済みの `filteredTrades` を受け取る。内部 date filter なし。`openedAt` semantics は Task015 のまま。対象期間ラベル（全期間 / 直近30日 / 直近90日）をパネルに表示。

---

## min sample

`MIN_INSIGHT_SAMPLE_SIZE`（`lib/trades/analysis-price.ts` の 5）を import して再利用。新定数 `= 5` は作っていない。

`< 5`：数値は出すが「参考値」。比較文は出さない。

---

## Trigger groups

固定順：`met` → `not_met` → `unavailable` → `invalid` → `no_trigger`

| key | UI |
|---|---|
| met | 条件成立 |
| not_met | 条件未成立 |
| unavailable | 判定データ不足 |
| invalid | 構造化条件利用不可 |
| no_trigger | Triggerなし |

invalid は helper が返せる場合のみ group。no_trigger と同一視しない。

---

## Action groups

固定順：BUY / SELL / WAIT / unavailable（「Action未保存」）

これは Trade side ではない。見出しは **エントリー時Action**。Task013/016 alignment とは別軸。

---

## Freshness

`analysisStale` のみ。`fresh` = 最新分析、`stale` = 期限切れ分析。「stale だから負けた」は書かない。

---

## Event Risk

`eventRiskAtEntry`：LOW / MEDIUM / HIGH / 未取得。unavailable を LOW にしない。独立の eventRiskHigh パネルは作らない。

---

## DLL

`dailyLossLimitReached`：未到達 / 到達。「到達中 = 違反」とは書かない。sample が少ない場合は参考値のみ。

---

## metrics

各 group：sampleSize / wins / losses / breakEven / winRate / totalPnl / averagePnl / profitFactor / sufficientSample

`summarize`（Task014）を再利用。年率・期待収益は計算しない。

---

## win/loss definition

既存 Performance と同じ（上記 eligible 節）。既存定義を優先。

---

## Profit Factor

`grossProfit / abs(grossLoss)`。`summarize` は `grossLoss === 0` のとき **null**（Infinity を返さない）。0/0 も null。

UI：`formatContextProfitFactor` → `1.72` または `—`。

---

## comparison rules

テンプレートのみ。最大 3 件。neutral。両 group が `MIN_INSIGHT_SAMPLE_SIZE` 以上のときだけ。

1. Trigger met vs not_met の平均損益
2. Action：BUY/SELL/WAIT がすべて十分なとき一覧。そうでなければ WAIT が十分なときの件数+平均
3. fresh vs stale の平均損益

Event / DLL の因果比較は生成しない。LLM なし。

OK 例：「この期間の保存済み取引では、条件成立グループの平均損益は +¥…、未成立グループは … でした。」  
NG：「Trigger成立を待つべき」「WAITを無視すると負けやすい」

---

## causal wording禁止

比較文は `FORBIDDEN` 正規表現で生成時に拒否。UI 必須 disclaimer：

「この分析は保存済みのエントリー時情報と過去の取引結果を集計したものです。因果関係や将来の勝率・収益を示すものではありません。」

勝率は「過去の取引結果」「将来の勝率を示すものではありません」と併記。

---

## WAIT semantics

WAIT group の成績は表示する。ルール違反・悪い Entry・WAIT 無視とは書かない。WAIT は context であり全取引ルールではない。

---

## Trigger semantics

MET は「条件成立時に登録された過去取引」の集計。ルール遵守ではない。NOT_MET はルール違反ではない。equality の `not_met + 0 pips` も Task022 のまま not_met group。

---

## empty state

eligible CLOSED 0：「この期間には分析できる決済済み取引がありません」

（親 Performance が取引 0 件のときは従来どおり「この期間には取引記録がありません。」）

---

## partial coverage

context がある CLOSED だけを group 分析。missing は coverage で明示。

---

## group ordering

データ量で並べ替えない。固定順。

---

## zero groups

`sampleSize > 0` のみ表示。ゼロ件 group は出さない。順序は固定キー順。

---

## UI location

Period filter → Trading Review Insights → **Pre-Trade Context Performance** → Entry Timing → AI Entry Context → 既存 Performance。

Coverage を先に。続けて Trigger / Action / Freshness / Event / DLL の compact sections。

DQ / Confidence panel は Task014 既存を再利用し、Task023 では重複しない。Readiness / distance 別は見送り。

---

## mobile

390x844。既存 `.performance-cards` の 1 カラム（max-width 540px）。horizontal overflow なし。

---

## desktop

1280x900。group card 3 列。既存 Performance と同一カード様式。overflow なし。

---

## API追加call

OpenAI 0 / Vision 0 / Twelve Data 0 / Finnhub 0 / FRED 0 / EODHD 0

---

## Supabase追加query

0。Dashboard/Journal 取得済み trades のみ。

---

## DB

migration 0 / RLS 0 / new table 0。snapshot 更新なし。backfill なし。

---

## privacy

外部送信なし。API secret / raw OpenAI / chart image / raw candles を扱わない。

---

## performance

trades を 1 回スキャンして bucket へ振り分け。O(n)。早すぎる最適化はしていない。

---

## unit tests

Task022：**488 pass** を維持し追加。今回 **542 pass / 0 fail**。

A–Z / AA–AZ：empty / OPEN / no-context / partial coverage / denominator / trigger 各 status / Action / freshness / Event / DLL / win-loss-BE / avg / total / PF / no Infinity / sample 5 / OPEN・invalid PnL 除外 / legacy ≠ no_trigger / 内部 period なし / deterministic / no mutation / no fetch / no OpenAI / no Supabase / no causal / no ruleFollowed / 固定順 / zero group / 比較条件と cap / Event unavailable ≠ LOW / WAIT ≠ 違反 / MET ≠ 遵守 / coverage % / period label / PF helper / 大小 PnL。

`MIN_INSIGHT_SAMPLE_SIZE` の再利用を source 検査。

---

## E2E

Task022：**79 本維持**。新規 20 本。合計 **99 passed**。

1 section / 2 coverage full / 3 partial / 4 no-context / 5 MET / 6 NOT_MET / 7 WAIT / 8 stale / 9 Event 未取得 / 10 DLL / 11 参考値 / 12 十分な metrics / 13 中立比較（禁止文言なし） / 14 全期間 / 15 30d / 16 90d / 17 OPEN 除外 / 18 legacy は no_trigger にしない / 19 390 / 20 1280

実 Supabase / OpenAI / Twelve Data へ通信しない。

---

## regression

壊していない：Daily Trading Plan / Entry Readiness / Structured Trigger / Watch / Trade 登録 / Pre-Trade Context Snapshot / Journal / Trading Review Insights / Period filter / Entry Timing / AI Entry Context / 既存 Performance。

---

## lint / build / diff

| コマンド | 結果 |
|---|---|
| `npm run lint` | pass |
| `npm test` | 542 pass |
| `npm run test:e2e` | 99 passed |
| `npm run build` | pass（既存 Supabase Node 20 警告のみ） |
| `git diff --check` | pass |

---

## known limitations

- Readiness 件数別・Trigger distance 別は未実装（distance は MET=0 と equality NOT_MET=0 が混在）
- Trigger × Action 等の compound 分析はしない（sample fragmentation）
- Event / DLL の自動比較文は出さない
- pair cross-analysis は Task014 既存に任せる
- 比較文は平均損益の事実記述まで。推奨・予測はしない
- 親 Period が取引 0 件のときは Task023 専用 empty ではなく既存「取引記録がありません」

---

## Task024候補

- Trigger × Action / stale / Event / Trade side の compound
- Trigger distance band（equality 0 と MET 0 を分離した設計が必要）
- Readiness 0–2 / 3–4 / 5（品質ラベルは付けない）
- pair × context
- OPEN の未実現は引き続き成績に入れない
