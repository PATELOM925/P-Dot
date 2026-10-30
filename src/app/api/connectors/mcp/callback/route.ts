import { NextResponse, type NextRequest } from "next/server";
import { getAuthContext } from "@/server/auth/session";
import { getSiteUrl } from "@/server/config";
import { createMcpAccountRepository } from "@/server/db/connected-accounts";
import { sameText } from "@/server/google/crypto";
import { hasAccount } from "@/lib/auth-identity";
import { newRequestId } from "@/server/http/responses";
import { logEvent } from "@/server/log";
import { MAX_SEALED_CHARS, sealBundle } from "@/server/mcp/bundle";
import { MCP_SERVERS, type McpServerId } from "@/server/mcp/catalog";
import { McpError, openMcpSession } from "@/server/mcp/client";
import { backToConnectors, mcpFetch, readyMcpKey, type McpOutcome } from "@/server/mcp/flow";
import { OAuthError, exchangeCode, revokeToken, type Tokens } from "@/server/mcp/oauth";
import { pinTools } from "@/server/mcp/pins";
import { MCP_STATE_COOKIE, MCP_STATE_PATH, openMcpState } from "@/server/mcp/state";

const ROUTE = "connectors.mcp.callback";
const MAX_PARAM_CHARS = 2048;
const SINGLE = ["code", "state", "iss", "error", "error_description", "error_uri"] as const;
const LIST_TIMEOUT_MS = 15_000;

/**
 * GET /api/connectors/mcp/callback. The app returns here after consent
 * (decision 0016). Checks the session, the account, the sealed state cookie,
 * the state and `iss` before it calls the app. Then it exchanges the code,
 * lists the tools once to pin them, seals the bundle and saves the row once.
 * Every answer deletes the state cookie.
 */
export async function GET(request: NextRequest): Promise<Response> {
  const requestId = newRequestId();
  let server: McpServerId | null = null;
  const done = (outcome: McpOutcome, step: string) => {
    logEvent(outcome === "connected" ? "info" : "warn", "mcp_connect_result", { requestId, route: ROUTE, server, outcome, step });
    return backToConnectors(request, server, outcome, true);
  };

  try {
    const auth = await getAuthContext();
    if (!auth) {
      const login = NextResponse.redirect(new URL("/login?next=/connectors", request.url), 303);
      login.cookies.set(MCP_STATE_COOKIE, "", { path: MCP_STATE_PATH, maxAge: 0, httpOnly: true });
      return login;
    }
    if (!hasAccount(auth)) return done("account_required", "account");
    const key = readyMcpKey(requestId, ROUTE);
    if (!key) return done("not_set_up", "config");

    const params = request.nextUrl.searchParams;
    if (SINGLE.some((name) => params.getAll(name).length > 1)) return done("error", "repeated");
    const cookie = request.cookies.get(MCP_STATE_COOKIE)?.value;
    const saved = cookie ? await openMcpState(key, cookie, Date.now()) : null;
    const state = params.get("state");
    if (!saved || saved.userId !== auth.userId || !state || state.length > MAX_PARAM_CHARS || !sameText(state, saved.state)) {
      return done("error", "state");
    }
    server = saved.server;
    const iss = params.get("iss");
    if (iss !== null ? iss !== saved.issuer : saved.issRequired) return done("error", "iss");
    if (params.get("error")) return done(params.get("error") === "access_denied" ? "denied" : "error", "consent");
    const code = params.get("code");
    if (!code || code.length > MAX_PARAM_CHARS) return done("error", "code");

    const catalog = MCP_SERVERS[saved.server];
    const tokens = await exchangeCode(
      mcpFetch,
      catalog,
      {
        tokenEndpoint: saved.tokenEndpoint,
        clientId: saved.clientId,
        redirectUri: `${getSiteUrl()}/api/connectors/mcp/callback`,
        code,
        verifier: saved.verifier,
      },
      Date.now(),
    );

    // From here a token exists. Any exit that stores nothing tries to revoke it.
    const dropTokens = async (outcome: McpOutcome, step: string) => {
      await revokeIssued(saved.revocationEndpoint, saved.clientId, tokens);
      return done(outcome, step);
    };
    if (tokens.scopes.length === 0) return dropTokens("denied", "scopes");

    let pins: Record<string, string>;
    const session = openMcpSession({
      url: catalog.resource,
      fetch: mcpFetch,
      token: async () => tokens.accessToken,
      signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
    });
    try {
      pins = await pinTools(catalog, await session.listTools());
    } catch (error) {
      logEvent("warn", "mcp_pin_failed", { requestId, route: ROUTE, server, kind: error instanceof McpError ? error.kind : "unknown" });
      return dropTokens("error", "pins");
    } finally {
      session.close();
    }
    if (Object.keys(pins).length === 0) return dropTokens("no_tools", "pins");

    const sealed = await sealBundle(key, auth.userId, saved.subject, {
      v: 1,
      server: saved.server,
      issuer: saved.issuer,
      resource: catalog.resource,
      clientId: saved.clientId,
      tokenEndpoint: saved.tokenEndpoint,
      revocationEndpoint: saved.revocationEndpoint,
      accessToken: tokens.accessToken,
      accessExpiresAt: tokens.accessExpiresAt,
      refreshToken: tokens.refreshToken,
      pins,
      claim: null,
    });
    if (sealed.length > MAX_SEALED_CHARS) return dropTokens("error", "size");
    try {
      await createMcpAccountRepository(auth.supabase).saveMcp(saved.server, saved.subject, tokens.scopes, sealed);
    } catch {
      return dropTokens("error", "save");
    }
    return done("connected", "saved");
  } catch (error) {
    if (error instanceof OAuthError) return done("error", `oauth_${error.kind}`);
    logEvent("error", "mcp_connect_failed", { requestId, route: ROUTE, errorName: error instanceof Error ? error.name : "unknown" });
    return backToConnectors(request, server, "error", true);
  }
}

async function revokeIssued(endpoint: string | null, clientId: string, tokens: Tokens): Promise<void> {
  if (!endpoint) return;
  await revokeToken(mcpFetch, {
    revocationEndpoint: endpoint,
    clientId,
    token: tokens.refreshToken ?? tokens.accessToken,
    hint: tokens.refreshToken ? "refresh_token" : "access_token",
  });
}
