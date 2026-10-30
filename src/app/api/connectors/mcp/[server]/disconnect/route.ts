import { getAssistantConfig } from "@/server/config";
import { createMcpAccountRepository } from "@/server/db/connected-accounts";
import { createQuotaGate } from "@/server/db/quota";
import { accountRequired } from "@/server/http/account";
import { withAuthenticatedRoute } from "@/server/http/route";
import { logEvent } from "@/server/log";
import { openBundle } from "@/server/mcp/bundle";
import { mcpServer } from "@/server/mcp/catalog";
import { backToConnectors, mcpFetch, readyMcpKey } from "@/server/mcp/flow";
import { revokeToken } from "@/server/mcp/oauth";

const ROUTE = "connectors.mcp.disconnect";

/**
 * POST /api/connectors/mcp/:server/disconnect, from the Disconnect button's
 * form (decision 0016). Revokes the token at the app when the app has a
 * revocation endpoint, then deletes the row only while it still has the
 * ciphertext that this request read. A connection made in another tab, or a
 * refresh, after the read stays, and the answer says so.
 */
export async function POST(request: Request, context: { params: Promise<{ server: string }> }): Promise<Response> {
  return withAuthenticatedRoute(request, { route: ROUTE, sameOrigin: true }, async ({ auth, requestId }) => {
    const refused = accountRequired(auth, requestId);
    if (refused) return refused;
    const server = mcpServer((await context.params).server);
    if (!server) return backToConnectors(request, null, "disconnect_error");

    const { quota } = getAssistantConfig();
    let allowed: boolean;
    try {
      allowed = (await createQuotaGate(auth.supabase, quota.requestsPerWindow, quota.windowSeconds).consume()).allowed;
    } catch {
      logEvent("error", "mcp_quota_failed", { requestId, route: ROUTE, server: server.id });
      return backToConnectors(request, server.id, "disconnect_error");
    }
    if (!allowed) return backToConnectors(request, server.id, "rate_limited");

    const repo = createMcpAccountRepository(auth.supabase);
    let row;
    try {
      row = await repo.getMcp(auth.userId, server.id);
    } catch {
      logEvent("error", "mcp_disconnect_failed", { requestId, route: ROUTE, server: server.id, step: "read" });
      return backToConnectors(request, server.id, "disconnect_error");
    }
    if (!row) return backToConnectors(request, server.id, "disconnected");

    const key = readyMcpKey(requestId, ROUTE);
    const bundle = key ? await openBundle(key, auth.userId, server, row.subject, row.tokenCiphertext) : null;
    let confirmed = false;
    if (bundle?.revocationEndpoint) {
      confirmed = await revokeToken(mcpFetch, {
        revocationEndpoint: bundle.revocationEndpoint,
        clientId: bundle.clientId,
        token: bundle.refreshToken ?? bundle.accessToken,
        hint: bundle.refreshToken ? "refresh_token" : "access_token",
      });
      if (!confirmed) logEvent("warn", "mcp_revoke_unconfirmed", { requestId, route: ROUTE, server: server.id });
    }

    let deleted: boolean;
    try {
      deleted = await repo.deleteMcp(auth.userId, server.id, row.tokenCiphertext);
    } catch {
      logEvent("error", "mcp_disconnect_failed", { requestId, route: ROUTE, server: server.id, step: "delete" });
      return backToConnectors(request, server.id, "disconnect_error");
    }
    if (!deleted) {
      let left;
      try {
        left = await repo.getMcp(auth.userId, server.id);
      } catch {
        logEvent("error", "mcp_disconnect_failed", { requestId, route: ROUTE, server: server.id, step: "confirm" });
        return backToConnectors(request, server.id, "disconnect_unknown");
      }
      if (left) return backToConnectors(request, server.id, "disconnect_changed");
    }
    return backToConnectors(request, server.id, confirmed ? "disconnected" : "disconnected_unconfirmed");
  });
}
