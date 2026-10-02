# AI-FX-Analyst v1.2 Task112 — API Usage / Rate Limit Optimization

Branch: `feature/v1.2-task112-api-usage-optimization`  
Commit / push: していない  
Scope: API cache/polling、stale fallback、usage observability。Signal Engine v2、DB、schema、provider追加は対象外。

## 1. Verdict

**PASS**。mockでTwelve Data requestsが減少し、dedupe/cache/stale freshness/rate-limit regressionと全必須validationが通過。

## 2. Problem

Dashboardはmarket/fundamentalを別々に60秒pollし、AI routeも60秒pollしていました。server cacheでprovider requestsは一部抑制されていたものの、OHLC全時間軸が同一5分TTLで、非表示タブ・AI cache expiryとの協調やstale UIの区別が不十分でした。

## 3. API Call Map

- **Twelve Data `/price`**: [market API route](../app/api/market/route.ts) → [shared market client](../lib/market/client.ts)。選択pair初回/60秒market poll/AI serviceのmarket readがtrigger。quote TTL60秒、endpoint＋symbol query key、in-flight dedupe。failure時はlast-good stale、429時はcooldown。1 active pairあたり10分mock: Before 10 / After 10 price requests。
- **Twelve Data `/time_series`**: 同market clientが15m/1h/4h/1dayを取得。`symbol, interval, outputsize=300, timezone=UTC, order=asc`をcache keyに含める。Beforeは各5分TTL、Afterは時間軸別TTL。MTF/Regime/Technicalは取得済みOHLCをローカル計算し、追加endpointなし。10分mock: Before 8 / After 5 series requests。
- **Finnhub `/api/v1/news?category=forex`**: [fundamental route](../app/api/fundamental/route.ts) → [fundamental provider wiring](../lib/fundamental/client.ts)。60秒dashboard poll、provider cache10分、pair間で共有。10分mock: Before見積1 / After spy1。
- **Finnhub `/api/v1/calendar/economic`**: calendar fallback末端のみ。`FINNHUB_CALENDAR_ENABLED=true`で有効、日付範囲は前日〜7日後。10分healthy-primary mock: Before見積0 / After spy0。
- **FRED `/fred/series/observations`**: macro serviceが8系列を並列取得。provider cache1時間、pair間共有。10分mock: Before見積8 / After spy8。
- **FinanceCalendar `/wp-json/fc/v1/calendar`**: calendar primary、API key不要。event-aware cacheは通常30分、重要event直前は期限短縮。10分mock: Before見積1 / After spy1。
- **EODHD `/api/economic-events`**: FinanceCalendar失敗時の第2段。refreshあたり最大4 countries（USD/JPY/GBP/EUR設定）を並列取得。10分healthy-primary mock: Before見積0 / After spy0。
- **Trading Economics `/calendar/country/...`**: calendar第3段、refreshあたり1 request。10分healthy-primary mock: Before見積0 / After spy0。
- **OpenAI Responses API / OpenRouter Chat Completions**: `/api/analysis` → [AI service](../lib/ai/service.ts) → [text interpreter](../lib/ai/interpret.ts)。初回/手動refresh/analysis expiryがtrigger。pair/chart key、in-flight dedupe、success最大5分・fallback結果最大1分・event boundary expiry。eligible OpenRouter failure時のみOpenAIへ一回fallback。
- **OpenAI/OpenRouter Vision**: `/api/chart-analysis` → chart vision client。ユーザーの画像解析操作のみ、pollなし。成功結果はbrowser memoryでpair＋file fingerprint単位cache、server cacheなし。
- **Trade Market Context refresh**: `/api/market`をユーザー操作時に一回呼ぶ。background pollingではない。

## 4. Twelve Data Audit

初回/完全refreshは`/price` 1＋`/time_series` 4 requests。cache keyにendpointと全query parametersを含み、symbol/interval/outputsizeの混同を防止。USD/JPY・EUR/JPY・GBP/JPYは独立keyで、選択中pairだけを取得しall-pair preloadはありません。indicator、MTF、Regime、chart、AIはこれらの共通OHLC/quoteを再利用します。

公式docsのcredit表記は`/price`、`/time_series`とも1 credit/symbol。実アカウントcredit値は取得していません。

## 5. Before Measurement

- Twelve Dataはpre-change codeをmock clock/fetchで10分実行し18 requests（price10＋series8）を記録。
- 他providerのBeforeは、初回auditで記録した旧TTL/fallback順を同じhealthy mock条件へ当てた見積値。pre-change provider countersはなく、live APIの実測値ではありません。Afterはmock fetch spiesで測定。
- Twelve Data `/api_usage` endpointは1 credit/queryのため、quotaを使わない測定では呼びませんでした。

