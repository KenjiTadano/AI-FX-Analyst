import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { supabaseConfig } from "./lib/supabase/config";
export async function proxy(request: NextRequest) {
  const config = supabaseConfig();
  let response = NextResponse.next({ request });
  if (request.nextUrl.pathname.startsWith("/auth/")) response.headers.set("Referrer-Policy", "no-referrer");
  if (!config) return response;
  const client = createServerClient(config.url, config.key, { cookies: {
    getAll: () => request.cookies.getAll(),
    setAll(values) {
      values.forEach(({ name, value }) => request.cookies.set(name, value));
      response = NextResponse.next({ request });
      values.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
    },
  } });
  try { await client.auth.getClaims(); } catch { /* Public analysis remains available; DB access still requires RLS. */ }
  response.headers.set("Cache-Control", "private, no-store");
  if (request.nextUrl.pathname.startsWith("/auth/")) response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}
export const config = { matcher: ["/", "/login", "/signup", "/auth/:path*"] };
