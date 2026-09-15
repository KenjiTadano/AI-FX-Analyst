# Task026 Multi-Timeframe Market Analysis / マルチタイムフレーム分析 実装報告

実装日：2026-09-15  
検証完了日：2026-09-15  
ステータス：**実装・検証完了**  
対象リポジトリ：AI-FX-Analyst  
ブランチ：`feature/task026-multi-timeframe-analysis`  
コミット・push：未実施（禁止どおり）

---

## 実装概要

Task026 は新しい売買判断ではない。複数時間軸の市場構造を **deterministic** に整理し、AI Direction / Action の **補助 Evidence** として渡す。

MTF helper 自身は BUY / SELL / WAIT を生成しない。4/4 完全一致のみ `aligned_*`。欠落足を別足で代用しない。部分失敗を許容する。全足未取得でも既存 AI 分析は継続する。

---

## 変更ファイル

### 新規

- `lib/market/multi-timeframe.ts` — 分析 / alignment / conflict / sanitizer
- `components/dashboard/multi-timeframe.tsx` — Dashboard カード
- `tests/multi-timeframe.test.ts` — A–BJ ほか
- `e2e/multi-timeframe.spec.ts` — Playwright 27 本
- `outputs/Task026-実装報告.md`（本報告）

### 更新

- `lib/market/types.ts` — `mtfTimeframes` / TTL 定数 / optional `daily`
- `lib/market/client.ts` — 既存 cache で `1day` を追加取得
- `lib/ai/types.ts` — optional `multiTimeframeAnalysis`
- `lib/ai/input.ts` — sanitized MTF evidence
- `lib/ai/openai.ts` — MTF は単独で売買決定しない旨の prompt
- `components/dashboard/dashboard.tsx` — MTF カード（選択 pair のみ）
- `components/dashboard/panels.tsx` — optional `ariaLabel`
- `app/globals.css` — 1カラム / desktop 4列
- `tests/market.mjs` — cold cache 5 request / 1day 429 isolation
- `e2e/fixtures/market.ts` / `e2e/helpers/mock.ts` — timeframe 別 fixture

Task003 の 15m/1h/4h テクニカル grid・score 重み・DQ `/3` は未変更。Task013/022 snapshot schema 未変更。Task023/024/025 に現在 MTF を混入していない。

---

## Task003既存OHLC調査結果

実装前の実コード（想像ではない）:

| 項目 | 実装 |
|---|---|
| OHLC timeframe | **15m / 1h / 4h** のみ（1D は未取得） |
| Twelve Data 経路 | サーバー `lib/market/client.ts` → `https://api.twelvedata.com/time_series`。ブラウザ直叩きなし |
| interval | `15m→15min`, `1h→1h`, `4h→4h` |
| outputsize | **300** |
| order | `asc` 指定後、時刻 sort。重複 timestamp は Map で last-write-wins（平均化なし） |
| cache | プロセス内 `Map`。key = `` `${symbol}:${frame}` `` 例: `USD/JPY:15m`。pending で同時重複抑制 |
| series TTL | **300 秒** |
| price TTL | **60 秒**（endpoint `price`） |
| failure TTL | **60 秒** |
| rate limit | 60秒あたり 8 call / 日次 800（UTC 0 リセット）。429 で 60 秒ブロック |
| indicator | `calculateIndicators`: SMA20/75/200, RSI14, ATR14, recentHigh/Low（直近20本）, trend |
| trend（既存） | close > SMA20 > SMA75 > SMA200 → bullish。逆順 → bearish。それ以外 neutral。SMA200 不足時も **neutral**（MTF では unavailable に区別） |
| EMA | **存在しない**。Task026 で新設しない |
| forming candle | `Date.parse(time) + duration <= now` の確定足のみ |
| AI technical source | `evaluateTechnical` が上記 3 足だけを評価。1D は含めない |
| Dashboard refresh | `useMarket` が **60 秒** `setTimeout` 再取得。hidden tab は 60 秒待つ。新規 polling なし |

---

## existing interval

既存: `15min` / `1h` / `4h`。  
追加: Twelve Data `1day`。内部 canonical は既存キーを再利用し `15m` / `1h` / `4h` / `1day`。

---

## existing outputsize

**300** のまま。SMA200 + warmup に足り、過剰に増やしていない。

---

## existing cache / TTL

単一 series TTL **300 秒** を 1day にも適用。timeframe 別 TTL の独自 layer は作っていない。

