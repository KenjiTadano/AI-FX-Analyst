import type { Quote, Trade } from "@/lib/trades/types";
import { unrealizedPnl } from "@/lib/trades/calculations";
import { alignmentLabels, computeAiAlignment, isRichSnapshot } from "@/lib/trades/snapshot";
import { actionGuidanceLabel, directionBiasLabel, signalLabels as decisionLabels } from "@/lib/ai/decision-ui";
import { dateTime, money, signalLabels, tone } from "./format";

export function TradeList({ trades, quote, now, onEdit, onClose, onDelete }: { trades: Trade[]; quote: Quote | null; now: number; onEdit?: (t: Trade) => void; onClose?: (t: Trade) => void; onDelete?: (t: Trade) => void }) {
  if (!trades.length) return <p className="material-empty">該当する取引はありません。</p>;
  return <div className="trade-list">{trades.map(trade => {
    const snapshot = trade.analysisSnapshot;
    const floating = unrealizedPnl(trade, quote, now);
    const gain = trade.status === "closed" ? trade.realizedPnl : floating;
    const alignment = computeAiAlignment(trade.side, snapshot, trade.pair);
    return <article className="trade-record" key={trade.id}>
      <div className="row"><h3>{trade.pair} <span className="badge">{trade.side === "long" ? "BUY / Long" : "SELL / Short"}</span></h3><span className="badge">{trade.status === "open" ? "保有中" : "決済済み"}</span></div>
      <p className="footnote">{trade.quantity.toLocaleString()}通貨 · Entry {trade.entryPrice.toLocaleString("ja-JP", { maximumFractionDigits: 10 })}{trade.status === "closed" ? ` → Exit ${trade.exitPrice!.toLocaleString("ja-JP", { maximumFractionDigits: 10 })}` : ` · Stop ${trade.stopLoss ?? "未設定"} · TP ${trade.takeProfit ?? "未設定"}`}</p>
      <p className={`trade-pnl ${gain === null ? "muted" : tone(gain)}`}>{trade.status === "open" ? "含み損益 " : "実現損益 "}{gain === null ? "現在レート未取得" : money(gain, true)}</p>
      <p className="footnote">Entry日時 {dateTime(trade.openedAt)}{trade.closedAt && <> / 決済日時 {dateTime(trade.closedAt)}</>}</p>
      <p className="footnote">登録時AI: {snapshot ? `${signalLabels[snapshot.signal]} / ${snapshot.score}` : "未記録"} · <span className="badge">{alignmentLabels[alignment]}</span></p>
      {snapshot ? <details>
        <summary>エントリー時AI分析</summary>
        <div className="snapshot-detail">
          <p>AI判断：{decisionLabels[snapshot.signal]}</p>
          {isRichSnapshot(snapshot) && <>
            <p>方向：{directionBiasLabel(snapshot.directionSignal)}</p>
            <p>Action：{actionGuidanceLabel(snapshot.action, snapshot.signal)}（{snapshot.action}）</p>
          </>}
          <p>確信度：{snapshot.confidence}% · 充足率：{snapshot.dataQualityScore}%</p>
          <p>要約：{snapshot.summary}</p>
          <p>分析時刻：{dateTime(snapshot.analyzedAt)} / 保存時刻：{dateTime(snapshot.capturedAt)}</p>
          <p>AI判断との一致：{alignmentLabels[alignment]}</p>
          {isRichSnapshot(snapshot) && <>
            <p>使用データ充足度：{snapshot.dataQuality?.score ?? snapshot.dataQualityScore}%</p>
            {snapshot.isFallback && <p className="neutral">AI一部利用不可時の暫定分析</p>}
            {snapshot.chartEvidence && <p>Chart Evidence：{snapshot.chartEvidence.used ? "使用" : "未使用"} · {snapshot.chartEvidence.timeframe ?? "時間足未検出"} · {snapshot.chartEvidence.trend} · 品質 {snapshot.chartEvidence.qualityScore}</p>}
            {snapshot.chartAnalysis && <details>
              <summary>チャート解析スナップショット</summary>
              <p>時間足：{snapshot.chartAnalysis.timeframe ?? "未検出"}</p>
              <p>トレンド：{snapshot.chartAnalysis.trend?.direction ?? "—"}（{snapshot.chartAnalysis.trend?.confidence ?? "—"}%）</p>
              <p>品質：{snapshot.chartAnalysis.dataQuality?.score ?? "—"}</p>
              <p>Support：{snapshot.chartAnalysis.supportLevels?.length ? snapshot.chartAnalysis.supportLevels.join(", ") : "未取得"}</p>
              <p>Resistance：{snapshot.chartAnalysis.resistanceLevels?.length ? snapshot.chartAnalysis.resistanceLevels.join(", ") : "未取得"}</p>
              <p className="footnote">チャート画像そのものは保存していません。</p>
            </details>}
          </>}
          {snapshot.pair !== trade.pair && <p className="neutral">元の分析は{snapshot.pair}です。通貨変更後の成績はAI未記録扱いです。</p>}
          <p className="footnote">この分析は登録時の表示内容です。後からの再分析では変わりません。</p>
        </div>
      </details> : <p className="footnote">エントリー時AI分析：保存なし</p>}
      {trade.notes && <p className="trade-notes">{trade.notes}</p>}
      {(onEdit || onClose || onDelete) && <div className="journal-actions">{trade.status === "open" && onClose && <button onClick={() => onClose(trade)}>決済を記録</button>}{onEdit && <button onClick={() => onEdit(trade)}>編集</button>}{onDelete && <button className="negative" onClick={() => onDelete(trade)}>削除</button>}</div>}
    </article>;
  })}</div>;
}
