# Task104 — Independent Market Context Snapshot

Branch: `feature/v1.1-task104-market-context-snapshot`  
commit / push: していない。

## Verdict

**PASS**

Trade 記録時点の市場コンテキストを、AI `analysisSnapshot` から独立した immutable JSONB `marketContextSnapshot` として保存できるようにした。AI 未実行・失敗でも deterministic な MTF / Regime / technical を残せる。close / P/L / notes / exit plan では書き換えない。Task103 Performance Intelligence は既存 adapter 経由で回帰なし。

---

## Inspected persistence architecture

| 領域 | 既存の保存先 | 備考 |
| --- | --- | --- |
| Task013 AI snapshot | `trades.analysis_snapshot` (JSONB) | `aiStatus` / `model` / signal / PreTrade 等。AI 成功時のみ意味ある |
| Task019〜025 PreTrade | `analysisSnapshot.preTradeContext` 等 | AI snapshot 内。toggle OFF で保存されない |
| Task026〜030 MTF / Regime | `analysisSnapshot.multiTimeframeAnalysis` / `marketRegimeAnalysis` | Dashboard の deterministic 結果を AI snapshot にコピーしていた |
| Task031 Exit Plan | `trades.exit_plan` (JSONB) | 独立カラム。`check_trade` で UPDATE 不可 |
| Task032/103 PI | 保存済み snapshot を読むのみ | 現在市場から historical 再計算しない |
| Trade create/update | `lib/trades/service.ts` + cloud repo | create で snapshot 捕捉、edit/close は既存 snapshot を保持 |
| Supabase | RLS 維持、`check_trade` で ownership + snapshot immutability | |

### Current coupling to AI snapshot（調査結論）

v1.0 では MTF / Regime は **AI analysis を保存するときだけ** trade に載っていた。そのため:

- AI 未実行 / OpenRouter 429 / OpenAI unavailable → MTF/Regime も欠落
- Performance Intelligence も AI snapshot 依存のカバレッジ低下

Task104 で何を独立させるか:

| 独立させる | AI snapshot に残す（二重巨大コピーしない） |
| --- | --- |
| MTF summary（15m/1h/4h/1D） | PreTrade / Action / Direction / AI reasons |
| Market Regime（regime / trend / volatility / evidence） | `aiStatus` / `model` / provider 系 |
| technical projection（1h lastClose / SMA / RSI） | chart evidence / AI narrative |
| `marketRate`（取得可能な相場） | entry price とは別概念 |

Entry Context UI の既存 MTF/Regime パネルは **read adapter** で独立 snapshot → legacy AI snapshot の順に読むため、同一巨大 blob の二重表示データ源にはしていない（永続化は独立カラム、AI 側の既存フィールドは触らない）。

---

## Chosen snapshot schema

概念名: **`marketContextSnapshot`**（既存 camelCase / DB snake_case に合わせた）

```ts
MarketContextSnapshot = {
  version: 1,
  capturedAt: string,      // ISO — trade.openedAt とは別概念
  pair: TradePair,
  marketRate: number | null,  // entryPrice ではない。無い場合は null（捏造しない）
  multiTimeframe: MultiTimeframeAnalysis | null,  // 既存型再利用
  marketRegime: MarketRegimeAnalysis | null,      // 既存型再利用
  technicalContext: {
    timeframe: "1h",
    lastClose, sma20, sma75, sma200, rsi14,
    source: "mtf_1h" | "regime_1h",
  } | null
}
```

- AI `provider` / `model` / `aiStatus` / `analysis` は sanitize で拒否（DB trigger でも拒否）
- pair mismatch（market.symbol ≠ trade.pair）→ capture 全体を `null`（誤ペアを保存しない）
- market が無くても **空の children 付き snapshot** を残せる → 「legacy 無し」と「unavailable」を区別

---

## DB / migration decision

**migration あり（必要）**

理由: 既存 `analysis_snapshot` は AI 必須フィールド制約があり、AI 非依存の独立 blob を同居させると schema / immutability / import が壊れる。`exit_plan` と同様に **nullable JSONB カラム**が最小で安全。

