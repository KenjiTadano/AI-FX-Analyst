# Task101 — FinanceCalendar Economic Calendar

Branch: `feature/v1.1-task101-finance-calendar`  
commit / push: していない。

## Summary

無料の FinanceCalendar API を Economic Calendar の **primary provider** として追加した。  
既存の EODHD → Trading Economics → Finnhub calendar は削除せず fallback として維持する。  
売買判断ロジック・AI prompt・Entry Trigger・DB / Supabase は変更していない。

## Inspected architecture

| 層 | 役割 |
| --- | --- |
| `lib/fundamental/client.ts` | calendar provider chain を組み立て、`assembleFundamentals` へ渡す |
| `lib/economic-calendar/service.ts` | `calendarWithFallback`（ok/empty なら次へ進まない） |
| `lib/economic-calendar/risk-window.ts` | high/medium のリスク時間帯、`calendarTtl`、`nextHigh` |
| `lib/fundamental/service.ts` | pair 通貨で calendar を filter |
| `lib/ai/input.ts` / `lib/ai/engine.ts` | `eventRisk`・economic evidence |
| `lib/trading-plan/daily-plan.ts` / Entry Readiness | calendar 由来の Event Risk |
| `components/dashboard/economic-calendar.tsx` | 指標一覧・次イベント・provider 表示 |

既存 cache: `ResourceCache` + `calendarTtl`（通常 30分、発表近傍は短縮）。新規 polling は追加していない。

## Changed files

| ファイル | 内容 |
| --- | --- |
| `lib/economic-calendar/finance-calendar-normalize.ts` | **新規** normalize / currency map / impact / null metrics |
| `lib/economic-calendar/providers/finance-calendar.ts` | **新規** server-side provider（API key なし） |
| `lib/fundamental/client.ts` | FinanceCalendar を chain 先頭へ |
| `lib/economic-calendar/service.ts` | fallback 警告文を汎用化 |
| `components/dashboard/economic-calendar.tsx` | FinanceCalendar 時の attribution |
| `tests/finance-calendar.test.ts` | **新規** unit tests |
| `outputs/Task101-FinanceCalendar.md` | 本報告書 |

## Provider chain

```
FinanceCalendar
  → EODHD
    → Trading Economics
      → Finnhub calendar (FINNHUB_CALENDAR_ENABLED=true のときのみ)
```

- FinanceCalendar が `ok` / `empty`（`data !== null`）なら **EODHD に進まない**（forbidden で全体 error にしない）。
- FinanceCalendar 失敗時のみ既存 fallback。
- 既存 provider は削除していない。新 env / secret は追加していない。

## FinanceCalendar endpoint

- Discovery: `https://www.financecalendar.com/wp-json/fc/v1`
- Calendar: `https://www.financecalendar.com/wp-json/fc/v1/calendar`
- Site / attribution: `https://www.financecalendar.com`
- API key: 不要

## Normalization

外部 schema → 既存 `EconomicEvent`:

| FinanceCalendar | EconomicEvent |
| --- | --- |
| `name` / `title` | `name` |
| `time_utc` | `scheduledAt` / `rawScheduledAt` / `timezone: "UTC"`（offset 付きのみ） |
| `impact` high/medium/low | `importance`（provider） |
| `consensus` | `forecast` |
| `prior` | `previous` |
| `actual` | `actual` |
| `category` | `reason` に含める |
| `url` | `url` |
| （派生） | `currency` / `country` / `source: "FinanceCalendar"` |

- `null` / 空 / `n/a` / `Not applicable…` → **null**（0 埋め・中立値なし）
- 数値 `0` は提供された場合のみ保持
- `time_utc` 欠落（all-day 等）→ `scheduledAt: null`（時刻を捏造しない）

## Currency / region mapping

対象: USD / JPY / EUR / GBP のみ。

- 既存 `relatedCurrencies`（name/title/url）
- 追加の deterministic ヒント: TSE/JPX、URL slug（`/event/us-`, `/event/eurozone-`, `/event/ecb-`, `/event/uk-`, `/event/boe-`, `/event/boj-`, `/event/tse-` 等）
- **1通貨に確定した場合のみ採用**。0件または複数ヒットは除外（推測割当なし）
- Australia / China / Sweden 等は除外

country 表示ラベル: United States / Japan / Euro Area / United Kingdom。

## Event risk integration

追加の売買ロジックなし。既存の:

- Daily Plan Event Risk
- Entry Readiness
- AI `eventRisk` / economic evidence

が、normalize 済み `EconomicEvent[]` を従来どおり消費する。  
high impact + 確定 `scheduledAt` が既存 `riskState` / `nextHigh` に載る。

## Attribution

`EconomicCalendar` UI で `provider === "FinanceCalendar"` のとき:

`Data: FinanceCalendar` → https://www.financecalendar.com

## Cache behavior

- 既存 `ResourceCache` key: `finance-calendar`
- TTL: 既存 `calendarTtl`（発表近傍短縮、通常 30分）
- 新規 polling / 連続 request loop なし
- FinanceCalendar 側 edge cache に依存しつつ、アプリ側でも重複を抑える

## Live smoke result

実 API へ **過剰でない範囲で** 接続確認（schema / upcoming）。

| 項目 | 結果 |
| --- | --- |
| HTTP | 200 |
| `from` / `to` | 2026-09-21 / 2026-10-05 |
| `count` | 27 |
| `time_utc` あり | 22 |
| impact | high 8 / medium 13 / low 6 |
| sample keys | actual, all_day, category, consensus, date, impact, name, prior, time_et, time_utc, title, url |
| attribution.source | financecalendar.com |

秘密情報なし。本文・個人情報は未出力。

## Unit / E2E / build

| 項目 | 結果 |
| --- | --- |
| lint | PASS |
| Unit | **1035** pass / 0 fail（v1.0 baseline 1020 を下回らない） |
| E2E | **332** pass（mock。baseline 維持） |
| build | PASS |
| git diff --check | PASS |

追加 unit の主な観点: normalize、USD/JPY/EUR/GBP mapping、impact、consensus/actual null、invalid、unmapped skip、time_utc、fallback、FC success 時に EODHD へ進まない、cache。

## Known limitations

- FinanceCalendar の window は provider 側固定（現状おおよそ当日〜2週間）。アプリは従来どおり pair 通貨で filter。
- country フィールドが API に無いため、name/title/url からの deterministic mapping に依存。曖昧なイベントは落とす。
- prior/consensus が長い説明文のとき文字列のまま保持（強制パースしない）。
- EODHD forbidden 自体は未解消（fallback 位置へ後退しただけ）。
- OpenRouter / Performance / Trigger 判定は未変更。

## Security

- API key / 新 secret / `NEXT_PUBLIC_` 秘密なし
- server-side fetch のみ（`lib/fundamental/client.ts` は `server-only`）
- remote Supabase schema / migration なし
- RLS 変更なし

## Impact counts

| 項目 | 値 |
| --- | --- |
| migration | 0 |
| Supabase API/query 変更 | 0 |
| 新規 polling | 0 |
| 新規有料 API | 0 |
| BUY/SELL 誘導変更 | 0 |
