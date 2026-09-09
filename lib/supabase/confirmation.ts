import type { SupabaseClient } from "@supabase/supabase-js";

export const confirmationLogin = "/login?notice=confirmation-login";
export const confirmationError = "/login?error=confirmation";
// This app currently has one authenticated destination. An allowlist also
// prevents external redirects, encoded slashes and auth callback loops.
export function confirmationNext(value: string | null) {
  return value === "/" ? value : "/";
}
export async function confirmEmail(params: URLSearchParams, auth: SupabaseClient["auth"]) {
  const next = confirmationNext(params.get("next"));
  if (params.has("error") || params.has("error_code")) return confirmationError;
  const token_hash = params.get("token_hash"), type = params.get("type"), code = params.get("code");
  try {
    if (token_hash) {
      if (type !== "email" && type !== "signup") return confirmationError;
      const { data, error } = await auth.verifyOtp({ token_hash, type });
      if (error) return confirmationError;
      return data.session ? next : confirmationLogin;
    }
    if (code) {
      const { data, error } = await auth.exchangeCodeForSession(code);
      // The email can already be confirmed even when the originating browser's
      // PKCE verifier is unavailable or its one-time code has been consumed.
      if (error || !data.session) return confirmationLogin;
      return next;
    }
    return "/auth/complete";
  } catch { return "/login?notice=confirmation-unavailable"; }
}
