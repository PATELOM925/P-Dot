import { NextResponse, type NextRequest } from "next/server";
import { getAuthContext } from "@/server/auth/session";
import { createConnectedAccountRepository } from "@/server/db/connected-accounts";
import { backToConnectors, googleFetch, readyGoogleConfig, type GoogleOutcome } from "@/server/google/connect-flow";
import { sameText, sealText, tokenAssociatedData } from "@/server/google/crypto";
import { GoogleApiError } from "@/server/google/http";
import { exchangeCode, revokeToken } from "@/server/google/oauth";
import { OAUTH_STATE_COOKIE, OAUTH_STATE_PATH, openOAuthState } from "@/server/google/oauth-state";
import { newRequestId } from "@/server/http/responses";
import { logEvent } from "@/server/log";

const ROUTE = "connectors.google.callback";
const MAX_PARAM_CHARS = 2048;

/**
 * GET /api/connectors/google/callback. Google returns here after consent.
 * Checks the session, the sealed state cookie, the user and the state before
 * it calls Google. Stores only the encrypted refresh token (decision 0014).
 * Every answer deletes the state cookie and redirects to the Connectors page.
 */
export async function GET(request: NextRequest): Promise<Response> {
  const requestId = newRequestId();
  const done = (outcome: GoogleOutcome, step: string) => {
    logEvent(outcome === "connected" ? "info" : "warn", "google_connect_result", { requestId, route: ROUTE, outcome, step });
    return backToConnectors(request, outcome, true);
  };

  try {
    const config = readyGoogleConfig(requestId, ROUTE);
    if (!config) return done("not_set_up", "config");

    const auth = await getAuthContext();
    if (!auth) {
      const login = NextResponse.redirect(new URL("/login?next=/connectors", request.url), 303);
      login.cookies.set(OAUTH_STATE_COOKIE, "", { path: OAUTH_STATE_PATH, maxAge: 0, httpOnly: true });
      return login;
    }

    const params = request.nextUrl.searchParams;
    const cookie = request.cookies.get(OAUTH_STATE_COOKIE)?.value;
    const saved = cookie ? await openOAuthState(config.encryptionKey, cookie, Date.now()) : null;
    const state = params.get("state");
    if (!saved || saved.userId !== auth.userId || !state || state.length > MAX_PARAM_CHARS || !sameText(state, saved.state)) {
      return done("error", "state");
    }
    if (params.get("error")) return done(params.get("error") === "access_denied" ? "denied" : "error", "consent");
    const code = params.get("code");
    if (!code || code.length > MAX_PARAM_CHARS) return done("error", "code");

    const tokens = await exchangeCode(googleFetch, config, code, saved.verifier);
    if (tokens.dataScopes.length === 0) {
      try {
        await revokeToken(googleFetch, tokens.refreshToken);
      } catch {
        // The token can only read the address. It is not stored.
      }
      return done("no_scopes", "scopes");
    }

    const ciphertext = await sealText(config.encryptionKey, tokens.refreshToken, tokenAssociatedData(auth.userId, "google"));
    await createConnectedAccountRepository(auth.supabase).saveGoogle(tokens.subject, tokens.email, tokens.dataScopes, ciphertext);
    return done("connected", "saved");
  } catch (error) {
    if (error instanceof GoogleApiError) return done("error", `google_${error.kind}`);
    logEvent("error", "google_connect_failed", {
      requestId,
      route: ROUTE,
      errorName: error instanceof Error ? error.name : "unknown",
    });
    return backToConnectors(request, "error", true);
  }
}
