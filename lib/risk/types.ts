import type { TradeScenario } from "../ai/types";
export interface RiskSettings { balance: number; target: number; riskPercent: number; tradeUnit: number }
export interface PositionSize { allowedLoss: number; maxUnits: number; estimatedLoss: number; lossPerUnit: number }
export interface RiskPlan { scenario: TradeScenario; entry: number; stopWidth: number; profitWidth: number; riskReward: number }
export interface PositionRisk { units: number; estimatedLoss: number; actualRiskPercent: number; exceedsRisk: boolean; validUnit: boolean }
export interface GoalProgress { remaining: number; percent: number; barPercent: number }
export interface DrawdownPoint { losses: number; balance: number; loss: number; remainingPercent: number }
export type RiskResult<T> = { data: T; error: null } | { data: null; error: string };
