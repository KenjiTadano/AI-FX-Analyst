# Task020 Structured Entry Trigger / 構造化エントリートリガー 実装報告

実装日：2026-09-15  
検証完了日：2026-09-15  
ステータス：**実装・検証完了**  
対象リポジトリ：AI-FX-Analyst  
ブランチ：`feature/task020-structured-entry-trigger`  
コミット・push：未実施（禁止どおり）

---

## 実装概要

自然言語の `scenario.condition` を parser で判定していない。

既存 OpenAI Structured Output（`fx_interpretation`）に nullable の `entryTrigger` を追加し、sanitizer を通した structured data だけを、Dashboard が既に持っている currentRate / 確定足 OHLC で deterministic 評価する。

- 追加 OpenAI call：**0**（既存 analysis の field 追加のみ）
- 追加 Twelve Data / その他外部 API：**0**
- Trigger 成立でも Action を変更しない（5/5 + WAIT + MET でも WAIT）
- 形成中 candle 不使用
- timeframe の代用なし
- pair mismatch fail closed
- Readiness 固定 5 項目の count は未変更

---

## 変更ファイル

### 新規

- `lib/ai/entry-trigger.ts` — schema 断片、sanitize、evaluate、表示ラベル
- `tests/entry-trigger.test.ts` — A–Z / AA–AH ほか
- `e2e/entry-trigger.spec.ts` — Playwright 11 本
- `outputs/Task020-実装報告.md`（本報告）

### 更新

- `lib/ai/types.ts` / `openai.ts` / `engine.ts` — Structured Output と analysis への取り付け
- `lib/trading-plan/entry-readiness.ts` — evaluation を derive（count 非加算）
- `components/dashboard/entry-readiness.tsx` / `daily-plan.tsx` / `dashboard.tsx` — UI と既存 market の受け渡し
- `app/globals.css`
- `lib/trades/types.ts` / `snapshot.ts` — optional `entryTrigger` 保存
- `tests/ai.test.ts` / `tests/chart-ai-integration.test.ts`
- `e2e/fixtures/analysis.ts` / `market.ts` / `helpers/mock.ts`

---

## Trigger schema

```ts
interface StructuredEntryTrigger {
  version: 1
  type: StructuredEntryTriggerType
  pair: Symbol
  price: number
  timeframe: TriggerTimeframe | null
  sourceCondition: string | null
}
```

未知 field は UI / 評価に使わない（known field のみコピー）。

---

## supported trigger types

- `price_above`
- `price_below`
- `candle_close_above`
- `candle_close_below`

未実装（意図的）：RSI/MACD/MA cross、pattern、volume、AND/OR、news/sentiment。

---

## AI Structured Output変更

`interpretationSchema` に `entryTrigger` を追加。

- OpenAI strict: `required` に含める（`anyOf: [object, null]`）
- Runtime: **未指定でも invalid_response にしない**（legacy mock / 欠落は null）
- 不正 object は **analysis 全体を落とさず** `entryTrigger = null`

chartless GET / chart-assisted POST は同一 schema。実 OpenAI call なしで fixture 確認。

---

## prompt rules

既存 system prompt へ最小追加：

- 明確な価格 threshold と判定方法（現在価格 or 確定足終値）がある場合のみ構造化
- 価格を推測しない
- timeframe 未明示 → null
- current vs candle が曖昧 → null
- 複合条件・クロス・パターン・ニュース → null
- Trigger から BUY/SELL を決め直さない
- version 1、4 type のみ

---

## sanitizer

`sanitizeStructuredEntryTrigger(value, analysisPair)`

- version === 1
- supported type
- pair ∈ USD/JPY|EUR/JPY|GBP/JPY かつ analysis pair 一致
- finite price、`0 < price < 1000`
- timeframe allowlist（price type は timeframe を捨てて null）
- candle type は timeframe 必須、なければ null（trigger ごと破棄）
- sourceCondition 最大 400、秘密パターン reject
- 失敗時 null。analysis の signal/WAIT は維持

---

## price guard

`0 < price < 1000`。JPY クロスの異常値を落とす。現在レートとの差では reject しない。

---

## timeframe allowlist

内部値（Twelve Data interval に合わせる）：

`1min` / `5min` / `15min` / `30min` / `1h` / `4h` / `1day`

Dashboard が既に取得している OHLC は **15m / 1h / 4h のみ**。

- 対応足がある candle trigger → その interval の確定足だけ評価
- 1min/5min/30min/1day → **trigger は捨てず evaluation `unavailable`**
- 15m trigger を 5m で代用しない

---

## evaluation model

`evaluateStructuredEntryTrigger({ trigger, pair, currentRate, candlesByTimeframe, now })`

status: `met` | `not_met` | `unavailable` | `invalid`

- observedValue / observedLabel（現在価格 or 確定足終値）
- expression（`PRICE < 156.2` / `15min CLOSE < 156.2`）
- humanLabel（「15分足の終値が156.2を下回る」）
- checkedAt = 判定時刻（分析時刻と別）

新しい timer / polling は作っていない。既存 market 60秒更新と Daily Plan の now に乗る。

---

## current price evaluation

- `price_above`: currentRate **>** price
- `price_below`: currentRate **<** price
- 等号は **not_met**（strict inequality）
- live rate が null（stale 含む）→ **unavailable**（分析時レートへフォールバックしない）

---

## closed candle evaluation

- `candle_close_above/below`: 指定 timeframe の **最新確定足 close** を比較
- 等号は not_met

---

## forming candle handling

