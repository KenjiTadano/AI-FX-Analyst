import { e2eOrigin, supabaseProjectRef } from "../env";
import { E2E_USER_EMAIL, E2E_USER_ID } from "./ids";

function encode(payload: object): string {
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

export function fakeJwt(payload: Record<string, unknown>): string {
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode(payload)}.e2e`;
}

export function e2eUser() {
  return {
    id: E2E_USER_ID,
    aud: "authenticated",
    role: "authenticated",
    email: E2E_USER_EMAIL,
    app_metadata: { provider: "email" },
    user_metadata: {},
    created_at: "2026-01-01T00:00:00.000Z",
  };
}

export function e2eSession() {
  const user = e2eUser();
  const access_token = fakeJwt({
    sub: E2E_USER_ID,
    role: "authenticated",
    aud: "authenticated",
    email: E2E_USER_EMAIL,
    exp: 2_000_000_000,
    iat: 1_700_000_000,
  });
  return {
    access_token,
    refresh_token: "e2e-refresh",
    expires_in: 3600,
    expires_at: 2_000_000_000,
    token_type: "bearer",
    user,
  };
}

export function e2eAuthCookieName() {
  return `sb-${supabaseProjectRef()}-auth-token`;
}

export function e2eAuthCookieValue() {
  const json = JSON.stringify(e2eSession());
  return `base64-${Buffer.from(json, "utf8").toString("base64url")}`;
}

export function e2eAuthCookie(origin = e2eOrigin()) {
  return {
    name: e2eAuthCookieName(),
    value: e2eAuthCookieValue(),
    url: origin,
    httpOnly: false,
    secure: origin.startsWith("https"),
    sameSite: "Lax" as const,
  };
}
