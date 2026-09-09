import { NextResponse, type NextRequest } from "next/server";
import { getServerSupabase } from "@/lib/supabase/server";
import { confirmEmail } from "@/lib/supabase/confirmation";

export async function GET(request: NextRequest) {
  let destination = "/login?notice=confirmation-unavailable";
  try {
    const client = await getServerSupabase({ writable: true });
    if (client) destination = await confirmEmail(request.nextUrl.searchParams, client.auth);
  } catch { /* Never log confirmation URLs, codes or tokens. */ }
  const target = new URL(destination, request.url);
  // Only the legacy completion page receives a browser-only fragment.
  // Explicitly clear it everywhere else so tokens cannot reach the dashboard.
  if (destination !== "/auth/complete") target.hash = "_";
  const response = NextResponse.redirect(target);
  response.headers.set("Cache-Control", "private, no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}
