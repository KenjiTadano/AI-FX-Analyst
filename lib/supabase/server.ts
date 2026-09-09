import "server-only";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { supabaseConfig } from "./config";
import type { Database } from "./database.types";
export async function getServerSupabase({ writable = false }: { writable?: boolean } = {}) {
  const config = supabaseConfig();
  if (!config) return null;
  const jar = await cookies();
  return createServerClient<Database>(config.url, config.key, { cookies: {
    getAll: () => jar.getAll(),
    setAll(values) { try { values.forEach(({ name, value, options }) => jar.set(name, value, options)); } catch (error) { if (writable) throw error; /* Server Components use the refreshed cookies from proxy. */ } },
  } });
}
