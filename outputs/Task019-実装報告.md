# Task019 Entry Readiness / エントリー準備度 実装報告

実装日：2026-09-15  
検証完了日：2026-09-15  
ステータス：**実装・検証完了**  
対象リポジトリ：AI-FX-Analyst  
ブランチ：`feature/task019-entry-readiness`  
コミット・push：未実施（禁止どおり）

---

## 実装概要

Task019 は新しい AI 判断ではない。Task017 Daily Trading Plan と既存 analysis / Risk / Event Risk から、

**「Entry を検討する材料がどこまで揃っているか」**

を derive して可視化する presentation layer である。

- 追加 OpenAI / Vision / 外部 API call：**0**
- 売買シグナル化しない（5/5 でも Action WAIT を維持）
- percentage / 勝率 / BUY-SELL probability なし
- 自然言語 Entry 条件の成立判定なし
- DB 保存なし（毎回既存 state から算出）
- Task005 / 006 / 012 / 017 の判定ロジックは未変更

---

## 変更ファイル

### 新規

- `lib/trading-plan/entry-readiness.ts` — pure `buildEntryReadiness`
- `components/dashboard/entry-readiness.tsx` — ENTRY READINESS パネル
- `tests/entry-readiness.test.ts` — A–Z および補助テスト
- `e2e/entry-readiness.spec.ts` — Playwright 拡張
- `outputs/Task019-実装報告.md`（本報告）

### 更新

- `components/dashboard/daily-plan.tsx` — Daily Plan の直後に Readiness を追加（置き換えない）
- `app/globals.css` — 1カラム / overflow 対策
- `e2e/fixtures/analysis.ts` — `event-unavailable`
- `e2e/fixtures/fundamental.ts` — calendar `high` / `empty` / `unavailable`
- `e2e/helpers/mock.ts` / `goto.ts` — scenario.calendar と `entry-readiness` 待機
- `e2e/responsive.spec.ts` — 既存 heading を Daily Plan に scope（`確認すべきEntry条件` との衝突回避）

---

## Entry Readiness model

```ts
buildEntryReadiness({ pair, analysis, dailyPlan, riskSettings })
```

| フィールド | 意味 |
|---|---|
| `pair` | 選択中ペア |
| `state` | `ready_to_review` / `waiting` / `warning` / `unavailable` |
| `confirmedCount` / `totalCount` | 固定5項目の確認数。`totalCount` は常に 5 |
| `action` / `direction` | Daily Plan の値をそのまま。Readiness は変更しない |
| `checks` | analysis / direction / dataQuality / risk / eventRisk |
| `entryCondition` | 別枠。confirmed にしない |
| `warnings` | daily_loss_limit → stale → analysis_unavailable → invalid_risk → low_data_quality → high_event_risk |
| `chartEvidenceUsed` | 補助表示のみ |
| `confidence` | 参考表示のみ。count に含めない |

**持たないフィールド：** `percentage` / `probability` / `winRate` / `readinessPercent`

各 check の状態：`confirmed` | `pending` | `warning` | `unavailable`  
文字ラベル：確認済み / 確認待ち / 注意 / 未取得

---

## fixed 5 checks

1. **AI分析**
2. **AI方向（Direction）**
3. **Data Quality**
4. **Risk Setting**
5. **Event Risk**

Entry Condition は母数に含めない。Confidence / Chart も母数に含めない。

---

## confirmed count rule

- 表示：`{confirmedCount} / 5 条件確認`
- `status === "confirmed"` のみ加算
- `pending` / `warning` / `unavailable` は加算しない
- Event unavailable を confirmed に数えない
- Entry Condition の存在を成立済み confirmed に数えない
- Chart の有無で count を変えない

例：

| 状況 | count |
|---|---|
| 分析・方向・DQ高・Risk有効・Event low | 5 / 5 |
| 上記 + Event high | 4 / 5 |
| 上記 + Event unavailable | 4 / 5 |
| analysis なし（Risk のみ有効） | 1 / 5（overall は unavailable） |

---

## overall state priority

Daily Plan に合わせ、高い方を優先：

1. `daily_loss_limit` → `warning`（「設定したDaily Loss Limitに到達しています」）
2. `stale` → `warning`（「分析から時間が経過しています」+ CTA）
3. `analysis unavailable`（missing / pair mismatch）→ `unavailable`
4. いずれかの固定 check が `warning` → `warning`
5. いずれかが `pending` または `unavailable` → `waiting`
6. 固定5すべて confirmed → `ready_to_review`（「条件を確認できます」）

`ready_to_review` は **Entry OK ではない**。

---

## Direction / Action separation

