# Task029 Market Regime Analysis / 相場環境分析 実装報告

実装日：2026-09-16  
検証完了日：2026-09-16  
ステータス：**実装・検証完了**  
対象リポジトリ：AI-FX-Analyst  
ブランチ：`feature/task029-market-regime`  
コミット・push：未実施（禁止どおり）

---

## 実装概要

Task029 は新しい Trading Decision ではない。既存 Task003 / Task026 の **1時間足確定足** から、今の相場が trending / range / transition / unavailable のどれにあるかを deterministic に整理する。

- Market Regime は市場コンテキストであり、BUY / SELL / WAIT ではない
- Trend Direction と Volatility は別軸
- 追加 Twelve Data / OpenAI / Supabase / polling / DB なし
- Action / Readiness / Trigger / Daily Plan / economic WAIT を変更しない
- Trade snapshot（Task027）と MTF Performance（Task028）には保存・集計しない

---

## 変更ファイル

### 新規

- `lib/market/market-regime.ts` — `analyzeMarketRegime` / `marketRegimeForPair` / ATR% / SMA spread / range position / sanitizer / AI payload
- `components/dashboard/market-regime.tsx` — MARKET REGIME カード
- `tests/market-regime.test.ts` — A–AZ + critical 1–5
- `e2e/market-regime.spec.ts` — Playwright 28 本
- `outputs/Task029-実装報告.md`（本報告）

### 更新

- `lib/market/indicators.ts` — 既存 Wilder ATR14 を `atr14Series` として抽出（計算式は同一）
- `lib/market/types.ts` — `MarketData.marketRegimeAnalysis?` を optional 追加
- `lib/ai/types.ts` — `AnalysisInput.marketRegimeAnalysis?`
- `lib/ai/input.ts` — optional evidence `technical:regime`
- `lib/ai/openai.ts` — Regime は signal ではない旨を system prompt に追加
- `components/dashboard/dashboard.tsx` — Multi-Timeframe の直後、Fundamental の前
- `app/globals.css` — `.regime-panel` / `.regime-reasons`（min-width 0, overflow-wrap）
- `e2e/fixtures/market.ts` — 必要なときだけ 1H 200本超 fixture
- `e2e/helpers/mock.ts` — `regime` / `regimeByPair`

大規模 refactor なし。既存 SMA20/75/200・RSI14・ATR14・recentHigh/Low・trend・`canonicalCandles` を再利用。

---

## Task003/026 audit

- Task003: `calculateIndicators` が SMA20/75/200・RSI14・ATR14・recentHigh/Low・trend を算出。`lib/market/client.ts` が 15m/1h/4h/1day を `outputsize: 300` で取得し、確定足のみ残す。
- Task003 trend: `close > SMA20 > SMA75 > SMA200` → bullish、逆順 → bearish、それ以外 → neutral。不足時に Task003 は trend=neutral にするが、Task029 は 200本未満を **unavailable** に固定し、不足を neutral/range へ変換しない。
- Task026: `canonicalCandles` / `MTF_MIN_CANDLES=200` / 確定足。MTF は 1D/4H/1H/15m の整合。Regime は 1H のみ。
- 既存 E2E market fixture は 1本足 + stored indicators。Regime 用の 200本超は `regime` option があるときだけ 1H を置換し、既存 MTF fixture を壊さない。

---

## source of truth

既存 Market Data の `timeframes["1h"].data.candles` のみ。新しい provider / fetch なし。Twelve Data の既存 OHLC を再利用。

---

## primary timeframe

**1H**。Task003 の `timeframes` と client `intervals["1h"]` が既に存在するため、新 series は作らない。4H / 1D / 15m は Regime 分類に混ぜない。

---

## confirmed candle semantics

Task003 `technical.ts` / client と同じ。

`Date.parse(time) + 3_600_000 <= analyzedAt`

forming candle は除外。`Date.now()` は helper 内部で使わない。`analyzedAt` は呼び出し側（Dashboard は 1H `fetchedAt`、AI は `buildInput` の now）から渡す。OHLC 正規化は Task026 `canonicalCandles`。

