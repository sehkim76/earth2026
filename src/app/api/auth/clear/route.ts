import { NextRequest, NextResponse } from "next/server";

const AUTH_CLEAR_ATTEMPT_COOKIE = "armission-auth-clear-attempt";

const authCookiesToClear = [
  "next-auth.session-token",
  "__Secure-next-auth.session-token",
  "__Host-next-auth.session-token",
  "next-auth.csrf-token",
  "__Host-next-auth.csrf-token",
  "authjs.session-token",
  "__Secure-authjs.session-token",
  "__Host-authjs.session-token",
  "authjs.csrf-token",
  "__Host-authjs.csrf-token",
] as const;

export async function GET(request: NextRequest) {
  const requestUrl = new URL(request.url);
  const nextPath = requestUrl.searchParams.get("next") || "/";
  const redirectUrl = new URL(nextPath, requestUrl.origin);
  const response = NextResponse.redirect(redirectUrl);
  const requestCookieNames = request.cookies.getAll().map((cookie) => cookie.name);
  const cookieNamesToClear = new Set<string>(authCookiesToClear);

  for (const cookieName of requestCookieNames) {
    for (const prefix of authCookiesToClear) {
      if (cookieName === prefix || cookieName.startsWith(`${prefix}.`)) {
        cookieNamesToClear.add(cookieName);
      }
    }
  }

  for (const cookieName of cookieNamesToClear) {
    const requiresSecure = cookieName.startsWith("__Secure-") || cookieName.startsWith("__Host-");

    response.cookies.set({
      name: cookieName,
      value: "",
      maxAge: 0,
      path: "/",
      secure: requiresSecure,
      sameSite: "lax",
    });
  }

  response.cookies.set({
    name: AUTH_CLEAR_ATTEMPT_COOKIE,
    value: "1",
    maxAge: 30,
    path: "/",
    httpOnly: true,
    sameSite: "lax",
  });

  return response;
}
