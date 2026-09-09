"use client";
import { createContext, useContext, useEffect, useState } from "react";
import { getBrowserSupabase } from "@/lib/supabase/client";
import type { User } from "@supabase/supabase-js";
interface AuthState { user: User | null; loading: boolean; configured: boolean; error: string | null }
const AuthContext = createContext<AuthState>({ user: null, loading: true, configured: false, error: null });
export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AuthState>({ user: null, loading: true, configured: false, error: null });
  useEffect(() => {
    const client = getBrowserSupabase(); let active = true; let generation = 0;
    async function refresh() {
      const own = ++generation;
      if (!client) { if (active) setState({ user: null, loading: false, configured: false, error: null }); return; }
      try {
        const { data, error } = await client.auth.getUser();
        if (active && own === generation) setState({ user: error ? null : data.user, loading: false, configured: true, error: error && error.name !== "AuthSessionMissingError" ? "認証状態を確認できません。再度ログインしてください。" : null });
      } catch { if (active && own === generation) setState({ user: null, loading: false, configured: true, error: "認証サービスに接続できません。" }); }
    }
    const timer = setTimeout(() => void refresh(), 0);
    const subscription = client?.auth.onAuthStateChange((event) => {
      // Clear account-bound UI before asynchronously validating the next session.
      if (event !== "TOKEN_REFRESHED" && event !== "INITIAL_SESSION") { generation++; setState({ user: null, loading: true, configured: true, error: null }); }
      setTimeout(() => { if (active) void refresh(); }, 0);
    });
    return () => { active = false; clearTimeout(timer); subscription?.data.subscription.unsubscribe(); };
  }, []);
  return <AuthContext.Provider value={state}>{children}</AuthContext.Provider>;
}
export const useAuth = () => useContext(AuthContext);