---

## minimum data

`REGIME_MIN_CANDLES = MTF_MIN_CANDLES = 200` 確定足。SMA200 のため。不足は regime / trendDirection / volatility すべて unavailable。neutral/range へ fallback しない。

---

## trend rule

Task003/026 と同じ SMA 並び。十分なデータがありどちらでもない場合のみ neutral。不足は unavailable。

---

## ATR percent

`atrPercent = ATR14 / close * 100`。close <= 0 または ATR invalid → null。

---

## volatility baseline

直近 100 本分の ATR14 series（Wilder、`atr14Series`）から **正の finite 値のみ** の median。sample が 100 未満、または baseline が finite かつ > 0 でない場合は volatility unavailable。Trend 判定が可能なら Trend / Regime は維持（別軸）。

---

## volatility thresholds

定数：

- high: `currentATR / medianATR >= 1.30`
- low: `<= 0.75`
- その間: normal

固定 pips 閾値は使わない。High だから Transition へ強制変更しない。

---

## SMA spread

`smaSpreadPercent = (max(SMA20,SMA75,SMA200) - min(...)) / close * 100`

JPY FX で 0.10% は 150 円付近で約 0.15 円。過剰最適化せず constant として明示。

- trending: bullish/bearish かつ `>= 0.10%`
- range: neutral かつ `<= 0.10%` かつ range position 条件

---

## range position

`rangeWidth = recentHigh - recentLow`  
`position = (close - recentLow) / rangeWidth`  
width <= 0 → null。

range candidate: `0.15 <= position <= 0.85`。高値/安値直近だけを即 breakout としない。

---

## regime rules

1. データ不足 → unavailable
2. bullish/bearish かつ SMA spread >= 0.10% → trending
3. neutral かつ SMA spread <= 0.10% かつ position が [0.15, 0.85] → range
4. それ以外（十分なデータ）→ transition

Volatility は分類に使わない。

---

## transition semantics

明確な trend 条件でも range 条件でもない。転換確定ではない。UI 表示は「移行・不明瞭」。

---

## unavailable semantics

200 確定足未満、invalid OHLC、pair mismatch（表示しない / カードは未取得メッセージ）。Neutral や Range へ fallback しない。メッセージ：

「相場環境を判定するための確定足データが不足しています」

---

## reasons

最大 4。factual のみ（並び・スプレッド・ATR 比・レンジ位置）。禁止語：チャンス / 買い優勢 / エントリー好機 / おすすめ / Entry OK。

---

## pure/deterministic

`analyzeMarketRegime({ pair, candles, analyzedAt })` は network なし。同じ candles + analyzedAt → deepEqual。入力配列を mutate しない（`canonicalCandles` が copy）。

---

## pair safety

`market.symbol !== selectedPair` なら `marketRegimeForPair` は null。sanitizer も expectedPair 不一致を拒否。foreign pair evidence は出さない。

---

## MarketData integration

`MarketData.marketRegimeAnalysis?` を optional 追加。既存 fixture への必須追加なし。Live 計算は MTF と同様に helper で 1H candles から行う。client.ts は regime を fetch しない。

---

## AI integration

既存 `buildInput` に optional `marketRegimeAnalysis` と evidence id `technical:regime` を追加。追加 OpenAI call 0。`createAnalysisService` の interpret は従来どおり 1 回。

---

## AI payload

許可: pair / timeframe / regime / trendDirection / volatility / atrPercent / atrRatio / smaSpreadPercent / reasons。

禁止: raw candles / full ATR series / provider raw / API metadata / secret。`regimeEvidencePayload` と sanitizer が `"candles"` / `atr14Series` / apikey を落とす。

Prompt 明記: Regime は deterministic evidence。BUY/SELL/WAIT を独立決定しない。High vol ≠ SELL。Trending ≠ BUY。Range ≠ 自動 WAIT。

---

## Action separation

