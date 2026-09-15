# Task021 Entry Trigger Watch / エントリー条件監視 実装報告

実装日：2026-09-15  
検証完了日：2026-09-15  
ステータス：**実装・検証完了**  
対象リポジトリ：AI-FX-Analyst  
ブランチ：`feature/task021-entry-trigger-watch`  
コミット・push：未実施（禁止どおり）

---

## 実装概要

Task021 は新しい売買判断ではない。Task020 の `sanitizeStructuredEntryTrigger` / `evaluateStructuredEntryTrigger` の結果を、Dashboard 上で監視しやすくする presentation / derived state である。

- 既存 Market Data の 60 秒更新に乗るだけ（新しい timer / polling なし）
- 「条件まであと何 pips」は structured trigger + evaluation.observedValue からのみ算出
- Trigger MET でも Action は既存値（WAIT のまま）
- not_met → met だけを session 内 newly met として扱う
- 追加 API call 0、DB migration 0、Watch state の永続化なし

---

## 変更ファイル

### 新規

- `lib/trading-plan/entry-trigger-watch.ts` — Watch model / identity / distance / transition helper
- `tests/entry-trigger-watch.test.ts` — A–Z / AA–AH ほか
- `components/dashboard/entry-trigger-watch.tsx` — ENTRY TRIGGER WATCH UI
- `e2e/entry-trigger-watch.spec.ts` — Playwright 17 本
- `outputs/Task021-実装報告.md`（本報告）

### 更新

- `components/dashboard/entry-readiness.tsx` — Task020 カードを Watch に発展（固定 5 check は未変更）
- `components/dashboard/daily-plan.tsx` — analyzedAt / rateDecimals を Watch へ受け渡し
- `app/globals.css` — Watch hero / notice / overflow 防止
- `e2e/helpers/mock.ts` / `e2e/helpers/goto.ts` — route fixture の market / analysis をテスト中に更新可能に

Task020 evaluator の判定式は Watch へコピーしていない。

---

## Watch model

```ts
type EntryTriggerWatchStatus = "waiting" | "met" | "unavailable" | "invalid"

buildEntryTriggerWatch({
  trigger, evaluation, action, direction,
  stale, dailyLossLimitReached, eventRiskHigh, analyzedAt, pair
})
```

- `not_met` → `waiting`
- `met` → `met`
- `unavailable` / `invalid` はそのまま
- stale は status ではなく warning
- trigger / evaluation が無い場合は `null`（Watch UI 非表示）
- `progressPercent` / `distancePercent` / `probability` / `winRate` は持たない

---

## source of truth

- 判定：`lib/ai/entry-trigger.ts` の `evaluateStructuredEntryTrigger`
- 正規化：`sanitizeStructuredEntryTrigger`
- Watch は `evaluation.status` / `observedValue` / `checkedAt` だけを読む
- Watch 側で currentRate 再取得・candles 再解析・forming candle 利用はしない

---

## distance formula

未成立時のみ UI 表示。内部は `max(0, signedGap)` を JPY pip へ変換。

| type | signed gap |
|---|---|
| `price_above` | `trigger.price - observedValue` |
| `price_below` | `observedValue - trigger.price` |
| `candle_close_above` | `trigger.price - observedClose` |
| `candle_close_below` | `observedClose - trigger.price` |

- met：内部 0 pips、UI は「条件成立」を優先（distance 非表示）
- 負の pips は表示しない
- 1500 pips のような大きな値も数値として表示する（「遠すぎる」等の評価は付けない）

---

## pip helper

再利用：`lib/trades/analysis-price.ts` の `priceDeltaToPips`（`JPY_PIP_SIZE = 0.01`）。

表示は `formatWatchDistancePips`（整数はそのまま、必要なら小数 1 桁。`7.999999` は出さない）。

---

## equality behavior

Task020 の strict inequality を維持。

`observed == trigger.price` → evaluation `not_met` → Watch `waiting` + **あと 0 pips**。

**0 pips ≠ 成立**。

---

## price trigger

`observedValue` は Task020 evaluation の currentRate。Watch は再取得しない。

