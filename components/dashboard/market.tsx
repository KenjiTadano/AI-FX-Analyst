"use client";

import { useEffect, useState } from "react";
import { timeframes, type MarketData } from "@/lib/market/types";
import { Panel } from "./panels";

export function useMarket(symbol: string) {
  const [result, setResult] = useState<{ symbol: string; data: MarketData | null; error: string | null } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      if (document.visibilityState === "hidden") { timer = setTimeout(refresh, 60000); return; }
      try {
        const response = await fetch(`/api/market?symbol=${encodeURIComponent(symbol)}`, { signal: controller.signal });
        if (!response.ok) throw new Error("取得に失敗しました。");
        const data: MarketData = await response.json();
        if (!controller.signal.aborted) setResult({ symbol, data, error: null });
      } catch {
        if (!controller.signal.aborted) setResult({ symbol, data: null, error: "市場データを取得できませんでした。自動再試行します。" });
      } finally { if (!controller.signal.aborted) timer = setTimeout(refresh, 60000); }
    }
    void refresh();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [symbol]);
  return result?.symbol === symbol ? result : null;
}

export function TechnicalPanel({ data, error }: { data: MarketData | null; error: string | null }) {
  const format = (value: number | null) => value === null ? "—" : value.toFixed(3);
  return <Panel title="テクニカル分析" eyebrow="TWELVE DATA / CLOSED CANDLES" className="reasons-panel">
    <div className="technical-grid">{timeframes.map(frame => {
      const resource = data?.timeframes[frame];
      const technical = resource?.data;
      const indicators = technical?.indicators;
      return <article key={frame} className="technical-frame"><h3>{frame === "15m" ? "15分足" : frame === "1h" ? "1時間足" : "4時間足"} <span className={`badge ${indicators?.trend === "bullish" ? "positive" : indicators?.trend === "bearish" ? "negative" : "neutral"}`}>{indicators ? { bullish: "上昇", bearish: "下降", neutral: "中立" }[indicators.trend] : "—"}</span></h3>
        {(error || resource?.error) && <p role="status" className="footnote negative">{error || resource?.error}{resource?.stale ? " 最終取得データを表示中です。" : ""}</p>}
        {!resource && !error && <p className="footnote">取得中…</p>}
        <dl className="metrics">{([ ["SMA20", indicators?.sma20], ["SMA75", indicators?.sma75], ["SMA200", indicators?.sma200], ["RSI14", indicators?.rsi14], ["ATR14", indicators?.atr14], ["直近高値（20本）", indicators?.recentHigh], ["直近安値（20本）", indicators?.recentLow] ] as const).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{format(value ?? null)}</dd></div>)}</dl>
        <p className="footnote">最終確定足の開始: {technical?.lastClosedAt ? new Date(technical.lastClosedAt).toLocaleString("ja-JP") : "—"}</p>
      </article>;
    })}</div>
    <p className="footnote">確定足のみで計算。終値 &gt; SMA20 &gt; SMA75 &gt; SMA200で上昇、逆順で下降、それ以外は中立。必要本数に満たない指標は「—」。価格指標はJPY、RSIは0〜100。</p>
  </Panel>;
}
