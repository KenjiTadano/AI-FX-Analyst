# Task106 — Market Context Change Analysis

Branch: `feature/v1.1-task106-market-context-change-analysis`  
commit / push: していない。

## Verdict

**PASS**

保存済み Original（Task104）と Manual Refresh History（Task105）を比較し、市場状態の変化を deterministic に可視化した。AI / BUY·SELL·WAIT / 売買推奨なし。DB migration / market fetch / PI への revision 混入なし。

---

## Inspected Task104/105 architecture

| 部品 | 役割 |
| --- | --- |
| `marketContextSnapshot` | エントリー原本（immutable） |
| `marketContextRevisions[]` | append-only 再取得履歴 |
| `marketContextFromTrade` / sanitize | 原本読み取り |
| `marketContextRevisionsFromTrade` | 履歴読み取り（append 順） |
| Entry Context UI | Snapshot + History + Refresh |
| PI / MTF / Regime adapters | 原本のみ（revision 除外） |

---

## Data provenance

- Original = `trade.marketContextSnapshot` のみ（revision を Original 扱いしない）
- History = `trade.marketContextRevisions[]` の **append 順**（timestamp で reorder しない）
- legacy `analysisSnapshot` は Change の Original に使わない
- 現在 market からの再計算なし

---

## Comparison model

`lib/trades/market-context-change.ts`（pure）

```ts
compareMarketContexts(before, after) → MarketContextChange
buildMarketContextChangeAnalysis(trade, { mode, selectedRevisionIndex })
```

Modes:

1. `original_to_latest`
2. `previous_to_latest`（revision 1件のみなら Original → その revision）
3. `original_to_selected`

---

## Rate / MTF / Regime / Technical

| 領域 | 内容 |
| --- | --- |
| Rate | absolute + percent（双方 null なら unavailable。P/L ではない） |
| MTF | 15m/1h/4h/1D の trend / structure / sufficientData。summary: changed/unchanged 件数 |
| Regime | regime / trendDirection / volatility |
| Technical | lastClose / SMA20/75/200 / RSI14 の numeric Δ |
| SMA relation | above / below / equal / unavailable（売買用語にしない） |
| RSI bucket | Task103 `classifyRsiBucket` 再利用（事実表示のみ） |

---

## Missing data / elapsed

- no_original / no_revisions を区別
- 片側だけ値がある場合は `unavailable → value` として changed（評価語なし）
- elapsed: capturedAt 差分を `1h 30m` 形式。異常は invalid（補正しない）
- append 順で capturedAt 逆転があれば anomaly 明示

---

## UI

Entry Context → Market Context Snapshot 付近に「市場変化」:

- モード切替（Original→最新 / 直前→最新 / 選択）
- Elapsed / Rate / Timeframes / Regime / Technical
- changed / unchanged / unavailable を data-status + 文言で区別（色に good/bad 意味なし）

---

## Performance Intelligence isolation

revision は引き続き entry performance に未使用。  
Unit regression: revision 追加後も SMA/RSI/MTF 集計不変。

---

## API / AI / DB impact

| 項目 | 結果 |
| --- | --- |
| 新規 API / AI request | **0** |
| market fetch | **0**（保存データのみ） |
| DB migration / RPC / RLS | **なし** |

---

## Changed files

| Path | Change |
| --- | --- |
| `lib/trades/market-context-change.ts` | **new** compare model |
| `components/trades/market-context-change.tsx` | **new** UI |
| `components/trades/market-context-snapshot.tsx` | Change セクション埋め込み |
| `app/globals.css` | スタイル |
| `tests/market-context-change.test.ts` | **new** |
| `e2e/entry-context.spec.ts` | Change UI E2E |

---

## Tests

Unit: original/latest/previous/selected、missing、rate、MTF、regime、technical、SMA/RSI、elapsed、append order、OPEN/CLOSED、PI isolation、forbidden language、no API/AI。

E2E: refresh 後に変化表示、モバイル overflow。

---

## Unit / E2E / build

| Check | Result |
| --- | --- |
| `npm run lint` | OK（既存 warning 1） |
| `npm test` | **1115 pass / 0 fail**（baseline 1097↑） |
| `npm run test:e2e` | **339 passed**（baseline 337↑） |
| `npm run build` | OK |
| `git diff --check` | OK |

---

## Known limitations

- Original 欠如時は revision があっても比較不可（仕様）
- 評価語・売買シグナルは一切出さないため、ユーザーが解釈する必要がある
- PI への change 集計接続は未実装（意図的）

---

## Future work

- PI への「変化後コンテキスト」集計は別 Task
- 複数 revision のタイムラインチャート
- pair 編集後の Original/revision pair mismatch 専用メッセージ強化