- cache key: `USD/JPY:15m` / `:1h` / `:4h` / `:1day` / `:price`
- hit: TTL 内は Twelve Data を呼ばない。concurrent は `pending` Map で 1 本化
- miss: resource() が fetch。失敗は 60 秒キャッシュして stale 再利用
- refresh: Dashboard 60 秒ごと `/api/market?symbol=`（選択 pair のみ）。サーバー cache が生きていれば warm

---

## Dashboard refresh

既存 60 秒。Task026 用の 15/30/60 秒ループは追加していない。MTF カードは `useMarket` の結果を表示するだけ。

---

## target timeframes / roles

| 足 | 役割（UI） |
|---|---|
| 1D | 大局 |
| 4H | 中期構造 |
| 1H | 短期構造 |
| 15m | エントリー周辺 |

1D BUY だから買う、15m SELL だから売る、という rule は無い。

---

## fetch strategy / selected pair only

`getMarketData(symbol)` を拡張。選択 pair だけ。3 pair 起動時一括 preload なし。pair switch 時に必要 pair を取得。cache 済みなら再利用。

並列は既存どおり `Promise.all` + 各 `resource()` が reject しない isolation。無制限 pair 並列はしていない。1 pair あたり最大 5 本（price + 4 series）。

---

## request budget

### cold cache（選択 1 pair）

既存: 1 price + 3 TF = **4**  
Task026 後: 1 price + 4 TF = **5**  
**追加 +1（1day）**

仕様例の「1 TF → +3」は、本リポジトリの現状（既に 3 TF）には当てはまらない。正確な増分は **+1**。

### warm cache（5 分以内）

series 再取得 **0**。price は 60 秒 TTL のため、60 秒超の Dashboard refresh では price のみ +1 の可能性（既存仕様）。

---

## cache key

`` `${symbol}:${frame}` ``。frame は `15m` / `1h` / `4h` / `1day`。

---

## failure isolation

timeframe 単位。1 足の 429 / invalid / empty で他足を捨てない。`Promise.all` だが `resource()` が catch して Resource.error を返す。1day 429 でも 15m/1h/4h は残る（`tests/market.mjs`）。

---

## forming/confirmed candle semantics

provider datetime を bar **開始** とみなし、`start + interval duration <= now` のみ structure に使う。forming 判定は既存 Task003 と同じ。Twelve Data に forming フラグは使っていない。

---

## candle order

provider `order=asc` + sort。MTF helper 入口で oldest-first に正規化。逆順入力も同じ結果。重複 timestamp は last-write-wins。平均化しない。invalid OHLC / NaN / Infinity は当該足 fail closed。

---

## minimum candle count

trend/structure に SMA200 が必要なため **200 本**。不足は `sufficientData=false`、trend/structure は **unavailable**（neutral と区別）。E2E fixture は 1 本 + 保存済み SMA200 を使い stored indicators を参照（本番は 300 本から再計算）。

---

## indicators reused

`calculateIndicators` のみ。SMA20 / SMA75 / SMA200 / RSI14 / recentHigh / recentLow。EMA は新設していない。仕様例の ema20/ema50 は Task003 に存在しないため不採用。

---

## trend rule

既存 Task003:

- bullish: close > SMA20 かつ SMA20 > SMA75 かつ SMA75 > SMA200
- bearish: 逆順
- それ以外でデータ十分: **neutral**
- データ不足: **unavailable**

---

## structure rule

複雑な smart-money 推測なし。Order Block / Liquidity Sweep / BOS / CHOCH は名乗らない。

- bullish → uptrend（上昇）
- bearish → downtrend（下降）
- neutral（十分） → **mixed**（混在）
- 不足 → unavailable

range は型にあるが、曖昧なため MVP では emit しない。

---

## higher timeframe bias

**1D + 4H の両方必須。**

- 両方 bullish → bullish
- 両方 bearish → bearish
- 不一致（片方が neutral 含む） → **neutral**
- 片方欠落 → **unavailable**（available 側だけで bias を作らない）

多数決で BUY/SELL は作らない。

---

## alignment

市場状態であり Action ではない。

- 4/4 bullish → `aligned_bullish`
- 4/4 bearish → `aligned_bearish`
- 中立を含む混在 → `mixed`
- 1 つでも unavailable → `insufficient`
- 3/4 は aligned にしない

---

## conflict

最大 3。事実のみ。

