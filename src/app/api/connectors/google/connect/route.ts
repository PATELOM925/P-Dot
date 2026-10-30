import { NextResponse } from "next/server";
import { backToConnectors, isSiteHost, readyGoogleConfig, secureCookies } from "@/server/google/connect-flow";
import { pkceChallenge, randomToken } from "@/server/google/crypto";
import { buildAuthorizationUrl } from "@/server/google/oauth";
import {
  OAUTH_STATE_COOKIE,
  OAUTH_STATE_MAX_AGE_SECONDS,
  OAUTH_STATE_PATH,
  sealOAuthState,
} from "@/server/google/oauth-state";
import { withAuthenticatedRoute } from "@/server/http/route";

/**
 * POST /api/connectors/google/connect, from the Connect button's form.
 * Starts Google's consent screen for Gmail and Calendar (decision 0014). The
 * state and the PKCE verifier go into a sealed httpOnly cookie that is bound
 * to the signed-in user.
 */
export async function POST(request: Request): Promise<Response> {
  return withAuthenticatedRoute(request, { route: "connectors.google.connect", sameOrigin: true }, async ({ auth, requestId }) => {
    const config = readyGoogleConfig(requestId, "connectors.google.connect");
    if (!config) return backToConnectors(request, "not_set_up");
    if (!isSiteHost(request)) return backToConnectors(request, "wrong_site");

    const state = randomToken();
    const verifier = randomToken();
    const sealed = await sealOAuthState(config.encryptionKey, {
      userId: auth.userId,
      state,
      verifier,
      expiresAt: Date.now() + OAUTH_STATE_MAX_AGE_SECONDS * 1000,
    });
    const response = NextResponse.redirect(buildAuthorizationUrl(config, state, await pkceChallenge(verifier)), 303);
    response.cookies.set(OAUTH_STATE_COOKIE, sealed, {
      httpOnly: true,
      secure: secureCookies(),
      sameSite: "lax",
      path: OAUTH_STATE_PATH,
      maxAge: OAUTH_STATE_MAX_AGE_SECONDS,
    });
    return response;
  });
}
