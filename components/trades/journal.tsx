"use client";
import { useEffect, useMemo, useState } from "react";
import type { AIAnalysis } from "@/lib/ai/types";
import type { ChartImageAnalysis } from "@/lib/chart-analysis/types";
import type { Quote, Trade, TradeDraft } from "@/lib/trades/types";
import { tradeRepository } from "@/lib/trades/repository";
import { createTrade, editTrade } from "@/lib/trades/service";
import { getBrowserSupabase } from "@/lib/supabase/client";
import { createCloudRepository, type CloudJournal } from "@/lib/supabase/cloud-repository";
import { TradeForm } from "./trade-form";
import { TradeList } from "./trade-list";
import { Performance } from "./performance";
import { Panel } from "../dashboard/panels";
export function TradeJournal({ userId, view, pair, quote, analysis, chartImageAnalysis = null, initialBalance }: { userId: string; view: "analysis" | "trades" | "performance"; pair: string; quote: Quote | null; analysis: AIAnalysis | null; chartImageAnalysis?: ChartImageAnalysis | null; initialBalance: number }) {
  const repository = useMemo(() => { const client = getBrowserSupabase(); return client ? createCloudRepository(client, userId) : null; }, [userId]);
  const [journal, setJournal] = useState<CloudJournal | null>(null);
  const [local, setLocal] = useState<Trade[]>([]);
  const [localError, setLocalError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [editor, setEditor] = useState<{ trade: Trade | null; mode: "new" | "edit" | "close" } | null>(null);
  const [deleting, setDeleting] = useState<Trade | null>(null);
  const [now, setNow] = useState(0);
  useEffect(() => {
    let active = true;
    void repository?.load().then(result => {
      if (!active) return;
      setJournal(result.data); setError(result.error);
      const legacy = tradeRepository.load(); setLocal(legacy.data?.trades ?? []); setLocalError(legacy.error);
    });
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => { active = false; clearInterval(clock); };
  }, [repository]);
  async function save(draft: TradeDraft, options?: { saveSnapshot?: boolean }): Promise<string | null> {
    if (!editor || !journal || !repository || busy) return "読み込み完了後に記録してください。";
    const at = new Date().toISOString();
    const result = editor.trade
      ? editTrade(editor.trade, draft, at)
      : createTrade(draft, analysis, crypto.randomUUID(), at, {
        chartImageAnalysis,
        marketPrice: rate,
        saveSnapshot: options?.saveSnapshot !== false,
      });
    if (!result.data) return result.error;
    setBusy(true);
    const saved = editor.trade ? await repository.update(result.data) : await repository.create(result.data);
    setBusy(false);
    if (!saved.data) { setError(saved.error); return saved.error; }
    setJournal({ ...journal, trades: editor.trade ? journal.trades.map(t => t.id === editor.trade!.id ? saved.data! : t) : [...journal.trades, saved.data] });
    setEditor(null); setError(null);
    const skipped = !editor.trade && options?.saveSnapshot !== false && analysis?.pair === draft.pair && !saved.data.analysisSnapshot;
    setMessage(skipped ? "クラウドへ保存しました（AIスナップショットは安全に除外）。" : "クラウドへ保存しました。");
    return null;
  }
  async function remove() {
    if (!deleting || !repository || !journal || busy) return;
    setBusy(true); const result = await repository.remove(deleting); setBusy(false);
    if (!result.data) { setError(result.error); return; }
    setJournal({ ...journal, trades: journal.trades.filter(t => t.id !== deleting.id) }); setDeleting(null); setError(null); setMessage("クラウドの取引を削除しました。");
  }
  const pending = local.filter(t => !journal?.importedIds.includes(t.id));
  async function migrate() {
    if (!repository || !journal || busy) return;
    setBusy(true); setMessage("");
    const result = await repository.importTrades(pending);
    if (result.error) { setError("移行を完了できませんでした。元データは保持しています。再試行しても重複登録しません。"); setBusy(false); return; }
    const updated = await repository.load(); setBusy(false);
    if (!updated.data || pending.some(t => !updated.data!.importedIds.includes(t.id))) { setError("移行後の確認を完了できませんでした。再読み込みして確認してください。元データは保持しています。"); return; }
    setJournal(updated.data); setError(null); setMessage("クラウドへの移行が完了しました。この端末の元データは残しています。");
  }
  const trades = journal?.trades ?? [];
  const sorted = [...trades].sort((a, b) => (b.closedAt ?? b.openedAt).localeCompare(a.closedAt ?? a.openedAt));
  const rate = quote && quote.pair === pair && !quote.stale && now - Date.parse(quote.fetchedAt) >= 0 && now - Date.parse(quote.fetchedAt) <= 120000 ? quote.price : null;
  const locked = busy || !!editor || !!deleting;
  return <div hidden={view === "analysis"} className="journal-shell">
    <p className="footnote">ログイン中のアカウントのクラウド記録です。注文・証券口座との同期は行いません。</p>
    {error && <p className="negative" role="alert">{error} <button disabled={busy} onClick={() => window.location.reload()}>再読み込み</button></p>}
    {!journal && !error && <p role="status">取引記録を読み込み中…</p>}
    {localError && <p className="neutral">端末データの移行：{localError}</p>}
    {journal && pending.length > 0 && <section className="panel"><h3>この端末に保存されている取引履歴があります</h3><p className="footnote">未移行{pending.length}件を、現在ログイン中のアカウントへコピーします。共用端末ではご自身の記録であることを確認してください。元データは削除しません。</p><button disabled={locked} onClick={() => void migrate()}>クラウドへ移行</button></section>}
    {message && <p className="positive" role="status">{message}</p>}
    {view === "trades" && <>
      <div className="journal-toolbar"><h2>トレード記録</h2><button className="journal-primary" disabled={!journal || locked} onClick={() => { setEditor({ trade: null, mode: "new" }); setMessage(""); }}>トレードを記録</button></div>
      {editor && <TradeForm key={`${editor.mode}-${editor.trade?.id ?? "new"}`} {...editor} pair={pair} rate={rate} analysis={analysis} chartImageAnalysis={chartImageAnalysis} onSave={save} onCancel={() => setEditor(null)} />}
      {deleting && <div className="delete-confirm" role="alertdialog" aria-label="取引削除の確認"><p>{deleting.pair}・{deleting.quantity.toLocaleString()}通貨のクラウド記録を削除しますか？この操作は取り消せません。</p><div className="journal-actions"><button disabled={busy} className="negative" onClick={() => void remove()}>削除を確定</button><button disabled={busy} onClick={() => setDeleting(null)}>削除をキャンセル</button></div></div>}
      <Panel title="保有ポジション" eyebrow="OPEN POSITIONS"><p className="footnote">含み損益は選択中の通貨の新鮮なレートがある場合のみ表示します。</p><TradeList trades={sorted.filter(t => t.status === "open")} quote={quote} now={now} onEdit={locked ? undefined : trade => setEditor({ trade, mode: "edit" })} onClose={locked ? undefined : trade => setEditor({ trade, mode: "close" })} onDelete={locked ? undefined : setDeleting} /></Panel>
      <Panel title="取引履歴" eyebrow="CLOSED TRADES"><TradeList trades={sorted.filter(t => t.status === "closed")} quote={quote} now={now} onEdit={locked ? undefined : trade => setEditor({ trade, mode: "edit" })} onDelete={locked ? undefined : setDeleting} /></Panel>
    </>}
    {view === "performance" && journal && <Performance trades={trades} initialBalance={initialBalance} />}
  </div>;
}
