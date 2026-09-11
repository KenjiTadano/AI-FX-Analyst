"use client";

import { useEffect, useState } from "react";
import type { DataResource, FundamentalData, Importance, NewsItem } from "@/lib/fundamental/types";
import { EconomicCalendar } from "./economic-calendar";
import { UsMacroPanel } from "./us-macro";
import { Panel } from "./panels";

const importanceLabels: Record<Importance, string> = { high: "高", medium: "中", low: "低" };
const importanceOrder = { high: 0, medium: 1, low: 2 };
const dateTime = (value: string) => new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));


export function useFundamentals(symbol: string) {
  const [result, setResult] = useState<{ symbol: string; data: FundamentalData | null; error: string | null } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      if (document.visibilityState === "hidden") { timer = setTimeout(refresh, 60_000); return; }
      try {
        const response = await fetch(`/api/fundamental?symbol=${encodeURIComponent(symbol)}`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(25_000)]), cache: "no-store" });
        if (!response.ok) throw new Error("request_failed");
        const data: FundamentalData = await response.json();
        if (data.symbol !== symbol || data.schemaVersion !== 1) throw new Error("invalid_response");
        if (!controller.signal.aborted) setResult({ symbol, data, error: null });
      } catch {
        if (!controller.signal.aborted) setResult({ symbol, data: null, error: "現在マーケット材料を取得できません。自動再試行します。" });
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(refresh, 60_000);
      }
    }
    void refresh();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [symbol]);
  return result?.symbol === symbol ? result : null;
}

function ResourceNote({ resource, label, error }: { resource?: DataResource<unknown>; label: string; error?: string | null }) {
  if (error) return <p className="material-empty" role="status">{error}</p>;
  if (!resource) return <p className="material-empty" role="status">取得中…</p>;
  if (resource.status === "error") return <p className="material-empty negative" role="status">現在{label}を取得できません。<span>{resource.error?.message}</span></p>;
  if (resource.status === "unavailable") return <p className="material-empty" role="status">{label}は未取得です。<span>{resource.error?.message}</span></p>;
  if (resource.status === "empty") return <p className="material-empty">取得範囲内に該当する{label}はありません。</p>;
  return null;
}
function ResourceFooter({ resource }: { resource?: DataResource<unknown> }) {
  if (!resource) return null;
  return <div className="material-source"><p>{resource.provider === "Finnhub" ? "Finnhub" : ""}{resource.fetchedAt ? ` · 取得 ${dateTime(resource.fetchedAt)} JST` : ""}</p>{resource.warnings.map(warning => <p key={warning}>{warning}</p>)}</div>;
}
function ImportanceBadge({ value }: { value: Importance }) {
  return <span className={`badge ${value === "high" ? "neutral" : ""}`}>重要度：{importanceLabels[value]}</span>;
}
function NewsCard({ item }: { item: NewsItem }) {
  return <li className="material-item"><div className="row"><span className="currency-tags">{item.currencies.join(" / ")}</span><ImportanceBadge value={item.importance} /></div><h4><a href={item.url} target="_blank" rel="noopener noreferrer">{item.title}<span aria-hidden="true"> ↗</span></a></h4><p className="material-source">{item.source} · {dateTime(item.publishedAt)} JST</p><details><summary>概要・関連性を見る</summary><p>{item.summary ?? "配信元の概要はありません。"}</p><p className="footnote">{item.reason}</p></details></li>;
}
export function FundamentalPanel({ symbol, result }: { symbol: string; result: ReturnType<typeof useFundamentals> }) {
  const [now, setNow] = useState(0);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const data = result?.data;
  const news = [...(data?.news.data ?? [])].sort((a, b) => importanceOrder[a.importance] - importanceOrder[b.importance] || b.publishedAt.localeCompare(a.publishedAt));
  return <Panel title="マーケット材料" eyebrow="FUNDAMENTALS / NEWS & EVENTS" className="fundamental-panel">
    <p className="material-intro">{symbol} に関連するニュースと発表予定。売買方向はまだ評価していません。</p>
    <div className="material-grid">
      <section className="material-category" aria-label="重要ニュース"><div className="material-heading"><span className="reason-number">01</span><h3>重要ニュース</h3><span className="mini-label">NEWS</span></div><ResourceNote resource={data?.news} label="ニュース" error={result?.error} /><ul>{news.slice(0, 3).map(item => <NewsCard key={item.id} item={item} />)}</ul>{news.length > 3 && <details className="material-more"><summary>ほか{news.length - 3}件を見る</summary><ul>{news.slice(3).map(item => <NewsCard key={item.id} item={item} />)}</ul></details>}<ResourceFooter resource={data?.news} /><p className="footnote">直近7日 · 重要度は語句による表示優先度です。</p></section>
      <EconomicCalendar resource={data?.calendar} now={now} error={result?.error} />
      <UsMacroPanel resource={data?.macroeconomic} symbol={symbol} error={result?.error} />
      <section className="material-category" aria-label="中央銀行"><div className="material-heading"><span className="reason-number">03</span><h3>中央銀行</h3><span className="mini-label">POLICY</span></div>{!data?.centralBanks.data && <ResourceNote resource={data?.centralBanks} label="中央銀行情報" error={result?.error} />}{data?.centralBanks.data?.map(bank => <article className="material-item" key={bank.currency}><div className="row"><h4>{bank.abbreviation}<small> / {bank.currency}</small></h4><span className="badge">{bank.policyRate.value ? `${bank.policyRate.value.lower}${bank.policyRate.value.upper !== null ? `–${bank.policyRate.value.upper}` : ""}%` : "金利未取得"}</span></div><p className="material-source">{bank.name}</p><dl className="bank-details"><div><dt>次回会合候補</dt><dd>{bank.nextMeeting.value ? `${dateTime(bank.nextMeeting.value)} JST` : "未取得"}</dd></div><div><dt>政策方向</dt><dd>{bank.policyDirection.value ? { hike: "利上げ", cut: "利下げ", hold: "据え置き" }[bank.policyDirection.value] : "未評価"}</dd></div></dl>{bank.relatedNewsIds.length > 0 && <details><summary>関連ニュース {bank.relatedNewsIds.length}件</summary><ul>{bank.relatedNewsIds.map(id => { const item = data?.news.data?.find(news => news.id === id); return item ? <li key={id}><a href={item.url} target="_blank" rel="noopener noreferrer">{item.title} ↗</a></li> : null; })}</ul></details>}</article>)}<ResourceFooter resource={data?.centralBanks} /></section>
      <section className="material-category" aria-label="市場環境"><div className="material-heading"><span className="reason-number">04</span><h3>市場環境</h3><span className="mini-label">SENTIMENT</span></div>{!data?.sentiment.data ? <ResourceNote resource={data?.sentiment} label="市場環境" error={result?.error} /> : <><div className="environment-value">{data.sentiment.data.market.value ? { "risk-on": "Risk On", neutral: "Neutral", "risk-off": "Risk Off" }[data.sentiment.data.market.value] : "未取得"}</div><p className="footnote">{data.sentiment.data.market.reason}</p><dl className="bank-details">{data.sentiment.data.currencies.map(item => <div key={item.currency}><dt>{item.currency}</dt><dd>{item.sentiment.value ? { bullish: "強気", neutral: "中立", bearish: "弱気" }[item.sentiment.value] : "未評価"}</dd></div>)}</dl><p className="footnote">取得できない情報を「中立」や売買シグナルで補完しません。</p></>}</section>
    </div>
  </Panel>;
}
