# AI-FX-Analyst — 別PC / Cursor 作業引き継ぎ

最終更新：2026-09-15  
対象リポジトリ：`KenjiTadano/AI-FX-Analyst`（ローカル名 `ai-fx-analyst`）  
この文書の目的：別PCの Cursor が、現状・制約・次作業を誤解なく再開できるようにする。

---

## 0. いますぐ読むこと（必須）

1. **現在の作業ブランチは `main` ではない。**
   - 作業先端：`feature/task016-ai-entry-context-analysis`
   - tip commit：`de8074f` — `feat: add AI direction × entry move context analysis`
   - `origin/main` tip：`9e1ccc0`（Task015 まで。Task016 **未マージ**）
2. `.env.local` は Git に含まれない。別PCでは手動配置が必須。
3. ヘッダー／フッターが **MVP / TASK 016** / **PROTOTYPE / TASK 016** なら正しいブランチ。
   - **TASK 015** のままなら `main` か古い tip を見ている。
4. 詳細は各 `outputs/Task0XX-実装報告.md`。本ファイルは要約と再開手順。
5. Next.js はこのリポ固有の版あり。`AGENTS.md` / `CLAUDE.md` と `node_modules/next/dist/docs/` を尊重。

---

## 1. 別PCセットアップ手順

```bash
git clone git@github.com:KenjiTadano/AI-FX-Analyst.git
cd AI-FX-Analyst   # またはローカルのクローン先
git fetch origin
git checkout feature/task016-ai-entry-context-analysis
git pull
git log -1 --oneline
# 期待: de8074f feat: add AI direction × entry move context analysis

cp /path/to/.env.local .env.local   # 元PCから安全にコピー
npm install
npm run lint
npm test          # 期待: 309 pass 前後
npm run build
npm run dev
```

確認 UI：

- ログインできる
- **成績**タブを開く
- 「表示期間」「トレード振り返り」「分析時点からEntryまで（Entry Timing）」「**AI方向とEntry位置**」が見える

---

## 2. プロジェクト概要

個人向け FX 分析ダッシュボード（Next.js + Supabase）。

主な機能レイヤ：

| 領域 | 内容 |
|------|------|
| Market | Twelve Data 等の価格・指標 |
| Fundamental | Finnhub / FRED / 経済カレンダー |
| AI 分析 | OpenAI Responses（サーバ側）。WAIT も正常判断 |
| Chart Vision | チャート画像解析 → AI 統合 |
| Risk | リスク表示・計算 |
| Trade Journal | 取引登録・編集・決済・一覧 |
| Performance | 成績・カレンダー・AI alignment 集計 |
| Insights | 過去トレードの決定論的振り返り（追加 API call なし） |

思想：

- **未来予測ではなく過去の振り返り**
- Insights / Entry Timing / AI Entry Context 表示で **OpenAI / Vision / 外部API を追加呼び出ししない**
- 大規模 refactor 禁止、DB migration は原則不要（必要な Task のみ明示）
- ユーザーが明示しない限り **commit / push 禁止**（ただし「別PC用に保存」依頼時は push 可）

---

## 3. Task 進捗マップ

| Task | 内容 | 状態 | 主な成果物 |
|------|------|------|------------|
| 001 | プロジェクト初期化 | 完了・リモートあり | 基盤 |
| 002 | UI プロトタイプ | 完了 | ダッシュボード骨格 |
| 003 | Market data | 完了 | Twelve Data 系 |
| 004 | Fundamental / News | 完了 | Finnhub 等 |
| 005 | AI 分析 | 完了 | OpenAI 分析 |
| 006 | Risk Management | 完了 | リスク UI/計算 |
| 007 | Trade Journal | 完了 | 取引 CRUD |
| 008 | Supabase Auth + 永続化 | 完了 | Auth / trades 保存 |
| 009 | Economic Calendar + FRED | 完了 | カレンダー / マクロ |
| 010 | Chart Image Analysis | 完了 | Vision |
| 011 | Chart → AI 統合 | 完了 | チャート証拠の統合 |
| 012 | AI Decision Explanation UI | 完了 | 判断説明 UI |
| 013 | Trade AI Analysis Snapshot | **完了・検証済** | `analysis_snapshot` 保存 |
| 014 | Trading Review Insights | **完了** | `lib/trades/insights.ts` |
| 015 | Period + Entry Timing | **完了** | period filter / Trade side 値動き |
| 016 | AI direction × Entry move | **完了・push 済** | AI direction 基準の複合分析 |
| 017 | （未確定） | **未着手** | 下記「次の作業」 |

ブランチ運用メモ：

- 各 Task は `feature/task0XX-...` で実装されることが多い
- **`main` は Task015 まで**（2026-09-15 時点）
- Task016 は feature ブランチに **push 済み**、**main 未マージ**、PR 未作成の可能性あり

