import { NextResponse, type NextRequest } from "next/server";
import { safeNextPath } from "@/lib/safe-url";
import { ConfigError } from "@/lib/supabase-config";
import { createSupabaseServerClient } from "@/server/db/supabase";
import { logEvent } from "@/server/log";

/**
 * GET /auth/callback. Supabase returns here after "Continue with Google"
 * (decision 0014). Exchanges the code for a session with the PKCE verifier
 * cookie. Every failure goes to one login message, so the answer never shows
 * whether an account exists.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const params = request.nextUrl.searchParams;
  const code = params.get("code");
  const next = safeNextPath(params.get("next"));

  let signedIn = false;
  if (code && !params.get("error")) {
    try {
      const supabase = await createSupabaseServerClient();
      const { error } = await supabase.auth.exchangeCodeForSession(code);
      signedIn = !error;
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
    }
  }

  if (!signedIn) {
    logEvent("warn", "google_sign_in_failed", { route: "auth.callback" });
    return NextResponse.redirect(new URL("/login?error=oauth", request.url), 303);
  }
  return NextResponse.redirect(new URL(next, request.url), 303);
}
