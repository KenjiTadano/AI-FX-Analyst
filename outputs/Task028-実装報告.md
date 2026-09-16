# Task028 MTF Performance Analysis / エントリー時MTF別の過去実績 実装報告

実装日：2026-09-16  
検証完了日：2026-09-16  
ステータス：**実装・検証完了**  
対象リポジトリ：AI-FX-Analyst  
ブランチ：`feature/task028-mtf-performance`  
コミット・push：未実施（禁止どおり）

---

## 実装概要

Task028 は新しい売買判断でも予測モデルでもない。Task027 で Trade に保存済みの `multiTimeframeAnalysis` だけを読み、期間フィルタ済みの **決済済み実現損益** を MTF 状態ごとに集計する。

- source of truth は `trade.analysisSnapshot.multiTimeframeAnalysis` と `realizedPnl`
- 現在の Live MTF / Market / AI / Daily Plan / Readiness / Watch / Pre-Trade Review では再分類しない
- OPEN と NaN / Infinity PnL は対象外
- legacy / pair mismatch / malformed は **Contextなし**（insufficient に混ぜない）
- WAIT Action を違反扱いしない。Direction と Action を混同しない
- 因果・推奨・品質スコアを生成しない

`lib/trading-review/` はリポジトリに存在しないため、Task023 と同じ `lib/trades/` に pure function を置いた。

---

## 変更ファイル

### 新規

- `lib/trades/mtf-performance.ts` — `buildMtfPerformanceAnalysis` / 分類 / 比較文
- `components/trades/mtf-performance.tsx` — Performance 内パネル
- `tests/mtf-performance.test.ts` — A–AZ + critical 1–5
- `e2e/mtf-performance.spec.ts` — Playwright 25 本
- `outputs/Task028-実装報告.md`（本報告）

### 更新

- `components/trades/performance.tsx` — Pre-Trade Context Performance の直後、Entry Timing の前に配置。`filteredTrades` のみ渡す
- `app/globals.css` — Task023 と同じ 1 カラム / overflow-wrap を `.mtf-perf-*` に共有
- `e2e/helpers/mock.ts` — `tradeSet: "mtf-performance"`
- `e2e/fixtures/trades.ts` — 保存済み MTF + legacy fixture

大規模 refactor なし。Task023 の `summarize` / `formatContextProfitFactor` / `MIN_INSIGHT_SAMPLE_SIZE` / `aiBuySellDirection` / `storedMultiTimeframeAnalysis` を再利用。

---

## source of truth

MTF：`storedMultiTimeframeAnalysis(trade)` → Task027 sanitizer。  
損益：`trade.realizedPnl`（再計算しない）。  
期間：Task015 `filterTradesByPeriod` の結果を引数で受け取る。内部 date filter なし。

---

## eligible trades

`status === "closed"` かつ `realizedPnl` が finite number。OPEN / null / NaN / Infinity 除外。Task023 と同じ規則。

---

## period semantics

`buildMtfPerformanceAnalysis(filteredTrades, periodLabel)`。all / 30d / 90d 切替は既存 Period filter が `filteredTrades` を更新するだけ。Task028 は window を持たない。

---

## coverage

- denominator: eligible CLOSED
- numerator: sanitizer 後に valid な saved MTF を持つ eligible
- eligible=0 → `coverageRate: null`（UI は空状態。0% と出さない）
- 表示: `MTF保存あり 35 / 40` と百分率（1 小数）

---

## legacy semantics

Task027 以前（field なし / legacy snapshot）は Contextなし。`alignment=insufficient` や `HTF=unavailable` へ再分類しない。

---

## sanitizer

Task027 `storedMultiTimeframeAnalysis` を再利用。

pair mismatch / malformed / candles / secret rejection → Contextなし。現在値補完なし。

---

## Alignment groups

固定順（0 件は非表示）:

| key | 表示 |
|---|---|
| aligned_bullish | 全時間軸で上向き |
| aligned_bearish | 全時間軸で下向き |
| mixed | 時間軸で方向が混在 |
| insufficient | データ不足 |

aligned = 良い / mixed = 悪い とは書かない。

---

## HTF groups

保存済み `higherTimeframeBias` のみ。再計算しない。

| key | 表示 |
|---|---|
| bullish | 上向き |
| bearish | 下向き |
| neutral | 中立 |
| unavailable | 未取得 |

---

## AI Direction × MTF groups

Direction 源は Task013 saved `directionSignal` のみ。`aiBuySellDirection` を再利用。

| key | 表示 | 規則 |
|---|---|---|
| aligned_with_ai | 方向一致 | BUY+aligned_bullish または SELL+aligned_bearish |
| contrary_to_ai | 逆方向 | BUY+aligned_bearish または SELL+aligned_bullish |
| mixed | 時間軸混在 | MTF alignment mixed（AI より優先） |
| insufficient | MTFデータ不足 | MTF alignment insufficient |
| ai_direction_unavailable | AI方向未取得 | wait / neutral / 非 rich snapshot |

「方向一致」は Entry correctness ではない。

---

## WAIT semantics

