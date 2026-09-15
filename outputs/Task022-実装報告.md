# Task022 Pre-Trade Context Snapshot / エントリー時判断状況の保存 実装報告

実装日：2026-09-15  
検証完了日：2026-09-15  
ステータス：**実装・検証完了**  
対象リポジトリ：AI-FX-Analyst  
ブランチ：`feature/task022-pretrade-context-snapshot`  
コミット・push：未実施（禁止どおり）

---

## 実装概要

Task022 は新しい売買判断ではない。Trade 登録ボタンを押した時点で Dashboard がすでに持っている state から、判断状況を **immutable snapshot** として保存する。

保存するのは事実のみ。

- AI Direction / Action / Entry Readiness（固定 5）
- Structured Trigger + evaluation（status / observedValue / checkedAt / Task021 distance）
- Data Quality / Confidence / Event Risk / Risk / DLL / stale

を、既存 Task013 `TradeAiAnalysisSnapshot` の optional `preTradeContext` として `analysis_snapshot` JSONB に同梱する。

禁止事項は守った。

- 新しい OpenAI / Vision / 外部 API call なし
- Trigger 再判定用 fetch なし（builder 内で currentRate / candles から再評価しない）
- 自動売買 / broker API なし
- 過去 Trade の推測 backfill なし
- Entry 後の market / 再分析 / Risk 変更で snapshot を書き換えない
- 自然言語 condition から Trigger を作らない
- MET = 良い Entry / WAIT Entry = 悪い Trade / 勝率予測 / ruleFollowed を生成しない
- `newlyMet` は session UI transition のため保存しない

5/5 + SELL + WAIT + MET はそのまま保存可能。WAIT を SELL へ変えない。Trigger equality は `not_met` + 0 pips を維持。Event unavailable を LOW にしない。

---

## 変更ファイル

### 新規

- `lib/trades/pre-trade-context.ts` — capture / sanitize / Task023 向け分類 helper / UI 文言
- `components/trades/pre-trade-context.tsx` — 登録 preview と Journal 詳細
- `tests/pre-trade-context.test.ts` — A–AJ ほか
- `e2e/pretrade-context.spec.ts` — Playwright 17 本
- `outputs/Task022-実装報告.md`（本報告）

### 更新

- `lib/trades/types.ts` — `PreTradeContextSnapshot` / `TradeAiAnalysisSnapshot.preTradeContext?`
- `lib/trades/snapshot.ts` — capture 時に preTrade を添付。不正なら `preTradeContext = null` のみ落とす
- `lib/trades/service.ts` — create 時に dailyPlan / readiness を渡し、distance は Task021 Watch から取得
- `components/dashboard/dashboard.tsx` — Daily Plan の live context を ref 経由で Journal へ
- `components/dashboard/daily-plan.tsx` — `onPlanContext` で plan + readiness を通知
- `components/trades/journal.tsx` — create 時に live context を渡す。quote `now` の即時 tick
- `components/trades/trade-form.tsx` — 既存トグル ON 時の軽量 preview。WAIT warning 維持
- `components/trades/trade-list.tsx` — 「エントリー時の判断状況」を既存 AI snapshot 詳細へ追加
- `app/globals.css` — 1 カラム grid / overflow-wrap
- `e2e/helpers/mock.ts` — trades POST/PATCH の in-memory persistence（snapshot は PATCH で不変）
- `e2e/fixtures/analysis.ts` — Event unavailable + trigger 用 fixture

大規模 refactor なし。Task013 snapshot の version / 必須フィールドは維持。

---

## snapshot schema