| 項目 | 内容 |
| --- | --- |
| File | `supabase/migrations/20260921180000_add_trade_market_context_snapshot.sql` |
| Column | `market_context_snapshot jsonb` nullable |
| Legacy | existing rows = NULL（互換） |
| RLS | 変更なし |
| Destructive | なし |
| Immutability | `check_trade` UPDATE で `analysis_snapshot` / `exit_plan` と同様に禁止 |
| Import | `import_local_trades` に同カラム追加 |
| Cloud update | `cloud-repository` が update payload から `market_context_snapshot` を削除 |

無理に migration 0 にしなかった理由: AI snapshot 内への埋め込みは AI independence と矛盾し、巨大データの意味的二重化にもなる。

---

## Changed files

| Path | Change |
| --- | --- |
| `lib/trades/market-context-snapshot.ts` | **new** capture / sanitize / field states / derive technical |
| `components/trades/market-context-snapshot.tsx` | **new** Entry Context 隣接の最小 UI |
| `supabase/migrations/20260921180000_add_trade_market_context_snapshot.sql` | **new** column + immutability |
| `lib/trades/types.ts` | `marketContextSnapshot?` |
| `lib/trades/service.ts` | create で常に capture、edit/close で保持 |
| `lib/trades/validation.ts` | sanitize（構造検証。pair 編集後も永続値は保持） |
| `lib/trades/mtf-snapshot.ts` | read adapter: marketContext → AI snapshot |
| `lib/trades/regime-snapshot.ts` | 同上 |
| `lib/trades/performance-intelligence.ts` | `savedTechnicalPoint` が technicalContext 優先 |
| `lib/supabase/{mappers,database.types,cloud-repository}.ts` | 永続化 / 型 / update 除外 |
| `components/trades/entry-context.tsx` | UI 埋め込み |
| `app/globals.css` | 最小スタイル（overflow 対策） |
| `tests/market-context-snapshot.test.ts` | **new** 要件 1〜22 |
| `tests/{entry-context,mtf-snapshot,supabase}.test.ts` | adapter / immutability 調整 |
| `e2e/{entry-context,mtf-snapshot}.spec.ts` | AI OFF でも market context 保存、T104 UI |

---

## Capture timing

- **いつ**: ユーザーが「トレードを記録」した `createTrade` 時（`capturedAt = now`）
- **何から**: 画面ですでに取得済みの `MarketData`（`options.market`）と任意の `marketPrice`
- **しないこと**: 追加 TwelveData / Finnhub リクエスト、新規 polling、AI / OpenRouter 呼び出し
- **失敗時**: sanitize → `null`。trade 本体の保存は継続（致命エラーにしない）
- **pair mismatch**: market を渡さない / capture `null`（誤ペア禁止）

---

## MTF / Regime / Technical persistence

| 項目 | 実装 |
| --- | --- |
| MTF | `multiTimeframeForPair` + `sanitizeMultiTimeframeAnalysis` を再利用。15m / 1h / 4h / 1D |
| Regime | `marketRegimeForPair` + sanitize。regime / trendDirection / volatility / evidence |
| Technical | **新規 indicator 計算なし**。MTF 1h → なければ Regime evidence から投影し `technicalContext` に明示保存 |
| 不整合防止 | 同一 capture pass で derive。後から live 再計算しない |

---

## AI independence

- `saveSnapshot: false` / analysis `null` / AI failure でも `marketContextSnapshot` は保存可能
- AI provider / model は snapshot に入れない（unit + DB check）
- PreTrade / Action は従来どおり AI snapshot 依存（責務分離）

---

## Immutability

| 操作 | marketContextSnapshot |
| --- | --- |
| close | 不変（`editTrade` が元を保持） |
| realized P/L | 不変 |
| notes update | 不変 |
| exit plan フィールド編集 | 不変（exit_plan 自体のルールは既存） |
| cloud UPDATE | カラム送信しない |
| DB trigger | UPDATE で変更すると exception |
| 自動置換（60s 等） | なし（helper 禁止を test） |

