# Task107 — Trade Evolution Performance

Branch: `feature/v1.1-task107-trade-evolution-performance`  
commit / push: していない。

## Verdict

**PASS**

保存済み Original（Task104）と Latest Revision（Task105 append 末尾）を Task106 `compareMarketContexts` で比較し、CLOSED トレードの実現結果を記述的に集計する Trade Evolution を Performance Intelligence 下部に追加した。売買判断・因果主張・DB/API/AI 変更なし。

---

## Inspected architecture

| 部品 | 役割 |
| --- | --- |
| Task103 `buildPerformanceIntelligence` | Entry 時コンテキスト × 実現結果（変更せず） |
| Task104 `marketContextSnapshot` | Entry 原本（immutable） |
| Task105 `marketContextRevisions[]` | append-only 再取得履歴 |
| Task106 `compareMarketContexts` | Original→Latest 差分判定（再利用） |
| Task107 `buildTradeEvolutionPerformance` | 差分ステータス × 実現結果の集計 |

Entry Performance と Trade Evolution は概念的に分離し、1つの score に混ぜない。

---

## Eligibility rules

対象（すべて満たすこと）:

1. `status === "closed"`
2. `realizedPnl` が finite
3. Original `marketContextSnapshot` あり（sanitize 成功）
4. `marketContextRevisions.length >= 1`

除外:

- OPEN
- realizedPnl なし / NaN
- Original なし（revision のみも対象外）
- revision なし

Period filter は Task103 と同じく呼び出し側の `filterTradesByPeriod` 済み trades を受け取る。

---

## Data provenance

- Original = `trade.marketContextSnapshot` のみ
- Latest = `marketContextRevisions` の **append 順最後**（timestamp で reorder しない）
- Previous→Latest / selected revision は Task106 UI 専用で Task107 集計に使わない
- 現在 market の再 fetch / 再計算なし
- Original / revisions を書き換えない

---

## Latest revision rule

```ts
latestMarketContextRevision(trade) → revisions[revisions.length - 1]
compareOriginalToLatest(trade) → compareMarketContexts(original, latest, { mode: "original_to_latest" })
```

---

## Task106 comparator reuse

`lib/trades/trade-evolution-performance.ts` は Task106 の `compareMarketContexts` を呼ぶ。

TF / Regime / Technical の差分判定を Task107 側で再実装しない。

Any Context Change は比較結果の対象フィールド（各 TF trend / regime 3項目 / SMA relation 3 / RSI bucket）から:

- 1つでも `changed` → `changed`
- 全て `unavailable` → `unavailable`
- それ以外 → `unchanged`

---

## Evolution dimensions

固定順表示（勝率・R でソートしない）:

1. Any Context Change — changed / unchanged / unavailable
2. Timeframe Trend — 15m / 1H / 4H / 1D 各 trend status
3. Market Regime — regime / trendDirection / volatility
4. SMA Relation — SMA20 / 75 / 200 relation
5. RSI Bucket — Task103 bucket の changed / unchanged / unavailable（transition 細分化なし）

---

## Outcome metrics

各 group:

- sample size / wins / losses / win rate / total P/L / average P/L

R がある trade のみ:

- R sample size / average R / total R / positive R count / negative R count

`realizedR` missing を 0R にしない（`realizedROrNull` / `calculateRealizedR` 再利用）。

---

## Sample safety

`MIN_INSIGHT_SAMPLE_SIZE = 5`（Task103 と同じ）。

- n < 5 → UI「サンプル不足（参考値）」、observation 対象外
- n ≥ 5 でも因果・推奨表現は禁止

---

## Selection bias

UI 必須表示:

> この分析はMarket Contextを手動で再取得したトレードのみを対象とします。全トレードを代表するとは限りません。

Coverage:

- Period CLOSED / Original available / Revision available / Evolution eligible

---

## Timing caveat

必須表示:

> 再取得タイミングはトレードごとに異なります

加えて Original→Latest の elapsed min / median / max（valid timestamp のみ）を Coverage 補助として表示。時間差を揃えた比較とは主張しない。

---

## Observations

- 最大 5 件、deterministic 優先順
- forbidden language guard（原因/効果/有効/優位/勝ちやすい/should/recommend 等）
- 例: 「1H trend changed は n=7、平均R +0.18Rでした」

---

## UI

`components/trades/trade-evolution.tsx` を `PerformanceIntelligencePanel` 下部に常時表示。

構成: Coverage → Any → Timeframe Trend → Regime → SMA → RSI → Observations

カード / stack、`min-width: 0` でモバイル overflow 回避。

---

## No-data UX

| emptyReason | メッセージ |
| --- | --- |
| `no_closed` | 決済済み取引なし |
| `no_original` | Original なし |
| `no_revision` | revision なし |
| `no_eligible` | Original+revision の両方を満たす決済なし |

単なる「データなし」にまとめない。

---

## Entry Performance との分離

| | Entry Performance (Task103) | Trade Evolution (Task107) |
| --- | --- | --- |
| 問い | Entry 時にどんな市場だったか | Entry 後に保存した市場状態がどう変わったか |
| 入力 | analysis / MTF / Regime snapshot 等 | Original + Latest revision |
| score 統合 | しない | しない |

---

## DB / API / AI impact

| 項目 | 結果 |
| --- | --- |
| migration | 0 |
| 新規 column | 0 |
| RPC / RLS | 変更なし |
| 新規 API request | 0 |
| 新規 AI / OpenRouter / OpenAI | 0 |
| market fetch | 0 |

保存済みデータのみ読む。

---

## Changed files

- `lib/trades/trade-evolution-performance.ts`（新規）
- `components/trades/trade-evolution.tsx`（新規）
- `components/trades/performance-intelligence.tsx`（Trade Evolution 接続）
- `app/globals.css`（te-* min-width）
- `tests/trade-evolution-performance.test.ts`（新規）
- `e2e/performance-intelligence.spec.ts`（Trade Evolution UI）
- `outputs/Task107-Trade-Evolution-Performance.md`（本ファイル）

---

## Tests

Unit: eligibility / latest=append last / Task106 reuse / dimensions / P&L / R missing≠0 / sample warning / period filter / bias / timing / observations≤5 / forbidden / no ranking / Task103 unchanged / immutability / no API·AI / mobile CSS

E2E: Trade Evolution 表示・selection bias・timing caveat・coverage・forbidden phrase・mobile overflow

---

## Unit / E2E / build

| Check | Result |
| --- | --- |
| `npm run lint` | PASS（既存 warning 1: finance-calendar unused import） |
| `npm test` | **1140 passed**（Task106 baseline 1115 を下回らない） |
| `npm run test:e2e` | **341 passed**（Task106 baseline 339 + Trade Evolution 2） |
| `npm run build` | PASS |
| `git diff --check` | PASS |

commit / push: していない。

---

## Known limitations

- Latest のみ使用。途中 revision の経路は集計しない
- SMA transition（above→below）の細分化は v1 では行わない
- Revision は手動再取得に依存するため selection bias が大きい
- elapsed は capturedAt が双方 valid な場合のみ

---

## Future work

- 複数 revision 経路（Original→各 revision）の optional 集計
- SMA / RSI transition detail（十分な n がある場合のみ）
- elapsed bucket（例: <1h / 1–4h / >1d）別の記述
- Task106 UI と共有する pure status aggregator のさらなる抽出
