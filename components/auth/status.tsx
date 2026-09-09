"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useAuth } from "./provider";
import { getBrowserSupabase } from "@/lib/supabase/client";
export function AuthStatus() {
  const router = useRouter();
  const auth = useAuth(); const [error, setError] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  async function logout() {
    setBusy(true); setError(null);
    try { const client = getBrowserSupabase(); if (!client) throw new Error(); const { error } = await client.auth.signOut({ scope: "local" }); if (error) throw error; router.replace("/"); router.refresh(); }
    catch { setError("ログアウトできませんでした。再試行してください。"); setBusy(false); }
  }
  return <div className="auth-status">{auth.loading ? <span>認証確認中…</span> : auth.user ? <><span>{auth.user.email}</span><button disabled={busy} onClick={() => void logout()}>ログアウト</button></> : <><Link href="/login">ログイン</Link><Link href="/signup">新規登録</Link></>}{(error || auth.error) && <span role="alert" className="negative">{error || auth.error}</span>}</div>;
}
export function LoginRequired({ settings = false }: { settings?: boolean }) {
  const auth = useAuth();
  return <section className="panel risk-panel"><h2>{settings ? "資金・リスク管理" : "トレード記録・成績"}</h2><p className="footnote">{auth.loading ? "認証状態を確認中…" : !auth.configured ? "Supabaseが設定されていません。ログイン・クラウド保存は設定後に利用できます。" : settings ? "ユーザー設定を保存するにはログインしてください。" : "取引履歴を保存するにはログインしてください。"}</p><p className="footnote">この端末の旧取引履歴は削除していません。ログイン後に移行できます。</p><Link href="/login">ログインへ</Link></section>;
}