---

## candle trigger

`observedValue` は Task020 evaluation の最新確定足 close。Watch は candles を再解析しない。形成中足は使わない。

確定足 timestamp は evaluator が返していないため、「ローソク足確定 12:15」とは書かない。`checkedAt` を candle close time として偽装しない。

---

## unavailable

表示：**判定データ待ち**。

安全に理由が分かる場合のみ：

- 価格トリガー：現在価格の判定データを待っています
- 時間足トリガー：例）15分足の確定データを待っています

存在しないデータを推測しない。timeframe 代用なし。evaluation が unavailable なら Watch も unavailable。

---

## invalid

表示：**構造化条件を利用できません**。raw invalid payload は出さない。

---

## trigger null

structured trigger なし → Watch UI 非表示。

Task019/020 の「確認条件あり」「条件成立の自動判定はしていません」を維持。

---

## Direction / Action

Watch Hero で **AI方向** と **現在Action** を同時表示。

Trigger met でも Action は既存値。WAIT を WAIT のまま維持。BUY/SELL を生成しない。

---

## stale

analysis stale + trigger met：

- Trigger status：条件成立
- warning：分析が古いため再分析してください
- 既存 CTA「AI総合分析を更新」を再利用
- Action は既存値

---

## DLL

DLL reached + trigger met：

- Trigger status：条件成立
- Safety warning：設定したDaily Loss Limitに到達しています
- Action 変更なし
- 「取引禁止」は出さない

---

## Event high

high Event Risk + trigger met：

- Trigger status：条件成立
- Event warning は残す（消さない）
- Action 変更なし

---

## transition detection

session memory（React state）のみ。DB / localStorage なし。

`nextWatchTransitionState`:

- `newlyMet = true` は **previous === not_met かつ current === met かつ同一 trigger identity** のみ
- inline notice：`エントリー条件の成立を確認しました`（`role="status"`）
- 自動消去 timer なし。identity / pair / reanalysis で reset

---

## unavailable → met

unavailable は「未成立を確認した」ではない。

そのため **unavailable → met は newlyMet = false**。「たった今成立した」とは断定しない。

---

## initial met

初回 render 時点ですでに met：

- 状態は「条件成立」
- 「たった今成立」「新しく成立」の演出はしない
- transition notice は出さない

---

## trigger identity

最低限：

`analyzedAt | pair | type | price | timeframe`

再分析で Trigger が変わったら previous を引き継がない。

---

## pair switch

USD/JPY → EUR/JPY で previous evaluation / met transition を残さない。pair 単位で fail closed。

---

## reanalysis

新 analysis になったら Watch をリセット。旧 Trigger の distance / transition / checkedAt を残さない。

---

## checkedAt

Task020 `evaluation.checkedAt` を利用。Watch で `Date.now()` を新たに量産しない。

met 時：「確認 HH:mm」＋「Dashboardで条件成立を確認した時刻」。

市場イベント時刻や candle close time としては表示しない。

---

## UI

Entry Readiness 内の Task020 カードを **ENTRY TRIGGER WATCH** に発展。別巨大パネルは増やしていない。

- 固定 5 check（AI分析 / Direction / Data Quality / Risk / Event Risk）は変更なし。Watch は 6 項目目にしない
- 落ち着いた成立確認。confetti / チャンス / 今です / ENTRY / GO なし
- 必須 disclaimer：条件までのpipsは価格差を示すだけで、成立確率やエントリー推奨度ではありません。
- Task020 の「条件成立は売買推奨ではない」disclaimer も維持

---

## accessibility

状態を色だけで伝えない。

条件待ち / 条件成立 / 判定データ待ち / 利用不可 を text 表示。

transition notice に `role="status"`。

---

## mobile

390×844。SELL / WAIT / 条件文 / expression / 最新値 / distance / status / disclaimer を同時表示しても horizontal overflow なし（E2E 16）。

---

## desktop

1280×900。Entry Readiness 内で視線移動が短い。Daily Plan との重複を増やしすぎない（E2E 17）。

---

## percentage禁止

