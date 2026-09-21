# Task105 — Market Context Snapshot Revision History

Branch: `feature/v1.1-task105-market-context-revision`  
commit / push: していない。  
remote migration: **未適用**（本 Task は SQL 作成まで。review → commit/merge → remote の順）。

## Verdict

**PASS**

Task104 の `marketContextSnapshot`（エントリー原本）を永久 immutable のまま維持し、ユーザー明示操作でのみ「現在の Market Context」を `marketContextRevisions[]` へ append-only で追加できるようにした。Performance Intelligence は原本のみを使い、revision では SMA/RSI/MTF/Regime 指標が変わらない。

---

## Inspected Task104 architecture

| 部品 | 役割 |
| --- | --- |
| `lib/trades/market-context-snapshot.ts` | capture / sanitize / `marketContextFromTrade` |
| `createTrade` | 登録時のみ原本 capture |
| `editTrade` / `closeTrade` | 原本保持 |
| `check_trade` | `market_context_snapshot` UPDATE 禁止 |
| cloud `update` | snapshot カラムを送信しない |
| PI / MTF / Regime adapters | `marketContextFromTrade` → legacy AI fallback |

Task104 Future にあった「明示再取得」を本 Task で実装。ただし **ヘッド置換ではなく履歴 append**（要件: ORIGINAL MUST NEVER CHANGE）。

---

## Original immutability

- Domain: `appendMarketContextRevision` / `buildTradeWithAppendedRevision` は `marketContextSnapshot` をコピーしたまま変更しない
- `editTrade` / `closeTrade` / notes / exit plan: revisions も保持し、原本は触らない
- Cloud regular UPDATE: `market_context_snapshot` **および** `market_context_revisions` を削除（通常 update では送らない）
- DB `check_trade`: `market_context_snapshot` 差分は従来どおり exception

---

## Chosen revision schema

```ts
MarketContextRevision = MarketContextSnapshot & {
  reason: "manual_refresh"; // Task105 唯一
}
```

永続化: `trade.marketContextRevisions: MarketContextRevision[] | null`  
DB: `market_context_revisions jsonb`（null or array、長さ ≤ 20）

Revision は entry 事実ではない。PI / `storedMultiTimeframeAnalysis` / `storedMarketRegimeAnalysis` / `savedTechnicalPoint` は **原本のみ**。

---

## DB / migration decision

**migration あり（必要）**

File: `supabase/migrations/20260921190000_add_trade_market_context_revisions.sql`

理由:

1. 原本カラムは UPDATE 不可のため、履歴用の保存先が別途必要
2. append-only を DB でも保証したい
3. 通常 client UPDATE では revisions を送らず、RPC のみで追加

内容:

- nullable JSONB `market_context_revisions`（legacy NULL 互換）
- `check_trade` に append-only prefix 検証 + 上限 20 + AI fields 拒否
- RPC `append_market_context_revision(p_trade_id, p_expected_version, p_revision)`（atomic + ownership + version）
- `import_local_trades` に同カラム追加
- RLS 変更なし / destructive なし
- **原本 immutability rule は変更しない**

---

## Append-only design

| 層 | 保証 |
| --- | --- |
| Domain | 既存配列 + 1 件 append。edit/delete/reorder helper なし |
| `isAppendOnlyMarketContextRevisions` | テスト・検証用 |
| DB trigger | 新配列が旧配列の prefix、長さ非減少、≤20 |
| Cloud | 通常 UPDATE から除外。RPC のみ |

---

## Concurrency strategy

**採用: Postgres RPC + optimistic `version`**

理由:

- read → client array → overwrite だと他タブの履歴喪失リスクがある
- 既存先例は `import_local_trades` RPC
- RPC 内 `FOR UPDATE` + `version` 一致で atomic append
- 競合時は失敗（再読み込み）。過剰な CRDT 等はしない

---

## Revision limit

`MAX_MARKET_CONTEXT_REVISIONS = 20`（`market-context-snapshot.ts` 一箇所）

21 件目:

- 原本不変
- 既存履歴削除なし
- 新規保存拒否
- UI/エラー文言で明示

---

## Manual capture flow

1. ボタン「現在のMarket Contextを再取得」
2. 確認 alertdialog（即保存しない）
3. OK 後:
   - **ユーザー明示のワンショット** `GET /api/market?symbol=trade.pair`（+1 request / action）
   - 失敗時は Dashboard 上の pair 一致 market にフォールバック
   - `captureMarketContextRevision`（既存 MTF/Regime/technical 再利用）
   - `repository.appendMarketContextRevision` RPC
