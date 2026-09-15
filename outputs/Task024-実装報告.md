# Task024 Pre-Trade Review / エントリー前最終確認 実装報告

実装日：2026-09-15  
検証完了日：2026-09-15  
ステータス：**実装・検証完了**  
対象リポジトリ：AI-FX-Analyst  
ブランチ：`feature/task024-pretrade-review`  
コミット・push：未実施（禁止どおり）

---

## 実装概要

Task024 は新しい売買判断ではない。Trade 登録フォームの最終段階に **PRE-TRADE REVIEW** を追加し、いま保存されようとしている Pre-Trade Context と、入力した Trade side の関係を確認できるようにした。

Review は **情報提示 + warning のみ**。登録可否は決定しない。

- WAIT / Trigger 未成立 / Event HIGH / stale / DLL 到達でも登録可能
- 「Entry OK」「GO」「今すぐ買う/売る」などの推奨・禁止文言なし
- OpenAI / Vision / 外部 API / Supabase extra query / 新 timer / polling / DB migration なし
- Review 自体は DB 保存しない（永続化は Task022 snapshot のみ）

---

## 変更ファイル

### 新規

- `lib/trades/pre-trade-review.ts` — `buildPreTradeReview` / warning builder / live capture wrapper
- `components/trades/pre-trade-review.tsx` — 登録フォーム内 inline Review
- `tests/pre-trade-review.test.ts` — A–AZ ほか 47 本
- `e2e/pretrade-review.spec.ts` — Playwright 23 本
- `outputs/Task024-実装報告.md`（本報告）

### 更新

- `components/trades/trade-form.tsx` — toggle の下・登録ボタンの上に Review。WAIT / 方向 conflict を Review へ統合。source 取得を toggle から独立
- `components/trades/pre-trade-context.tsx` — 登録用 preview を削除。Journal 詳細 renderer は維持
- `app/globals.css` — Review 1 カラム（390）/ 2〜3 列（desktop）/ overflow-wrap
- `e2e/fixtures/analysis.ts` — `trigger-price-above`（BUY + WAIT + MET）
- `e2e/pretrade-context.spec.ts` — Task022 preview 意味を Review testid へ合わせて維持

Task023 Performance 集計ロジックは未変更。schema / migration / RLS 未変更。

---

## Review source

Dashboard 既存 live state のみ。

1. Trade form の pair / side
2. 表示中 AI analysis（pair 一致時のみ）
3. `getPreTradeSource()` の Daily Plan + Entry Readiness（Task022 と同じ ref）

Review 専用の currentRate fetch / AI fetch / Trigger 再評価 / Risk 再計算は作っていない。

---

## Task022との関係

`captureLivePreTradeContext` は Task022 `capturePreTradeContext` を再利用する。

- distance は Task021 `buildEntryTriggerWatch`（Task022 service と同じ経路）
- pair mismatch / 分析なしは capture が null（fail closed）
- sanitizer も Task022 のまま

登録時の最終記録は従来どおり `createTrade` → `captureTradeAiSnapshot` → `capturePreTradeContext`。Review は preview であり、snapshot を置き換えない。

---

## Review/snapshot consistency

同じ analysis + plan + readiness を渡すと、`capturedAt` 以外の意味フィールドが一致する。

| 項目 | Review | Journal snapshot |
|---|---|---|
| pair | form pair | draft.pair |
| direction | capture | 同じ |
| action | capture | 同じ |
| readiness | `n / 5` | 同じ confirmedCount / totalCount=5 |
| trigger status | capture（invalid は live eval） | capture（invalid は null） |
| event risk | `formatPreTradeEvent` | 同じ |
| stale | analysisStale | 同じ |
| risk | capital / percent / perTrade | 同じ |

`capturedAt` は Review では分析時刻（表示用）、snapshot では登録時刻 `now`。Review 表示時刻を snapshot capturedAt として見せない。

---

## UI placement

Trade form 内：

pair / side / 価格 / 数量  
→ 「現在のAI分析をこの取引に保存」toggle  
→ PRE-TRADE REVIEW  
→ 登録ボタン

確認 modal / 必須 checkbox / 二段階 submit は追加していない。

