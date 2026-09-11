"use client";
import { useEffect, useState } from "react";
import type { DataResource, EconomicEvent } from "@/lib/fundamental/types";
import { eventStatus } from "@/lib/fundamental/normalize";
import { calendarKnown, countdown, formatJst, nextHigh, riskState } from "@/lib/economic-calendar/risk-window";
import { surprise } from "@/lib/economic-calendar/normalize";
const flags = { USD: "🇺🇸", JPY: "🇯🇵", EUR: "🇪🇺", GBP: "🇬🇧" };
const value = (v: EconomicEvent["actual"], unit: string | null) => v === null ? "未取得" : typeof v === "string" ? v : `${v.toLocaleString("ja-JP")}${unit ? ` ${unit}` : ""}`;
export function NextEventBanner({ resource }: { resource?: DataResource<EconomicEvent[]> }) {
  const [now, setNow] = useState(0);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  return <CalendarSummary resource={resource} now={now} />;
}
export function CalendarSummary({ resource, now }: { resource?: DataResource<EconomicEvent[]>; now: number }) {
  if (!now) return <p className="footnote">次の重要イベントを確認中…</p>;
  if (!calendarKnown(resource, now)) return <p className="footnote">経済指標データ未取得・期限切れ — 重要イベントの有無は不明です。</p>;
  const events = resource!.data!, risk = riskState(events, now), next = nextHigh(events, now);
  return <div className="calendar-summary"><strong>次の重要イベント</strong>{next ? <p>{flags[next.currency]} {next.name} · {formatJst(next.scheduledAt!)} · {countdown(next.scheduledAt!, now)}</p> : <p>取得範囲内に時刻が確定した次のhighイベントはありません。</p>}{(risk.imminent || risk.uncertainTime) && <p className="neutral">{risk.reasons.join(" ")}</p>}</div>;
}
export function EconomicCalendar({ resource, now, error }: { resource?: DataResource<EconomicEvent[]>; now: number; error?: string | null }) {
  const known = !!now && calendarKnown(resource, now);
  const events = known ? [...resource!.data!].sort((a, b) => {
    const rank = (e: EconomicEvent) => riskState([e], now).imminent ? 0 : e.scheduledAt && Date.parse(e.scheduledAt) > now ? 1 : !e.scheduledAt ? 2 : 3;
    return rank(a) - rank(b) || (a.scheduledAt ?? "~").localeCompare(b.scheduledAt ?? "~");
  }) : [];
  return <section className="material-category" aria-label="経済指標"><div className="material-heading"><span className="reason-number">02</span><h3>重要経済指標</h3><span className="mini-label">CALENDAR</span></div>
    {error || resource?.status === "error" ? <p role="status" className="negative">現在、経済指標データを取得できません。{resource?.error?.message ?? error}</p> : !resource ? <p role="status">取得中…</p> : !known ? <p role="status">経済指標データ未取得・期限切れ。{resource.error?.message} 重要指標の有無は不明です。</p> : !events.length ? <p>取得範囲内に対象通貨の指標はありません。</p> : null}
    <ul>{events.slice(0, 5).map(event => <CalendarCard key={event.id} event={event} now={now} />)}</ul>
    {events.length > 5 && <details className="material-more"><summary>ほか{events.length - 5}件を見る</summary><ul>{events.slice(5).map(event => <CalendarCard key={event.id} event={event} now={now} />)}</ul></details>}
    <p className="material-source">{resource?.provider}{resource?.fetchedAt ? ` · 取得 ${formatJst(resource.fetchedAt)}` : ""}</p>{resource?.warnings.map(w => <p className="footnote" key={w}>{w}</p>)}
    <p className="footnote">前日〜7日先 · highは30分前〜15分後、mediumは15分前〜5分後に待機。配信の遅延・変更があります。</p>
  </section>;
}
function CalendarCard({ event, now }: { event: EconomicEvent; now: number }) {
  const status = eventStatus(event, now), diff = surprise(event), risk = riskState([event], now);
  return <li className="material-item"><div className="row"><span>{flags[event.currency]} {event.currency} / {event.country}</span><span className="badge">重要度：{{ high: "高 ★★★★★", medium: "中 ★★★", low: "低 ★" }[event.importance]}</span></div><h4>{event.name}</h4>
    <p className="event-time">{event.scheduledAt ? formatJst(event.scheduledAt) : "発表日時未確認（推定時刻を含む）"}</p>{event.scheduledAt && <p className="footnote">{countdown(event.scheduledAt, now)}</p>}
    <p className="footnote">{{ upcoming: "発表前", released: "発表済み", awaiting_actual: "予定時刻経過・実績未取得", unknown: "時刻未確認" }[status]}{event.isKeyIndicator ? " · 主要指標" : ""}</p>
    <dl className="event-values"><div><dt>前回</dt><dd>{value(event.previous, event.unit)}</dd></div><div><dt>市場予想</dt><dd>{value(event.forecast, event.unit)}</dd></div><div><dt>実績</dt><dd>{event.actual === null && status === "upcoming" ? "未発表" : value(event.actual, event.unit)}</dd></div></dl>
    {diff && <p>サプライズ：{diff.difference > 0 ? "+" : ""}{diff.difference} {diff.unit}（市場予想{diff.relation === "equal" ? "と" : "を"}{diff.relation === "above" ? "上回る" : diff.relation === "below" ? "下回る" : "同水準"}）</p>}
    {risk.imminent && <p className="neutral footnote">発表前後のリスク時間帯：新規エントリーは待機</p>}
    <p className="footnote">{event.actual === null ? "市場予想は確定値ではありません。発表後の結果と市場反応を確認してください。" : "結果と市場予想の差だけで、為替の方向を断定しません。"}</p>
    {event.url && <a className="footnote" href={event.url} target="_blank" rel="noopener noreferrer">情報元 ↗</a>}
  </li>;
}