---

## 4. 直近（Task013〜016）で重要な区別

### Task013 — Snapshot

- Trade 登録時に AI 分析状態を `analysisSnapshot` として固定
- 後から AI が変わっても過去 Trade の判断は変わらない
- 核心フィールド例：`directionSignal`, `action`, `confidence`, chart evidence, data quality
- alignment：`aligned` / `contrary` / `wait_override` / `neutral` / `unavailable`

### Task014 — Insights

- `generateTradingInsights(trades)` — 決定論的、最大 **7件**
- `MIN_INSIGHT_SAMPLE_SIZE = 5`
- 強い傾向結論は sample 不足時に出さない
- 因果・「こうすれば勝てる」断定禁止

### Task015 — Period + Entry Timing

- 期間：`all` / `30d` / `90d`（`openedAt` 基準、rolling inclusive）
- **同じ `filteredTrades`** を Performance / Insights / Entry Timing で共有
- `directionalEntryMovePips` は **Trade side（BUY/SELL）基準**
- 独自 period filter を Insights 側に作らない

### Task016 — AI Entry Context（最新完了）

- `aiDirectionalMovePips` は **AI `directionSignal` 基準**（Task015 と混同禁止）
- 優先源：`snapshot.directionSignal`（signal から推測しない）
- `AI_ENTRY_NEUTRAL_PIPS = 2`
  - `> +2` → `with_ai_direction`
  - `< -2` → `against_ai_direction`
  - それ以外 → `near_analysis_price`
- WAIT でも direction が BUY/SELL なら分類可。Action と方向は UI で分離
- 分析価格：`analysisPrice` → `marketPrice`（`lib/trades/analysis-price.ts`）
- UI：成績タブ「AI方向とEntry位置」
- テスト：**309 pass**（Task015 の 284 + 約25）

禁止表現例：

- AI方向へ進んだら Entry すべき
- 逆へ動いたら待つべき
- この形なら勝てる / AI direction が正しい

---

## 5. 主要ファイル地図（再開時の入口）

### Trade / Performance コア

| パス | 役割 |
|------|------|
| `lib/trades/types.ts` | Trade 型 |
| `lib/trades/snapshot.ts` | Snapshot / alignment / rich snapshot |
| `lib/trades/analytics.ts` | `summarize` 等の集計 |
| `lib/trades/insights.ts` | Trading Review Insights |
| `lib/trades/performance-period.ts` | 期間フィルタ |
| `lib/trades/analysis-price.ts` | 分析参照価格・pip ヘルパー共有 |
| `lib/trades/entry-timing.ts` | Task015 Trade side 値動き |
| `lib/trades/ai-entry-context.ts` | Task016 AI direction × Entry |
| `lib/trades/service.ts` / `repository.ts` / `validation.ts` | CRUD・永続化 |

### UI

| パス | 役割 |
|------|------|
| `components/trades/performance.tsx` | 成績本体・period・子パネル配線 |
| `components/trades/insights.tsx` | Insights UI |
| `components/trades/entry-timing.tsx` | Entry Timing UI |
| `components/trades/ai-entry-context.tsx` | AI Entry Context UI |
| `components/trades/journal.tsx` / `trade-form.tsx` / `trade-list.tsx` | Journal |
| `components/dashboard/dashboard.tsx` | タブ・TASK バッジ |
| `app/globals.css` | レイアウト／カード |

### テスト

| パス | 内容 |
|------|------|
| `tests/trade-insights.test.ts` | Task014 |
| `tests/trade-period-timing.test.ts` | Task015 |
| `tests/trade-ai-entry-context.test.ts` | Task016 A〜X |

### 報告

- `outputs/Task005`〜`Task016-実装報告.md`
- 特に再開前は **Task013〜016** を読む

---

## 6. 成績タブの表示順（Task016 時点）

1. 表示期間（全期間 / 30日 / 90日）
2. Trading Review Insights
3. Entry Timing（Trade 方向基準）
4. **AI方向とEntry位置（AI direction 基準）** ← Task016
5. 既存 Performance（損益・equity・カレンダー・alignment 等）

期間変更時は上記すべてが同一 `filteredTrades` に追従すること。

---

## 7. 共通制約（Task014〜016 系で特に守る）

- 大規模 refactor 禁止
- DB migration 原則不要（必要ならユーザー指示で明示）
- Insights / Timing / AI Entry Context のための追加：
  - OpenAI / Vision / FRED / Finnhub / Twelve Data call = **0**
- Trade history を新しい外部サービスへ送らない
- 既存 Performance / Journal / Snapshot 挙動を壊さない
- Mobile 390×844 / Desktop 1280×900、横スクロール禁止
- 色だけで「良い／悪い」を区別しない
- commit / push はユーザー明示時のみ
- 実ユーザー Trade を汚染しない（Browser fixture は一時ユーザー → cleanup）

