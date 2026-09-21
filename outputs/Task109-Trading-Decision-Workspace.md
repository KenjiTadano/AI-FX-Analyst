# Task109 — Trading Decision Workspace

Branch: `feature/v1.1-task109-trading-decision-workspace`  
commit / push: していない。

## Verdict

**PASS**

Analysis タブ上部に Trading Decision Workspace を追加し、既存の Direction / Action / Readiness / Trigger / Event Risk / MTF / Regime / Similar History を要約表示する。新しい score・signal・recommendation は追加していない。

---

## Inspected architecture

| 既存 | 再利用 |
| --- | --- |
| `buildDailyTradingPlan` | Event Risk / plan direction·action |
| `buildEntryReadiness` | readiness count / trigger evaluation |
| `multiTimeframeForPair` | MTF trends |
| `marketRegimeForPair` | regime / trend / volatility |
| `findSimilarHistoricalContexts` | count + top similarity only |
| `directionBiasLabel` / `actionGuidanceLabel` | 既存ラベル |
| `STATUS_TEXT` / `STATE_LABEL` | Trigger / Readiness 文言 |

---

## Workspace information hierarchy

1. **Decision Summary** — Pair / Rate / Freshness / Direction / Action / Confidence / AI status / Readiness / Trigger / Event Risk  
2. **Market Context** — MTF 15m–1D / Regime / Trend / Volatility  
3. **Historical Reference** — Similar count + top %（P/L・R・勝率なし）

配置: Analysis 最上部 → 既存 AIOverview / Daily Plan / Market detail は維持。

---

## Direction / Action separation

- `tdw-direction` と `tdw-action` は別フィールド  
- Direction SELL + Action WAIT を単一 signal に統合しない  

---

## AI unavailable handling

- `ai.status` を Action と別表示  
- unavailable / error / missing 時は `WORKSPACE_AI_UNAVAILABLE_NOTE` を表示  
- Action WAIT を「AI が WAIT と判断」と誤認させない（Task034 維持）

---

## Readiness / Trigger / Event Risk

- Readiness: 既存 `confirmedCount / totalCount` + `STATE_LABEL`（新 score なし）  
- Trigger: 既存 `STATUS_TEXT`（MET≠エントリー推奨。注記表示）  
- Event Risk: 既存 `plan.eventRisk`（high は視認性強化、新 risk score なし）

---

## MTF / Regime

- 既存 `trend` / `REGIME_LABEL` 等をそのまま表示  
- alignment score 等の新規指標なし  

---

## Similar History integration

- Task108 再利用: `matches.length` + `topPercent`  
- Workspace に P/L / R / win-loss を出さない  
- 「過去事例を見る」で `#similar-historical-context` へ  

---

## Progressive disclosure

Workspace = compact summary。詳細は既存セクション + jump links（AI / Entry / Market）。

---

## Unavailable states

項目単位で unavailable を表示。1項目欠落で Workspace 全体を隠さない。

---

## Responsive / accessibility

- 縦 stack（mobile 1列）  
- `min-width: 0` / overflow-wrap  
- headings / aria-label / jump focus  

---

## Proof: no new decision logic

- `decisionScore` / `compositeScore` / probability / EV / predicted R なし  
- 文言: 「新しい売買判定やスコアは追加していません」  
- Trigger MET でも Action WAIT を変更しない  

---

## DB / API / AI

migration 0 / write 0 / RPC 0 / RLS 変更なし / DB write 0  
market・AI request 追加 0  

---

## Changed files

- `lib/dashboard/trading-decision-workspace.ts`（新規）
- `components/dashboard/trading-decision-workspace.tsx`（新規）
- `components/dashboard/dashboard.tsx`（Workspace 配置）
- `components/dashboard/panels.tsx`（`id` 対応）
- `app/globals.css`
- `tests/trading-decision-workspace.test.ts`（新規）
- `e2e/trading-decision-workspace.spec.ts`（新規）
- `outputs/Task109-Trading-Decision-Workspace.md`（本ファイル）

---

## Tests

Unit: rate/freshness / Direction≠Action / AI unavailable / readiness / trigger / event / MTF / Regime / similar summary / no composite / partial data / Task108·107·PI回帰 / no DB·API·AI / a11y

E2E: render / separate fields / layers / existing detail remains / no recommendation / mobile / keyboard focus

---

## Unit / E2E / build

| Check | Result |
| --- | --- |
| Unit | **1175** passed（Task108 baseline 1158↑） |
| E2E | **351** passed（Task108 baseline 344↑） |
| lint | PASS（既存 finance-calendar warning のみ） |
| build | PASS |
| `git diff --check` | PASS |

---

## Known limitations

- Daily Loss Limit は localStorage を Workspace 側でも読む（Daily Plan と同キー）  
- Technical 詳細数値は Layer2 に出さず既存 TechnicalPanel に委ねる  
- Similar History の emptyReason は要約のみ  

---

## Future work

- Technical compact strip（既存 indicators の再表示）  
- Workspace 折りたたみ設定  
- jump 時の highlight  
