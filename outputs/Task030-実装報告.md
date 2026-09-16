# Task030 Entry Context / エントリー判断コンテキスト 実装報告

実装日：2026-09-16  
検証完了日：2026-09-16  
ステータス：**実装・検証完了**  
対象リポジトリ：AI-FX-Analyst  
ブランチ：`feature/task030-entry-context`  
コミット・push：未実施（禁止どおり）

---

## 実装概要

Task030 は新しい Trading Decision ではない。既存の AI Direction / Action / MTF / Market Regime / Readiness / Trigger / Event Risk / Risk / DLL / Freshness を、エントリー時点の **factual context** として compose して表示する。

- Quality Score / Entry Score / Entry OK / GO / Good/Bad は作らない
- BUY / SELL / WAIT を Entry Context から新規生成しない
- 既存 Action が source of truth。Direction BUY + Action WAIT は valid
- 巨大な `entryContext` JSON は保存しない。既存 `TradeAiAnalysisSnapshot` に `marketRegimeAnalysis?` sibling を追加し、UI は `preTradeContext` + `multiTimeframeAnalysis` + `marketRegimeAnalysis` を合成する
- Task029 Market Regime を Trade 登録時に初めて固定保存する。追加 fetch / OpenAI / Vision なし

---

## terminology

| 用語 | 意味 |
|---|---|
| ENTRY CONTEXT | エントリー判断コンテキスト。判断材料の整理であり、推奨でも品質評価でもない |
| Live Entry Context | Dashboard / 登録フォームの現在 pair から compose した表示用オブジェクト |
| Stored Entry Context | 登録時 snapshot の sibling のみから compose した表示用オブジェクト |
| AI Direction | 既存 direction。Action とは独立 |
| Action | 既存 BUY / SELL / WAIT。Entry Context は上書きしない |
| MTF Alignment | 全時間軸で上向き / 下向き / 時間軸混在 / データ不足 |
| vsDirection | Direction との関係。方向一致 / 逆方向。一致 = 良い、とは書かない |
| Market Regime | Task029 の 1H 相場環境。Readiness の 6 個目ではない |
| analyzedAt | Regime 分析時刻（Task029） |
| capturedAt | Trade snapshot 保存時刻。混同しない |

禁止語：Entry Score / Quality Score / Setup Score / Good Entry / Bad Entry / Entry OK / GO / A/B/C / おすすめ / 勝ちやすい / 条件が良い / ruleFollowed / 因果ラベル。

---

## source of truth

| 項目 | ソース | 再計算しない |
|---|---|---|
| Direction / Action | Task012 / Task022 `preTradeContext` | しない |
| Readiness 5 | Task019 / Task022 | 6 個目を追加しない |
| Trigger | Task020/021 evaluation。`newlyMet` は session-only | snapshot に入れない |
| Event Risk | Task022 saved/live。unavailable ≠ LOW | しない |
| Risk | Task006 / Task022 | 独自 sizing なし |
| DLL | Task017/022 | 到達 = ルール違反、と書かない |
| Freshness | Task012/022 stale | blocking しない |
| MTF / HTF | Task026/027 snapshot helper | 別ロジックで再計算しない |
| Regime | Dashboard 現在 pair の Task029 分析を copy | 登録時 Twelve / OpenAI 再実行なし |

Action が唯一の既存 decision 系情報の source of truth。Entry Context は Decision を増やさない。

---

## composition architecture

候補どおり `lib/trades/entry-context.ts`：

- `buildLiveEntryContext(...)` — Task024 live PreTrade + Task026 Live MTF + Task029 Live Regime
- `buildStoredEntryContext(trade)` — sanitize 済み `preTradeContext` / `multiTimeframeAnalysis` / `marketRegimeAnalysis` のみ。current Dashboard を参照しない
- どちらも pure。`Date.now()` 内部使用なし。同じ input → `deepEqual`

保存は巨大 JSON ではなく sibling：

```
TradeAiAnalysisSnapshot {
  version: 1
  preTradeContext?
  multiTimeframeAnalysis?
  marketRegimeAnalysis?   // Task030 追加。optional。version bump なし
}
```

`lib/trades/regime-snapshot.ts` が `captureMarketRegimeSnapshot` / `storedMarketRegimeAnalysis` / `regimeSnapshotState` を提供。Task027 MTF helper と同じ copy + sanitizer パターン。

---

## live context

Trade 登録フォームの Task024 Pre-Trade Review を ENTRY CONTEXT へ発展。

- 入力：現在 pair の AI / Daily Plan / Readiness / Dashboard `MarketData`（pair 一致時のみ）
- pair mismatch：foreign Regime / MTF を preview しない
- 追加 fetch なし。Dashboard state の copy
- 新しい blocking warning なし。既存 DLL / stale / Event / WAIT / conflict / trigger / context を維持
- WAIT / Trigger NOT_MET / Event HIGH / stale / DLL reached / MTF contrary / Regime transition でも登録可能

---

## stored context

`buildStoredEntryContext(trade)` は sanitizer 通過後の snapshot sibling のみを読む。Live Regime で補完しない。outcome / `realizedPnl` を見ない。