検証コマンド（完了時ほぼ必須）：

```bash
npm run lint
npm test
npm run build
git diff --check
```

---

## 8. 環境変数（概要）

`.env.example` を参照。実値は `.env.local` のみ。

最低限アプリ起動・ログインに必要なもの：

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`

分析・市場・カレンダー用（機能ごとに）：

- `OPENAI_API_KEY` / `OPENAI_ANALYSIS_MODEL` / `OPENAI_CHART_MODEL`
- `TWELVE_DATA_API_KEY`
- `FINNHUB_API_KEY` 等
- `FRED_API_KEY` 等

注意：

- **service_role / secret を `NEXT_PUBLIC_*` に入れない**
- `.env.local` を commit しない

---

## 9. 既知の制限・未マージ状況

- Task016 は feature に push 済みだが **`main` 未マージ**
- 期間タブは session state（reload で全期間に戻る）
- AI Entry Context × confidence のクロス UI は未実装（必須外だった）
- Task016 の pip magnitude bands UI は Entry Timing との重複回避で未追加
- 一部実装報告の「commit / push 未実施」記述は **作成当時の文言**。Task016 本体は後から **push 済み**（`de8074f`）

---

## 10. 次の作業内容（Task017 候補）

**正式な Task017 仕様書はまだユーザーから未提示。**  
着手前にユーザーへ「Task017 の正式ブリーフがあるか／候補から選ぶか」を確認すること。

### A. 有力候補（Task016 報告より）

1. **期間選択の localStorage 永続化**  
   reload しても 30D/90D を維持。`performance-period` / Performance UI の小変更向き。
2. **Playwright で成績タブ回帰固定化**  
   period / Insights / Entry Timing / AI Entry Context の表示回帰。
3. **30D vs 全期間の差分ハイライト**  
   既存 period 比較文の UI 強化。
4. **AI Entry Context × confidence / alignment の詳細クロス UI**  
   任意。UI 複雑化に注意。必須ではなかった。

### B. 過去から持ち越し候補

- Data Quality 帯の専用カード UI（Task014 時点）
- note / 手動振り返りタグ分析
- Task013〜016 の `main` への段階 merge / PR 整備

### C. やってはいけない次作業（明示指示なしでは）

- Task016 の指標を「勝ちパターン診断」に変えること
- Insights のために OpenAI を呼び出すこと
- Trade side と AI direction の値動きを同じラベルで統合すること
- 実ユーザーデータの破壊的 migration / hard reset

### D. Task017 を始めるときの推奨手順

1. 本ファイル + `outputs/Task016-実装報告.md` を読む
2. `feature/task016-ai-entry-context-analysis` から新規ブランチを切る（例：`feature/task017-...`）
3. ユーザーの Task017 仕様を優先。無ければ候補を提示して選択を待つ
4. 既存 309 tests を壊さない
5. 完了時は `outputs/Task017-実装報告.md` を作成
6. commit / push はユーザー指示時のみ

---

## 11. Cursor への指示テンプレ（別PCで貼る用）

```text
リポジトリ AI-FX-Analyst で作業する。
まず outputs/CURSOR-別PC作業引き継ぎ.md と outputs/Task016-実装報告.md を読め。
ブランチは feature/task016-ai-entry-context-analysis（またはそこから切った task017 ブランチ）。
main には Task016 が入っていない点に注意。
大規模 refactor 禁止。Insights 系の追加 API call 禁止。
commit / push は指示するまで禁止。
日本語で簡潔に報告すること。
```

---

## 12. クイック健全性チェックリスト

- [ ] `git branch` が Task016（または Task017）feature
- [ ] `git log -1` が期待 commit
- [ ] `.env.local` あり、ログイン可
- [ ] `npm test` green（約 309）
- [ ] 成績タブに「AI方向とEntry位置」
- [ ] 期間切替で Insights / Timing / AI Context が同時に変わる
- [ ] ヘッダーが TASK 016（Task017 着手後はバッジ更新するなら仕様に従う）

---

## 13. 関連ドキュメント索引

| ファイル | 用途 |
|----------|------|
| `AGENTS.md` / `CLAUDE.md` | Next.js agent 規則 |
| `outputs/Task013-実装報告.md` | Snapshot |
| `outputs/Task014-実装報告.md` | Insights |
| `outputs/Task015-実装報告.md` | Period / Entry Timing |
| `outputs/Task016-実装報告.md` | AI Entry Context（最新完了） |
| `supabase/README.md` | DB / migration 周辺 |
| `.env.example` | 環境変数キー一覧 |

---

以上。不明点はユーザーに確認し、推測で仕様を広げないこと。