```ts
interface PreTradeContextSnapshot {
  version: 1
  capturedAt: string
  pair: TradePair
  direction: "BUY" | "SELL" | "NEUTRAL" | null
  action: "BUY" | "SELL" | "WAIT" | null
  readiness: {
    confirmedCount: number
    totalCount: 5
    state: "ready_to_review" | "waiting" | "warning" | "unavailable"
  } | null
  trigger: {
    structuredTrigger: StructuredEntryTrigger
    evaluation: {
      status: "met" | "not_met" | "unavailable" | "invalid"
      observedValue: number | null
      checkedAt: string | null
      distanceToTriggerPips: number | null
    }
  } | null
  dataQuality: { score: number | null } | null
  confidence: number | null
  eventRisk: { level: "high" | "medium" | "low" | "unknown"; available: boolean } | null
  risk: { capital: number; riskPercent: number; riskPerTrade: number } | null
  dailyLossLimitPercent: number | null
  dailyLossRemaining: number | null
  dailyLossLimitReached: boolean
  analysisStale: boolean
  eventRiskHigh: boolean
}
```

保存しない：

- `newlyMet`
- `goodEntry` / `badEntry` / `correctEntry` / `wrongEntry`
- `ruleFollowed` / `ruleBroken` / `disciplineScore`
- raw OpenAI / candles / chart image / API secret / 各 Readiness check 全文

Task023 向け helper（分類ラベルはまだ保存しない）：

- `triggerStatusAtEntry` → `met` | `not_met` | `unavailable` | `invalid` | `no_trigger`
- `actionAtEntry` → `BUY` | `SELL` | `WAIT` | `unavailable`
- `eventRiskAtEntry` → `high` | `medium` | `low` | `unavailable`

---

## Task013との関係

Task013 を置き換えない。`TradeAiAnalysisSnapshot` の中に optional `preTradeContext` を追加した。

既存の Task013 フィールド（signal / directionSignal / action / DQ / chart / economicRisk 要約など）はそのまま。Journal の「エントリー時AI分析」詳細の末尾に「エントリー時の判断状況」を足す。

WAIT warning と AI direction vs Trade side warning は Task013 のまま。Trigger MET でも WAIT warning を消さない。PreTradeContext で上書きしない。

---

## versioning方針

**`TradeAiAnalysisSnapshot.version` は 1 のまま。version bump しない。**

理由：

- DB `check_trade()` は `version = 1` を要求する
- version bump は migration が必要になる
- optional JSONB キー追加は既存 check を壊さない
- Task013 sanitizer / copy / immutability trigger を維持できる最小変更

`PreTradeContextSnapshot.version` も 1（ネストした context 自身の版）。未知 version は reject → `preTradeContext = null`。

---

## capture source

Trade 登録ボタン時点の Dashboard live state。新しい API fetch なし。

| 項目 | source |
|---|---|
| Direction / Action / Readiness / Trigger / evaluation / stale / DLL | `EntryReadiness`（Daily Plan が構築済み） |
| Event Risk / Risk / capital / riskPercent / riskPerTrade / DLL % / remaining | `DailyTradingPlan` |
| DQ / Confidence / pair | `AIAnalysis`（plan / readiness と pair 一致時） |
| distanceToTriggerPips | Task021 `buildEntryTriggerWatch`（service 側。formula は snapshot にコピーしない） |

Daily Plan は分析タブ `hidden` でも mount されたまま。`onPlanContext` で ref を更新し、Journal の `getPreTradeSource()` が登録時に読む。

snapshot builder（`capturePreTradeContext`）は `evaluateStructuredEntryTrigger` / candles / currentRate 再評価を呼ばない。

---

## capture timing

`createTrade(..., now)` の `now` を Task013 `capturedAt` と PreTrade `capturedAt` の両方に使う。数秒ずれを作らない。

`openedAt` はフォームの datetime-local（分精度・ユーザー編集可）。Task013 と同じく登録時計 `now` とは別フィールド。

登録後の market 更新 / AI 再分析 / Trigger 変化 / Event 更新 / Risk 設定変更では書き換えない。`editTrade` / `closeTrade` は既存どおり `analysisSnapshot` を引き継ぐ。DB UPDATE も `analysis_snapshot` を変更できない（Task013 trigger）。

