# Task102 — OpenRouter Production Integration

Branch: `feature/v1.1-task102-openrouter-production`  
commit / push: していない。

## Verdict

**PASS**

Task034 の OpenAI / OpenRouter provider abstraction を再利用し、Vercel production 向けに:

- env 指定の `openrouter/free` 等を利用可能
- requested vs actual model の区別
- OpenRouter → OpenAI の one-shot fallback（最大 1+1）
- 402 / 429 / timeout / invalid_response の既存 semantics 維持
- Chart は `OPENROUTER_CHART_MODEL` 明示指定のみ

Gemini 2.5 Flash の hardcode なし。AI prompt / BUY・SELL / Entry Trigger / Calendar / Performance / DB / Supabase は未変更。

---

## Inspected Task034 architecture

再利用した既存構成（新規 provider 層は作っていない）:

| 部品 | 役割 |
| --- | --- |
| `lib/ai/provider.ts` | `resolveTextProvider` / `resolveChartProvider` / `classifyProviderHttp` / `retryAfterSeconds` |
| `lib/ai/openai.ts` | Responses + Chat Completions、strict JSON schema、単発 fetch（retry なし） |
| `lib/ai/client.ts` | server-only 配線 + hourly/daily limit |
| `lib/ai/service.ts` | process-local cache / pending dedupe / rate limit |
| `lib/ai/engine.ts` | finalize、AI unavailable ≠ market WAIT |
| `lib/chart-analysis/*` | Vision。`imageCapable=false` 時は画像送信しない |

Task102 で追加した薄い層:

- `lib/ai/interpret-types.ts` — `AiCallMeta` / `InterpretCallResult`
- `lib/ai/interpret.ts` — `createTextInterpreter`（OpenRouter primary + OpenAI fallback）
- `createOpenAICaller` — `actualModel` / `latencyMs` / `requestedModel` を返す内部 API（`createOpenAI` は既存契約維持）

---

## Changed files

| Path | Change |
| --- | --- |
| `lib/ai/interpret.ts` | **new** OpenRouter→OpenAI one-shot fallback |
| `lib/ai/interpret-types.ts` | **new** call metadata types |
| `lib/ai/openai.ts` | `createOpenAICaller` + `extractResponseModel` |
| `lib/ai/provider.ts` | `Env` type export（既存 logic 維持） |
| `lib/ai/client.ts` | `createTextInterpreter` へ接続 |
| `lib/ai/service.ts` | InterpretCallResult unwrap、detail/meta 保持 |
| `lib/ai/engine.ts` | 402/429 メッセージ、meta → `ai.*` |
| `lib/ai/types.ts` | `requestedModel` / `actualModel` / `fallbackUsed` / `latencyMs` |
| `components/dashboard/ai-analysis.tsx` | details に Provider / Model（メイン画面は非表示） |
| `.env.example` | `openrouter/free` 例 + fallback 注記 |
| `tests/openrouter-production.test.ts` | **new** 14+ cases |

---

## Provider selection

- `AI_PROVIDER=openrouter` → OpenRouter chat completions（`OPENROUTER_*`）
- それ以外（未設定含む）→ OpenAI Responses（`OPENAI_*`）— **削除していない**
- Text model: `OPENROUTER_MODEL`（必須。空なら OpenRouter path は disabled）
- 推奨 production text: `OPENROUTER_MODEL=openrouter/free`
- Chart: `OPENROUTER_CHART_MODEL` 明示。text model への自動転用なし

---

## Requested vs actual model

- `requestedModel` = env で指定した ID（例: `openrouter/free`）
- `actualModel` = upstream `response.model`（取得でき、かつ secret 様でない場合のみ）
- free router は実際の vendor model が変わり得るため UI details / API `ai` で区別可能
- secrets / prompt / image は log しない

---

## Fallback architecture

```
AI_PROVIDER=openrouter
  ├─ OpenRouter 1 request
  │    success → return（OpenAI を呼ばない）
  │    failure in {api_error, rate_limited, timeout, invalid_response, not_configured}
  │         └─ OpenAI 1 request（OPENAI_API_KEY がある場合のみ）
  └─ OpenRouter 未設定 + OpenAI 設定あり → OpenAI 1 回（fallbackUsed=true）

AI_PROVIDER=openai（既定）
  └─ OpenAI のみ（fallback なし）
```

制約:

- 同じ OpenRouter request の再送なし
- OpenAI fallback 最大 1 回
- 1 user action あたり最大 OpenRouter 1 + OpenAI 1
- 勝手な retry loop なし（402/429/timeout 含む）

---

## 402 / 429 behavior

Task034 を維持:

- `classifyProviderHttp(402)` → `api_error` + `http_402`
- `429` → `rate_limited` + `http_429`
- `Retry-After` 秒は detail に `retry_after_N` として記録（ヘッダ全体は client へ出さない）
- UI: 402 は「利用枠または課金」、429 は「約N秒後…自動再試行はしません」
- 自動 retry なし（fallback がある場合のみ別 provider へ 1 回）

