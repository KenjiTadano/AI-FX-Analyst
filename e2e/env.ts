/** Public dummy config for E2E-only Next.js. Not a real project and not a secret. */
export const E2E_DUMMY_SUPABASE_URL = "https://e2e.supabase.co";
export const E2E_DUMMY_SUPABASE_ANON_KEY = "sb_publishable_e2e_not_a_secret";

export function e2ePort(): string {
  return process.env.E2E_PORT ?? process.env.PORT ?? "3000";
}

export function e2eOrigin(): string {
  return process.env.PLAYWRIGHT_BASE_URL ?? `http://localhost:${e2ePort()}`;
}

export function supabaseProjectRef(url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? E2E_DUMMY_SUPABASE_URL): string {
  try {
    return new URL(url).hostname.split(".")[0] || "e2e";
  } catch {
    return "e2e";
  }
}
