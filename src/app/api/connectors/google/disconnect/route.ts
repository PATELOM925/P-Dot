import { createConnectedAccountRepository } from "@/server/db/connected-accounts";
import { backToConnectors, googleFetch, readyGoogleConfig } from "@/server/google/connect-flow";
import { openText, tokenAssociatedData } from "@/server/google/crypto";
import { GoogleApiError } from "@/server/google/http";
import { revokeToken } from "@/server/google/oauth";
import { withAuthenticatedRoute } from "@/server/http/route";
import { logEvent } from "@/server/log";

const ROUTE = "connectors.google.disconnect";

/**
 * POST /api/connectors/google/disconnect, from the Disconnect button's form.
 * Revokes the refresh token at Google, then deletes the row (decision 0014).
 * The row is deleted also when Google does not confirm, because the user
 * asked to stop; the answer then says so. A retry is safe: Google answers 400
 * for a token that already ended, and a missing row is "disconnected".
 */
export async function POST(request: Request): Promise<Response> {
  return withAuthenticatedRoute(request, { route: ROUTE, sameOrigin: true }, async ({ auth, requestId }) => {
    const repo = createConnectedAccountRepository(auth.supabase);
    let row;
    try {
      row = await repo.getGoogleToken(auth.userId);
    } catch {
      logEvent("error", "google_disconnect_failed", { requestId, route: ROUTE, step: "read" });
      return backToConnectors(request, "disconnect_error");
    }
    if (!row) return backToConnectors(request, "disconnected");

    let confirmed = false;
    const config = readyGoogleConfig(requestId, ROUTE);
    const token = config
      ? await openText(config.encryptionKey, row.tokenCiphertext, tokenAssociatedData(auth.userId, "google"))
      : null;
    if (token !== null) {
      try {
        await revokeToken(googleFetch, token);
        confirmed = true;
      } catch (error) {
        logEvent("warn", "google_revoke_unconfirmed", {
          requestId,
          route: ROUTE,
          kind: error instanceof GoogleApiError ? error.kind : "unknown",
        });
      }
    }

    try {
      await repo.deleteGoogle(auth.userId);
    } catch {
      logEvent("error", "google_disconnect_failed", { requestId, route: ROUTE, step: "delete" });
      return backToConnectors(request, "disconnect_error");
    }
    return backToConnectors(request, confirmed ? "disconnected" : "disconnected_unconfirmed");
  });
}