---

## Trade side

Review 上部：

- `USD/JPY`
- `SELLで登録予定` または `BUYで登録予定`

これは Trade form の side。AI Direction ではない。

---

## AI Direction

別ラベル **AI方向**。BUY / SELL / NEUTRAL / 未取得。

混同しない。conflict 時も「間違った方向です」「SELLに変更してください」とは書かない。

---

## Action

**現在Action**：BUY / SELL / WAIT / 未取得。

Trigger MET でも Action を変更しない。

---

## WAIT

Action WAIT なら warning：

「現在のActionはWAITです。」

Trigger がある場合は既存 `TRIGGER_DISCLAIMER`（条件成立 ≠ 売買推奨）を表示。登録ボタンは有効。

---

## Readiness

Task019 固定 5。表示は `4 / 5` または `5 / 5`。

state の日本語は既存 `STATE_LABEL`（条件を確認できます / 確認待ち / 注意 / 未取得）。

5/5 を Entry OK / 取引推奨へ変換しない。Trigger を 6 項目目にしない。

DQ / Confidence は Review では省略し、Direction / Action / Readiness / Trigger / Event / Freshness / Risk に集中した。

---

## Trigger

- MET → 条件成立
- not_met → 条件未成立 + warning
- unavailable → 判定データ不足 + warning
- invalid → 構造化条件利用不可（raw payload 非表示）
- null → 「自動判定できる構造化条件はありません」（自然言語は解析しない）

---

## equality

threshold == observed は Task020/021 どおり **not_met + 0 pips**。

Review：条件未成立 / 条件まであと 0 pips。0 pips だから MET へ変更しない。

---

## distance

not_met のときだけ Task021 Watch の pips を表示。

「条件までのpipsは価格差を示すだけで、成立確率やエントリー推奨度ではありません。」

percentage / probability / progress は出さない。負の distance は作らない。

---

## Event Risk

LOW / MEDIUM / HIGH / 未取得。unavailable を LOW にしない。

HIGH warning：「重要イベントリスクが高い状態です。」  
未取得 warning：「イベントリスク情報を取得できていません。」

---

## stale

`analysisStale=true` → 期限切れ分析 + warning。  
false → 最新分析。再分析 CTA はフォームへ重複追加しない。

---

## DLL

`dailyLossLimitReached=true` → 「設定したDaily Loss Limitに到達しています。」

「取引禁止」「登録できません」は出さない。登録可能。

---

## Risk

Task022 の `riskPerTrade` / `riskPercent`。例：`500円 / 1.0%`。

context がなければ **未取得**。0 円とは推測しない。

---

## toggle ON/OFF

Task022 トグル維持。

- ON：Review に保存予定 context。「この判断状況は取引登録時点の情報として保存されます」
- OFF：Review は残す。「AI分析の保存がOFFのため、この判断状況は取引履歴には保存されません」。保存結果 `analysisSnapshot = null`

toggle ON かつ context ありのときだけ `data-testid="pretrade-preview"` を付け、Task022 preview テストの意味を維持。同じ情報を preview と Review で二重表示しない。

---

## warnings

pure `buildPreTradeReview`。component に判定をベタ書きしない。builder は入力を mutation しない。

| code | severity |
|---|---|
| daily_loss_limit_reached | warning |
| analysis_stale | warning |
| event_high | warning |
| event_unavailable | info |
| action_wait | warning |
| direction_conflict | warning |
| trigger_unavailable / invalid / not_met | warning |
| context_unavailable | info |
| context_not_saved | info |

danger / success は使わない。色だけでなく text 必須。warning list に `aria-label="エントリー前の注意"`。

必須 disclaimer：

「この表示はエントリー前の判断状況を確認するためのもので、売買を推奨・禁止するものではありません。」

---

## warning priority

表示順は固定。最大 5 件。複数同時表示可。

1. Daily Loss Limit  
2. stale  
3. Event HIGH / unavailable  
4. Action WAIT  
5. Direction conflict  
6. Trigger unavailable / invalid / not_met  
7. context unavailable / not saved  

