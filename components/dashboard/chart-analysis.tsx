"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { ChartAnalysisResponse, ChartImageAnalysis } from "@/lib/chart-analysis/types";
import { canAttachToPairAnalysis, qualityLabel } from "@/lib/chart-analysis/normalize";
import { chartAttachBlockMessages, chartAttachBlockReason } from "@/lib/chart-analysis/sanitize";
import { Panel } from "./panels";

const pairs = ["USD/JPY", "EUR/JPY", "GBP/JPY"] as const;
const trendLabels: Record<ChartImageAnalysis["trend"]["direction"], string> = {
  strong_up: "強い上昇",
  up: "上昇",
  sideways: "レンジ",
  down: "下降",
  strong_down: "強い下降",
  unknown: "不明",
};

type PreparedImage = { file: File; previewUrl: string; fingerprint: string };

async function prepareImage(file: File): Promise<PreparedImage> {
  const bitmap = await createImageBitmap(file);
  const maxEdge = 1600;
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("canvas_unavailable");
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(value => value ? resolve(value) : reject(new Error("encode_failed")), file.type === "image/png" ? "image/png" : "image/jpeg", 0.88);
  });
  const prepared = new File([blob], file.name.replace(/\.\w+$/, file.type === "image/png" ? ".png" : ".jpg"), { type: blob.type });
  const fingerprint = `${file.name}:${file.size}:${file.lastModified}:${prepared.size}`;
  return { file: prepared, previewUrl: URL.createObjectURL(prepared), fingerprint };
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function StructureList({ structure }: { structure: ChartImageAnalysis["structure"] }) {
  const items = [
    ["Higher High", structure.higherHigh],
    ["Higher Low", structure.higherLow],
    ["Lower High", structure.lowerHigh],
    ["Lower Low", structure.lowerLow],
  ] as const;
  const known = items.filter(([, value]) => value !== null);
  if (!known.length) return <p className="footnote">明確に読めるMarket Structureはありません。</p>;
  return <ul className="chart-level-list">{known.map(([label, value]) => <li key={label}>{label}: {value ? "あり" : "なし"}</li>)}</ul>;
}