---

## Direction

既存 AI Direction をそのまま表示。BUY / SELL / NEUTRAL / 未取得。Entry Context から生成しない。

---

## Action

既存 Action をそのまま表示。BUY / SELL / WAIT。上書きしない。Direction BUY + Action WAIT は完全に valid。

---

## MTF

Alignment 表示：全時間軸で上向き / 下向き / 時間軸混在 / データ不足。  
Compact Review の MTF 行は vsDirection：方向一致 / 逆方向 / 時間軸混在 / データ不足。一致 = 良い、とは書かない。Journal の Task027 カードは既存 ALIGNMENT_LABEL を維持。

---

## HTF

既存 `higherTimeframeBias`：上向き / 下向き / 中立 / 未取得。

---

## Regime

trending = トレンド、range = レンジ、transition = 移行・不明瞭、unavailable = 未取得。  
Trend：上向き / 下向き / 中立 / 未取得。  
Readiness check ではない。

---

## Volatility

高い / 通常 / 低い / 未取得。high volatility = SELL、ではない。

---

## Readiness

固定 5。6 個目なし。5/5 でも Entry OK と出さない。

---

## Trigger

Task020/021 evaluation 再利用。MET = 条件成立 のみ。MET → GO / Entry OK 禁止。`newlyMet` は保存しない。

---

## Event Risk

HIGH / MEDIUM / LOW / 未取得。unavailable を LOW にしない。

---

## Risk

Task006 / Task022 の riskPerTrade / riskPercent。独自 position sizing なし。

---

## DLL

未到達 / 到達 / 未設定/未取得。事実のみ。到達 = ルール違反、と書かない。

---

## Freshness

stored compose：最新 / 更新から時間経過。  
Live Review は Task024 E2E 維持のため 最新分析 / 期限切れ分析。stale でも registration blocking しない。

---

## Regime snapshot

登録時、Dashboard 現在 pair の Task029 分析を copy。

保存：version / pair / timeframe / analyzedAt / regime / trendDirection / volatility / evidence summary / reasons。

保存禁止：raw candles / ATR series / provider raw / API metadata / secret / full MarketData。

`analyzedAt` は 1H `fetchedAt`（Dashboard と同じ）。`capturedAt` は Trade snapshot 側。

---

## sanitizer

表示・保存前に Task013 / Task022 / Task027 / Task029 sanitizer を通す。Regime pair mismatch または malformed は Regime だけ null。SECRET_PAYLOAD（`sk-` / api key / base64 image 等）も Regime sibling のみ落とす。

---

## pair safety

- 保存時：`market.symbol !== draft.pair` → Regime/MTF null。AI/PreTrade は残る（AI pair が一致していれば）
- Live preview：フォーム pair と Dashboard Market pair 不一致なら foreign Regime を出さない
- stored：expectedPair 不一致なら Regime だけ非表示

---

## fail-soft isolation

malformed Regime → `marketRegimeAnalysis` のみ null。valid AI / PreTrade / MTF は残す。親 `TradeAiAnalysisSnapshot.version` は 1 のまま。sibling 追加のみなので version bump / migration なし。

---

## toggle semantics

既存「現在のAI分析をこの取引に保存」のみ。新 toggle なし。

- ON：Task013 AI + Task022 PreTrade + Task027 MTF + Task030 Regime
- OFF：全部保存しない

Task027 coupling は維持：AI snapshot なし → Regime sibling も保存されない。

---

## immutability

create 時のみ capture。`editTrade` / `closeTrade` は `analysisSnapshot` を preserve。既存 DB immutable trigger を維持。

---

## historical integrity

CURRENT REGIME MUST NEVER REWRITE HISTORICAL REGIME。登録後に Live が trending → range になっても Journal / Post-Trade は登録時 trending。

---

## outcome independence

`realizedPnl` で context / warning / regime / MTF / readiness を書き換えない。利益だから Good Context、損失だから Bad Context、は禁止。同一 saved context の +PnL / −PnL Trade は Entry Context が `deepEqual`。

---

## legacy

Task030 以前の Trade は Regime snapshot なし。UI：「相場環境は保存されていません」。Live Regime で補完しない。

---

## partial context

AI / PreTrade / MTF あり、Regime なし → 他 3 つを表示。Regime だけ保存なし。全部 Context なし扱いにしない。

---

## Pre-Trade Review integration

Task024 を ENTRY CONTEXT に発展。warnings / non-blocking / registration allowed は維持。既存 testid（direction / action / readiness / trigger / event / freshness 等）は残し、MTF / HTF / Regime / Volatility / DLL を追加。巨大な別カードは作らない。

---

## OPEN Journal

OPEN Trade 詳細で `StoredEntryContext`：既存 PreTrade + Task027 MTF + Task030 Regime。保存済み Entry Context として表示。

---

## CLOSED Post-Trade Review

Result / Holding Duration とは分離して Entry Context を表示。Task025 原則維持。利益/損失で context label を変えない。

---

## UI

タイトル：ENTRY CONTEXT / エントリー判断コンテキスト。「Entry Quality」は出さない。

構造：

