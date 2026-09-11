# Task013 Trade JournalへのAI分析・チャート解析スナップショット保存 実装報告

実装日：2026-09-11  
検証完了日：2026-09-11  
ステータス：**検証完了**（実DB E2E / Browser / lint・test・build）  
対象リポジトリ：AI-FX-Analyst  
ブランチ：`feature/task013-trade-analysis-snapshot`  
コミット・push：未実施（禁止どおり）  
main merge：未実施

---

## 実装概要

取引登録時点の AI 分析状態を、Trade Journal に **参照ではなく snapshot** として固定保存するようにした。

- 既存の `trades.analysis_snapshot`（jsonb, nullable）を拡張利用（新 column は追加しない）
- `version: 1` の `TradeAiAnalysisSnapshot` を定義
- ChartImageAnalysis 構造化結果と Chart Evidence 要約を snapshot 内に含める（画像・Base64は保存しない）
- Trade edit / close でも snapshot は不変（DB trigger でも保護）
- alignment（一致 / 逆行 / WAIT override 等）は snapshot + trade side から derived 計算
- OpenAI / Vision の再実行なし（追加コストゼロ）
- Task012 までの UI・分析フローは維持
- 実Supabase migration 適用・実Trade E2E・Browser（390/1280）確認まで完了

---

## 変更ファイル

### 新規

- `lib/trades/snapshot.ts` — capture / sanitize / alignment
- `supabase/migrations/20260911220000_extend_trade_ai_analysis_snapshot.sql`
- `tests/trade-snapshot.test.ts` — 要件 A〜O 相当
- `outputs/Task013-実装報告.md`

### 更新

- `lib/trades/types.ts` — `TradeAiAnalysisSnapshot` / `TradeChartAnalysisSnapshot` / `AiAlignment`
- `lib/trades/service.ts` — create 時のみ snapshot 取得（options 対応）
- `lib/trades/validation.ts` — legacy + version=1 両対応
- `lib/trades/analytics.ts` — alignment / chartEvidence / confidence band 集計
- `lib/supabase/database.types.ts` — snapshot コメント更新
- `components/trades/trade-form.tsx` — 保存トグル / preview / WAIT・逆方向警告
- `components/trades/trade-list.tsx` — エントリー時AI分析詳細 / alignment badge（検証時: nested null の optional chaining）
- `components/trades/performance.tsx` — 一致別・Chart別・確信度帯
- `components/trades/journal.tsx` — chart state 連携・save options
- `components/dashboard/dashboard.tsx` — chart を Journal へ渡し、TASK 013 表示
- `app/globals.css` — snapshot preview / detail スタイル

---

## snapshot schema

### Legacy（Task007/008, version なし）

既存フィールドを維持。読み込み・表示・成績集計で引き続き有効。

### Task013 `TradeAiAnalysisSnapshot`（`version: 1`）

必須（legacy 互換フィールドを含む）:

- `version: 1`
- `pair`, `signal`, `score`, `confidence`, `summary`
- `dataQualityScore`, `analyzedAt`, `capturedAt`, `expiresAt`
- `aiStatus`, `model`, `bullishReasons`, `bearishReasons`
- `directionSignal`, `action`, `isFallback`

拡張:

- `marketPrice` / `analysisPrice`
- `factors` / `scenario`
- `dataQuality`（categories + macro）
- `economicRisk`（要約）
- `chartEvidence`（`used` 含む）
- `chartAnalysis`（構造化チャート結果）
- `aiCode`

`capturedAt` = Trade登録時刻、`analyzedAt` = AI分析生成時刻。Entry価格とは別。

---

## snapshot version

- 新 snapshot: **`version: 1`**
- 旧 snapshot: version フィールドなし（legacy）
- DB / アプリ双方で両形式を受理

---

## Supabase migration

ファイル: `supabase/migrations/20260911220000_extend_trade_ai_analysis_snapshot.sql`

内容:

- `check_trade()` を `CREATE OR REPLACE` で拡張
- 既存 required keys は維持（legacy 互換）
- `version = 1` のとき `directionSignal` / `action` / `isFallback` を検証
- UPDATE 時の `analysis_snapshot` 不変制約は維持
- **DROP TABLE / データ変換なし**（nullable jsonb 拡張のみ）
- RLS / 新 table なし

---

## sanitizer

`captureTradeAiSnapshot` / `sanitizeTradeAiSnapshot` / `sanitizePersistedSnapshot`:

- pair mismatch → snapshot null（trade 自体は成功可）
- unknown / malformed → null（trade は失わない、silent にはしない）
- string 長・配列数を制限
- secret っぽい文字列（`sk-...`, `data:image/...`, prompt 系）を scrub / reject
- raw OHLC / 画像 / prompt / OpenAI raw response は保存しない

---

## Trade登録