4. Cancel → 何も作らない

新 polling / 60s 自動 revision / AI 連動 / close・notes 連動: **なし**

---

## Confirmation UX

既存 `delete-confirm`（alertdialog）パターンを再利用。

文言: 「エントリー時のMarket Contextは変更されません。現在の市場状態を履歴として追加します。」  
Cancel / 再取得

---

## Pair safety

- `revision.pair === trade.pair` 必須
- market.symbol mismatch → 保存禁止
- 原本の pair（pair 編集後の provenance）は書き換えない
- PI は原本を使うため entry context 不変

---

## AI independence

- OpenRouter / OpenAI: revision capture で呼ばない
- provider / model / aiStatus: sanitize + DB で拒否
- 429 等は revision に影響しない

---

## Performance Intelligence isolation

優先順（変更なし）:

1. original `marketContextSnapshot`
2. legacy `analysisSnapshot`

`marketContextRevisions` は参照しない。  
Unit: revision 追加後も SMA/RSI/MTF/Regime 集計が同一。

---

## Legacy behavior

- `marketContextSnapshot = null` + `revisions = null/[]` → 正常
- legacy にも manual revision 追加可
- revision を original 扱いしない（adapters は原本のみ）
- original backfill なし

---

## UI

Entry Context → Market Context Snapshot:

- エントリー時（原本）
- 現在コンテキスト履歴（0件文言 / details 折りたたみ）
- 再取得ボタン + 確認

用語は「再取得履歴」「現在コンテキスト履歴」。Revision 技術語を前面に出さない。

---

## API / query / polling impact

| 項目 | 影響 |
| --- | --- |
| 新規 AI request | **0** |
| 新規 AI provider | **0** |
| background polling | **0** |
| market API | **ユーザー確定操作 1 回あたり最大 +1**（明示 one-shot）。失敗時は既存 Dashboard market 再利用 |

---

## Security

- RLS 変更なし（RPC は `security invoker` + `auth.uid()`）
- service role を client に出さない
- revision payload を domain sanitize + DB 検証
- secrets / AI fields を snapshot に入れない

---

## Changed files

| Path | Change |
| --- | --- |
| `lib/trades/market-context-snapshot.ts` | revision 型・capture・append helpers・定数 |
| `lib/trades/types.ts` / `validation.ts` / `service.ts` | フィールド・validate・append API |
| `supabase/migrations/20260921190000_add_trade_market_context_revisions.sql` | **new** |
| `lib/supabase/{database.types,mappers,cloud-repository}.ts` | 型・map・RPC |
| `components/trades/{market-context-snapshot,entry-context,trade-list,post-trade-review,journal}.tsx` | UI + wiring |
| `app/globals.css` | 履歴・確認スタイル |
| `tests/market-context-revision.test.ts` | **new** |
| `tests/{entry-context,supabase}.test.ts` | vision 誤検出修正 / UPDATE 除外 |
| `e2e/{entry-context.spec,helpers/mock,fixtures/trades}.ts` | RPC mock・E2E |

---

## Tests

Unit（Task105 要件 1〜32 相当）+ 既存 Task104 回帰。

E2E:

- cancel → 履歴なし
- confirm → revision 追加・原本 Captured 不変

---

## Unit / E2E / build

| Check | Result |
| --- | --- |
| `npm run lint` | OK（既存 warning 1） |
| `npm test` | **1097 pass / 0 fail**（baseline 1081↑） |
| `npm run test:e2e` | **337 passed**（baseline 335↑） |
| `npm run build` | OK |
| `git diff --check` | OK |

---

## Known limitations

- remote migration 未適用（意図的）
- one-shot market fetch 失敗時は Dashboard キャッシュ依存（捏造しない）
- Form 上の MTF/Regime preview は従来どおり AI 保存トグル連動（永続 revision とは分離）
- 競合時は RPC version conflict → ユーザー再読み込み

---

## Remote migration status

**Not applied.** Task104 と同様、report review → commit/merge → remote apply の順。

---

## Future work

- revision 比較 UI（原本 vs 再取得差分）
- 上限到達後のエクスポート / アーカイブ（自動削除は禁止のまま）
- 明示的「履歴をクリア」は別 Task・強い確認が必要（現状 delete 禁止）