- Direction BUY/SELL → check confirmed。これは「Entry してよい」ではない
- Direction NEUTRAL → pending
- analysis なし → direction unavailable（Daily Plan の NEUTRAL 表示とは区別）
- Action は check に含めず、Hero で別表示
- Action WAIT → 「現在のActionはWAITです」+「条件成立まで待つ」
- Action BUY/SELL → Task017 の 「BUY条件を確認」/「SELL条件を確認」を再利用
- Readiness が高いことによる Action 変更はしない

---

## Data Quality

新しいスコア計算はしていない。`analysis.dataQuality.score`（Daily Plan 経由）を使い、既存 `qualityLabel`（`lib/chart-analysis/normalize.ts`）を再利用：

| score | qualityLabel | Readiness |
|---|---|---|
| >= 80 | 高 | confirmed |
| >= 50 | 中 | pending |
| < 50 | 低 | warning |
| missing / NaN | — | unavailable |

Performance 用 `SCORE_BANDS`（0-49 / 50-69 / 70-84 / 85-100）はトレード成績のグループ分けであり、Task019 の 高/中/低 には使っていない。

---

## Entry Condition

- ソースは Task005/012/017 の `scenario.condition` のみ（Daily Plan `entryCondition`）
- テキストあり → `pending` / 「確認条件あり」
- なし → `unavailable`
- `evaluated: false` 固定
- 明示：「条件成立の自動判定はしていません」
- `currentRate` が条件価格を下回っていても成立判定しない（自然言語 parser なし）

---

## Risk

Task006 / Daily Plan の `capital` / `riskPercent` / `riskPerTrade`（= `allowedLoss`）を再利用。計算式のコピーなし。

| 入力 | status |
|---|---|
| settings なし | unavailable |
| 値不正で `riskPerTrade` が出せない | warning「Risk設定を確認してください」 |
| 3値とも有効 | confirmed（1回あたり金額） |

Daily Plan 専用の Risk 値は作っていない。

---

## Daily Loss Limit

- Daily Plan の `dailyLossRemaining <= 0` を再利用
- 到達時は warnings 先頭 + overall `warning`
- 文言：既存 `RISK_LIMIT_MESSAGE`「設定したDaily Loss Limitに到達しています」
- 「取引禁止」は出さない
- 他 check が confirmed でも Entry 推奨へ変換しない

---

## Event Risk

Daily Plan `eventRisk` を再利用。新規 calendar fetch なし。

| eventRisk | status |
|---|---|
| high | warning |
| medium | pending |
| low | confirmed |
| available=false / unknown で未取得 | unavailable |

unavailable の表示：**「イベント情報：取得できていません」**  
**「重要イベントなし」とは書かない。** unavailable を安全とも扱わない。

---

## FRED constraint

FRED actual を未来 Event にしていない。Task009/017 どおり、Event は経済カレンダー（または analysis.economicRisk の既存フォールバック）のみ。E2E fundamental fixture の FRED は empty のまま。

---

## chart evidence

`chartEvidence.used` はバッジ「チャート解析を含む（任意）」のみ。Chart なしでも count / overall を下げない。必須 check ではない。

---

## pair safety

`analysis.pair !== 選択 pair` は fail closed。他 pair の condition / chart / confidence を出さない。E2E：USD/JPY → EUR/JPY で旧条件「156.20を下抜けた場合」が Readiness に残らない。

---

## stale

- analysis check = warning「分析を更新してください」
- overall = warning
- CTA は Task012/017 と同じ 「AI総合分析を更新」（新規 AI call 経路を増やしていない）

---

## UI

Daily Trading Plan の直下に別パネル：

- eyebrow：`ENTRY READINESS`
- title：`エントリー準備度`
- Hero：`3 / 5 条件確認` + 現在Action + WAIT/BUY/SELL copy
- 5 check list
- 別カード「確認すべきEntry条件」
- Disclaimer 必須文

Daily Plan は残置。Today's Result / Daily Loss Limit 入力 / Event 詳細は Daily Plan 側のまま（重複を抑える）。

---

## accessibility

色だけで状態を表さない。各 check に「確認済み / 確認待ち / 注意 / 未取得」を併記。記号（✓ / — / ! / ×）は `aria-hidden`。

---

## mobile / desktop

- 390x844：1カラム、`min-width: 0` / `overflow-wrap: anywhere`、horizontal overflow なし（E2E）
- 1280x900：Daily Plan の下に全幅の補助パネル。grid-column 1 / -1

ライブ認証セッションでの手動ブラウザ確認は、Browser MCP がこの環境で未接続のため未実施。Playwright が両 viewport で overflow と主要 copy を確認済み。

