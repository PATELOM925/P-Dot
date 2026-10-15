import "server-only";
import { ConfigError } from "@/lib/supabase-config";
import { getAuthContext, type AuthContext } from "@/server/auth/session";
import { logEvent } from "@/server/log";
import { isSameOrigin } from "./request";
import { errorResponse, newRequestId, notConfigured, unauthorized } from "./responses";

interface RouteOptions {
  route: string;
  /** Reject browser requests from other origins (use for state-changing methods). */
  sameOrigin?: boolean;
}

/**
 * Common wrapper for private API routes: request ID, origin check, verified
 * session, timing log, and a JSON 500 instead of an HTML error page.
 */
export async function withAuthenticatedRoute(
  request: Request,
  options: RouteOptions,
  handler: (ctx: { auth: AuthContext; requestId: string }) => Promise<Response>,
): Promise<Response> {
  const requestId = newRequestId();
  const startedAt = Date.now();
  const finish = (response: Response) => {
    logEvent(response.status >= 500 ? "error" : "info", "api_request", {
      requestId,
      route: options.route,
      method: request.method,
      status: response.status,
      durationMs: Date.now() - startedAt,
    });
    return response;
  };

  try {
    if (options.sameOrigin && !isSameOrigin(request)) {
      return finish(errorResponse(403, "forbidden", "Cross-origin requests are not allowed.", requestId));
    }
    const auth = await getAuthContext();
    if (!auth) return finish(unauthorized(requestId));
    return finish(await handler({ auth, requestId }));
  } catch (error) {
    if (error instanceof ConfigError) {
      logEvent("error", "config_missing", { requestId, route: options.route, missing: error.missing.join(",") });
      return finish(notConfigured(requestId));
    }
    logEvent("error", "unhandled_route_error", {
      requestId,
      route: options.route,
      errorName: error instanceof Error ? error.name : "unknown",
    });
    return finish(errorResponse(500, "internal_error", "Something went wrong. Please retry.", requestId));
  }
}