---

## pair safety

selected pair / analysis pair / dailyPlan pair / readiness pair / trigger pair を検証。

いずれか不一致なら **fail closed**：該当 context を混ぜず、`capturePreTradeContext` は `null`。他 pair の Trigger 文言を snapshot に入れない。

Trade 側 pair が分析 pair と違う場合、Task013 本体も従来どおり snapshot なし（`analysis.pair !== pair`）。

---

## Direction

Task012/013 semantics を再利用。

`directionSignal`：

- `strong_buy` / `buy` → BUY
- `strong_sell` / `sell` → SELL
- `neutral` / `wait` → NEUTRAL

推測しない。readiness / plan の既存 direction を優先。

---

## Action

Daily Plan / analysis の既存 Action を保存。

Trigger MET でも `WAIT → SELL` へ変えない。

許容する組み合わせ例：

- direction = SELL
- action = WAIT
- trigger.status = met

---

## Readiness

Task019 固定 5 semantics。

- `confirmedCount` 0..5
- `totalCount === 5`
- `state`

各 check 全文は保存しない。Trigger を 6 項目目にしない。

5/5 + WAIT + MET を「Entry OK」へ変換しない。

---

## Structured Trigger

Task020 `sanitizeStructuredEntryTrigger` のみ保存。raw OpenAI object 禁止。自然言語 condition から生成しない。sanitized 結果が無ければ `trigger = null`。

---

## Trigger evaluation

登録時点の Task020 evaluation を capture。

保存：

- `status`
- `observedValue`
- `checkedAt`（Dashboard で評価した時刻。candle close time ではない）
- `distanceToTriggerPips`（Task021 の値）

builder 内再評価なし。`invalid` は trigger ごと null（不正条件を事実として残さない）。

---

## distance

Task021 `buildEntryTriggerWatch` の `distanceToTriggerPips` をそのまま保存。同じ計算式を snapshot 側にコピーしない。

- met：Watch は **0**
- not_met equality：Watch は **0**
- unavailable / invalid：Watch は **null**

Journal UI の距離表示は `not_met` のときだけ。met の 0 を「条件成立」以外の距離ラベルにしない。

---

## equality

Task020/021 維持。

`observed == price`：

- status = `not_met`
- distance = 0

この組み合わせを保存可能。0 pips を MET へ変換しない。UI は「条件未成立」。

---

## unavailable

Trigger evaluation unavailable：

- status = `unavailable`
- observedValue nullable
- distance nullable

unavailable を not_met へ変換しない。UI は「判定データ不足」。

---

## DQ

既存 analysis Data Quality score を保存。新しい score を計算しない。

---

## Confidence

既存 confidence を保存。勝率ではない。Journal では既存 `CONFIDENCE_DISCLAIMER` を維持。

---

## Event Risk

Task017/019 の既存 Event Risk を保存。

- `level`
- `available`

`available = false` のとき level は `"unknown"` に正規化。LOW にしない。

UI：`available=false` または unknown → **「未取得」**。「LOW」「重要イベントなし」にしない。

calendar が取れず analysis.economicRisk.known=true のときは、Task017 の既存 fallback（LOW 扱い）を **live の事実として** capture する。E2E の「未取得」は `economicRisk.known=false` + calendar unavailable の fixture を使う。

---

## FRED constraint

FRED actual を未来 Event Risk へ変換しない。Task009/017 制約維持。capture は calendar / analysis.economicRisk の既存値のみ。

---

## Risk

Task006 source of truth。plan の既存値のみ。

- capital
- riskPercent
- riskPerTrade

Risk 再計算式は Task022 で作らない。

---

## DLL

optional で保存：

- `dailyLossLimitPercent`
- `dailyLossRemaining`
- `dailyLossLimitReached`

Task017 の既存値のみ。新計算禁止。

---

## stale