複合 fixture（DLL + stale + Event HIGH + WAIT + NOT_MET）でも submit 可能。優先度の低い `context_not_saved` は cap で落ちることがある。

---

## blocking有無

**なし。** `blocking: false` 固定。

warning で submit を disabled にしない。既存 HTML/validateDraft のみ。

---

## submit behavior

既存 1 回 submit。busy 中以外は「取引を保存」が有効。登録瞬間の Task022 snapshot が最終記録。

---

## pair safety

Trade pair と analysis / plan / readiness の pair が不一致なら context null。

他 pair の Direction / Trigger を表示しない。「現在のAI判断状況を確認できません」。Task022 も foreign context を保存しない。

---

## analysis unavailable

Review panel は表示。AI判断状況は未取得。warning あり。登録可能。snapshot なし。

---

## live update

既存 market refresh / analysis refresh / Journal re-render で Review は最新 live source を読む。Review 専用 polling は追加していない。

---

## polling

追加 0。`setInterval` / `setTimeout` / fetch loop を Review に入れてない。

---

## schema / DB / API

- schema 変更 0（Trade / TradeAiAnalysisSnapshot / PreTradeContextSnapshot そのまま）
- DB migration 0
- RLS 変更 0
- new table 0
- reviewAccepted / reviewSeen / reviewWarnings を DB へ追加していない
- OpenAI 0 / Vision 0 / Twelve Data 0 / Finnhub 0 / FRED 0 / EODHD 0
- Supabase extra query 0

---

## privacy

Review に出さない：API key / raw OpenAI / system prompt / chart image / raw candles / Supabase secret / invalid trigger の raw payload。

---

## mobile / desktop

- 390x844：1 カラム。overflow なし（E2E 22）
- 1280x900：summary 2〜3 列。warning は下部。overflow なし（E2E 23）

---

## accessibility

- section `aria-label="エントリー前の最終確認"`
- dt/dd で label/value
- warning はテキスト必須
- warning list `aria-label="エントリー前の注意"`

---

## unit tests

Task023 baseline **542** を維持し、**589** pass（+47）。

A–AZ および WAIT+MET / toggle OFF snapshot null / warning 複合順序 / cap を含む。

---

## E2E

Task023 baseline **99** を維持し、**122** pass（+23）。

Task018 fixture 方式。実 Supabase / OpenAI / Twelve Data へ通信しない。warning ありでも mock Trade 登録し、Journal の Task022 snapshot まで確認。

---

## regression

壊していない：

Daily Trading Plan / Entry Readiness / Structured Trigger / Entry Trigger Watch / Trade Journal / Task013 snapshot / Task022 PreTrade snapshot / Task023 Performance / Period filter / Entry Timing / AI Entry Context / Risk / 既存 Trade validation。

---

## known limitations

- Review の live `capturedAt` は分析時刻。保存 snapshot の `capturedAt` は登録 `now`。意味フィールドは一致、時刻は一致させない（仕様）
- Task022 は invalid trigger を snapshot に残さない（`trigger=null`）。Review だけ live eval で「構造化条件利用不可」を出す
- warning cap 5 のため、複合 + toggle OFF では `context_not_saved` が落ちることがある（上位 5 件は維持）
- DQ / Confidence は Review では省略（巨大化防止）
- 既存 Journal の 1 秒 clock は Task022 由来。Review 専用ではない

---

## Task025候補

- Post-Trade Review（決済後に保存済み snapshot を見返す）。新しい判断は作らない
- Review の warning cap を設定可能にする（まだ blocking しない）
- invalid trigger を snapshot に残すかは Task022 互換を崩さず別タスクで検討
- Journal 詳細と Review のラベル統一（登録予定 vs AI方向）の視覚デザイン整理
- 依然として confirmation modal / 登録禁止 / Entry OK 化は候補にしない

---

## Validation

| コマンド | 結果 |
|---|---|
| `npm run lint` | pass |
| `npm test` | **589** pass（baseline 542 以上） |
| `npm run test:e2e` | **122** pass（baseline 99 以上） |
| `npm run build` | pass |
| `git diff --check` | pass（空白エラーなし） |

commit / push は実施していない。
