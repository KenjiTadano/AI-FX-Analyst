import type { Quote, Trade } from "@/lib/trades/types";
import { unrealizedPnl } from "@/lib/trades/calculations";
import { dateTime, money, signalLabels, tone } from "./format";
export function TradeList({ trades, quote, now, onEdit, onClose, onDelete }: { trades: Trade[]; quote: Quote | null; now: number; onEdit?: (t: Trade) => void; onClose?: (t: Trade) => void; onDelete?: (t: Trade) => void }) {
  if (!trades.length) return <p className="material-empty">該当する取引はありません。</p>;
  return <div className="trade-list">{trades.map(trade => {
    const snapshot = trade.analysisSnapshot;
    const floating = unrealizedPnl(trade, quote, now);
    const gain = trade.status === "closed" ? trade.realizedPnl : floating;
    return <article className="trade-record" key={trade.id}>
      <div className="row"><h3>{trade.pair} <span className="badge">{trade.side === "long" ? "BUY / Long" : "SELL / Short"}</span></h3><span className="badge">{trade.status === "open" ? "保有中" : "決済済み"}</span></div>
      <p className="footnote">{trade.quantity.toLocaleString()}通貨 · Entry {trade.entryPrice.toLocaleString("ja-JP", { maximumFractionDigits: 10 })}{trade.status === "closed" ? ` → Exit ${trade.exitPrice!.toLocaleString("ja-JP", { maximumFractionDigits: 10 })}` : ` · Stop ${trade.stopLoss ?? "未設定"} · TP ${trade.takeProfit ?? "未設定"}`}</p>
      <p className={`trade-pnl ${gain === null ? "muted" : tone(gain)}`}>{trade.status === "open" ? "含み損益 " : "実現損益 "}{gain === null ? "現在レート未取得" : money(gain, true)}</p>
      <p className="footnote">Entry日時 {dateTime(trade.openedAt)}{trade.closedAt && <> / 決済日時 {dateTime(trade.closedAt)}</>}</p>
      <p className="footnote">登録時AI: {snapshot ? `${signalLabels[snapshot.signal]} / ${snapshot.score}` : "未記録"}{snapshot?.signal === "wait" && " · AI分析では待機判断でした"}</p>
      {snapshot && <details><summary>登録時の分析を見る</summary><p>{snapshot.summary}</p><p>分析 {dateTime(snapshot.analyzedAt)} / 取得 {dateTime(snapshot.capturedAt)}</p><p>確信度 {snapshot.confidence}% · 充足率 {snapshot.dataQualityScore}% · {snapshot.aiStatus === "available" ? "AI統合済み" : "AI未取得・テクニカルのみ"}</p>{snapshot.pair !== trade.pair && <p className="neutral">元の分析は{snapshot.pair}です。通貨変更後の成績はAI未記録扱いです。</p>}{Date.parse(snapshot.capturedAt) >= Date.parse(snapshot.expiresAt) && <p className="neutral">登録時点で分析の有効期限を過ぎていました。</p>}<p>この分析は登録時の表示内容です。過去の取引時点の分析を復元したものではありません。</p></details>}
      {trade.notes && <p className="trade-notes">{trade.notes}</p>}
      {(onEdit || onClose || onDelete) && <div className="journal-actions">{trade.status === "open" && onClose && <button onClick={() => onClose(trade)}>決済を記録</button>}{onEdit && <button onClick={() => onEdit(trade)}>編集</button>}{onDelete && <button className="negative" onClick={() => onDelete(trade)}>削除</button>}</div>}
    </article>;
  })}</div>;
}