pair 編集後: snapshot.pair は登録時の事実として残る。adapter は `ctx.pair === trade.pair` のときだけ適用（別ペアの市場コンテキストを誤適用しない）。AI snapshot と同じ provenance 方針。

---

## Legacy compatibility

- `marketContextSnapshot == null` → 正常な legacy
- 現在市場からの automatic backfill **なし**
- PI / MTF / Regime adapter は legacy 時 `analysisSnapshot` にフォールバック
- UI: `legacy（market context snapshot なし）`

---

## Performance Intelligence adapter

優先順:

1. `marketContextSnapshot.technicalContext` / MTF / Regime  
2. legacy `analysisSnapshot.*`

同一保存データからは Task103 と同じ分類結果になることを unit（regression）で確認。数値を「現在市場」で書き換えない。

---

## UI

Trade 詳細 Entry Context 付近に最小表示:

- Market Context Snapshot
- Captured / Pair / Market rate
- MTF / Regime / Technical: `saved` | `unavailable` | legacy
- AI Provider 情報と混ぜない
- mobile overflow 対策（grid + `overflow-wrap`）

---

## API / query / polling impact

| 項目 | 影響 |
| --- | --- |
| 新規 AI request | **0** |
| OpenRouter / OpenAI（capture 目的） | **呼ばない** |
| 新規外部 provider | **0** |
| 新規 polling | **0** |
| 追加 market API | **0**（既存 Dashboard market 再利用） |

---

## Tests

Unit `tests/market-context-snapshot.test.ts` ほか:

1. trade creation captures  
2–3. AI 未実行 / failure でも capture  
4–5. pair 一致 / mismatch rejection  
6. capturedAt  
7. marketRate ≠ entryPrice  
8–10. MTF / Regime / technical  
11. missing context でも trade 保存  
12–15. close / P/L / notes / exit plan で不変  
16–17. legacy 互換・no backfill  
18. Task103 metrics regression  
19. new → legacy fallback adapter  
20. AI provider/model 非保存  
21. no automatic replacement  
22. field states（legacy / unavailable / saved）

E2E:

- AI OFF でも market context + MTF/Regime 表示（意図的に仕様更新）
- T104 capture UI / mobile overflow
- legacy fixture は `market-context-legacy`

---

## Unit / E2E / build

| Check | Result |
| --- | --- |
| `npm run lint` | OK（既存 warning 1: unused `EconomicEvent`） |
| `npm test` | **1081 pass / 0 fail**（baseline 1063 以上） |
| `npm run test:e2e` | **335 passed**（baseline 333 以上、+2） |
| `npm run build` | OK |
| `git diff --check` | OK |

---

## Known limitations

- Supabase migration はローカル/リモートへの **適用自体は運用側作業**（本 Task は SQL 追加まで）
- pair 編集後は adapter が独立 snapshot を適用しない（登録時 pair の provenance 保持）
- market 未取得時は snapshot は残るが MTF/Regime/technical/rate は `unavailable`
- Form 上の MTF/Regime **preview** は従来どおり AI 保存トグル連動（永続化とは分離）
- Explicit snapshot 再取得 UI は未実装（下記）

---

## Future explicit replacement strategy

Task104 では自動更新禁止。将来別 Task で:

1. ユーザー明示操作「Market Context を再取得」のみ
2. 新 version または監査用 `replacedAt` / 履歴を検討（黙って上書きしない）
3. Performance Intelligence は「最終確定 snapshot」を読む契約を明文化
4. backfill はオプトイン・一括自動は禁止のまま

---

## Forbidden checklist（遵守）

- [x] historical automatic backfill なし  
- [x] 現在市場で過去 context 再計算なし  
- [x] snapshot 自動置換なし  
- [x] AI request / prompt / BUY·SELL·WAIT / Entry Trigger / OpenRouter / Calendar 変更なし  
- [x] 新規外部 API / polling なし  
- [x] RLS 緩和なし  
- [x] commit / push なし  