Action WAIT でも Direction が BUY/SELL なら分類する。WAIT をルール違反・無視と書かない。Action 別 Performance は新設しない（Task023 と重複させない）。

---

## metrics

Task023 `summarize` 再利用:

sampleSize / wins / losses / breakEven / winRate / totalPnl / averagePnl / profitFactor / sufficientSample

win: PnL > 0、loss: < 0、breakEven: === 0。

---

## Profit Factor

`grossLoss === 0` → `null`。UI `—`。Infinity / 0 除算なし。`formatContextProfitFactor` 再利用。

---

## minimum sample

`MIN_INSIGHT_SAMPLE_SIZE`（`lib/trades/analysis-price.ts` の 5）を import。重複 constant なし。不足 group は事実値 + 「参考値」。比較には使わない。

---

## deterministic comparisons

最大 3。両方 sufficient のときのみ。

1. 方向一致 vs 逆方向の平均損益
2. 全時間軸上向き vs 混在
3. HTF 上向き vs 下向き

「優秀」「狙うべき」は出さない。因果を示唆しない。

---

## wording safety

禁止: alignedだから勝率が高い / mixedだから負けやすい / 4/4を待つべき / HTFに逆らうと負ける / この条件なら勝てる / Good Setup / MTF Score / Entry OK。

許可: 保存件数と平均損益の事実。

---

## historical integrity

CURRENT MTF MUST NEVER REWRITE HISTORICAL MTF。Live fixture を bearish にしても保存 bullish の分類は変わらない。AI 再分析も無視。

---

## all unavailable

valid snapshot。coverage numerator に含む。Alignment insufficient / HTF unavailable。legacy と区別。

---

## partial

3/4 は valid。alignment=insufficient。欠損足を現在値で埋めない。

---

## pair mismatch

sanitizer が null → Contextなし。他 pair として分類しない。

---

## UI placement

Period filter → Trading Review Insights → Pre-Trade Context Performance → **MTF Performance Analysis** → Entry Timing → AI Entry Context → 既存 Performance。

英語 eyebrow: `MULTI-TIMEFRAME PERFORMANCE`  
日本語 title: `エントリー時MTF別の過去実績`

カード: 件数 / 勝・負・±0 / 勝率 / 平均損益 / PF。390 は縦積み（既存 `.performance-cards`）。1280 は 3 列。

---

## responsive

390x844: 1 カラム。横テーブルなし。1280x900: 既存 performance-cards。overflow なしを E2E で確認。

---

## disclaimer

専用:

> この集計は取引登録時に保存されたMTF情報と、決済済み取引の過去結果を集計したものです。特定のMTF状態が将来の利益や勝率を保証するものではなく、結果との因果関係を示すものでもありません。

Task023 disclaimer は別パネルに残している。

---

## API / Supabase / polling / DB

| 項目 | 数 |
|---|---|
| Twelve Data / OpenAI / Vision / Finnhub / FRED / EODHD | 0 |
| Supabase extra query | 0（既存 Trade array のみ） |
| 追加 timer / polling | 0 |
| migration / new table / new column / RLS | 0 |

結果は persist しない。毎回 O(n) の pure 計算。Trade / snapshot を mutation しない。

---

## complexity

O(n)。Trade ごとに外部アクセスしない。

---

## unit tests

`tests/mtf-performance.test.ts`

A–AZ および critical 1–5（WAIT+BUY、contrary を「悪い」としない、legacy≠insufficient、all-unavailable valid、Live 非使用で deepEqual）。

`npm test`: **785 pass / 0 fail**（Task027 完了時 727。本 Task +58）

---

## E2E

`e2e/mtf-performance.spec.ts` 25 本。section / empty / coverage / legacy / insufficient / unavailable / alignment / HTF / AI aligned+contrary / WAIT / 参考値 / PF — / period all·30d·90d / Live 不変 / AI 不変 / 推奨なし / 因果なし / 390 / 1280 / 外部通信なし。

`npm run test:e2e`: **212 passed**（Task027 完了時 187。本 Task +25）

---

## regression

Task015 period、Task016 AI Entry Context、Task023 PreTrade Performance、Task024 Review、Task025 PostTrade、Task026 Live MTF、Task027 Snapshot を含む既存 E2E は全通過。

---

## 検証結果

| コマンド | 結果 |
|---|---|
| `npm run lint` | 成功 |
| `npm test` | **785 pass** |
| `npm run test:e2e` | **212 passed** |
| `npm run build` | 成功 |
| `git diff --check` | 問題なし |

---

## known limitations

1. 1D / 4H / 1H / 15m 個別の bullish vs bearish は未集計（v1.1）
2. SMA / RSI bucket は未集計（v1.1）
3. Action 別は Task023 に任せ、本 Task では作らない
4. AI なし / トグル OFF の Trade は MTF も無い（Task027 結合）

---

## Task029候補

- 時間足別（1D/4H/1H/15m）の trend 別成績
- SMA/RSI 帯の参考集計（品質スコアなし）
- 保存済み MTF × Trigger の交差（因果ラベルなし）
