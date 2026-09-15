# Task017 Daily Trading Plan / 今日のトレード計画 実装報告

実装日：2026-09-15  
検証完了日：2026-09-15  
ステータス：**実装・検証完了**  
対象リポジトリ：AI-FX-Analyst  
ブランチ：`feature/task017-daily-trading-plan`  
コミット・push：未実施（禁止どおり）  
main merge：未実施（`main` は Task015 まで。Task016 も未マージ）

---

## 実装概要

既存の AI 分析・リスク設定・Trade Journal・経済カレンダーを組み合わせ、Dashboard 分析タブ先頭に **今日のトレード計画（Daily Trading Plan）** を追加した。

- 「分析結果を見る」から「今日どう行動するかを整理する」へ進める UI
- **Market Direction ≠ Action Now** を維持（例：AI方向 SELL + Action WAIT）
- 生成は `buildDailyTradingPlan` の決定論的 pure model
- OpenAI / Vision / 外部 API の **追加 call = 0**
- DB migration / RLS / Trade schema / snapshot 変更 **なし**
- 自動売買・証券会社 API **なし**

---

## 変更ファイル

### 新規

- `lib/trading-plan/today.ts` — ローカル暦日 helper（`now` injectable、JST 固定なし）
- `lib/trading-plan/daily-plan.ts` — Daily Plan model / status / 集計
- `components/dashboard/daily-plan.tsx` — 「今日のトレード計画」UI
- `tests/daily-plan.test.ts` — A〜Y および日付境界
- `outputs/Task017-実装報告.md` — 本報告

### 更新

- `components/dashboard/dashboard.tsx` — Daily Plan 配線、TASK 017、trades / risk settings の持ち上げ
- `components/trades/journal.tsx` — 取得済み Trade を `onTradesChange` で再利用
- `components/settings/cloud-settings.tsx` — Task006 設定を `onSettingsChange` で再利用
- `app/globals.css` — Daily Plan レイアウト（mobile 1カラム / desktop 2カラム）

---

## Daily Plan model

`buildDailyTradingPlan({ pair, analysis, trades, riskSettings, currentRate, calendar, dailyLossLimitPercent, now })`

主要フィールド：

- `direction` / `action` / `status` / `mainMessage` / `statusReason` / `directionNote`
- `confidence` / `dataQuality` / `stale`
- `entryCondition` / `invalidationCondition` / `stopLoss` / `takeProfit` / `conditionSource`
- `eventRisk`（calendar または analysis.economicRisk。FRED 入力なし）
- `riskPerTrade`（1回あたり） / `dailyLossLimit`（ユーザー設定時のみ）
- `todayTradeCount` / `todayClosedCount` / `todayRealizedPnl` / `todayScopeLabel: 全通貨ペア`
- `chartEvidenceUsed`

同じ入力なら同じ結果。LLM call なし。

---

## status priority

```
risk_limit > stale > unavailable > wait | review_buy | review_sell
```

| status | 条件 | main message |
|--------|------|----------------|
| `risk_limit` | Daily Loss Limit 設定ありかつ remaining ≤ 0 | 設定したDaily Loss Limitに到達しています |
| `stale` | 分析から 5分以上、または expiresAt 経過 | 分析から時間が経過しています |
| `unavailable` | 分析なし / pair mismatch | AI分析を実行すると今日の計画を表示できます |
| `wait` | action WAIT | 今はエントリーせず待つ |
| `review_buy` | action BUY | BUY条件を確認 |
| `review_sell` | action SELL | SELL条件を確認 |

「今すぐ買う / 売る」「取引禁止」は使わない。

---

## direction / action 分離

- AI方向：`directionSignal` → `BUY` / `SELL` / `NEUTRAL`
- Action：既存 `action`（なければ signal から WAIT/BUY/SELL）
- SELL + WAIT の補助文：`AI方向は下方向ですが、現在のActionはWAITです。`
- BUY + WAIT も同様
- SELL を即 Entry 指示に変換しない（Task012 維持）

---

## Entry / Invalidation / SL/TP

| 項目 | source | ない場合 |
|------|--------|----------|
| Entry条件 | `analysis.scenario.condition` の既存文言のみ | 表示しない（捏造しない） |
| 無効化 | `analysis.scenario.invalidation` | 「無効化条件：データなし」 |
| Stop Loss | `scenario.stopLoss` | 出さない |
| Take Profit | `scenario.takeProfit1` | 出さない |

source label：`現在のAI分析に含まれる条件`  
価格・条件を Daily Plan 側で新規計算しない。

---

## Event Risk

- 優先：既取得の Economic Calendar（`calendarKnown` + 発表前後 window + 次回 upcoming）
- なければ：analysis の `economicRisk`（分析時点のカレンダー由来）
- 重要度はイベント既存 `importance` のみ（高 / 中 / 低 / 不明）
- データなし：`現在利用できる重要イベント情報はありません`
- ニュース本文からの高リスク推測なし

---

## FRED 制約

FRED は released macro actuals。Daily Plan の入力に `macroeconomic` を持たない。  
FRED 実績を「本日21:30 CPI発表」のような未来イベントへ変換しない。

---

## Risk

Task006 の `balance` / `riskPercent` を source of truth とする。  
Daily Plan 専用の capital / riskRate は複製しない。

表示：

- 資金
- 1回あたりRisk（%）
- **1回あたりRisk基準**（`allowedLoss`。1日の最大損失額と呼ばない）

---

## Daily Loss Limit

