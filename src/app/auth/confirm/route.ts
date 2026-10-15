import type { EmailOtpType } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { safeNextPath } from "@/lib/safe-url";
import { ConfigError } from "@/lib/supabase-config";
import { createSupabaseServerClient } from "@/server/db/supabase";
import { logEvent } from "@/server/log";

const OTP_TYPES = new Set<EmailOtpType>(["signup", "email", "recovery", "invite", "email_change", "magiclink"]);

/**
 * GET /auth/confirm — landing point for email verification and password
 * recovery links. Supports both link styles:
 *  - `?token_hash=…&type=…` (recommended email template; works in any browser)
 *  - `?code=…` (Supabase default PKCE link; must open in the same browser)
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const params = request.nextUrl.searchParams;
  const tokenHash = params.get("token_hash");
  const type = params.get("type") as EmailOtpType | null;
  const code = params.get("code");
  const next = safeNextPath(params.get("next"), type === "recovery" ? "/reset-password" : "/chat");

  let verified = false;
  try {
    const supabase = await createSupabaseServerClient();
    if (tokenHash && type && OTP_TYPES.has(type)) {
      const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
      verified = !error;
    } else if (code) {
      const { error } = await supabase.auth.exchangeCodeForSession(code);
      verified = !error;
    }
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    verified = false;
  }

  if (!verified) {
    logEvent("warn", "auth_link_invalid", { route: "auth.confirm" });
    const failure = new URL("/login", request.url);
    failure.searchParams.set("error", "link_invalid");
    return NextResponse.redirect(failure);
  }
  return NextResponse.redirect(new URL(next, request.url));
}
