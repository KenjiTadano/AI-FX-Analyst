import { symbols, timeframes, type Candle, type Symbol, type Timeframe } from "../market/types";

export const STRUCTURED_ENTRY_TRIGGER_VERSION = 1;
export const ENTRY_TRIGGER_PRICE_MAX = 1000;
export const ENTRY_TRIGGER_SOURCE_MAX = 400;
export const structuredEntryTriggerTypes = [
  "price_above",
  "price_below",
  "candle_close_above",
  "candle_close_below",
] as const;
export type StructuredEntryTriggerType = (typeof structuredEntryTriggerTypes)[number];
export const triggerTimeframes = ["1min", "5min", "15min", "30min", "1h", "4h", "1day"] as const;
export type TriggerTimeframe = (typeof triggerTimeframes)[number];

export type EntryTriggerEvaluationStatus = "met" | "not_met" | "unavailable" | "invalid";

export interface StructuredEntryTrigger {
  version: 1;
  type: StructuredEntryTriggerType;
  pair: Symbol;
  price: number;
  timeframe: TriggerTimeframe | null;
  sourceCondition: string | null;
}

export interface EntryTriggerEvaluation {
  status: EntryTriggerEvaluationStatus;
  checkedAt: string;
  observedValue: number | null;
  observedLabel: string;
  reason: string;
  expression: string;
  humanLabel: string;
}

export const TRIGGER_SOURCE_LABEL = "AI分析時に構造化された条件";
export const TRIGGER_MET_LABEL = "条件成立を確認";
export const TRIGGER_NOT_MET_LABEL = "条件未成立";
export const TRIGGER_UNAVAILABLE_LABEL = "判定データ不足";
export const TRIGGER_INVALID_LABEL = "構造化条件を利用できません";
export const TRIGGER_STALE_NOTE = "分析が古いため再分析してください";
export const TRIGGER_DISCLAIMER =
  "条件成立は、AI分析時に設定された条件が市場データ上で確認できたことを示すもので、売買の推奨や注文実行を意味しません。";

export const STATUS_TEXT: Record<EntryTriggerEvaluationStatus, string> = {
  met: "条件成立",
  not_met: "条件未成立",
  unavailable: "判定データ不足",
  invalid: "利用不可",
};

export const TIMEFRAME_LABEL: Record<TriggerTimeframe, string> = {
  "1min": "1分足",
  "5min": "5分足",
  "15min": "15分足",
  "30min": "30分足",
  "1h": "1時間足",
  "4h": "4時間足",
  "1day": "日足",
};

const TRIGGER_TO_MARKET: Partial<Record<TriggerTimeframe, Timeframe>> = {
  "15min": "15m",
  "1h": "1h",
  "4h": "4h",
};

const CANDLE_DURATION_MS: Record<TriggerTimeframe, number> = {
  "1min": 60_000,
  "5min": 300_000,
  "15min": 900_000,
  "30min": 1_800_000,
  "1h": 3_600_000,
  "4h": 14_400_000,
  "1day": 86_400_000,
};

const SECRET = /sk-[a-zA-Z0-9]{10,}|api[_-]?key\s*[:=]|data:image\/|BEGIN (RSA )?PRIVATE|systemPrompt/i;

export const entryTriggerObjectSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    version: { type: "number", enum: [1] },
    type: { type: "string", enum: [...structuredEntryTriggerTypes] },
    pair: { type: "string", enum: [...symbols] },
    price: { type: "number" },
    timeframe: { anyOf: [{ type: "string", enum: [...triggerTimeframes] }, { type: "null" }] },
    sourceCondition: { anyOf: [{ type: "string", maxLength: ENTRY_TRIGGER_SOURCE_MAX }, { type: "null" }] },
  },
  required: ["version", "type", "pair", "price", "timeframe", "sourceCondition"],
} as const;