## 6. Root Causes

- 1h/4h/1day OHLCまで15mと同じ5分cache TTL。
- AI hookがserver-side `expiresAt`より短い60秒固定poll。
- hidden tabでもtimerを再予約し、visible復帰時のrequestを協調していない。
- fundamental `ResourceCache`がexpired success後のprovider failure時にlast-good dataを破棄。
- MTF/Regime helperがstale flagを入力eligibilityに反映していない。
- caches/limitersはprocess-localで、Vercel instances間では共有されない。

## 7. Architecture Changes

- 既存`lib/market/client.ts`を共有market data入口として維持。新しいdata-layer architectureやproviderは追加していません。
- 既存`ResourceCache`を拡張してstale-while-revalidateを実装。
- provider fetch boundaryにcounterを追加し、`GET /api/api-usage`でdevelopment時のみ取得可能にしました。

## 8. Cache Policy

- Twelve Data: quote60秒、15m series5分、1h15分、4h30分、1day6時間、failure60秒。
- Fundamental: news10分、FRED1時間、calendar通常30分（event-aware短縮）、failure60秒、401/403は15分。
- Analysis cacheの意味と期限は不変。success最大5分、未取得時最大1分、risk boundaryで短縮。
- OHLC provider semantics、outputsize、timezone、order、確定足判定は不変。

## 9. Request Deduplication

- Twelve Dataはendpoint＋sorted全query keyとpending promiseでdedupe。
- ResourceCacheはpair間共有key、TTL hit、in-flight promiseを共有。
- AI serviceはpair/chart keyでcacheとpendingを共有。新しい分析reuse keyは導入していません。

## 10. Polling / Visibility

- market/fundamental foreground pollingは60秒維持。hidden時はscheduled timerを停止、visible復帰時に共有schedulerで0/250/500msずつstagger。
- AI pollingは固定60秒から`expiresAt`連動へ変更。通常は最大5分、event/fallback expiryが早ければその時刻に再実行。
- 既存の1秒`setInterval`はclock/countdown表示のみで外部APIを呼びません。authの`router.refresh()`はnavigationだけでmarket pollingではありません。

## 11. Rate Limit Handling

- Twelve Dataの既存8 calls/minute・800 calls/day guardを維持。HTTP429/HTTP200 body-code 429を検出。
- `Retry-After`秒数またはHTTP dateを最大24時間で解釈。headerなしは60秒cooldown。daily quotaはUTC翌日までblockし、無意味なpoll retryを抑制。
- Finnhub/FRED/FinanceCalendar/EODHD/Trading Economics/AIで429・timeout・provider errorを区別して計測。
- 同一providerへの自動retryなし。OpenRouter→OpenAI既存fallbackは対象条件時に一回のみ。

## 12. Stale Fallback

- expired success dataはSTALEとして即時返し、key単位background refreshを開始。
- refresh失敗時はlast-good data/fetchedAtを保持し、`stale:true`＋error状態へ移行。成功時はfreshへ復帰。保存データがなければunavailable/error。
- Fundamental footerでFRESH/STALE/UNAVAILABLEを表示。marketではrate/OHLCのstale状態を表示。
- stale news/calendar/FREDはAI evidenceから除外し、stale calendarはrisk stateをknownにしない。stale candlesはMTF/Regimeから除外しunavailable表示。計算式は変更なし。

## 13. API Usage Observability

providerごとに`requests`, `cacheHits`, `cacheMisses`, `inFlightDedupes`, `rateLimited`, `dailyQuota`, `timeouts`, `providerErrors`, `errors`, `calls`, `fallbacks`, `successes`, `lastRequestAt`, `lastSuccessAt`をprocess memoryで保持。

`GET /api/api-usage`はdevelopment限定、`Cache-Control: private, no-store`。自動polling/UIはありません。production永続監視の代替ではありません。

## 14. Twelve Credit Header Handling

確認したTwelve Data公式docsにはcredit usage response headersの記載がありません。残数/used値は推測・捏造せず取得していません。公式`/api_usage` endpointは1 creditを使うため呼びません。

## 15. AI Call Audit

10分mockで`createAnalysisService`＋mock OpenAI Responses transportを実行しOpenAI 2 requests/calls、OpenRouter 0を確認。server analysis cacheが0分と5分に推論し、他pollはcache hit。OpenRouter 429→OpenAI fallback testで両provider各1 request、fallback1、同一provider retry0を確認。