stale 分析のまま Trade 登録しても snapshot は保存する。`analysisStale: true` を残し、後から「stale 分析で Entry した」を検証できる。

警告 boolean：

- `dailyLossLimitReached`
- `eventRiskHigh`
- `analysisStale`

新しい severity 計算はしない。

---

## newlyMetを保存するか

**保存しない。**

理由：「Trigger が成立していたか」と「画面上で not_met→met を観測したか」は別概念。`newlyMet` は Task021 の session UI transition。

---

## immutability

Task013 の DB / service を維持。

- edit（entry price / memo 等）：preTradeContext 不変
- close：exit 情報だけ更新。preTradeContext そのまま
- 登録後の market / 再分析 / Risk 変更：JSONB を書き換えない
- delete：Trade 行と一緒に消える。別 table なし

E2E mock の PATCH も `analysis_snapshot` を保持する（cloud-repository が UPDATE から snapshot を除外するのと同じ）。

---

## toggle ON/OFF

既存トグル「現在のAI分析をこの取引に保存」を維持。

- ON：AI snapshot + preTradeContext
- OFF：AI snapshot なし、preTradeContext も保存しない（ユーザー意思を尊重）

「Pre-Trade Context だけ保存」トグルは追加しない。

---

## Journal UI

見出し：**エントリー時の判断状況**  
英語補助：PRE-TRADE CONTEXT  
注記：**エントリー時点の保存情報**

表示例：

- AI方向 / Action / 準備度 5 / 5
- Trigger 条件成立 / 条件 / 確認値 / 判定確認時刻
- DQ / Confidence / Event / Risk

用語禁止（Task022）：ルール遵守 / 正しいEntry / Entry OK

欠落：`エントリー時の判断状況は保存されていません`  
Event unavailable：`未取得`  
Trigger unavailable：`判定データ不足`  
equality：`条件未成立`

登録フォームの preview は 4 行程度の軽量表示。巨大カードにしない。WAIT warning は MET でも残す。

---

## legacy

既存 Trade：`preTradeContext` undefined/null。推測 backfill しない。UI は欠落メッセージのみ。

localStorage `decodeJournal` は既存 sanitizer 経由。新 field があっても restore は壊れない。不正 preTrade は null にして Trade / Task013 snapshot を落とさない。

---

## sanitizer

Task013 sanitizer を拡張。

- preTrade だけ不正 → `preTradeContext = null`
- 親 snapshot の secret scan は preTrade を除外し、壊れた context で Task013 全体を殺さない
- preTrade 自身は secret scrub / 未知 enum reject / 数値範囲 / JSON 8KB cap
- copy は `JSON.parse(JSON.stringify)`（live object 参照を保持しない）

数値：

- confirmedCount 0..5、totalCount === 5
- confidence / DQ 0..100
- observed finite/null、distance >= 0/null
- capital >= 0、riskPercent 既存範囲、riskPerTrade >= 0

---

## size cap

`PRE_TRADE_CONTEXT_MAX_JSON = 8192`。超過は `null`。無制限 JSON にしない。Task013 本体の既存 cap / DB check は維持。

---

## Supabase

既存 `analysis_snapshot` JSONB へ格納。新 table なし。追加 read/write なし（Trade 保存時の既存 write に JSON キーが含まれるだけ）。

---

## DB migration

**0。** remote migration 未実行。`check_trade()` は version=1 object を要求するだけで、未知キーは拒否しない。

---

## RLS

変更なし。

---

## API追加call

| 対象 | 追加 |
|---|---|
| OpenAI | 0 |
| Vision | 0 |
| Twelve Data | 0 |
| Finnhub | 0 |
| FRED | 0 |
| EODHD | 0 |
| Supabase extra roundtrip | 0 |

---

## privacy

保存禁止：API key / system prompt / raw OpenAI / chart image・base64 / Supabase secret / browser state / full market history / raw candles。

保存するのは必要最小限の derived structured context。

---

## mobile

