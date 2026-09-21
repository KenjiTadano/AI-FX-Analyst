# Task033 Dashboard Final Integration 実装報告

実装日：2026-09-21  
ステータス：**実装・検証完了**  
ブランチ：`feature/task033-dashboard-final-integration`  
コミット・push：未実施

新しい分析ロジックは追加していない。既存コンポーネントの配置と見出しだけを整理した。

---

## 現状Dashboard監査結果

分析タブは Daily Plan / AI / 設定 / テクニカル / MTF / Regime / 材料 / 説明が1グリッドに並んでいた。成績タブは Task032 のあとにも Insights・PreTrade・MTF・Entry Timing・AI Entry Context・損益・カレンダーが同列だった。

ナビゲーションは「分析 / チャート読取 / トレード / 成績」のまま。route 追加なし。

---

## 解決したUX問題

- 分析画面を Analysis → Trade Setup → Market の順にし、通貨ペアを各見出しに出した
- Direction と Action が別である旨を Analysis 見出し下に明示
- Trigger 条件成立はエントリー推奨ではない旨を Trade Setup に明示
- 根拠・資金設定、および Task032 に含まれない成績詳細を `<details open>` にまとめ、初期表示は維持したまま折りたたみ可能にした

---

## 変更ファイル

- `components/dashboard/dashboard.tsx`
- `components/trades/performance.tsx`
- `app/globals.css`
- `e2e/dashboard-integration.spec.ts`（新規）
- `outputs/Task033-実装報告.md`

---

## Dashboard IA

1. MARKET（既存レートパネル。状態ラベル LOADING / FRESH / STALE / ERROR）
2. Analysis（AI総合判定）
3. Trade Setup（今日の計画・準備度・Trigger Watch は既存 Daily Plan 内）
4. Market detail（テクニカル / MTF / Regime / 材料）
5. 詳細 disclosure（なぜ？ / 資金設定）
6. チャート読取・トレード・成績は既存タブ

Journal / Post-Trade / snapshot の計算は未変更。

---

## Task032重複整理

中心は Trading Performance Intelligence のまま。

`<details open>` に残したもの（Task032が完全には含まない）：

- Trading Review Insights
- Pre-Trade Context Performance
- MTF Performance（既存パネル）
- Entry Timing
- AI方向とEntry位置
- 損益サマリー / 資産推移 / カレンダー / alignment / signal / chart / confidence / pair

削除したパネルはない。

---

## 副作用

外部API 0 / Supabase query 0 / polling 0 / migration 0

---

## 実測

| 項目 | 結果 |
|------|------|
| Unit 追加 | 0（pure helper なし） |
| Unit | **1010 passed / 0 failed** |
| E2E 追加 | **8**（`e2e/dashboard-integration.spec.ts`） |
| E2E | **329 passed / 0 failed**（321+8） |
| lint | PASS |
| build | PASS |
| git diff --check | PASS |
| TODO/FIXME | 追加なし |

---

## known limitations

- 詳細 disclosure は初期 open。閉じた状態を既定にすると既存 E2E が見出しを見失うため
- Pre-Trade 登録UIはトレードタブの既存フォームのまま（分析タブへ複製していない）
- チャートは独立タブのまま