`finalizeAnalysis` / engine は regime を読まない。trending + bullish + high vol でも既存 WAIT は WAIT。

---

## Readiness

`READINESS_FIXED_TOTAL = 5` のまま。6 個目の check は追加しない。entry-readiness は regime を import しない。

---

## Trigger

`lib/ai/entry-trigger.ts` と Watch は未変更。MET / NOT_MET に影響しない。

---

## Daily Plan

`STATUS_PRIORITY` 未変更。daily-plan は regime を import しない。

---

## economic WAIT

`eventRisk.imminent` による WAIT override を regime で解除しない。

---

## UI

Dashboard 配置：

Market Data / Technical → Multi-Timeframe → **Market Regime** → Fundamental / AI

表示：

- 相場状態: トレンド / レンジ / 移行・不明瞭 / 未取得
- 方向: 上向き / 下向き / 中立 / 未取得
- ボラティリティ: 高い / 通常 / 低い / 未取得
- 1H / ATR% / 基準比 / SMA spread / factual reasons

禁止: 買い相場 / 売り相場 / チャンス / 危険 / Entry OK / おすすめ / 強い買い。高ボラは market fact。

---

## responsive

390x844: 1 column、`min-width: 0` / `overflow-wrap: anywhere`。1280x900: compact card。E2E で横 overflow なしを確認。

---

## snapshot scope

Task029 では Trade snapshot に Regime を保存しない。Task027 schema 変更なし。

---

## Performance scope

Task028 MTF Performance に Regime 軸を追加しない。

---

## API counts

| API | 追加 |
| --- | --- |
| Twelve Data | 0 |
| OpenAI calls | 0（既存 analysis request の payload に summary を足すのみ） |
| Vision | 0 |
| Finnhub | 0 |
| FRED | 0 |
| EODHD | 0 |
| Supabase query | 0 |

---

## polling

新 timer 0。既存 `useMarket` 60s refresh のみ。Regime コンポーネントに setInterval / setTimeout なし。

---

## DB

migration 0 / new table 0 / new column 0 / RLS 0。

---

## complexity

1H candles は既存 max 300。ATR series は O(n)、median は 100 要素 sort。network なし。

---

## unit tests

Task028 baseline 785 → **850 pass**（65 本追加）。A–AZ および critical 1–5 を含む。既存 fixture 必須破壊なし。

---

## E2E

Task028 baseline 212 → **240 passed**（28 本追加）。カード表示、4 状態、3 vol、1H、reasons、WAIT 維持、Readiness 5、Trigger/Daily Plan/MTF 非破壊、pair switch、不足/forming、AI request に candles なし、外部ネットワーク 0、390/1280 overflow なし。

---

## regression

Task001〜028 を維持。特に Task003 Market、Task005 AI、Task012 Direction/Action、Task017 Daily Plan、Task019 Readiness（5 固定）、Task020 Trigger、Task026 MTF、Task027 Snapshot、Task028 Performance。

検証：

- `npm run lint` 成功
- `npm test` 850 pass
- `npm run test:e2e` 240 passed
- `npm run build` 成功
- `git diff --check` 問題なし

---

## known limitations

- Live 1H のみ。Historical Regime snapshot は未保存（Task030 候補）。
- 4H/1D/15m は Regime に混ぜない（MTF 側の役割）。
- Volatility baseline は直近 100 ATR の median ratio。絶対 pips や percentile の高度化はしていない。
- SMA spread / range position 閾値は MVP constant。通貨ペア別最適化はしない。
- クライアントの `/api/analysis` GET は pair のみ。Regime summary はサーバー側 `buildInput` に載る。E2E はモック経路のため payload 有無は unit で担保。

---

## Task030候補

- Entry Context へ Regime を任意添付するか
- Trade snapshot へ Live Regime を保存するか（Task027 拡張）
- Regime Performance（Task028 拡張）をやるか
- 4H を context として併記するか（分類自体は 1H 維持）
- 閾値の後追い調整はデータ観測後に constant を明示変更するに留める
