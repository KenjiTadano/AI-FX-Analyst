"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import type { RiskSettings } from "@/lib/risk/types";
import type { AIAnalysis } from "@/lib/ai/types";
import { getBrowserSupabase } from "@/lib/supabase/client";
import { createSettingsRepository } from "@/lib/supabase/cloud-repository";
import { validateSettings } from "@/lib/supabase/mappers";
import { RiskManagement } from "../dashboard/risk-management";
export function CloudSettings({ userId, analysis, pair, currentRate, onBalanceChange }: { userId: string; analysis: AIAnalysis | null; pair: string; currentRate: number | null; onBalanceChange: (balance: number) => void }) {
  const repository = useMemo(() => { const client = getBrowserSupabase(); return client ? createSettingsRepository(client, userId) : null; }, [userId]);
  const [initial, setInitial] = useState<RiskSettings | null>(null);
  const [draft, setDraft] = useState<RiskSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("設定を読み込み中…");
  const [saving, setSaving] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    void repository?.load().then(result => { if (alive.current) { setInitial(result.data); setError(result.error); setStatus(result.data ? "クラウドから取得済み" : "未取得"); if (result.data) onBalanceChange(result.data.balance); } });
    return () => { alive.current = false; if (timer.current) clearTimeout(timer.current); };
  }, [repository, onBalanceChange]);
  function change(settings: RiskSettings) {
    setDraft(settings); setStatus("未保存"); setError(null);
    if (timer.current) clearTimeout(timer.current);
    try { validateSettings(settings); } catch { setError("設定が入力範囲外のため未保存です。リスク率は10%以下にしてください。"); return; }
    timer.current = setTimeout(async () => {
      if (!repository || !alive.current) return;
      setSaving(true); setStatus("保存中…");
      const result = await repository.save(settings);
      if (!alive.current) return;
      setSaving(false); setError(result.error); setStatus(result.data ? "クラウド保存済み" : "未保存");
    }, 600);
  }
  return <div className="risk-panel cloud-settings"><p className="footnote" role="status">{status}</p>{error && <p className="negative" role="alert">{error}</p>}{initial ? <><RiskManagement analysis={analysis} pair={pair} currentRate={currentRate} initialBalance={initial.balance} initialTarget={initial.target} initialRiskPercent={initial.riskPercent} initialTradeUnit={initial.tradeUnit} onBalanceChange={onBalanceChange} onSettingsChange={change} disabled={saving} />{error && draft && <div className="journal-actions"><button disabled={saving} onClick={() => change(draft)}>設定の保存を再試行</button><button disabled={saving} onClick={() => window.location.reload()}>クラウドから再読み込み</button></div>}</> : error && <button onClick={() => window.location.reload()}>再読み込み</button>}</div>;
}