- 1D と 4H が反対
- 上位足 bullish + 1H bearish → 「上位足は上向きですが、1時間足は下向きです」
- 上位足 bearish + 15m bullish → 「上位足は下向きですが、15分足は上向きです」

「だから買わない」「反転チャンス」「今が押し目」は出さない。

---

## partial data / unavailable

3/4 でもカードは出す。欠落足は「未取得」。全体 error にしない。  
全 4 未取得: 「マルチタイムフレーム分析を取得できません」。既存 AI は MTF なしで継続。MTF 失敗だけで WAIT hard override は新設していない。

4H unavailable を 1H×4 で作らない。chart screenshot の detected timeframe も代用しない。

---

## AI integration / payload

`AnalysisInput.multiTimeframeAnalysis?` + evidence `technical:mtf`。既存 GET chartless / POST chart-assisted 契約は維持。OpenAI 追加 call **0**（既存 interpret に summary を載せるだけ）。

送信許可: pair, timeframe, trend, structure, lastClose, SMA/RSI, available count, alignment, conflicts。  
禁止: raw candles, provider raw, API metadata, secret。conflict は 3 件・各 120 文字。

prompt: MTF は deterministic evidence。conflict 時も Direction と Action を分けてよい。必ず WAIT の hard rule は作らない。4/4 投票スコアは送らない。

既存 safety（data insufficient / economic / stale / WAIT）は壊していない。MTF aligned_bullish でも指標直前なら WAIT。

---

## chart coexistence

Market MTF と Chart screenshot は別 evidence。両方残す。chart 4H bearish を provider 4H の穴埋めに使わない。

---

## economic safety

`finalizeAnalysis` の economicBlocked を MTF で上書きしない。

---

## UI

Dashboard「MULTI-TIMEFRAME / マルチタイムフレーム分析」。上位足バイアス、4 足の Trend/Structure、整合状態、Conflict、`n / 4 timeframes`。SMA/RSI は details。買い/売り/エントリー/チャンス/おすすめはカード内に出さない。色だけでなく「上向き/下向き/中立/未取得」テキスト。`aria-label="マルチタイムフレーム分析"`。

Task024/025 へは複製しない。Journal 過去 Trade に現在 MTF を出さない。

---

## pair switch

`useMarket(selectedPair)`。mismatch は `multiTimeframeForPair` が null（前 pair を出さない）。

---

## loading/error

既存「取得中…」/ timeframe 未取得。全体 500 にしない。

---

## API追加call

OpenAI 0 / Vision 0 / Finnhub 0 / FRED 0 / EODHD 0 / Supabase 0。  
Twelve Data: 選択 pair の **1day 1 本**（cold）。warm 0。

---

## polling / DB / schema / snapshot

新規 polling 0。migration 0 / RLS 0 / new table 0。Trade / snapshot schema 変更 0。

---

## privacy

API key は client に出ない。AI へ raw candles を送らない。

---

## mobile / desktop

390: 縦カード、overflow なし。1280: 4 列比較、overflow なし。

---

## unit tests

Task025 baseline **640** 維持。Task026 **65** 追加。合計 **705 pass**。A–BJ および critical 3 本を含む。

---

## E2E

Task025 baseline **147** 維持。Task026 **27** 追加。合計 **174 passed**。Task018 fixture。実 Twelve Data / OpenAI / Supabase 非通信。

---

## regression

Direction/Action 分離、WAIT、economic safety、Trigger、Readiness、Pre-Trade Review、Post-Trade Review、Task013/022 snapshot、Task023 Performance を維持。既存テクニカル 3 足の重みと DQ 分母 3 は変更していない。MTF unavailable で DQ を 0 にしていない。

---

## known limitations

1. range は未使用（曖昧なため mixed 優先）
2. series TTL は全足 300 秒（1D はもっと長くてよいが独自 layer を避けた）
3. 200 本未満の本番データは unavailable（stored SMA がある E2E fixture のみ例外経路）
4. MTF は live のみ。snapshot 未保存
5. 1 pair あたり cold 5 並列（既存 Promise.all 踏襲）。分散 limiter は未導入
6. 仕様例の EMA20/50 は未実装（Task003 SMA に合わせた）

---

## Task027候補

- Task013/022 への MTF snapshot 保存（その後 Task023/025 へ）
- 足ごとの TTL（1D 長め、15m 短め）
- 明示的 range ルール
- bounded concurrency / 共有 rate limiter
- Dashboard テクニカル grid と MTF の重複削減
