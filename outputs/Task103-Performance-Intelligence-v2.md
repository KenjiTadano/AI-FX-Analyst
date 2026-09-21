# Task103 — Performance Intelligence v2

Branch: `feature/v1.1-task103-performance-intelligence-v2`  
commit / push: していない。

## Verdict

**PASS**

Task032 Performance Intelligence を拡張し、保存済み CLOSED trade の entry snapshot から

- Individual Timeframe（15m / 1h / 4h / 1D）
- SMA Context
- RSI Context

を追加した。BUY/SELL/WAIT 生成はしない。現在市場からの historical 再計算なし。DB migration / 新規 API / AI request なし。

---

## Inspected Task032 architecture

| 部品 | 役割 |
| --- | --- |
| `lib/trades/performance-intelligence.ts` | `buildPerformanceIntelligence` — CLOSED + realizedPnl、Regime / MTF / PreTrade / Regime×MTF、R、Observations |
| `lib/trades/mtf-performance.ts` | Alignment / HTF / AI×MTF |
| `lib/trades/pre-trade-performance.ts` | Trigger / Action / Freshness / Event / DLL |
| `lib/trades/performance-period.ts` | Task015 period filter（呼び出し側） |
| `components/trades/performance-intelligence.tsx` | 成績 UI |
| `tests/performance-intelligence.test.ts` / `e2e/performance-intelligence.spec.ts` | 回帰 |

原則（維持）:

- Entry snapshot のみ（OUTCOME MUST NOT REWRITE CONTEXT）
- n &lt; 5 はサンプル不足明示
- Observations 最大 5・deterministic・recommendation 禁止
- realizedR 欠落は 0R にしない

---

## Available snapshot fields

調査結果、**すでに永続化されている**:

### MTF (`analysisSnapshot.multiTimeframeAnalysis`)

各 `timeframes[]`（15m / 1h / 4h / 1day）:

- `trend`, `structure`, `sufficientData`
- `lastClose`, `sma20`, `sma75`, `sma200`, `rsi14`
- `recentHigh`, `recentLow`, `dataPoints`

### Regime (`analysisSnapshot.marketRegimeAnalysis`)

- `regime`, `trendDirection`, `volatility`
- `evidence.close`, `evidence.sma20/75/200`, `evidence.rsi14`, ATR 系

### その他（Task032 既存）

- PreTrade context、Action、Exit Plan / realizedR

Task103 の SMA/RSI は **MTF 1h frame を優先**、無ければ **Regime evidence（1h）** を使用。推測生成なし。

---

## Unavailable snapshot fields

| 項目 | 状態 |
| --- | --- |
| エントリー価格と SMA の専用フィールド | 無し（MTF/Regime の close を使用） |
| 複数 TF 横断の「統合 RSI」 | 無し（1h のみ） |
| partial / multi-exit R | Task103 スコープ外 |
| legacy snapshot（version 無し） | MTF/Regime/技術指標なし → 分析除外 |

DB migration で schema 追加はしていない。

---

## Changed files

| Path | Change |
| --- | --- |
| `lib/trades/performance-intelligence.ts` | TF / SMA / RSI 集計、R ± count、observations 拡張 |
| `components/trades/performance-intelligence.tsx` | Overview → R → Market → Timeframe → Technical → Observations |
| `app/globals.css` | timeframe stack の最小スタイル |
| `tests/performance-intelligence.test.ts` | v2 unit cases |
| `e2e/performance-intelligence.spec.ts` | v2 UI 可視性 |
| `outputs/Task103-Performance-Intelligence-v2.md` | 本報告 |

---

## Timeframe analysis

- 対象: 保存 MTF がある trade のみ、各 TF で `sufficientData` かつ trend ≠ unavailable
- グループ: bullish / bearish / neutral
- 指標: sample / wins / losses / win rate / total·average P/L / R n · average R · total R
- 欠落: 「MTF snapshotなし」「この時間軸の保存データなし」

---

## SMA analysis

- 保存 1h close と SMA20/75/200 が揃う場合のみ
- buckets: `price > SMA*` / `price < SMA*`（等号は除外・推測しない）
- データ無しは架空 UI を出さず理由表示

---

## RSI analysis

- 保存 1h `rsi14` のみ
- Deterministic buckets: `&lt;30` / `[30,45)` / `[45,55)` / `[55,70]` / `&gt;70`
- 欠落時は「RSIがsnapshotにありません」等（笼統な「データなし」のみにしない）

---

## Sample safety

- `MIN_INSIGHT_SAMPLE_SIZE = 5` 維持
- UI: 「サンプル不足（n&lt;5・参考値）」
- 「有利」「勝ちやすい」等の断定なし

---

## R handling

- Task031 `calculateRealizedR` / `summarizeRPerformance` のみ
- missing ≠ 0R
- UI: average R / total R / positive R count / negative R count

---

## UI

```
Overview (+ coverage)
→ R Metrics
→ Market Context（既存 MTF / Regime / PreTrade / Regime×MTF）
→ Timeframe（個別 TF）
→ Technical Context（SMA / RSI）
→ Observations
```

カード/stack 中心。dashboard ナビは未変更。

---

## No-data UX

| 状態 | 表示 |
| --- | --- |
| sample 不足 | 参考値ラベル |
| MTF snapshot なし | TIMEFRAME_NO_MTF |
| 特定 TF なし | TIMEFRAME_NO_FRAME |
| 価格なし | TECHNICAL_NO_PRICE |
| SMA なし | TECHNICAL_NO_SMA |
| RSI なし | TECHNICAL_NO_RSI |
| R なし | 「0Rではなく集計対象外」 |

---

## Observations

- 最大 5
- 事実記述のみ（例: 「4H bullish contextではn=…、平均Rは…」）
- causal / recommendation 禁止（FORBIDDEN ガード維持）

---

## Tests

Unit（追加）: CLOSED only、period、MTF missing、TF grouping/metrics、n&lt;5、R missing≠0、SMA あり/なし、RSI buckets/境界/なし、Regime·MTF 回帰、3軸なし、live 再計算なし、observations/forbidden。

E2E: 既存 + `pi-timeframe` / `pi-technical` / `pi-sma` / `pi-rsi` / overflow。

---

## Unit / E2E / build

| 項目 | 結果 |
| --- | --- |
| lint | PASS（既存 finance-calendar unused warning 1） |
| Unit | **PASS 1063**（Task102 baseline 1054 を下回らない） |
| E2E | **PASS 333**（Task102 baseline 332 を下回らない。+1） |
| build | PASS |
| git diff --check | PASS |
| migrations | **0** |
| new API requests | **0** |
| new AI requests | **0** |

E2E: `CI=1 E2E_PORT=3016`。

---

## Known limitations

1. SMA/RSI は 1h 保存値のみ（他 TF の個別 SMA/RSI 集計は未実装・過学習回避）
2. price === SMA の trade は gt/lt どちらにも入れない
3. legacy / snapshot 無し trade は技術分析から除外
4. 3 軸 cross は作らない（Regime×MTF のみ維持）
5. partial exit / multi-leg R は対象外

---

## Recommended future persistence fields

必要なら将来（別 Task）で検討:

- entry 時点の明示的 `entryPriceVsSma` / `entryRsi`（TF 付き）
- 複数 TF の RSI を分析したい場合の TF 別タグ
- coverage 用の `technicalContextVersion`

現状の MTF/Regime evidence で Task103 は充足。migration は不要だった。
