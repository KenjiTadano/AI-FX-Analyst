"use client";
import { useEffect, useState } from "react";
import type { AIAnalysis } from "@/lib/ai/types";
import type { RiskSettings } from "@/lib/risk/types";
import { allowedLoss, positionRisk, positionSize } from "@/lib/risk/position-size";
import { analysisPlan } from "@/lib/risk/risk-reward";
import { drawdown, goalProgress } from "@/lib/risk/drawdown";
import defaults from "@/lib/settings/defaults.json";
import { Panel } from "./panels";

const money = (n: number | null | undefined) => n == null ? "未算出" : new Intl.NumberFormat("ja-JP", { style: "currency", currency: "JPY", maximumFractionDigits: 2 }).format(n);
const number = (n: number) => n.toLocaleString("ja-JP", { maximumFractionDigits: 2 });
const price = (n: number | null | undefined) => n == null ? "未算出" : n.toFixed(3);
const readNumber = (value: string) => value.trim() === "" ? NaN : Number(value);

export function RiskManagement({ analysis, pair, currentRate, initialBalance = defaults.balance, initialTarget = defaults.target, initialRiskPercent = defaults.riskPercent, initialTradeUnit = defaults.tradeUnit, onSettingsChange, disabled = false, onBalanceChange }: { analysis: AIAnalysis | null; pair: string; currentRate: number | null; initialBalance?: number; initialTarget?: number; onBalanceChange?: (balance: number) => void; initialRiskPercent?: number; initialTradeUnit?: number; onSettingsChange?: (settings: RiskSettings) => void; disabled?: boolean }) {
  const [fields, setFields] = useState({ balance: String(initialBalance), target: String(initialTarget), riskPercent: String(initialRiskPercent), tradeUnit: String(initialTradeUnit) });
  const [positions, setPositions] = useState<Record<string, string>>({});
  const [now, setNow] = useState(0);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const settings: RiskSettings = { balance: readNumber(fields.balance), target: readNumber(fields.target), riskPercent: readNumber(fields.riskPercent), tradeUnit: readNumber(fields.tradeUnit) };
  const budget = allowedLoss(settings.balance, settings.riskPercent);
  const goal = goalProgress(settings.balance, settings.target);
  const losses = drawdown(settings.balance, settings.riskPercent);
  const planResult = now ? analysisPlan(analysis, pair, now) : { data: null, error: "分析状態を確認中…" };
  const plan = planResult.data;
  const sizeResult = plan ? positionSize(settings.balance, settings.riskPercent, plan.entry, plan.scenario.stopLoss, settings.tradeUnit) : null;
  const size = sizeResult?.data;
  const inputPosition = positions[pair] ?? "";
  const actual = size && plan ? positionRisk(readNumber(inputPosition), size, settings.balance, plan.entry, plan.scenario.stopLoss, settings.tradeUnit) : null;
  function changeField(key: keyof typeof fields, value: string) {
    const next = { ...fields, [key]: value }; setFields(next);
    if (key === "balance") onBalanceChange?.(readNumber(value));
    onSettingsChange?.({ balance: readNumber(next.balance), target: readNumber(next.target), riskPercent: readNumber(next.riskPercent), tradeUnit: readNumber(next.tradeUnit) });
  }
  function field(key: keyof typeof fields, label: string, min: string, max: string, step: string) {
    return <label>{label}<input type="number" inputMode="decimal" min={min} max={max} step={step} value={fields[key]} disabled={disabled} onChange={event => changeField(key, event.target.value)} /></label>;
  }
  return <Panel title="資金・リスク管理" eyebrow="CAPITAL & POSITION LIMIT" className="risk-panel">
    <p className="material-intro">{pair} · 設定した許容損失額から、条件付きプランの最大数量を計算します。</p>
    <div className="risk-settings">
      {field("balance", "現在資産（円）", "0", "1000000000000", "0.01")}
      {field("target", "目標資産（円）", "0.01", "1000000000000", "0.01")}
      {field("riskPercent", "許容リスク率（%）", "0.0001", onSettingsChange ? "10" : "100", "0.1")}
      <label>取引単位<select value={fields.tradeUnit} disabled={disabled} onChange={event => changeField("tradeUnit", event.target.value)}>{!["1", "100", "1000"].includes(fields.tradeUnit) && <option value={fields.tradeUnit}>{fields.tradeUnit}通貨</option>}<option value="1">1通貨</option><option value="100">100通貨</option><option value="1000">1,000通貨</option></select></label>
    </div>
    <p className="footnote">{onSettingsChange ? "変更は入力後にクラウドへ保存します。保存状態を確認してください。" : "設定はこの画面を開いている間だけ保持します。"}目標資産は最大数量に影響しません。</p>
    {budget === null && <p className="negative" role="status">現在資産は0〜1兆円、許容リスク率は0より大きく{onSettingsChange ? "10" : "100"}%以下の数値で入力してください。</p>}
    <div className="risk-highlights" aria-live="polite">
      <div><span>最大許容損失</span><strong data-testid="risk-budget">{money(budget)}</strong><small>現在資産 × 許容リスク率（1銭未満切り捨て）</small></div>
      <div><span>最大ポジションサイズ</span><strong data-testid="risk-max-units">{size ? `${number(size.maxUnits)}通貨` : "未算出"}</strong><small>計算上の上限 · 条件付きプランがある場合のみ</small></div>
    </div>
    {(planResult.error || sizeResult?.error) && <p className="footnote neutral" role="status">{planResult.error || sizeResult?.error}</p>}
    {size?.maxUnits === 0 && <p className="footnote neutral">許容損失額内では最小取引単位を持てません。数量は0通貨です。</p>}
    <p className="footnote">損切り価格で約定する前提の計算です。手数料・スプレッド・スリッページ・窓開けにより、実際の損失は許容額を超えることがあります。必要証拠金による上限は含みません。</p>
    <div className="risk-detail-grid">
      <section className="risk-card"><h3>条件付きトレードプラン</h3><dl className="metrics">
        <div><dt>現在レート</dt><dd>{price(currentRate)}</dd></div>
        <div><dt>Entry帯</dt><dd className="entry-zone">{plan ? `${price(plan.scenario.entryZone.min)} ～ ${price(plan.scenario.entryZone.max)}` : "未算出"}</dd></div>
        <div><dt>数量計算のEntry</dt><dd>{price(plan?.entry)}</dd></div>
        <div><dt>Stop Loss</dt><dd className="negative">{price(plan?.scenario.stopLoss)}</dd></div>
        <div><dt>Take Profit 1 / 2</dt><dd className="entry-zone">{plan ? `${price(plan.scenario.takeProfit1)} / ${price(plan.scenario.takeProfit2)}` : "未算出"}</dd></div>
        <div><dt>損切り幅 / 利確①幅</dt><dd className="entry-zone">{plan ? `${price(plan.stopWidth)} / ${price(plan.profitWidth)} 円` : "未算出"}</dd></div>
        <div><dt>Risk / Reward</dt><dd>{plan ? `1 : ${plan.riskReward.toFixed(2)}` : "未算出"}</dd></div>
        <div><dt>最大数量の想定損失</dt><dd>{money(size?.estimatedLoss)}</dd></div>
      </dl><p className="footnote">{plan?.scenario.condition ?? "Entry・損切り・利確の価格を補完せず、分析結果を待ちます。"}</p>{plan && <p className="footnote">{plan.scenario.invalidation} 数量計算にはEntry帯の不利な端を使用します。</p>}
      {size && <p className="footnote">最大{number(size.maxUnits)}通貨では、損切りに到達した場合、約{money(size.estimatedLoss)}の損失を想定しています。</p>}</section>
      <section className="risk-card"><h3>入力ポジションの確認</h3><label className="risk-position">ポジション数量（通貨）<input type="number" inputMode="numeric" min="0" step={settings.tradeUnit} value={inputPosition} placeholder="数量を入力" disabled={!size} onChange={event => setPositions(previous => ({ ...previous, [pair]: event.target.value }))} /></label>
      <div aria-live="polite">{actual ? <><dl className="metrics"><div><dt>想定損失額</dt><dd>{money(actual.estimatedLoss)}</dd></div><div><dt>資産に対するリスク率</dt><dd>{Number.isFinite(actual.actualRiskPercent) ? `${number(actual.actualRiskPercent)}%` : "算出不可（資産0円）"}</dd></div></dl>{actual.exceedsRisk && <p className="negative risk-warning" role="alert">設定した許容リスクを超えています</p>}{!actual.validUnit && <p className="neutral footnote">選択した取引単位の整数倍で入力してください。</p>}<p className="footnote">このポジションでは損切りに到達した場合、約{money(actual.estimatedLoss)}の損失を想定しています。</p></> : <p className="footnote">{size && inputPosition ? "数量は0以上の計算可能な整数で入力してください。" : "有効なプランと数量がある場合に比較します。"}</p>}</div>
      <h3 className="risk-subheading">目標達成状況</h3>{goal ? <><div className="capital-summary"><div><span>現在資産</span><strong>{money(settings.balance)}</strong></div><div className="target"><span>目標資産</span><strong>{money(settings.target)}</strong></div></div><progress className="capital-progress" value={goal.barPercent} max="100" aria-label="目標達成率" /><dl className="metrics"><div><dt>達成率</dt><dd>{number(goal.percent)}%</dd></div><div><dt>残り金額</dt><dd>{money(goal.remaining)}</dd></div></dl></> : <p className="footnote neutral">目標は0.01円以上1兆円以下の数値で入力してください。</p>}</section>
    </div>
    <section className="risk-drawdown"><h3>連敗シミュレーション</h3><p className="footnote">各トレードで、その時点の資産 × 許容リスク率を失う複利計算です。将来の損益予測ではありません。</p><div className="drawdown-grid">{losses.map(point => <article key={point.losses}><span>{point.losses === 1 ? "1敗" : `${point.losses}連敗`}</span><strong>{money(Math.round(point.balance))}</strong><progress value={point.remainingPercent} max="100" aria-label={`${point.losses}敗後の残存資産率`} /><small>減少額 約{money(Math.round(point.loss))}</small></article>)}</div>{!losses.length && <p className="footnote">資産とリスク率を入力すると表示します。</p>}</section>
  </Panel>;
}