export function ChartAnalysisPanel({
  pair,
  onPairChange,
  includedChart,
  onIncludeChart,
  onExcludeChart,
}: {
  pair: string;
  onPairChange: (pair: string) => void;
  includedChart: ChartImageAnalysis | null;
  onIncludeChart: (analysis: ChartImageAnalysis) => void;
  onExcludeChart: () => void;
}) {
  const inputId = useId();
  const [image, setImage] = useState<PreparedImage | null>(null);
  const [sourceName, setSourceName] = useState<string | null>(null);
  const [sourceSize, setSourceSize] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<ChartImageAnalysis | null>(null);
  const cacheRef = useRef<Map<string, ChartImageAnalysis>>(new Map());
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => {
    abortRef.current?.abort();
    if (image?.previewUrl) URL.revokeObjectURL(image.previewUrl);
  }, [image?.previewUrl]);

  function resetAnalysisState() {
    setAnalysis(null);
    onExcludeChart();
  }

  async function onFileChange(fileList: FileList | null) {
    const file = fileList?.[0];
    setError(null);
    resetAnalysisState();
    if (image?.previewUrl) URL.revokeObjectURL(image.previewUrl);
    setImage(null);
    setSourceName(null);
    setSourceSize(null);
    if (!file) return;
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
      setError("対応形式は PNG / JPEG / WebP のみです。");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setError("画像サイズは5MB以下にしてください。");
      return;
    }
    try {
      const prepared = await prepareImage(file);
      setSourceName(file.name);
      setSourceSize(file.size);
      setImage(prepared);
      const cached = cacheRef.current.get(`${pair}:${prepared.fingerprint}`);
      if (cached) setAnalysis(cached);
    } catch {
      setError("画像の読み込みに失敗しました。別の画像を選んでください。");
    }
  }

  function clearImage() {
    abortRef.current?.abort();
    if (image?.previewUrl) URL.revokeObjectURL(image.previewUrl);
    setImage(null);
    setSourceName(null);
    setSourceSize(null);
    resetAnalysisState();
    setError(null);
    setLoading(false);
  }

  async function analyze() {
    if (!image || loading) return;
    const cacheKey = `${pair}:${image.fingerprint}`;
    const cached = cacheRef.current.get(cacheKey);
    // New parse attempt clears any previously included snapshot.
    onExcludeChart();
    if (cached) { setAnalysis(cached); setError(null); return; }
    setLoading(true);
    setError(null);
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const body = new FormData();
      body.set("pair", pair);
      body.set("image", image.file, image.file.name);
      const response = await fetch("/api/chart-analysis", {
        method: "POST",
        body,
        cache: "no-store",
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]),
      });
      const payload: ChartAnalysisResponse = await response.json();
      if (!payload.ok || !payload.analysis) throw new Error(payload.error?.message ?? "チャート解析に失敗しました。");
      cacheRef.current.set(cacheKey, payload.analysis);
      setAnalysis(payload.analysis);
    } catch (caught) {
      if (controller.signal.aborted) return;
      setError(caught instanceof Error ? caught.message : "チャート解析に失敗しました。");
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }

  const blockReason = analysis ? chartAttachBlockReason(analysis, pair as typeof pairs[number]) : "unavailable";
  const canInclude = !!analysis && canAttachToPairAnalysis(analysis, pair as typeof pairs[number]);
  const isIncluded = !!analysis && !!includedChart
    && includedChart.analyzedAt === analysis.analyzedAt
    && includedChart.pair === analysis.pair;

  return <div className="chart-analysis-layout">
    <Panel title="チャート読取" eyebrow="CHART IMAGE / VISION ASSIST">
      <p className="material-intro">チャート画像は補助的なTechnical Evidenceです。画像だけでは売買判断を確定しません。画像は解析に使用し、このアプリでは保存しません。</p>
      <div className="chart-controls">
        <label htmlFor={`${inputId}-pair`}>通貨ペア</label>
        <select id={`${inputId}-pair`} value={pair} onChange={event => { onPairChange(event.target.value); resetAnalysisState(); }}>
          {pairs.map(item => <option key={item} value={item}>{item}</option>)}
        </select>
        <label htmlFor={`${inputId}-file`}>チャート画像</label>
        <input id={`${inputId}-file`} type="file" accept="image/png,image/jpeg,image/webp" onChange={event => void onFileChange(event.target.files)} disabled={loading} />
      </div>
      {image && <div className="chart-preview-card">
        {/* Local blob preview; next/image is unnecessary for ephemeral object URLs. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={image.previewUrl} alt={`${pair} チャート画像プレビュー`} className="chart-preview-image" />
        <p className="material-source">{sourceName} · {sourceSize != null ? formatSize(sourceSize) : "—"}{image.file.size !== sourceSize ? ` → 送信 ${formatSize(image.file.size)}` : ""}</p>
        <div className="chart-actions">
          <button type="button" className="journal-primary" onClick={() => void analyze()} disabled={loading}>{loading ? "チャートを解析しています…" : "チャートを解析"}</button>
          <button type="button" onClick={clearImage} disabled={loading}>削除 / 選び直す</button>
        </div>
      </div>}
      {!image && <p className="material-empty" role="status">PNG / JPEG / WebP（最大5MB）のチャート画像を選択してください。</p>}
      {error && <p className="material-empty negative" role="alert">{error}</p>}
      {loading && <p className="footnote" role="status" aria-live="polite">チャートを解析しています…</p>}
    </Panel>

    {analysis && <Panel title="チャート解析結果" eyebrow="VISION RESULT / TECHNICAL EVIDENCE">
      {analysis.pairMismatch && <p className="neutral" role="status">選択通貨ペアと画像内の通貨ペアが一致しません。この結果は{analysis.pair}のAI総合判断へ自動統合しません。</p>}
      <dl className="bank-details">
        <div><dt>1. トレンド</dt><dd>{trendLabels[analysis.trend.direction]} · 信頼度 {analysis.trend.confidence}%</dd></div>
        <div><dt>2. 時間足</dt><dd>{analysis.detected.timeframe ?? "未検出"}</dd></div>
        <div><dt>検出ペア</dt><dd>{analysis.detected.pair ?? "未検出"}</dd></div>
        <div><dt>チャート種別</dt><dd>{analysis.detected.chartType ?? "未検出"}</dd></div>
      </dl>
      <p className="footnote">{analysis.trend.reason}</p>
      <h3 className="chart-result-heading">3. Market Structure</h3>
      <StructureList structure={analysis.structure} />
      <h3 className="chart-result-heading">4. Support</h3>
      {analysis.levels.support.length ? <ul className="chart-level-list">{analysis.levels.support.map(level => <li key={`s-${level}`}>{level}</li>)}</ul> : <p className="footnote">明確なSupportはありません。</p>}
      <h3 className="chart-result-heading">5. Resistance</h3>
      {analysis.levels.resistance.length ? <ul className="chart-level-list">{analysis.levels.resistance.map(level => <li key={`r-${level}`}>{level}</li>)}</ul> : <p className="footnote">明確なResistanceはありません。</p>}
      <h3 className="chart-result-heading">6. Pattern</h3>
      {analysis.patterns.length ? <ul className="chart-level-list">{analysis.patterns.map(item => <li key={item.name}><strong>{item.name}</strong>（{item.confidence}%）: {item.description}</li>)}</ul> : <p className="footnote">無理に当てはめたPatternはありません。</p>}
      <h3 className="chart-result-heading">7. Indicator</h3>
      {analysis.indicators.length ? <ul className="chart-level-list">{analysis.indicators.map(item => <li key={item.name}><strong>{item.name}</strong>{item.value != null ? `: ${item.value}` : ""} — {item.interpretation}</li>)}</ul> : <p className="footnote">画像に見えるIndicatorはありません。</p>}
      <h3 className="chart-result-heading">8. AI Observations</h3>
      {analysis.observations.length ? <ul className="chart-level-list">{analysis.observations.map(item => <li key={item}>{item}</li>)}</ul> : <p className="footnote">追加の観察はありません。</p>}
      <h3 className="chart-result-heading">9. Warning</h3>
      {analysis.warnings.length ? <ul className="chart-level-list">{analysis.warnings.map(item => <li key={item}>{item}</li>)}</ul> : <p className="footnote">警告はありません。</p>}
      <h3 className="chart-result-heading">10. Data Quality</h3>
      <p>画像品質: {qualityLabel(analysis.dataQuality.score)}（{analysis.dataQuality.score}）</p>
      <p className="footnote">readable={String(analysis.dataQuality.imageReadable)} · pairDetected={String(analysis.dataQuality.pairDetected)} · timeframeDetected={String(analysis.dataQuality.timeframeDetected)}</p>
      <div className="chart-attach-box">
        <h3 className="chart-result-heading">AI総合分析への統合</h3>
        <p className="footnote">結果を確認したうえで、明示操作した場合のみ総合分析へ含めます。勝手には送りません。</p>
        {isIncluded ? (
          <div className="chart-actions">
            <p className="neutral" role="status">このチャートはAI総合分析の対象に含まれています。分析タブで「AI総合分析を更新」を押してください。</p>
            <button type="button" onClick={onExcludeChart}>チャートを総合分析から外す</button>
          </div>
        ) : (
          <div className="chart-actions">
            <button
              type="button"
              className="journal-primary"
              disabled={!canInclude}
              onClick={() => onIncludeChart(analysis)}
            >
              このチャートをAI総合分析に含める
            </button>
          </div>
        )}
        {!canInclude && blockReason && <p className="material-empty neutral" role="status">{chartAttachBlockMessages[blockReason]}</p>}
      </div>
      <p className="footnote">画像だけではBUY/SELL/WAITを最終決定しません。市場データ・ニュース・指標と合わせて判断してください。</p>
    </Panel>}
  </div>;
}