## 16. News / Fundamental Audit

10分mock fetch spyでFinnhub news1、FRED 8 series calls、FinanceCalendar1。FinanceCalendarがvalid empty responseを返すためEODHD/Trading Economics/Finnhub calendarは各0。正常時の既存provider cache TTLを維持。

## 17. After Measurement

- Twelve Data: 15 upstream requests（price10＋series5）、35 cache hits、0 errors。SWR delay/recovery、daily quota、Retry-Afterもmock確認。
- Finnhub1、FRED8、FinanceCalendar1、EODHD0、Trading Economics0。
- OpenAI primary2、OpenRouter0。Visionは明示的な画像解析操作がないため0。
- すべてfetch spy/mock clockによる測定で、実provider quotaを消費していません。

## 18. Before vs After

- Twelve Data: 18 → 15 requests/10分、16.7%減。provider docsの1 credit/symbol/end-point表記に基づくcredit相当推定も18→15。ただしaccount dashboard実測ではありません。
- Finnhub news: 旧TTL見積1 → spy1。FRED: 旧TTL見積8 → spy8。FinanceCalendar: 旧TTL見積1 → spy1。fallback providers: 旧fallback順で0 → spy0。これらは既にcache効率があり、今回の差分ではTTLを不用意に変更していません。
- OpenAI primary: service expiry由来の旧server-side想定2 → mock2。AI browser route pollは60秒固定10回からexpiry時2回へ減らす設計。fallback/cache expiryはより短い設定を維持。
- Finnhub/FRED/calendar/AIのBefore値は初期auditで確認したTTLとtriggerからの見積で、pre-change runtime counter実測ではありません。

## 19. DB Impact

Migration 0、column 0、RPC 0、RLS/schema変更0。Supabase code pathは変更なし。

## 20. API / AI Semantic Impact

provider endpoint/parameters/order/fallback条件、AI prompt/model、Direction、Action、Entry Readiness、Trigger、score、MTF/Regime式、trade snapshots、Market Context、Exit Planは変更なし。stale dataだけ分析eligibilityを下げ、fresh input時のsignal logicには触れていません。

## 21. Security

Usage snapshotはprovider名・counter・timestampsのみ。API key、Authorization、request/response body、full URLを保存しない。Twelve Data keyはAuthorization headerのまま。FRED/EODHDの既存query-key方式は変更していません。

## 22. Changed Files

- Market policy/cache: `lib/market/client.ts`, `lib/market/types.ts`
- Stale cache/AI freshness: `lib/fundamental/cache.ts`, `lib/fundamental/types.ts`, `lib/fundamental/service.ts`, `lib/ai/input.ts`, `lib/economic-calendar/risk-window.ts`, `lib/economic-calendar/service.ts`
- Provider counters: Finnhub, FRED, FinanceCalendar, EODHD, Trading Economics, OpenAI, OpenRouter, Vision calls
- Visibility/panels: dashboard market/fundamental/AI/MTF/Regime; `lib/client/polling.ts`
- Observability route: `lib/api-usage.ts`, `app/api/api-usage/route.ts`
- Regression tests: API usage, market, fundamental, calendar, AI fallback, polling, MTF/Regime stale gating

## 23. Tests

- Unit: 1193 pass / 0 fail。Task111 baseline 1181を上回る。
- E2E: 362 pass / 0 fail。Task111 baseline 362を維持。
- `npm run lint`: pass。
- `npm run build`: pass（Next.js 16.3.4 Turbopack）。
- `git diff --check`: pass。
- provider quotaはmockのみ。real API/credit dashboardは未呼び出し。

## 24. Known Limitations

- cache/limiter/AI cache/countersはprocess-local。Vercel serverless instance間で共有されない。
- usage routeはdevelopment限定、production metricsの永続化・集約なし。
- Twelve Data credit headersは未確認。live quota/remaining credits未測定。
- EODHD/FRED secret query parameter方式は既存実装を維持。

## 25. Future Infrastructure Options

Task113以降の候補: 認証されたproduction usage aggregation、shared Redis/KV cache・distributed rate limiter、Twelve Data公式usage metadata/header仕様の確認。DB/Redis/KVは本Taskで追加しない。

## 26. Final Verdict

**PASS**。Twelve Data mock requestsは実測で16.7%減。duplicate requestsはin-flight/key dedupe、cache behaviorはdeterministic tests、stale/fresh区別とretry storm抑制を確認。Signal/AI semantics、DB schema、新providerは変更なし。Commit / pushなし。