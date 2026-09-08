import type { AIAnalysis } from "../ai/types";
import { distance } from "./decimal";
import type { RiskPlan, RiskResult } from "./types";
export function riskReward(entry: number, stop: number, target: number, direction: "long" | "short"): { stopWidth: number; profitWidth: number; riskReward: number } | null {
  if (![entry, stop, target].every(v => Number.isFinite(v) && v >= 1e-9 && v <= 1e12)) return null;
  if (direction === "long" ? !(stop < entry && entry < target) : !(target < entry && entry < stop)) return null;
  const [sn, sd] = distance(entry, stop), [pn, pd] = distance(entry, target);
  return { stopWidth: Number(sn) / Number(sd), profitWidth: Number(pn) / Number(pd), riskReward: Number(pn * sd * BigInt(100) / (pd * sn)) / 100 };
}
export function analysisPlan(analysis: AIAnalysis | null | undefined, pair: string, now: number): RiskResult<RiskPlan> {
  if (!analysis || analysis.pair !== pair) return { data: null, error: "分析データ未取得のため、ポジションサイズは未算出です。" };
  if (!Number.isFinite(Date.parse(analysis.expiresAt)) || now >= Date.parse(analysis.expiresAt)) return { data: null, error: "分析の有効期限を過ぎました。更新まで待機してください。" };
  if (analysis.signal === "wait") return { data: null, error: "AI判断：待った。現在はエントリー条件を満たしていないため、ポジション取得は推奨していません。" };
  if (!["USD/JPY", "EUR/JPY", "GBP/JPY"].includes(pair) || analysis.ai.status !== "available") return { data: null, error: "対象通貨またはAI分析の状態を確認できません。" };
  const s = analysis.scenario;
  const direction = analysis.signal === "buy" || analysis.signal === "strong_buy" ? "long" : analysis.signal === "sell" || analysis.signal === "strong_sell" ? "short" : null;
  if (!s || !s.entryZone || !direction || s.direction !== direction || ![s.entryZone.min, s.entryZone.max].every(v => Number.isFinite(v) && v >= 1e-9 && v <= 1e12) || s.entryZone.min > s.entryZone.max) return { data: null, error: "条件付きEntry・Stop Loss・Take Profitが揃っていないため未算出です。" };
  const entry = direction === "long" ? s.entryZone.max : s.entryZone.min;
  const otherEntry = direction === "long" ? s.entryZone.min : s.entryZone.max;
  const metrics = riskReward(entry, s.stopLoss, s.takeProfit1, direction);
  if (!metrics || !riskReward(otherEntry, s.stopLoss, s.takeProfit1, direction) || metrics.riskReward < 1.5 || !Number.isFinite(s.takeProfit2) || (direction === "long" ? s.takeProfit2 <= s.takeProfit1 : s.takeProfit2 <= 0 || s.takeProfit2 >= s.takeProfit1)) return { data: null, error: "価格関係またはRR 1.5以上の条件を満たさないため未算出です。" };
  return { data: { scenario: s, entry, ...metrics }, error: null };
}
