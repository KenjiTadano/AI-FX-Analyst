# Task003: Twelve Data market data

## Setup

Set `TWELVE_DATA_API_KEY` in `.env.local`, then restart Next.js. Do not prefix the variable with `NEXT_PUBLIC_`. `.env.example` is tracked with an empty placeholder; `.env.local` remains ignored. No key values are committed. No new dependencies.

## Design

- `lib/market/types.ts`: supported pairs, candles, indicators, resource state and market response.
- `lib/market/client.ts`: server-only `/price` and `/time_series` client. API key sent via Authorization header, never a URL. Requests have a 12-second timeout; upstream error details are never forwarded.
- `lib/market/indicators.ts`: chronological closed candles, SMA20/75/200; Wilder RSI14 and ATR14 seeded from 14 changes; highest/lowest of the last 20 closed candles. Neutral flat RSI is 50. Insufficient history returns null. Trend uses close > SMA20 > SMA75 > SMA200 (bullish), reversed (bearish), otherwise neutral.
- `app/api/market/route.ts`: allows only USD/JPY, EUR/JPY, GBP/JPY. Returns independently available price and timeframe resources. Unsupported symbols receive 400; upstream failure is represented in resource state (HTTP 200), enabling partial results.
- `components/dashboard/market.tsx`: selected-pair polling, cancellation on switching, hidden-tab pause, technical UI. News, events, AI, trades and account remain explicitly marked mock.

## Cache and quota

Successful normalized resources are cached server-side in memory: price 60 seconds, all three OHLC intervals 300 seconds. Identical in-flight requests are coalesced. Failed responses retry after 60 seconds; a last successful value is retained and visibly marked stale. An absent key produces empty resources without contacting Twelve Data.

This uses an explicit validated cache instead of Next.js fetch/revalidate: Twelve Data may return errors with HTTP 200, so raw response caching could cache an error as a success. Fetch uses `no-store`, and only the resource cache controls freshness. This cache and the 8/minute, 800/day guard apply to one server process and reset on restart; multiple workers/instances require shared storage and rate limiting. Other clients using the same key are not counted locally, and the provider may return 429.

Only the selected pair is requested. Initial selection costs at most 4 calls. Rapidly switching all 3 pairs can hit the minute limit and automatically retries. One pair continuously visible costs approximately 96 credits/hour; 800/day is not enough for round-the-clock polling. Daily counters reset at UTC midnight. This is an interactive local MVP, not an always-on free feed.

300 OHLC records are requested with UTC timestamps; the unfinished candle is excluded. Displayed quote time is retrieval time, not the timestamp of a trade; `/price` can return the latest available price when the market is closed. Technical timestamps are the start of the last closed candle. No daily percentage change is synthesized.

## Verification

- `npm run lint`
- `npm run build`
- `node tests/market.mjs`: deterministic calculations, normalization, missing key, cache, deduplication, stale fallback and rate-limit handling without spending API credits.
- Browser: USD/JPY, EUR/JPY, GBP/JPY selection, missing-key state, narrow-screen layout, console errors.
- Real provider data cannot be verified until `.env.local` has a Twelve Data API key. At implementation time the key was not configured.

## Official references

- https://twelvedata.com/docs/introduction/quickstart
- https://twelvedata.com/docs/introduction/overview
- https://support.twelvedata.com/en/articles/5615854-credits