---

## Timeout behavior

- `AbortSignal.timeout`（既定 25s）
- `TimeoutError` / `AbortError` → `timeout`
- 同一 provider 再送なし。OpenRouter timeout 時のみ OpenAI fallback 最大 1 回

---

## Structured output behavior

- 既存 `interpretationSchema` / `validateInterpretation` を維持
- schema を緩めない / JSON 推測修復しない / BUY・SELL fallback 生成しない
- invalid → `invalid_response` → AI unavailable / error（market WAIT とは別）

---

## Chart behavior

- `OPENROUTER_CHART_MODEL` 未設定 → `imageCapable=false`、`enabled=false`
- text model を vision に自動利用しない
- 画像非対応時は既存どおり画像を送らない

---

## Cost safety

- `AI_ANALYSIS_HOURLY_LIMIT` / `AI_ANALYSIS_DAILY_LIMIT` 維持（既定 20 / 100）
- parallel AI request 追加なし
- background AI / polling からの AI 呼び出し追加なし
- process-local limiter（multi-instance 非共有）— 新規 DB limiter は作っていない

---

## Vercel considerations

- serverless 前提: process-local cache / rate limit は instance 間非共有（Task034 どおり）
- secrets は server-only。`NEXT_PUBLIC_*` に API key を置かない
- OpenRouter / OpenAI URL は server fetch のみ

---

## Security

- API key / prompt 全文 / chart image / 個人情報は log しない
- error detail は `http_NNN` / `retry_after_N` / validation reason code 程度
- `extractResponseModel` は secret 様文字列を弾く
- production 大量 log なし（invalid_response の debug は既存 `AI_VALIDATION_DEBUG` 条件付き）

---

## UI

- 既存 AI status UI を利用
- `<details>`「AI Provider / Model」に provider / requested / actual / fallback / latency
- メイン画面をモデル名だらけにしない
- AI 失敗時に「AIがWAITと判断した」とは出さない（Task034 の分離維持）

---

## Live smoke

| 項目 | 結果 |
| --- | --- |
| `OPENROUTER_API_KEY` | ローカル `.env.local` に未設定（len=0） |
| live connection | **SKIP** |

キー設定後の推奨 smoke（1 回のみ）:

```bash
AI_PROVIDER=openrouter OPENROUTER_MODEL=openrouter/free \
  # OPENROUTER_API_KEY は env のみ。report に値を書かない
```

actual model が取れた場合は model ID のみ記録可。

---

## Unit / E2E / build

| 項目 | 結果 |
| --- | --- |
| `npm run lint` | PASS（exit 0）。既存 warning 1: `finance-calendar.ts` unused import（Task101 由来、本 task 非対象） |
| `npm test` | **PASS 1048** / fail 0（Task101 baseline 1035 を下回らない。+13） |
| `npm run test:e2e` | **PASS 331 + 1 flaky**（exit 0）。実質 332 本。baseline 332 を維持 |
| `npm run build` | PASS（Next.js 16.3.4） |
| `git diff --check` | PASS |

E2E 実行条件: `CI=1 E2E_PORT=3015`（port 3000 の既存 `next dev` を reuse すると「認証確認中…」で詰まる環境要因あり。コード回帰ではない）。flaky 1件は `exit-plan › 39 1280 no overflow` の timeout→retry 成功。

---

## Known limitations

1. process-local rate limit は Vercel multi-instance で厳密共有されない（意図どおり。DB limiter はスコープ外）
2. `openrouter/free` は実モデルが変動し、structured output 非対応モデルが選ばれると `invalid_response` になる（修復しない）
3. OpenRouter 失敗時の OpenAI fallback はコストが発生し得る（明示設定時のみ）
4. Chart vision は `OPENROUTER_CHART_MODEL` 必須。free text router では chart は動かない
5. live smoke はキー未設定のため SKIP

---

## Env vars required

Production（OpenRouter primary）例:

```
AI_PROVIDER=openrouter
OPENROUTER_API_KEY=          # server-only
OPENROUTER_MODEL=openrouter/free
OPENROUTER_CHART_MODEL=      # vision を使う場合のみ明示
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
OPENAI_API_KEY=              # optional one-shot fallback
OPENAI_ANALYSIS_MODEL=gpt-4.1-mini
AI_ANALYSIS_HOURLY_LIMIT=20
AI_ANALYSIS_DAILY_LIMIT=100
```

OpenAI direct（v1.0 互換）:

```
AI_PROVIDER=openai   # or unset
OPENAI_API_KEY=
OPENAI_ANALYSIS_MODEL=gpt-4.1-mini
OPENAI_CHART_MODEL=   # optional
```

**Never** put `OPENROUTER_API_KEY` / `OPENAI_API_KEY` in `NEXT_PUBLIC_*`.
