import { NextResponse } from "next/server";
import { getAssistantConfig, getSiteUrl } from "@/server/config";
import { createQuotaGate } from "@/server/db/quota";
import { isSiteHost, secureCookies } from "@/server/google/connect-flow";
import { pkceChallenge, randomToken } from "@/server/google/crypto";
import { accountRequired } from "@/server/http/account";
import { withAuthenticatedRoute } from "@/server/http/route";
import { logEvent } from "@/server/log";
import { mcpServer } from "@/server/mcp/catalog";
import { backToConnectors, mcpFetch, readyMcpKey } from "@/server/mcp/flow";
import { OAuthError, authorizationUrl, clientIdFor, discover } from "@/server/mcp/oauth";
import { MCP_STATE_COOKIE, MCP_STATE_MAX_AGE_SECONDS, MCP_STATE_PATH, sealMcpState } from "@/server/mcp/state";

const ROUTE = "connectors.mcp.connect";

/**
 * POST /api/connectors/mcp/:server/connect, from the Connect button's form.
 * Reads the app's OAuth metadata, checks it against the catalog, gets a client
 * ID and sends the browser to the app's consent screen (decision 0016). The
 * state, the PKCE verifier and the endpoints go into a sealed httpOnly cookie
 * that is bound to the signed-in user.
 */
export async function POST(request: Request, context: { params: Promise<{ server: string }> }): Promise<Response> {
  return withAuthenticatedRoute(request, { route: ROUTE, sameOrigin: true }, async ({ auth, requestId }) => {
    const refused = accountRequired(auth, requestId);
    if (refused) return refused;
    const server = mcpServer((await context.params).server);
    if (!server) return backToConnectors(request, null, "error");
    const key = readyMcpKey(requestId, ROUTE);
    if (!key) return backToConnectors(request, server.id, "not_set_up");
    if (!isSiteHost(request)) return backToConnectors(request, server.id, "wrong_site");

    const { quota } = getAssistantConfig();
    const decision = await createQuotaGate(auth.supabase, quota.requestsPerWindow, quota.windowSeconds).consume();
    if (!decision.allowed) return backToConnectors(request, server.id, "rate_limited");

    let target: string;
    let sealed: string;
    try {
      const endpoints = await discover(mcpFetch, server);
      const siteUrl = getSiteUrl();
      const clientId = await clientIdFor(mcpFetch, endpoints, siteUrl);
      const state = randomToken();
      const verifier = randomToken();
      sealed = await sealMcpState(key, {
        userId: auth.userId,
        server: server.id,
        state,
        verifier,
        subject: `conn_${crypto.randomUUID()}`,
        issuer: endpoints.issuer,
        tokenEndpoint: endpoints.tokenEndpoint,
        revocationEndpoint: endpoints.revocationEndpoint,
        clientId,
        issRequired: endpoints.issRequired,
        expiresAt: Date.now() + MCP_STATE_MAX_AGE_SECONDS * 1000,
      });
      target = authorizationUrl(server, endpoints, {
        clientId,
        redirectUri: `${siteUrl}/api/connectors/mcp/callback`,
        state,
        codeChallenge: await pkceChallenge(verifier),
      });
    } catch (error) {
      const kind = error instanceof OAuthError ? error.kind : "unknown";
      logEvent("warn", "mcp_connect_failed", { requestId, route: ROUTE, server: server.id, kind });
      return backToConnectors(request, server.id, kind === "unsupported" ? "not_supported" : "error");
    }

    const response = NextResponse.redirect(target, 303);
    response.cookies.set(MCP_STATE_COOKIE, sealed, {
      httpOnly: true,
      secure: secureCookies(),
      sameSite: "lax",
      path: MCP_STATE_PATH,
      maxAge: MCP_STATE_MAX_AGE_SECONDS,
    });
    return response;
  });
}