---

## API cost

Entry Readiness 表示による追加：

| サービス | 追加 call |
|---|---|
| OpenAI | 0 |
| Vision | 0 |
| Twelve Data | 0 |
| Finnhub | 0 |
| FRED | 0 |
| EODHD | 0 |

`buildEntryReadiness` は同期 pure function。`fetch` / 外部 SDK を import しない。

---

## DB

migration なし。RLS 変更なし。Readiness を保存しない。毎回 `buildDailyTradingPlan` の結果から derive。

---

## privacy

model / UI に API key、prompt、raw OpenAI response、chart image/base64 を入れない。condition テキストは既存 analysis.scenario.condition のみ。

---

## unit tests

Task018 時点：343 pass を維持したうえで追加。

今回：`# tests 372` / `# pass 372` / `# fail 0`

A–Z：

| ID | 内容 |
|---|---|
| A | analysis valid → confirmed |
| B | analysis missing → unavailable |
| C | pair mismatch fail closed |
| D | stale → warning + CTA copy |
| E | BUY direction confirmed |
| F | SELL direction confirmed（Entry OK にしない） |
| G | NEUTRAL → pending |
| H | DQ high（82 / 高） |
| I | DQ low（20 / 低） |
| J | DQ missing |
| K | Risk valid |
| L | Risk invalid |
| M | Event high → warning |
| N | Event low → confirmed |
| O | Event unavailable copy |
| P | unavailable を confirmed に数えない |
| Q | condition あり → pending |
| R | condition なし |
| S | 自然言語を currentRate で成立判定しない |
| T | Daily Loss Limit 最優先 |
| U | WAIT 維持 |
| V | 5/5 + WAIT のまま WAIT |
| W | chart optional |
| X | deterministic |
| Y | no external call |
| Z | percentage / probability フィールドなし |

補助：BUY は review copy、DQ 中（60）は pending、Risk settings なしは unavailable。

---

## E2E

Task018 の 26 本は全維持。Playwright 追加 8 本。合計 **34 passed**。

| テスト | 確認 |
|---|---|
| 49 SELL+WAIT | direction SELL / action WAIT。WAIT は Readiness で変わらない |
| 50 5/5+WAIT | `5 / 5 条件確認` + WAIT。「Entry OK」「今すぐ売る/買う」なし。`%` なし |
| 51 Event unavailable | 未取得。「重要イベントなし」なし。5/5 にしない |
| 52 stale | 注意 + 「AI総合分析を更新」 |
| 53 Daily Loss Limit | warning 最優先。「取引禁止」なし |
| 54 pair switch | EUR/JPY で旧 pair 条件が残らない |
| 55 / 55b | 390x844 / 1280x900 overflow なし |

fixture 拡張のみ。新しい E2E フレームワークは導入していない。

---

## existing regression

壊していない（E2E 26 + unit 既存 343 で確認）：

Daily Trading Plan / AI総合判定 / Risk / Technical / Fundamental / Chart / Trade Journal / Performance / Period filter / Entry Timing / AI Entry Context

Task005/006/012/017 の判定関数は未改変。

---

## lint / build

| コマンド | 結果 |
|---|---|
| `npm run lint` | pass |
| `npm test` | 372 pass |
| `npm run test:e2e` | 34 passed |
| `npm run build` | pass（既存の Supabase Node 20 deprecation 警告のみ） |
| `git diff --check` | pass |

---

## known limitations

- 自然言語 condition の市場成立は判定しない（将来の structured trigger 待ち）
- Event unavailable は「イベントなし」ではなく「未取得」。安全とも扱わない
- `ready_to_review` は材料が揃った確認可能状態であり、発注許可ではない
- Data Quality の 高/中/低 は chart `qualityLabel`（80/50）に合わせた。insights の 4-band とは別
- Confidence は参考表示のみ
- Daily Plan の Event 文言（「現在利用できる重要イベント情報はありません」）は Task017 のまま。Readiness 側だけ「取得できていません」に切り替えている

---

## Task020 候補

1. Structured Entry Trigger（価格・時間足を structured 化し、自然言語 parser なしで成立判定できるようにする）
2. Daily Plan の Event unavailable copy を Readiness と揃える（「重要イベントなし」誤読の防止を Daily Plan 側にも）
3. Readiness の desktop 2カラム（check list | condition）で Daily Plan との視線移動をさらに短くする
4. Risk invalid 時に既存「資金・リスク管理」パネルへフォーカスする CTA
5. stale / DLL の優先度を Dashboard 全体（AI総合判定 Hero）とさらに視覚的に揃える
