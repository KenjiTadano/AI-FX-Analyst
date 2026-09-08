"use client";
import { useEffect, useState } from "react";
import type { AIAnalysis } from "@/lib/ai/types";
import type { Journal, Quote, Trade, TradeDraft } from "@/lib/trades/types";
import { tradeRepository } from "@/lib/trades/repository";
import { createTrade, editTrade } from "@/lib/trades/service";
import { TradeForm } from "./trade-form";
import { TradeList } from "./trade-list";
import { Performance } from "./performance";
import { Panel } from "../dashboard/panels";
export function TradeJournal({ view, pair, quote, analysis, initialBalance }: { view: "analysis" | "trades" | "performance"; pair: string; quote: Quote | null; analysis: AIAnalysis | null; initialBalance: number }) {
  const [journal, setJournal] = useState<Journal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [editor, setEditor] = useState<{ trade: Trade | null; mode: "new" | "edit" | "close" } | null>(null);
  const [deleting, setDeleting] = useState<Trade | null>(null);
  const [now, setNow] = useState(0);
  useEffect(() => {
    // Loading and all writes go through the repository; UI never accesses localStorage.
    const timer = setTimeout(() => { const result = tradeRepository.load(); setJournal(result.data); setError(result.error); setNow(Date.now()); }, 0);
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => { clearTimeout(timer); clearInterval(clock); };
  }, []);
  function persist(trades: Trade[]): string | null {
    if (!journal) return "保存データを読み込めていません。";
    const result = tradeRepository.save(trades, journal.revision);
    if (!result.data) { setError(result.error); return result.error; }
    setJournal(result.data); setError(null); return null;
  }
  function save(draft: TradeDraft): string | null {
    if (!editor || !journal) return "読み込み完了後に記録してください。";
    const at = new Date().toISOString();
    const result = editor.trade ? editTrade(editor.trade, draft, at) : createTrade(draft, analysis, crypto.randomUUID(), at);
    if (!result.data) return result.error;
    const trades = editor.trade ? journal.trades.map(t => t.id === editor.trade!.id ? result.data! : t) : [...journal.trades, result.data];
    const failure = persist(trades);
    if (!failure) { setEditor(null); setMessage(editor.mode === "close" ? "決済を保存しました。成績に反映しました。" : "取引を保存しました。"); }
    return failure;
  }
  const trades = journal?.trades ?? [];
  const sorted = [...trades].sort((a, b) => (b.closedAt ?? b.openedAt).localeCompare(a.closedAt ?? a.openedAt));
  const rate = quote && quote.pair === pair && !quote.stale && now - Date.parse(quote.fetchedAt) >= 0 && now - Date.parse(quote.fetchedAt) <= 120000 ? quote.price : null;
  return <div hidden={view === "analysis"} className="journal-shell">
    <p className="footnote">記録はこのブラウザ内に保存します。ブラウザのデータ削除で失われます。注文・証券口座との同期は行いません。</p>
    {error && <p className="negative" role="alert">{error}</p>}
    {!journal && !error && <p role="status">取引記録を読み込み中…</p>}
    {message && <p className="positive" role="status">{message}</p>}
    {view === "trades" && <>
      <div className="journal-toolbar"><h2>トレード記録</h2><button className="journal-primary" disabled={!journal || !!editor || !!deleting} onClick={() => { setEditor({ trade: null, mode: "new" }); setMessage(""); }}>トレードを記録</button></div>
      {editor && <TradeForm key={`${editor.mode}-${editor.trade?.id ?? "new"}`} {...editor} pair={pair} rate={rate} analysis={analysis} onSave={save} onCancel={() => setEditor(null)} />}
      {deleting && <div className="delete-confirm" role="alertdialog" aria-label="取引削除の確認"><p>{deleting.pair}・{deleting.quantity.toLocaleString()}通貨の記録を削除しますか？この操作は取り消せません。</p><div className="journal-actions"><button className="negative" onClick={() => { const failure = persist(trades.filter(t => t.id !== deleting.id)); if (!failure) { setDeleting(null); setMessage("取引を削除しました。"); } }}>削除を確定</button><button onClick={() => setDeleting(null)}>削除をキャンセル</button></div></div>}
      <Panel title="保有ポジション" eyebrow="OPEN POSITIONS"><p className="footnote">含み損益は上部で選択中の通貨の新鮮なレートがある場合のみ表示します。</p><TradeList trades={sorted.filter(t => t.status === "open")} quote={quote} now={now} onEdit={editor || deleting ? undefined : trade => setEditor({ trade, mode: "edit" })} onClose={editor || deleting ? undefined : trade => setEditor({ trade, mode: "close" })} onDelete={editor || deleting ? undefined : setDeleting} /></Panel>
      <Panel title="取引履歴" eyebrow="CLOSED TRADES"><TradeList trades={sorted.filter(t => t.status === "closed")} quote={quote} now={now} onEdit={editor || deleting ? undefined : trade => setEditor({ trade, mode: "edit" })} onDelete={editor || deleting ? undefined : setDeleting} /></Panel>
    </>}
    {view === "performance" && journal && <Performance trades={trades} initialBalance={initialBalance} />}
  </div>;
}
