import test from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";
import { confirmEmail, confirmationNext, confirmationLogin, confirmationError } from "../lib/supabase/confirmation";
function fixture(options: { error?: boolean; session?: boolean; throws?: boolean } = {}) {
  const calls: unknown[] = [];
  const result = () => {
    if (options.throws) throw new Error("private provider detail");
    return { data: { session: options.session === false ? null : {} }, error: options.error ? { code: "test" } : null };
  };
  const auth = {
    verifyOtp: async (input: unknown) => { calls.push(["otp", input]); return result(); },
    exchangeCodeForSession: async (code: string) => { calls.push(["pkce", code]); return result(); },
  } as unknown as SupabaseClient["auth"];
  return { auth, calls };
}
test("email and signup hashes verify once and establish session", async () => {
  for (const type of ["email", "signup"]) {
    const f = fixture();
    assert.equal(await confirmEmail(new URLSearchParams({ token_hash: "hash", type, next: "/" }), f.auth), "/");
    assert.deepEqual(f.calls, [["otp", { token_hash: "hash", type }]]);
  }
});
test("standard confirmation code is exchanged rather than reported as OTP failure", async () => {
  const f = fixture();
  assert.equal(await confirmEmail(new URLSearchParams("code=one-time-code"), f.auth), "/");
  assert.deepEqual(f.calls, [["pkce", "one-time-code"]]);
});
test("missing verifier or consumed PKCE code offers password login without asserting email failure", async () => {
  assert.equal(await confirmEmail(new URLSearchParams("code=used"), fixture({ error: true }).auth), confirmationLogin);
});
test("successful verification without a session offers login", async () => {
  assert.equal(await confirmEmail(new URLSearchParams("token_hash=hash&type=email"), fixture({ session: false }).auth), confirmationLogin);
});
test("expired or invalid OTP and explicit provider errors report failure", async () => {
  assert.equal(await confirmEmail(new URLSearchParams("token_hash=expired&type=email"), fixture({ error: true }).auth), confirmationError);
  for (const query of ["error=access_denied", "error_code=otp_expired", "token_hash=x&type=recovery", "token_hash=x"]) {
    const f = fixture(); assert.equal(await confirmEmail(new URLSearchParams(query), f.auth), confirmationError); assert.deepEqual(f.calls, []);
  }
});
test("no server-readable token reaches browser completion, not a false failure", async () => {
  const f = fixture(); assert.equal(await confirmEmail(new URLSearchParams(), f.auth), "/auth/complete"); assert.deepEqual(f.calls, []);
});
test("transport exceptions never expose sensitive provider details", async () => {
  assert.equal(await confirmEmail(new URLSearchParams("code=x"), fixture({ throws: true }).auth), "/login?notice=confirmation-unavailable");
});
test("next is restricted to app dashboard and cannot redirect outside or loop", async () => {
  for (const next of [null, "/", "//evil.example", "https://evil.example", "/\\evil.example", "/%2f%2fevil.example", "/auth/confirm", "/login?token_hash=secret"]) {
    assert.equal(confirmationNext(next), "/");
    const f = fixture(); assert.equal(await confirmEmail(new URLSearchParams({ code: "code", next: next ?? "" }), f.auth), "/");
  }
});