export const entryTriggerSchema = {
  anyOf: [entryTriggerObjectSchema, { type: "null" }],
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isPriceType(type: StructuredEntryTriggerType): boolean {
  return type === "price_above" || type === "price_below";
}

export function triggerExpression(trigger: StructuredEntryTrigger): string {
  const op = trigger.type.endsWith("above") ? ">" : "<";
  if (isPriceType(trigger.type)) return `PRICE ${op} ${trigger.price}`;
  return `${trigger.timeframe ?? "—"} CLOSE ${op} ${trigger.price}`;
}

export function triggerHumanLabel(trigger: StructuredEntryTrigger): string {
  if (trigger.type === "price_above") return `現在価格が${trigger.price}を上回る`;
  if (trigger.type === "price_below") return `現在価格が${trigger.price}を下回る`;
  const frame = trigger.timeframe ? TIMEFRAME_LABEL[trigger.timeframe] : "指定時間足";
  if (trigger.type === "candle_close_above") return `${frame}の終値が${trigger.price}を上回る`;
  return `${frame}の終値が${trigger.price}を下回る`;
}

export function sanitizeStructuredEntryTrigger(value: unknown, analysisPair: string): StructuredEntryTrigger | null {
  if (value == null) return null;
  if (!isRecord(value)) return null;
  if (value.version !== STRUCTURED_ENTRY_TRIGGER_VERSION) return null;
  if (!structuredEntryTriggerTypes.includes(value.type as StructuredEntryTriggerType)) return null;
  const type = value.type as StructuredEntryTriggerType;
  if (!symbols.includes(value.pair as Symbol)) return null;
  const pair = value.pair as Symbol;
  if (pair !== analysisPair) return null;
  if (typeof value.price !== "number" || !Number.isFinite(value.price)) return null;
  if (value.price <= 0 || value.price >= ENTRY_TRIGGER_PRICE_MAX) return null;
  let timeframe: TriggerTimeframe | null = null;
  if (value.timeframe != null) {
    if (!triggerTimeframes.includes(value.timeframe as TriggerTimeframe)) return null;
    timeframe = value.timeframe as TriggerTimeframe;
  }
  if (!isPriceType(type) && !timeframe) return null;
  if (isPriceType(type)) timeframe = null;
  let sourceCondition: string | null = null;
  if (value.sourceCondition != null) {
    if (typeof value.sourceCondition !== "string") return null;
    const text = value.sourceCondition.trim().slice(0, ENTRY_TRIGGER_SOURCE_MAX);
    if (!text || SECRET.test(text)) return null;
    sourceCondition = text;
  }
  return { version: 1, type, pair, price: value.price, timeframe, sourceCondition };
}

function lastClosedCandle(candles: Candle[] | null | undefined, timeframe: TriggerTimeframe, nowMs: number): Candle | null {
  if (!Array.isArray(candles) || !candles.length) return null;
  const duration = CANDLE_DURATION_MS[timeframe];
  const closed = candles.filter(candle => {
    const start = Date.parse(candle.time);
    return Number.isFinite(start) && Number.isFinite(candle.close) && start + duration <= nowMs;
  });
  return closed.at(-1) ?? null;
}

function result(
  status: EntryTriggerEvaluationStatus,
  nowMs: number,
  trigger: StructuredEntryTrigger | null,
  observedValue: number | null,
  observedLabel: string,
  reason: string,
): EntryTriggerEvaluation {
  return {
    status,
    checkedAt: new Date(nowMs).toISOString(),
    observedValue,
    observedLabel,
    reason,
    expression: trigger ? triggerExpression(trigger) : "",
    humanLabel: trigger ? triggerHumanLabel(trigger) : TRIGGER_INVALID_LABEL,
  };
}

export interface EvaluateStructuredEntryTriggerInput {
  trigger: unknown;
  pair: string;
  currentRate?: number | null;
  candlesByTimeframe?: Partial<Record<Timeframe, { candles: Candle[]; lastClosedAt: string | null } | null>>;
  now: Date | number | string;
}

export function evaluateStructuredEntryTrigger(input: EvaluateStructuredEntryTriggerInput): EntryTriggerEvaluation {
  const nowMs = typeof input.now === "number" ? input.now : typeof input.now === "string" ? Date.parse(input.now) : input.now.getTime();
  const checkedAt = Number.isFinite(nowMs) && nowMs > 0 ? nowMs : Date.now();
  const trigger = sanitizeStructuredEntryTrigger(input.trigger, input.pair);
  if (!trigger) {
    return result("invalid", checkedAt, null, null, "—", TRIGGER_INVALID_LABEL);
  }
  if (isPriceType(trigger.type)) {
    const rate = typeof input.currentRate === "number" && Number.isFinite(input.currentRate) ? input.currentRate : null;
    if (rate == null) {
      return result("unavailable", checkedAt, trigger, null, "現在価格", TRIGGER_UNAVAILABLE_LABEL);
    }
    const met = trigger.type === "price_above" ? rate > trigger.price : rate < trigger.price;
    return result(met ? "met" : "not_met", checkedAt, trigger, rate, "現在価格", met ? TRIGGER_MET_LABEL : TRIGGER_NOT_MET_LABEL);
  }
  const marketFrame = trigger.timeframe ? TRIGGER_TO_MARKET[trigger.timeframe] : undefined;
  if (!trigger.timeframe || !marketFrame || !timeframes.includes(marketFrame)) {
    return result("unavailable", checkedAt, trigger, null, "確定足終値", TRIGGER_UNAVAILABLE_LABEL);
  }
  const series = input.candlesByTimeframe?.[marketFrame];
  const closed = lastClosedCandle(series?.candles, trigger.timeframe, checkedAt);
  if (!closed) {
    return result("unavailable", checkedAt, trigger, null, "確定足終値", TRIGGER_UNAVAILABLE_LABEL);
  }
  const close = closed.close;
  const met = trigger.type === "candle_close_above" ? close > trigger.price : close < trigger.price;
  return result(met ? "met" : "not_met", checkedAt, trigger, close, "確定足終値", met ? TRIGGER_MET_LABEL : TRIGGER_NOT_MET_LABEL);
}
