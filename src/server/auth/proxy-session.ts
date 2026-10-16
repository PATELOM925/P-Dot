import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { getSupabaseConfig, isSupabaseConfigured } from "@/lib/supabase-config";

// Used only by src/proxy.ts. Not marked `server-only` because the proxy bundle
// is compiled separately from React Server Components.

const PROTECTED_PREFIXES = ["/today", "/chat", "/workflows", "/connectors", "/settings", "/reset-password"];
const SIGNED_OUT_ONLY = ["/login", "/signup", "/forgot-password"];

function matches(pathname: string, prefixes: string[]): boolean {
  return prefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

/**
 * Refreshes the Supabase session cookie on every matched request and applies
 * page-level redirects. API routes are not redirected; they return 401 JSON
 * and perform their own authentication check.
 */
export async function updateSession(request: NextRequest): Promise<NextResponse> {
  let response = NextResponse.next({ request });
  if (!isSupabaseConfigured()) return response;

  const { url, publishableKey } = getSupabaseConfig();
  const supabase = createServerClient(url, publishableKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet, headers) {
        for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
        // Responses that set auth cookies must not be cached by a CDN.
        for (const [key, value] of Object.entries(headers)) response.headers.set(key, value);
      },
    },
  });

  // Do not add logic between creating the client and getClaims(): the call is
  // what refreshes an expired session.
  let signedIn = false;
  try {
    const { data } = await supabase.auth.getClaims();
    signedIn = Boolean(data?.claims?.sub);
  } catch {
    // Treat an unreachable Auth server as signed out for routing purposes.
  }
  const { pathname, search } = request.nextUrl;

  let redirectTo: URL | null = null;
  if (!signedIn && matches(pathname, PROTECTED_PREFIXES)) {
    redirectTo = request.nextUrl.clone();
    redirectTo.pathname = "/login";
    redirectTo.search = "";
    // A recovery session is required for /reset-password; send users back to request one.
    if (pathname === "/reset-password") redirectTo.pathname = "/forgot-password";
    else redirectTo.searchParams.set("next", `${pathname}${search}`);
  } else if (signedIn && matches(pathname, SIGNED_OUT_ONLY)) {
    redirectTo = request.nextUrl.clone();
    redirectTo.pathname = "/chat";
    redirectTo.search = "";
  }

  if (redirectTo) {
    const redirect = NextResponse.redirect(redirectTo);
    // Carry over refreshed/cleared session cookies and their cache headers.
    for (const cookie of response.cookies.getAll()) redirect.cookies.set(cookie);
    for (const header of ["cache-control", "expires", "pragma"]) {
      const value = response.headers.get(header);
      if (value) redirect.headers.set(header, value);
    }
    return redirect;
  }

  return response;
}