model / UI に `progressPercent` / `distancePercent` / `probability` / `winRate` を追加していない。80%到達 / 92%達成 は出さない。

---

## API追加call

| サービス | 追加 call |
|---|---|
| OpenAI | 0 |
| Vision | 0 |
| Twelve Data | 0 |
| Finnhub | 0 |
| FRED | 0 |
| EODHD | 0 |

---

## polling追加有無

**production への追加 polling / setInterval は 0。**

既存 `useMarket` / `useAIAnalysis` の 60 秒更新に乗るだけ。

E2E の not_met → met は Playwright `clock.fastForward` で既存 setTimeout 経路を進める。production backdoor（`?e2e=true` / `window.__E2E__`）なし。

---

## DB

migration なし。RLS 変更なし。Watch state 保存なし。

---

## snapshot方針

Task020 ですでに sanitized `entryTrigger` を Trade Snapshot へ保存済み。

Task021 では：

- live Watch transition を DB へ自動保存しない
- ユーザーが Trade 登録した瞬間の evaluation 追加保存は **見送る**

理由：Watch 機能と snapshot schema 変更を分離する。

---

## privacy

Watch model / UI へ API key / raw OpenAI / system prompt / chart image / Supabase secret を入れない。

---

## unit tests

Task020：**412 pass** を維持し追加。今回 **449 pass / 0 fail**。

A–Z：distance（above/below × price/candle）、met 0、equality waiting+0、decimal rounding、unavailable/invalid は distance なし、trigger null、SELL/BUY+WAIT、met でも WAIT、stale/DLL/Event warning、percentage なし、deterministic、大きい distance、pair mismatch、checkedAt、Watch 内 candle 再評価なし、fetch/timer/確率なし、Task020 equality 維持。

AA–AH：not_met→met、initial met、met→met、unavailable→met、identity/pair/analyzedAt/reanalysis reset。

---

## E2E

Task020：**45 本維持**。新規 17 本。合計 **62 passed**。

1 waiting+8 pips / 2 price met / 3 candle waiting / 4 candle met / 5 equality 0 pips / 6 判定データ待ち / 7 SELL+WAIT+MET / 8 5/5+WAIT+MET / 9 stale+MET / 10 DLL+MET / 11 Event high+MET / 12 pair switch / 13 identity change / 14 initial met / 15 not_met→met notice / 16 390 / 17 1280

実 OpenAI / Twelve Data へは通信しない。

---

## existing regression

壊していない：Daily Trading Plan / Entry Readiness 固定 5 check / Structured Entry Trigger / AI総合判定 / Risk / Technical / Fundamental / Chart / Trade Journal / Performance / Period filter / Entry Timing / AI Entry Context。

---

## lint / build / diff

| コマンド | 結果 |
|---|---|
| `npm run lint` | pass |
| `npm test` | 449 pass |
| `npm run test:e2e` | 62 passed |
| `npm run build` | pass（既存 Supabase Node 20 警告のみ） |
| `git diff --check` | pass |

---

## known limitations

- Watch は Dashboard を開いている間だけ再評価する。バックグラウンド監視サービスではない
- OS / Email / LINE / Push / Notification API は未実装（意図的）
- 自然言語 condition の距離計算はしない
- 1min/5min/30min/1day は Task020 どおり unavailable
- `==` は 0 pips でも未成立
- Trade 登録時に live evaluation を snapshot へは保存しない（本 Task で見送り）
- 確定足の close time は evaluator が返さないため UI に出さない
- ライブ認証ブラウザ MCP は未接続。検証は Playwright

---

## Task022 候補

1. Trade 登録時に Task020 evaluation（status / observedValue / checkedAt）を snapshot へ追加保存
2. ユーザー向け「Watch は画面を開いている間だけ」の短い説明
3. Daily Plan への Trigger 状態の重複表示はしない方針のまま、Readiness 内の視線誘導だけ改善
4. `==` 近傍の tick size 許容（MVP は strict inequality のまま）
5. evaluator が安全に closed candle time を返せる場合のみ `observedAt` を追加
