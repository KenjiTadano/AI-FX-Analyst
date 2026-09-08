import { validBudget } from "./position-size";
import type { DrawdownPoint, GoalProgress } from "./types";
export function goalProgress(balance: number, target: number): GoalProgress | null {
  if (!Number.isFinite(balance) || balance < 0 || balance > 1e12 || !Number.isFinite(target) || target < 0.01 || target > 1e12) return null;
  const percent = balance / target * 100;
  return { remaining: Math.max(0, target - balance), percent, barPercent: Math.min(100, percent) };
}
export function drawdown(balance: number, riskPercent: number): DrawdownPoint[] {
  if (!validBudget(balance, riskPercent)) return [];
  return [1, 3, 5, 10].map(losses => {
    const remaining = balance * (1 - riskPercent / 100) ** losses;
    return { losses, balance: remaining, loss: balance - remaining, remainingPercent: balance > 0 ? remaining / balance * 100 : 0 };
  });
}
