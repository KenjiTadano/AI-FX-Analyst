export function validPublicConfig(url: string | undefined, key: string | undefined) {
  if (!url || !key || key.startsWith("sb_secret_")) return null;
  try {
    const parsed = new URL(url);
    if (!(["https:"].includes(parsed.protocol) || parsed.protocol === "http:" && ["localhost", "127.0.0.1"].includes(parsed.hostname))) return null;
    if (key.includes(".")) {
      const claims = JSON.parse(atob(key.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
      if (claims.role !== "anon") return null;
    } else if (!key.startsWith("sb_publishable_")) return null;
    return { url: parsed.origin, key };
  } catch { return null; }
}
export function supabaseConfig() {
  return validPublicConfig(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
}