`candle.time + duration <= now` のものだけ使う。形成中は無視。残らなければ unavailable。Task003 の CLOSED CANDLES と独立に evaluator でも再フィルタ。

---

## pair safety

trigger.pair ≠ 選択 pair → sanitize 失敗 / invalid。他 pair の Trigger を表示・評価しない。E2E：USD/JPY → EUR/JPY で 156.2 が Readiness Trigger 領域に残らない。

---

## stale

Trigger met でも overall は stale warning 優先。Trigger UI に「分析が古いため再分析してください」。既存再分析 CTA。stale を met で解除しない。

---

## DLL

Daily Loss Limit 到達時、Trigger met でも warning 最優先。「取引禁止」は出さない。Action は変えない。

---

## Event Risk

high Event Risk は Trigger met でも warning のまま。Trigger は Event を override しない（unit AC）。

---

## Entry Readiness integration

- trigger なし：従来「確認条件あり」「条件成立の自動判定はしていません」
- trigger あり：ENTRY TRIGGER カード（expression + human label + 状態 + 判定時刻）
- invalid：raw を出さず「構造化条件を利用できません」
- unavailable：「判定データ不足」（未成立と区別）
- met：「条件成立を確認」。Entry OK / 今すぐ売る/買う なし

---

## Readiness count unchanged

固定 5：AI分析 / Direction / Data Quality / Risk / Event Risk。Trigger は 6 項目目にしない。5/5 semantics 維持。

---

## Direction / Action separation

5/5 + SELL + WAIT + Trigger MET でも Action WAIT。「現在のActionはWAITです」。Task017 status/action ロジック未変更。

---

## legacy compatibility

`entryTrigger` undefined/null で既存 UI は壊れない。過去 analysis / snapshot 対応。OpenAI 応答から欠落しても schema error にしない（runtime）。

---

## OpenAI failure behavior

entryTrigger だけ不正 → null に落として analysis 継続。WAIT/failure にしない。invalid_response は従来どおり factors/confidence 等の本体 schema 違反時のみ。

---

## Trade Snapshot対応有無

**保存する：** 新規 trade 登録時、sanitized `entryTrigger` を JSONB へ optional 保存。migration なし。

**保存しない：** live evaluation（市場データ依存。candle は capture 時に OHLC が無い）。評価スナップショットは Task021 候補。

不正 trigger は snapshot 全体を落とさず `entryTrigger: null`。

---

## API追加call

| サービス | 追加 |
|---|---|
| OpenAI | 0（既存 response field のみ） |
| Vision | 0 |
| Twelve Data | 0 |
| Finnhub | 0 |
| FRED | 0 |
| EODHD | 0 |

---

## DB migration

なし。既存 JSONB。RLS 変更なし。

---

## privacy

API key / raw OpenAI / system prompt / chart image / Supabase secret を model・fixture report に出さない。sourceCondition は既存 condition 相当の短文のみ（cap 400 + secret scrub）。

---

## mobile / desktop

- 390x844 overflow なし（E2E 10）
- 1280x900 Entry Readiness 内で Condition / Trigger を確認（E2E 11）
- Daily Plan の status ロジックは触らず、Readiness 中心

ライブ認証ブラウザ MCP は未接続。検証は Playwright。

---

## unit tests

Task019：372 pass を維持し追加。今回 **412 pass / 0 fail**。

A–Z：valid 4 types、reject（type/pair/mismatch/NaN/<=0/>guard/timeframe/source cap）、price/candle met・equal not_met、forming ignored、mismatch/no-rate/no-candle unavailable、null 互換、WAIT 維持、deterministic。

AA–AH：stale / DLL / Event high が met を override、pair switch、invalid で analysis 生存、NL parse なし、fetch なし、probability フィールドなし。

既存 OpenAI tests：schema に entryTrigger、invalid でも interpretation 成功、chartless / chart-assisted fixture。

---

## E2E

Task018/019 の **34 本維持**。新規 11 本。合計 **45 passed**。

1 not_met / 2 met / 3 candle met / 4 unavailable / 5 null fallback / 6 **5/5+WAIT+MET** / 7 stale+MET / 8 DLL+MET / 9 pair switch / 10 390 / 11 1280

実 OpenAI / Twelve Data へは通信しない。

---

## lint / build / diff

| コマンド | 結果 |
|---|---|
| `npm run lint` | pass |
| `npm test` | 412 pass |
| `npm run test:e2e` | 45 passed |
| `npm run build` | pass（既存 Supabase Node 20 警告のみ） |
| `git diff --check` | pass |

---

## known limitations

- 本番 `generateScenario` の condition は定性文のため、AI が entryTrigger を出せないことが多い（正しく null）
- WAIT 時は scenario 自体が null。Trigger は interpretation 由来で独立
- 1min/5min/30min/1day は評価 unavailable（追加 fetch しない）
- snapshot に evaluation は保存していない
- 自然言語 condition と structured trigger の意味的一致は prompt 任せ（parser で検証しない）

---

## Task021 候補

1. Trade snapshot へ Trigger evaluation（status / observedValue / checkedAt）を保存
2. Dashboard が未取得の timeframe を追加 fetch せずに「どの足なら評価できるか」を明示する UX
3. AI が qualitative WAIT のとき、entry zone 数値から **サーバーが trigger を合成しない**方針のまま、ユーザーが手動で structured trigger を確認する UI
4. Daily Plan への Trigger badge（今回は Readiness のみ）
5. `==` 近傍の tick size 許容（MVP は strict inequality のまま）