- 任意のユーザー設定（資金に対する %、上限 10%）
- 初期 **未設定**（危険な既定値を置かない）
- AI 推奨値ではないと明示
- 永続化は **localStorage**（migration なし）
- `dailyLossUsed = max(0, -todayRealizedPnl)`
- `remaining = max(0, limit - used)`
- 利益の日は used = 0（budget を増やさない）
- remaining ≤ 0 でも「取引禁止」とは書かない

---

## Today aggregation

- 判定：Trade の `openedAt` が **ブラウザ / OS の local calendar day**
- JST 固定はしない。`now` injectable
- 全通貨ペア合計を原則とし、UI に「全通貨ペア」と明示。選択 pair 件数は併記
- OPEN：件数に含む、realized P/L に含めない
- closed：既存 `summarize` / `realizedPnl` を再利用（別 P/L 式なし）
- 昨日 opened：today から除外
- 新規 DB query なし。Journal が既に取得した trades を再利用

---

## Pair safety

選択中 pair と `analysis.pair` が不一致なら fail closed → `unavailable`。  
別 pair の条件・SL/TP・chart evidence・confidence を表示しない。

---

## stale

Task012 の `isAnalysisStale`（5分）を再利用。expiresAt 経過も stale。  
再分析 CTA は既存 `refreshAnalysis`（Task012/011 経路）。Daily Plan 専用 API なし。

---

## chart evidence

`analysis.chartEvidence.used` のとき badge「チャート解析を含む」。  
画像 / base64 は Daily Plan に入れない。

---

## UI

分析タブ先頭。優先度：

1. 今の Action（Hero）
2. AI方向
3. Entry条件
4. Risk
5. Event
6. Today's Result
7. Data Quality / Confidence

下部：

- Confidence disclaimer
- 「この画面は分析とリスク管理を整理するための参考情報です。注文は自動送信されません。」

---

## Mobile / Desktop

- Mobile：1カラム。セクション先頭で pair / Action / message / AI方向
- Desktop（1000px+）：Hero 全幅、下 2カラム
- 横スクロール禁止（`min-width: 0` / `overflow-wrap`）
- 既存 dark UI と統合
- ヘッダー / フッター：`TASK 017`

---

## API cost

Daily Plan 表示自体の追加：

OpenAI = 0 / Vision = 0 / FRED = 0 / Finnhub = 0 / Twelve Data = 0

既存 Dashboard の通常 fetch は Task017 追加分に数えない。専用 fetch は追加していない。

---

## Privacy / Security

Daily Plan model / UI に含めない：

- API key
- raw OpenAI response / prompt
- chart image / base64

---

## Tests

既存 309 + 本 Task で **343 pass / 0 fail**。

新規 `tests/daily-plan.test.ts`：

A SELL+WAIT 分離 / B BUY+WAIT / C review_buy / D review_sell / E stale 優先 / F risk_limit 最優先 / G 分析なし / H pair mismatch / I entry あり / J entry なし捏造しない / K SL/TP なし捏造しない / L FRED を未来 event にしない / M OPEN は件数のみ / N closed は P/L / O 昨日除外 / P 利益 used=0 / Q 損失 used / R remaining=0 / S 別 pair 非表示 / T chart badge / U disclaimer / V no auto trading / W NaN safe / X 同一入力同一結果 / Y fetch なし  
+ local day 境界 / 全 pair 合計 / invalidation 空 / stale < risk_limit / 1回Risk≠日次上限

---

## Browser

確認できたこと：

- 分析タブ先頭に「今日のトレード計画 / DAILY TRADING PLAN」
- 未取得時 CTA「AI分析を実行すると今日の計画を表示できます」+ 既存再分析ボタン
- Action Hero が他カードより目立つ
- Entry なしを捏造しない / 無効化はデータなし
- 1回あたりRisk基準と Daily Loss Limit（ユーザー設定・未設定可）を分離
- Event なしコピーが自然
- Today's Result に「全通貨ペア」
- Confidence disclaimer と自動売買しない copy
- AI総合判定・資金リスク・テクニカル・ファンダメンタルが残っている
- 実ユーザー Trade は変更していない（未ログインで Journal 非操作）

ブラウザ MCP が途中切断したため、分析ロード後の SELL+WAIT 実表示、pair 切替後の残留なし、390×844 / 1280×900 の目視スクロール確認は **未完了**。レイアウトは CSS で対応済み。

---

## lint / build

```
npm run lint   # pass
npm test       # 343 pass
npm run build  # pass
git diff --check  # pass
```

---

## 既知の制限

- Daily Loss Limit は localStorage。端末・ブラウザをまたがない
- 1日の最大取引回数は未実装（任意・非必須）
- 期間タブの永続化は Task015 のまま（session）
- AI Entry Context × confidence クロス UI は未実装
- Task016 はまだ `main` 未マージ。本ブランチは Task016 feature から分岐
- ログイン前は Today 件数が 0（Journal 未取得）。ログイン後に既存 trades を再利用
- SSR 初回の `now=0` はクライアント effect 後に local day へ更新（hydration は 0 で一致）

---

## Task018 候補

1. Playwright で Daily Plan / 成績タブの回帰固定（390 / 1280）
2. 期間選択の localStorage 永続化
3. Task016 + Task017 の `main` 段階 merge / PR
4. Daily Loss Limit のクラウド設定化（migration が必要なら別 Task）
5. 1日の最大取引回数（ユーザー設定）

やってはいけない：Daily Plan を勝ちパターン診断にする、Insights のための OpenAI call、Trade side と AI direction の値動きラベル統合。
