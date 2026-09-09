"use client";
import { useEffect, useRef } from "react";
import Link from "next/link";
import { getBrowserSupabase } from "@/lib/supabase/client";
import { confirmationError, confirmationLogin } from "@/lib/supabase/confirmation";

export default function CompleteConfirmation() {
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    window.history.replaceState(null, "", window.location.pathname);
    void (async () => {
      let destination = confirmationLogin;
      try {
        if (fragment.has("error") || fragment.has("error_code")) destination = confirmationError;
        else {
          const client = getBrowserSupabase();
          const access_token = fragment.get("access_token"), refresh_token = fragment.get("refresh_token");
          if (client) {
            if (access_token && refresh_token) {
              const { error } = await client.auth.setSession({ access_token, refresh_token });
              if (error) { window.location.replace(confirmationError); return; }
            }
            const { data, error } = await client.auth.getUser();
            if (!error && data.user?.email_confirmed_at) destination = "/";
          }
        }
      } catch { destination = "/login?notice=confirmation-unavailable"; }
      window.location.replace(destination);
    })();
  }, []);
  return <main className="auth-page"><p role="status">メール確認後のログイン状態を確認しています…</p><Link href={confirmationLogin}>ログインへ進む</Link></main>;
}
