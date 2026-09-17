# Task031 実装報告 — Exit Plan & R-Multiple

## 実装概要

Task031は新しい売買判断ではない。Trade登録時点のExit Planを固定保存し、初期リスク値幅と CLOSED Trade の Realized R-Multiple を、¥損益とは別の価格リスク基準の過去結果として表示する。

R は良い/悪い取引、Entry Quality、AI評価、将来予測ではない。

## source of truth

ユーザーが Trade 登録フォームで確認・入力した `stopLoss` / `takeProfit`。AI scenario の SL/TP は prefill のみ。黙って確定 Exit Plan にしない。

R の denominator は保存済み `exitPlan.initialStopLoss` と `exitPlan.entryPrice`。現在の `trade.stopLoss` / `trade.entryPrice` では再構成しない。

## Exit Plan schema

```ts
interface TradeExitPlan {
  version: 1
  pair: Symbol
  side: "buy" | "sell"
  capturedAt: string
  entryPrice: number
  initialStopLoss: number
  initialTakeProfit: number | null
  initialRiskPrice: number
  initialRiskPips: number
  plannedRewardPrice: number | null
  plannedRewardPips: number | null
  plannedRewardRiskRatio: number | null
}
```

Trade へ `exitPlan?: TradeExitPlan | null` を追加。`realizedR` は DB に保存せず derived。

## SL source / TP source

既存 Trade の任意フィールド `stopLoss` / `takeProfit` を登録時にスナップショット。AI scenario から自動確定しない。

## AI prefill

AI scenario に pair・direction が一致し、かつ entry に対して valid な SL がある場合のみフォームへ prefill。TP が invalid なら TP のみ空。editable。注記: 「現在のAI分析から初期値を入力しています。必要に応じて変更してください。」

## user editing

登録前は自由に変更。登録後の Exit Plan は immutable（edit / close で上書きしない）。

## BUY / SELL validation

- BUY: `initialStopLoss < entryPrice`。TP がある場合 `takeProfit > entryPrice`
- SELL: `initialStopLoss > entryPrice`。TP がある場合 `takeProfit < entryPrice`
- 空欄は OK（SL 未入力 → Exit Plan なし、登録可能）
- 入力済みで invalid → field error。黙って null 保存しない
- `entryPrice === stopLoss` は invalid（0除算禁止）

## pip semantics

既存 `priceDeltaToPips` / `JPY_PIP_SIZE = 0.01` を再利用（USD/JPY, EUR/JPY, GBP/JPY）。新規 pip ロジックなし。UI は原則 1 decimal。

## initial risk

BUY: `entryPrice - initialStopLoss`  
SELL: `initialStopLoss - entryPrice`  
正の finite のみ。pips は上記 helper。

## planned reward / planned R:R

BUY: `takeProfit - entryPrice`  
SELL: `entryPrice - takeProfit`  
`plannedRewardRiskRatio = plannedRewardPrice / initialRiskPrice`  
UI: `2.00R`。これは Planned R:R であり Realized R ではない。TP なしなら planned RR は null。

## realized R formula

CLOSED かつ valid Exit Plan かつ finite exitPrice:

- BUY: `(exitPrice - exitPlan.entryPrice) / (exitPlan.entryPrice - initialStopLoss)`
- SELL: `(exitPlan.entryPrice - exitPrice) / (initialStopLoss - exitPlan.entryPrice)`

価格差ベース。`realizedPnl / riskAmount` では計算しない（quantity / fees / slippage を混ぜない）。

## price-based R rationale

Entry / Initial SL / Exit の値幅計画を評価するため。手数料・スワップ・スプレッドは R に含めない。

## no clamp

SL 超え Exit で Realized R < -1 あり得る。TP 超えで Planned R:R より大きくてよい。-1R / TP への clamp なし。

## break-even

`exitPrice === exitPlan.entryPrice` → `0.00R`。UI で `-0.00R` は出さない。

## immutability

create で capture。edit / close は `trade.exitPlan` を保持。クラウド UPDATE は `exit_plan` を PATCH しない。DB `check_trade` も `exit_plan` を immutable。

## historical integrity

