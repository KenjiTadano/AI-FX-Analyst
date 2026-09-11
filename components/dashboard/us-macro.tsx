"use client";

import type { DataResource, EconomicIndicatorValue } from "@/lib/fundamental/types";

function formatValue(value: number | null, unit: string | null): string {
  if (value === null || !Number.isFinite(value)) return "未取得";
  const rounded = Math.abs(value) >= 100 ? value.toLocaleString("ja-JP", { maximumFractionDigits: 1 }) : value.toLocaleString("ja-JP", { maximumFractionDigits: 2, minimumFractionDigits: 0 });
  const signed = value > 0 && unit?.includes("前月差") ? `+${rounded}` : rounded;
  return unit ? `${signed} ${unit}` : signed;
}

function periodLabel(date: string | null, frequency: string | null): string {
  if (!date) return "観測日未取得";
  if (frequency === "Quarterly") {
    const month = Number(date.slice(5, 7));
    const quarter = Math.floor((month - 1) / 3) + 1;
    return `${date.slice(0, 4)} Q${quarter}（観測日 ${date}）`;
  }
  return `対象期間 ${date.slice(0, 7)}（観測日 ${date}）`;
}

function MacroCard({ item }: { item: EconomicIndicatorValue }) {
  return <li className="material-item">
    <div className="row"><h4>{item.shortName ?? item.name}</h4><span className="badge">FRED実績</span></div>
    <p className="material-source">{item.name}</p>
    <dl className="event-values">
      <div><dt>最新</dt><dd>{formatValue(item.value, item.unit)}</dd></div>
      <div><dt>前回</dt><dd>{formatValue(item.previousValue, item.unit)}</dd></div>
      <div><dt>頻度</dt><dd>{item.frequency ?? "未取得"}</dd></div>
    </dl>
    <p className="footnote">{periodLabel(item.observationDate, item.frequency)}</p>
    {item.stale && <p className="neutral footnote">観測日が古めです。最新速報として扱わないでください。</p>}
    {item.sourceUrl && <a className="footnote" href={item.sourceUrl} target="_blank" rel="noopener noreferrer">FRED series ↗</a>}
  </li>;
}

export function UsMacroPanel({ resource, symbol, error }: { resource?: DataResource<EconomicIndicatorValue[]>; symbol: string; error?: string | null }) {
  const items = resource?.data ?? [];
  const emphasizeUsd = symbol.startsWith("USD/");
  return <section className={`material-category${emphasizeUsd ? " macro-emphasis" : ""}`} aria-label="米国マクロ">
    <div className="material-heading"><span className="reason-number">05</span><h3>米国マクロ</h3><span className="mini-label">FRED</span></div>
    <p className="footnote">発表済みの米国マクロ実績です。市場予想・速報・次回発表予定ではありません。{emphasizeUsd ? "" : " USD要因として共通参照します。"}</p>
    {error ? <p className="material-empty negative" role="status">{error}</p>
      : !resource ? <p className="material-empty" role="status">取得中…</p>
      : resource.status === "error" || resource.status === "unavailable" ? <p className="material-empty negative" role="status">米国マクロデータを取得できません。<span>{resource.error?.message}</span></p>
      : !items.length ? <p className="material-empty" role="status">米国マクロデータを取得できません。</p>
      : null}
    <ul>{items.slice(0, emphasizeUsd ? 8 : 4).map(item => <MacroCard key={item.id} item={item} />)}</ul>
    {!emphasizeUsd && items.length > 4 && <details className="material-more"><summary>ほか{items.length - 4}件を見る</summary><ul>{items.slice(4).map(item => <MacroCard key={item.id} item={item} />)}</ul></details>}
    <p className="material-source">FRED{resource?.fetchedAt ? ` · 取得 ${new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(resource.fetchedAt))} JST` : ""}</p>
    {resource?.warnings.map(warning => <p className="footnote" key={warning}>{warning}</p>)}
    <p className="footnote">指数そのもの・前年比・前月差を混同しません。NFPは総雇用者数ではなく前月差です。FFは実効金利であり政策目標レンジではありません。</p>
  </section>;
}
