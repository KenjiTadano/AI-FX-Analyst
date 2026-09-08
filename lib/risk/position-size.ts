import { ceilYenCents, distance, fraction } from "./decimal";
import type { PositionRisk, PositionSize, RiskResult } from "./types";
export function validBudget(balance: number, riskPercent: number): boolean {
  return Number.isFinite(balance) && balance >= 0 && balance <= 1e12 && Number.isFinite(riskPercent) && riskPercent > 0 && riskPercent <= 100;
}
export function allowedLoss(balance: number, riskPercent: number): number | null {
  if (!validBudget(balance, riskPercent)) return null;
  const [bn, bd] = fraction(balance), [rn, rd] = fraction(riskPercent);
  // Round the budget down to one sen; never add spending capacity.
  return Number(bn * rn / (bd * rd)) / 100;
}
export function positionSize(balance: number, riskPercent: number, entry: number, stop: number, tradeUnit: number): RiskResult<PositionSize> {
  const budget = allowedLoss(balance, riskPercent);
  if (budget === null || !Number.isSafeInteger(tradeUnit) || tradeUnit <= 0) return { data: null, error: "資産・リスク率・取引単位の入力を確認してください。" };
  if (![entry, stop].every(v => Number.isFinite(v) && v >= 1e-9 && v <= 1e12) || entry === stop) return { data: null, error: "EntryとStop Lossには異なる正の価格が必要です。" };
  const [dn, dd] = distance(entry, stop);
  if (Number(dn) / Number(dd) < 1e-9) return { data: null, error: "損切り幅が計算対応範囲より小さいため未算出です。" };
  const [bn, bd] = fraction(budget);
  const unit = BigInt(tradeUnit);
  const units = bn * dd / (bd * dn * unit) * unit;
  if (units > BigInt(Number.MAX_SAFE_INTEGER)) return { data: null, error: "数量が計算対応範囲を超えるため未算出です。" };
  return { data: { allowedLoss: budget, maxUnits: Number(units), estimatedLoss: ceilYenCents(dn * units, dd), lossPerUnit: Number(dn) / Number(dd) }, error: null };
}
export function positionRisk(units: number, size: PositionSize, balance: number, entry: number, stop: number, tradeUnit: number): PositionRisk | null {
  if (!Number.isSafeInteger(units) || units < 0 || !Number.isFinite(balance) || balance < 0 || !Number.isSafeInteger(tradeUnit) || tradeUnit <= 0 || ![entry, stop].every(v => Number.isFinite(v) && v >= 1e-9 && v <= 1e12) || entry === stop) return null;
  const [dn, dd] = distance(entry, stop);
  const loss = ceilYenCents(dn * BigInt(units), dd);
  return { units, estimatedLoss: loss, actualRiskPercent: balance > 0 ? loss / balance * 100 : loss > 0 ? Infinity : 0, exceedsRisk: units > size.maxUnits, validUnit: units % tradeUnit === 0 };
}