- デフォルト: 「現在のAI分析をこの取引に保存」ON
- OFF 可能
- AI なしでも通常登録可（snapshot null）
- 画面上の AI state +（あれば）chart state をコピー
- OpenAI / Vision 再実行なし

Preview 例:

- 判断 / 方向 / Action / 確信度 / 分析時刻 / Chart 要約

---

## WAIT / direction conflict

- `action=WAIT` でも登録可能  
  → 「AI分析では現在WAITです」警告
- Trade BUY と AI SELL（または逆）  
  → 「現在のAI方向と逆方向の取引です」警告
- いずれも禁止しない

---

## alignment

`computeAiAlignment(side, snapshot, tradePair)`（derived、DB非保存）:

| 結果 | 条件 |
|------|------|
| `wait_override` | action/signal が WAIT |
| `aligned` | BUY↔buy系 / SELL↔sell系 |
| `contrary` | 方向が逆 |
| `neutral` | 方向感なし |
| `unavailable` | snapshot なし / pair 不一致 |

優先: WAIT override → direction 一致/逆 → neutral/unavailable

表示ラベル: AI一致 / AI逆行 / WAIT中エントリー / AI中立 / AI分析なし

---

## Journal表示

詳細（折りたたみ）:

- エントリー時AI分析（判断・方向・Action・確信度・要約・時刻）
- Data Quality / fallback 表示
- Chart Evidence / Chart 解析（画像なしである旨を明示）
- snapshot なし旧Trade: 「エントリー時AI分析：保存なし」

一覧: alignment badge（重くしすぎない）

---

## Performance

追加セクション:

1. **AI判断との一致別** — aligned / contrary / wait_override / neutral / unavailable  
   （件数・勝率・実現P/L）
2. **AI判断別成績** — 登録時 snapshot の signal（現行AIではない）
3. **Chart Evidence別** — 使用 / 未使用
4. **確信度帯別（参考）** — 0-49 / 50-69 / 70-84 / 85-100（少サンプルは参考値）

WAIT中エントリー成績を明示して、判断改善に使えるようにした。

---

## Chart snapshot

保存条件:

- AI に attach 済み (`chartEvidence.used=true`) または UI の chart state がある場合
- attach されていない chart のみの場合: `chartEvidence.used=false` で区別

保存内容: source / pair / timeframe / trend / structure / levels / patterns / indicators / quality / warnings / analyzedAt  
**画像ファイル・Base64は保存しない**

---

## fallback

- `ai.status !== "available"` → `isFallback: true`
- Journal で「AI一部利用不可時の暫定分析」と表示

---

## Security / Privacy

保存しない:

- API keys / headers
- system / developer prompt
- OpenAI raw response 全文
- chart 画像 / Base64

保存するのは validation 済み構造化結果のみ。  
UI に「チャート画像そのものは保存していません」を表示。

---

## Tests

`tests/trade-snapshot.test.ts` ほか既存 suite:

| ID | 内容 |
|----|------|
| A | AIあり → versioned snapshot |
| B | AIなし → null / trade成功 |
| C | chartEvidenceあり → chart保存 |
| D | chartなし → chart null |
| E | pair mismatch → attach拒否 |
| F | WAIT → wait_override |
| G | BUY+AI BUY → aligned |
| H | BUY+AI SELL → contrary |
| I | edit → snapshot不変 |
| J | close → snapshot不変 |
| K | legacy undefined/versionなし → 正常 |
| L | malformed → sanitize拒否 |
| M | secret系 → scrub/拒否 |
| N | fallback → isFallback |
| O | alignment集計 |

**test件数: 243 pass**（Task012時点 226 から拡張、既存破壊なし）

---

## Supabase実DB確認（検証完了）

対象プロジェクト: **AI-FX-Analyst**（ref `qjkpuleifyurrqkzklmy`、linked）  
適用 migration: `20260911220000_extend_trade_ai_analysis_snapshot.sql`  
方法: 通常の remote migration apply（**`db reset` なし**）。`migration list` で local=remote を確認。

### Migration安全性（再確認）

- DROP TABLE なし
- 既存 trade / snapshot データの削除・変換なし
- legacy snapshot（version なし）互換を維持
- RLS 変更なし（既存ポリシー維持）
- `check_trade()` は CREATE OR REPLACE のみ。既存 required keys + v1 追加検証
- UPDATE 時 `analysis_snapshot` 不変制約を維持

### 実Trade E2E（一時ユーザー、終了後削除）

手順: 実AI分析（USD/JPY）→ Trade登録（snapshot ON）→ DB確認 → reload相当の再取得 → edit → close → Chart Evidence付き登録 → AIなし登録 → AI再分析後の不変確認 → テストデータ削除。

実測結果:

