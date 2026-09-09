import { createBrowserClient } from "@supabase/ssr";
import { supabaseConfig } from "./config";
import type { Database } from "./database.types";
export function getBrowserSupabase() {
  const config = supabaseConfig();
  return config ? createBrowserClient<Database>(config.url, config.key, { auth: { detectSessionInUrl: false } }) : null;
}
