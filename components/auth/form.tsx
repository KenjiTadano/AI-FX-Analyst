"use client";
import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { getBrowserSupabase } from "@/lib/supabase/client";
import { supabaseConfig } from "@/lib/supabase/config";
export function AuthForm({ signup = false }: { signup?: boolean }) {
  const router = useRouter();
  const [message, setMessage] = useState(""); const [busy, setBusy] = useState(false);
  const configured = !!supabaseConfig();
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setMessage(""); setBusy(true);
    const form = new FormData(event.currentTarget), email = String(form.get("email")).trim(), password = String(form.get("password"));
    try {
      const client = getBrowserSupabase(); if (!client) throw new Error();
      if (signup) {
        // Keep this callback free of query parameters: the custom email template appends token_hash/type/next.
        const { data, error } = await client.auth.signUp({ email, password, options: { emailRedirectTo: `${window.location.origin}/auth/confirm` } });
        if (error) throw error;
        if (data.session) { router.replace("/"); router.refresh(); return; }
        setMessage("確認メールを送信しました。メール内のリンクから登録を完了してください。届かない場合は迷惑メールも確認してください。");
      } else {
        const { error } = await client.auth.signInWithPassword({ email, password }); if (error) throw error;
        router.replace("/"); router.refresh(); return;
      }
    } catch { setMessage(signup ? "登録できませんでした。入力内容・接続・メール送信上限を確認してください。" : "ログインできませんでした。メール・パスワード・メール確認状況を確認してください。"); }
    setBusy(false);
  }
  return <main className="auth-page"><Link href="/">← 分析へ戻る</Link><section className="panel"><h1>{signup ? "新規登録" : "ログイン"}</h1><p className="footnote">AI FX Analystのアカウントです。証券会社のログイン情報は入力しないでください。</p>{!configured && <p className="neutral" role="status">Supabaseが設定されていません。</p>}<form onSubmit={submit}><label>メールアドレス<input name="email" type="email" autoComplete="email" required disabled={!configured || busy} /></label><label>パスワード<input name="password" type="password" minLength={8} autoComplete={signup ? "new-password" : "current-password"} required disabled={!configured || busy} /></label><button disabled={!configured || busy}>{busy ? "処理中…" : signup ? "確認メールを送信" : "ログイン"}</button></form>{message && <p role="status">{message}</p>}<p className="footnote"><Link href={signup ? "/login" : "/signup"}>{signup ? "ログインはこちら" : "アカウントを作成"}</Link></p></section></main>;
}