390x844。`.pretrade-grid` は 1 カラム。label 7.5rem + 値 `minmax(0,1fr)`。`overflow-wrap: anywhere`。horizontal overflow なし（E2E 16）。

---

## desktop

1280x900。既存 AI Snapshot details 内に配置。Direction / Action の重複は「判断状況」として事実を再掲する程度に抑える。overflow なし（E2E 17）。

---

## unit tests

Task021：**449 pass** を維持し追加。今回 **488 pass / 0 fail**。

A valid full / B SELL+WAIT+MET / C BUY+WAIT+MET / D 5/5 / E not_met / F equality not_met+0 / G unavailable / H trigger null / I DQ / J confidence / K Event low / L Event high / M Event unavailable not low / N Risk / O DLL / P stale / Q pair mismatch / R invalid trigger / S invalid preTrade は親を殺さない / T capturedAt / U checkedAt / V 判定確認時刻ラベル / W edit / X close / Y toggle OFF / Z legacy / AA local restore / AB unknown enum / AC numeric / AD distance negative / AE no candles / AF no secrets / AG no OpenAI / AH no fetch / AI no backfill / AJ deterministic copy

追加：live readiness を mutation しても snapshot 不変、newlyMet 非保存、quality ラベル非生成。

---

## E2E

Task021：**62 本維持**。新規 17 本。合計 **79 passed**。

1 preview / 2 SELL+WAIT+MET / 3 5/5 / 4 observedValue / 5 checkedAt / 6 Event 未取得 / 7 stale / 8 DLL / 9 toggle OFF / 10 edit / 11 close / 12 market 変化後も journal 不変 / 13 再分析後も snapshot 不変 / 14 pair mismatch / 15 legacy / 16 390x844 / 17 1280x900

実 Supabase / OpenAI / Twelve Data へ通信しない。Task018 fixture + in-memory trades mock。production backdoor なし。

---

## existing regression

壊していない：Daily Trading Plan / Entry Readiness 固定 5 / Structured Trigger / Entry Trigger Watch / AI総合判定 / Risk / Technical / Fundamental / Chart / Trade Journal Task013 snapshot / Performance Period / Entry Timing / AI Entry Context。

Task014/015/016 の集計は新 optional field を無視して従来どおり動く（Performance E2E 維持）。

---

## lint / build / diff

| コマンド | 結果 |
|---|---|
| `npm run lint` | pass |
| `npm test` | 488 pass |
| `npm run test:e2e` | 79 passed |
| `npm run build` | pass（既存 Supabase Node 20 警告のみ） |
| `git diff --check` | pass |

---

## known limitations

- Preview の `capturedAt` 表示は分析時刻（`analyzedAt`）。永続化時は createTrade の `now`（Task013 と同じ）
- `openedAt` はユーザー入力の分精度。snapshot `capturedAt` とは別
- calendar 欠落時に analysis.economicRisk.known=true なら Task017 fallback の LOW が live 事実として保存される（unavailable を LOW に変換する新ロジックではない）
- Task022 では Performance 集計・compliance ラベルを追加しない
- OPEN trade でも context は保存するが、結果分析はしない
- Journal の quote `now` は登録フォームのレート自動入力用。snapshot の Trigger 再評価には使わない

---

## Task023候補

保存済み schema で可能な中立分類：

- trigger status at entry：`met` / `not_met` / `unavailable` / `no_trigger`
- action at entry：`BUY` / `SELL` / `WAIT`
- stale：true/false
- event risk：`high` / `medium` / `low` / `unavailable`
- DLL reached / eventRiskHigh

まだやってはいけない：

- ruleFollowed / ruleBroken / disciplineScore
- Trigger MET = ルール遵守
- WAIT Entry = 悪い Trade
- 勝率予測

helper `triggerStatusAtEntry` / `actionAtEntry` / `eventRiskAtEntry` は Task022 で用意済み。Task023 で集計 UI を設計する。
