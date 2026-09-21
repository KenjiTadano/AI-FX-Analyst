# Task108 — Similar Historical Trade Context

Branch: `feature/v1.1-task108-similar-historical-context`  
commit / push: していない。

## Verdict

**PASS**

現在の Dashboard Market Context（既取得 `MarketData`）と、過去 Trade の Original `marketContextSnapshot` を比較し、市場状態が近い過去事例を参考表示する。類似度に P/L・R・勝敗・AI は使わない。

---

## Inspected architecture

| 部品 | 役割 |
| --- | --- |
| `captureMarketContextSnapshot` | ライブ MarketData → 正規 Snapshot（再利用） |
| `marketContextFromTrade` | Original のみ（revision / AI snapshot 除外） |
| Task106 `smaRelation` / `CHANGE_TIMEFRAME_ORDER` | Technical / TF 次元 |
| Task103 `classifyRsiBucket` / `realizedROrNull` | RSI bucket / Outcome 表示のみ |
| Task107 Trade Evolution | Entry後変化。**類似候補には使わない** |

---

## Current context source

`buildCurrentMarketContext` → `captureMarketContextSnapshot({ pair, capturedAt, market, marketRate })`

- 追加 market API なし（Dashboard の `useMarket` 結果のみ）
- `capturedAt` は取得済み `price.fetchedAt`（不正なら固定 ISO fallback）
- 不足分野は null のまま（捏造しない）

UI: Analysis → Market セクション下部（`ia-market-detail`）

---

## Historical eligibility

採用: **CLOSED + finite realizedPnl + Original snapshot sanitize 成功 + same pair**

| 除外 | 理由 |
| --- | --- |
| OPEN | 参考 Outcome が無く、分析画面の historical reference として薄い |
| Original なし | provenance 維持 |
| revisions のみ | Entry 時 Context ではない（Task107 領域） |
| legacy analysisSnapshot | Original として混ぜない |
| 他ペア | pair mismatch をごまかさない |

---

## Pair strategy

same-pair only（USD/JPY↔USD/JPY 等）。cross-pair なし。

---

## Similarity dimensions（11）

1. MTF trend: 15m / 1h / 4h / 1D  
2. Regime: regime / trendDirection / volatility  
3. Technical: SMA20/75/200 relation + RSI bucket  

各次元: `match` | `mismatch` | `not_comparable`

raw `marketRate` / absolute price distance はスコアに使わない。

---

## Score formula

```
comparable = match + mismatch の件数
ratio = matches / comparable
percent = round(ratio * 1000) / 10
```

weighting なし（単純 match ratio）。

---

## Minimum comparable guard

`MIN_COMPARABLE_DIMENSIONS = 5`

未満 → ranking 対象外（`insufficient_comparable`）。1項目一致で 100% に見せない。

---

## Threshold

`MIN_SIMILARITY = 0.6`

未満は候補外。「悪い context」とは呼ばない。

---

## Ranking / tie-break

1. similarity ratio desc  
2. comparable count desc  
3. openedAt desc  
4. tradeId desc  

**禁止:** P/L / R / win-loss / AI（`rankSimilarMatches` が outcome を読まない）

---

## Result limit

`MAX_SIMILAR_RESULTS = 5`

---

## Outcome display

検索・ランキング後のみ:

- entry date / pair / side  
- realized P/L  
- realized R（あれば。missing ≠ 0R）  

OPEN は候補外のため outcome unavailable 表示パスは防御的に残す。

---

## Disclaimer（必須）

- 「市場コンテキストが似ていても、同じ結果になることを意味しません。」  
- 「過去の損益は類似度の計算には使用していません。」  

aggregate 勝率・予測文言なし。

---

## No-data UX

| reason | 意味 |
| --- | --- |
| `current_unavailable` | 現在 Context 不可 |
| `no_historical_snapshot` | Original なし |
| `no_same_pair_candidate` | same-pair 候補なし |
| `insufficient_comparable` | 比較項目不足 |
| `below_threshold` | しきい値未満 |

---

## Task107 separation / PI isolation

- revisions を類似ソースにしない  
- `buildPerformanceIntelligence` / `buildTradeEvolutionPerformance` を変更しない  
- similarity score を PI に混ぜない  

---

## DB / API / AI

migration 0 / column 0 / RPC 0 / RLS 変更なし  
market request 追加 0 / AI 0 / embedding 禁止 / DB write なし

---

## Changed files

- `lib/trades/context-similarity.ts`（新規）
- `components/dashboard/similar-historical-context.tsx`（新規）
- `components/dashboard/dashboard.tsx`（Market 下部に配置）
- `app/globals.css`
- `tests/context-similarity.test.ts`（新規）
- `e2e/similar-historical-context.spec.ts`（新規）
- `outputs/Task108-Similar-Historical-Context.md`（本ファイル）

---

## Tests

Unit: pair / original / revision除外 / MTF·Regime·Technical / raw price無視 / ratio / min comparable / threshold / ranking・outcome除外 / max5 / CLOSED outcome / empty UX / disclaimer / PI·Evolution回帰 / immutability / no API·AI

E2E: パネル表示・disclaimer・予測禁止・empty/list・mobile overflow

---

## Unit / E2E / build

| Check | Result |
| --- | --- |
| Unit | **1158** passed（Task107 baseline 1140↑） |
| E2E | **344** passed（Task107 baseline 341↑） |
| lint | PASS（既存 finance-calendar warning のみ） |
| build | PASS |
| `git diff --check` | PASS |

---

## Known limitations

- CLOSED only（OPEN 類似は v1 対象外）  
- equal SMA は `smaRelation("equal")` として比較可能  
- current と historical で片側 unavailable の次元は comparable に入らない  
- 期間フィルタは Dashboard 全 trades（成績 period とは独立）  

---

## Future work

- optional period filter  
- structure 次元の追加  
- OPEN「保有中の類似」表示（outcome なし）  
- equal-weight 以外の説明可能な weighting  