| 項目 | 結果 |
|------|------|
| version=1 snapshot 保存 | 成功（例: pair USD/JPY, signal wait, directionSignal sell, action WAIT, confidence 55, capturedAt/analyzedAt あり, isFallback false） |
| reload 後同一 snapshot | 成功（構造比較） |
| edit 後不変 | 成功（notes のみ変更、snapshot 同一） |
| 不正な snapshot UPDATE | DB が拒否（immutable メッセージ） |
| close 後不変 | 成功（status closed、snapshot 同一） |
| Chart Evidence | `chartEvidence.used=true` + `chartAnalysis` あり |
| 画像 / Base64 非保存 | 成功（snapshot JSON に image/base64 なし） |
| Trade登録時の Vision/OpenAI 再実行 | なし（画面上の分析コピーのみ） |
| AI再分析後の過去Trade不変 | 成功 |
| AIなし Trade（analysis_snapshot=null） | 登録成功 |
| テストデータ cleanup | E2E用 3件 + Browser用 5件と一時ユーザー削除。既存ユーザーTradeは未削除 |
| secret leak | 報告書・ログへ API key / service_role を出力していない |

---

## Browser確認（検証完了）

環境: `http://127.0.0.1:3013`、一時ログインユーザー（検証後削除）  
スクリーンショットツールは使わず、**DOM / scrollWidth・clientWidth / ボタン bounding box** で確認。

### Viewport

| Viewport | 横スクロール | 備考 |
|----------|--------------|------|
| 390×844 | なし（scrollWidth=clientWidth=390） | Emulation + DOM |
| 1280×900 | なし | Emulation 時 clientWidth≈1265（枠差分）。overflowX なし |

### 確認ケース

| ケース | 結果 |
|--------|------|
| AI分析あり Trade 登録 UI（preview） | 判断・方向・Action・確信度・分析時刻・Chart要約を表示 |
| AI分析なし（トグル OFF） | 「現在のAI分析をこの取引に保存」OFF で preview 非表示。登録禁止なし |
| WAIT警告 | 「AI分析では現在WAITです。登録は禁止しません。」表示 |
| direction conflict | 「現在のAI方向と逆方向の取引です。登録は禁止しません。」表示（実AIがWAITのときは fetch モックで action=SELL にしたうえで BUY を選択して確認） |
| Chart Evidenceあり | Journal詳細に Chart Evidence / チャート解析スナップショット表示 |
| snapshotなし旧Trade | 「エントリー時AI分析：保存なし」 |
| Trade詳細 snapshot | AI判断・direction・action・confidence・summary・分析時刻・alignment |
| Performance | AI一致 / AI逆行 / WAIT中エントリー / AI分析なし、Chart Evidence別、確信度帯別が実Tradeで表示 |
| 操作性 | 主要ボタン操作可能、文字切れ・横スクロールなしを確認 |

### 検証中の最小修正

`components/trades/trade-list.tsx`: rich snapshot の `dataQuality` / `chartAnalysis` 入れ子が欠ける場合に落ちないよう optional chaining（新機能追加なし）。

---

## lint / build（検証後再実行）

- `npm run lint` — pass
- `npm test` — **243 pass**（fail 0）
- `npm run build` — pass
- `git diff --check` — pass
- secret leak なし（報告書に key を記載していない）

---

## 既知の制限

- 過去 trade への snapshot 自動補完は非対象（仕様どおり）
- snapshot 差し替え UI は非対象
- confidence / chart 集計はサンプル少で参考値表示
- alignment は DB 非永続（derived）。将来 materialize する場合も source of truth は side + snapshot
- direction conflict の Browser 確認は、実相場が WAIT だったため一時的な fetch モックで SELL action を再現（製品コード変更なし）

---

## Task014への引継ぎ

Task013 の実DB/E2E/Browser 完了条件は満たした。以降の候補:

- 分析時点価格 → Entry までの値動き差分集計
- Data Quality 帯別成績 UI の本格化
- snapshot 差し替え（明示操作のみ）の要否検討
- WAIT override / contrary の学習フィードバック UX
- 必要なら Playwright 固定化

---

## 完了条件との対応

| 条件 | 状態 |
|------|------|
| 実AI分析 → Trade登録 → 実Supabaseへ snapshot 保存 | **実測成功**（version=1） |
| reload 後 Journal に同一 snapshot | **実測成功** |
| edit 後 snapshot 不変 | **実測成功** |
| close 後 snapshot 不変 | **実測成功** |
| Chart Evidence / 画像非保存 / AIなし / WAIT・conflict UI | **実測成功** |
| Browser 390 / 1280 | **実測成功**（DOM確認） |
| lint / test(≥243) / build / diff --check | **pass** |
| 後方互換（旧Trade null/legacy） | 実装・テスト・Browser確認済み |
| commit / push | 未実施（禁止どおり） |