CURRENT AI の SL/TP が変わっても stored Exit Plan は不変。利益/損失でも「本来の SL」へ補正しない。

## toggle independence

「現在のAI分析を保存」OFF でも、ユーザーが SL を入力していれば Exit Plan を保存。AI snapshot ではない。AI unavailable / Action WAIT でも保存可能。

## legacy

Task031 以前の `exitPlan` なし Trade は推測しない。表示: 「初期Exit Planは保存されていません」。R: —。

## sanitizer

`sanitizeExitPlan` が version / pair / side / prices / capturedAt を検証し、derived を pair/side/entry/SL/TP から再計算（blind trust しない）。prompt / apiKey / candles / image を拒否。

## pair / side safety

`exitPlan.pair !== trade.pair` または side 不一致 → stored plan は invalid、R null。JSON 自体は残し、表示は確認不可。

## fail-soft

malformed Exit Plan でも Trade は失わない。R のみ unavailable。AI snapshot / PreTrade / MTF / Regime は消さない。

## Trade Form

新規: 初期損切り / 初期利確（任意）。独立 compact EXIT PLAN プレビュー（初期リスク / 計画R:R）。Entry Context には詰め込まない。良い/悪い R:R、Entry OK、GO は出さない。

## OPEN Journal

EXIT PLAN: Entry / 初期損切り / 初期利確 / 初期リスク / 計画R:R。実現R: 未決済。

## CLOSED Journal / Post-Trade Review

EXIT PLAN / RESULT: 上記 + Exit / 実現値幅 / 実現R。Post-Trade Review に実現損益と実現Rを併記。+2R=成功 / -1R=失敗 のラベルなし。

## R Performance

既存 PF は変更せず別集計。対象は CLOSED + valid exitPlan + finite exitPrice + calculable R。

- R Coverage = valid R trades / eligible CLOSED
- Total R / Average R
- positiveR / negativeR / zeroR（内部）

R bucket / 因果分析は Task032 候補。

## local persistence

localStorage journal の `validateTrade` が `exitPlan` を sanitize して復元。legacy は null。

## Supabase persistence / migration / RLS

- カラム: `exit_plan JSONB NULL`（object check）
- migration: `supabase/migrations/20260916210000_add_trade_exit_plan.sql`
- `check_trade` で UPDATE 時 immutable（analysis_snapshot と同様）
- `import_local_trades` に `exit_plan` を追加
- RLS `trades_owner` 維持。policy 追加/無効化なし
- mapper: `exit_plan` ↔ `exitPlan`。malformed JSON は `exitPlan null`、Trade 維持
- 新規 query なし（既存 CRUD payload に含めるのみ）

## API counts / query / polling

外部 API 追加 0（Twelve / OpenAI / Vision / Finnhub / FRED / EODHD）。query 追加 0。polling 追加 0。

## Readiness / Trigger / Action / Daily Plan / Entry Context

Readiness 固定 5。Trigger / Action / Daily Plan 変更なし。Entry Context 構造維持。Exit Plan は独立 section。

## responsive / wording

390: フィールド・R summary 縦積み、横 overflow なし。1280: compact grid。  
使用語: 初期損切り / 初期利確 / 初期リスク / 計画R:R / 実現値幅 / 実現R。  
禁止語: 良いR / 悪いR / 成功R / 失敗R / 理想的 / 最低ライン / おすすめ。

## unit / E2E / regression

- Unit: **993 passed**（baseline 922 を下回らない。Task031 追加含む）
- E2E: **312 passed**（baseline 273 を下回らない。Task031 39 件追加）
- lint / build / `git diff --check` 成功

## known limitations

- partial exits なし（既存 single `exitPrice`）
- fees / swap / spread は R に含めない
- 登録後に `trade.entryPrice` を編集しても R は `exitPlan.entryPrice` 基準
- 現在の SL 移動は R denominator に影響しない

## Task032 候補

- R bucket performance（+1R 以上、0〜1R、-1R 超 等）
- R と勝率の交差集計
- 因果・推奨文言のない参考分布
- multi-exit / scaled-out の R
- 手数料込みの money-R（別指標として明示する場合）