- AI：Direction / Action
- MARKET：MTF / HTF Bias / Regime / Regime方向 / Volatility
- ENTRY：Readiness / Trigger / Event Risk
- RISK：Risk per Trade / DLL
- DATA：Freshness

Dashboard の Live MTF / Regime カードは残す。Trade form は compact。色だけで意味を伝えない。bullish = success / bearish = danger の good/bad semantic にはしない。

---

## responsive

- 390x844：AI / MARKET / ENTRY / RISK / DATA を縦積み。横 table なし。overflow なし
- 1280x900：既存 design system の 2〜4 column。overflow なし

---

## wording safety

禁止語を UI / helper / テスト禁止正規表現で確認。Trigger MET は条件成立。MTF 一致を良いと書かない。

---

## quality score absence

0〜100 / 星 / A/B/C / green score / quality % / confidence-like Entry score なし。

---

## compliance absence

ruleFollowed / ruleBroken / disciplineScore / complianceScore なし。

---

## causal wording absence

「この Regime だから利益」「MTF 一致だから成功」「Trigger 未成立だから失敗」なし。

---

## API counts

| API | 追加 |
|---|---|
| Twelve Data | 0 |
| OpenAI | 0 |
| Vision | 0 |
| Finnhub | 0 |
| FRED | 0 |
| EODHD | 0 |
| Supabase query | 0 |

Task029 の既存 AI evidence integration は維持。登録ボタンで再分析しない。

---

## Supabase

追加 query 0。既存 `analysis_snapshot` JSONB に optional sibling を入れるだけ。

---

## polling

新 timer 0。

---

## DB / migration

migration 0 / new table 0 / new column 0 / RLS 0。既存 JSONB。`TradeAiAnalysisSnapshot.version` は 1 のまま。

---

## unit

`tests/entry-context.test.ts`：A–BK + critical 1–5。

- 全体：922 passed（baseline 850 を下回らない）
- Task030 追加：72 passed

---

## E2E

`e2e/entry-context.spec.ts`：1–33。Task024 `pretrade-review.spec.ts` のタイトルを ENTRY CONTEXT / エントリー判断コンテキストへ更新（意味は維持）。

- 全体：273 passed（baseline 240 を下回らない）

---

## regression

Task001〜029 を維持。特に Snapshot / Daily Plan / Readiness / Trigger / Watch / PreTrade Snapshot / Performance / PreTrade Review / PostTrade Review / MTF / MTF Snapshot / MTF Performance / Market Regime。

Task029 の「snapshot に Regime を保存しない」ソース検査は、Task030 で sibling 保存を開始したため MTF helper / MTF Performance 側の非侵入検査に更新。

---

## known limitations

- Task027 coupling 維持：AI snapshot OFF / なしのとき Regime も保存されない
- Live Review の Freshness 文言は Task024 E2E 互換で「最新分析 / 期限切れ分析」。stored compose は「最新 / 更新から時間経過」
- Compact Review の MTF 行は vsDirection。Journal MTF カードは Task027 の alignment 文言
- malformed Regime は sanitizer で null 化されるため、永続後は unreadable ではなく absent（「保存されていません」）。isolation は AI/PreTrade/MTF が残ることで満たす
- Entry Context は O(1) compose。Regime 計算自体は Task029 既存

---

## Task031 候補

1. OPEN Journal で Entry Context を details 外へ常時出す UX（現状は Task013 詳細内）
2. Live / stored Freshness 文言の一本化（E2E 互換を崩さず）
3. Task032：Regime 別 / Entry Context 別の成績（本 Task では作っていない）
4. malformed Regime を unreadable として残すか、null 化するかの persistence 方針の明示
5. compact vsDirection と Journal MTF alignment の並記ルール

---

## 変更ファイル

### 新規

- `lib/trades/entry-context.ts`
- `lib/trades/regime-snapshot.ts`
- `components/trades/entry-context.tsx`
- `components/trades/regime-snapshot.tsx`
- `tests/entry-context.test.ts`
- `e2e/entry-context.spec.ts`
- `outputs/Task030-実装報告.md`（本報告）

### 更新

- `lib/trades/types.ts` — `marketRegimeAnalysis?`
- `lib/trades/snapshot.ts` — capture + fail-soft sanitize
- `lib/trades/pre-trade-review.ts` — live compose / タイトル / MARKET・DLL 行
- `components/trades/pre-trade-review.tsx` — compact Entry Context
- `components/trades/trade-form.tsx` — market 渡し / regime preview
- `components/trades/trade-list.tsx` — OPEN `StoredEntryContext`
- `components/trades/post-trade-review.tsx` — CLOSED Entry Context
- `app/globals.css` — group label / compact / 390・1280
- `e2e/pretrade-review.spec.ts` — タイトル
- `e2e/fixtures/trades.ts` / `e2e/helpers/mock.ts` — legacy / malformed fixture
- `tests/market-regime.test.ts` — snapshot 非侵入検査を Task030 後の境界へ更新

大規模 refactor なし。

---

## 検証コマンド

```
npm run lint          # pass
npm test              # 922 passed
npm run test:e2e      # 273 passed
npm run build         # pass
git diff --check      # pass
```
