import {
  EXIT_PLAN_CLOSED_EYEBROW,
  EXIT_PLAN_DISCLAIMER,
  EXIT_PLAN_EYEBROW,
  EXIT_PLAN_MISSING,
  EXIT_PLAN_OPEN_R,
  EXIT_PLAN_TITLE,
  EXIT_PLAN_UNREADABLE,
  calculateRealizedMovePips,
  calculateRealizedR,
  exitPlanState,
  formatMovePips,
  formatPlannedRR,
  formatRealizedR,
  formatRiskPips,
  storedExitPlan,
} from "@/lib/trades/exit-plan";
import type { Trade } from "@/lib/trades/types";

function row(label: string, value: string, testId: string) {
  return <div><dt>{label}</dt><dd data-testid={testId}>{value}</dd></div>;
}

function price(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return value.toLocaleString("ja-JP", { maximumFractionDigits: 10 });
}

export function ExitPlanDetail({ trade }: { trade: Trade }) {
  const plan = storedExitPlan(trade);
  const state = exitPlanState(trade);
  const closed = trade.status === "closed";
  const realizedR = closed ? calculateRealizedR(trade) : null;
  const realizedMove = closed ? calculateRealizedMovePips(trade) : null;
  return (
    <section className="exit-plan" data-testid="exit-plan" aria-label={EXIT_PLAN_TITLE}>
      <p className="eyebrow">{closed ? EXIT_PLAN_CLOSED_EYEBROW : EXIT_PLAN_EYEBROW}</p>
      <h4>{EXIT_PLAN_TITLE}</h4>
      {state === "absent" && <p className="footnote" data-testid="exit-plan-missing">{EXIT_PLAN_MISSING}</p>}
      {state === "unreadable" && <p className="footnote" data-testid="exit-plan-unreadable">{EXIT_PLAN_UNREADABLE}</p>}
      {plan && <dl className="exit-plan-grid">
        {row("Entry", price(plan.entryPrice), "exit-plan-entry")}
        {row("初期損切り", price(plan.initialStopLoss), "exit-plan-sl")}
        {row("初期利確", price(plan.initialTakeProfit), "exit-plan-tp")}
        {row("初期リスク", formatRiskPips(plan.initialRiskPips), "exit-plan-risk")}
        {row("計画R:R", formatPlannedRR(plan.plannedRewardRiskRatio), "exit-plan-planned-rr")}
        {closed && row("Exit", price(trade.exitPrice), "exit-plan-exit")}
        {closed && row("実現値幅", formatMovePips(realizedMove), "exit-plan-move")}
        {row("実現R", closed ? formatRealizedR(realizedR) : EXIT_PLAN_OPEN_R, "exit-plan-realized-r")}
      </dl>}
      {!plan && <p data-testid="exit-plan-realized-r">{closed ? "—" : EXIT_PLAN_OPEN_R}</p>}
      <p className="footnote">{EXIT_PLAN_DISCLAIMER}</p>
    </section>
  );
}
