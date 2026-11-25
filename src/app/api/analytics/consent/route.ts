import { errorResponse } from "@/server/http/responses";
import { withAuthenticatedRoute } from "@/server/http/route";
import { captureProductEvent, isAnalyticsAccountEligible, isAnalyticsConfigured, isAnalyticsProductionHost } from "@/server/analytics";
import { readJsonBody } from "@/server/http/request";

export async function POST(request: Request): Promise<Response> {
  return withAuthenticatedRoute(request, { route: "analytics-consent", sameOrigin: true }, async ({ auth, requestId }) => {
    if (auth.isAnonymous || !isAnalyticsAccountEligible(request, auth.userId) || !isAnalyticsProductionHost(request) || !isAnalyticsConfigured()) {
      return errorResponse(404, "not_found", "Not found.", requestId);
    }
    const body = await readJsonBody(request, 128);
    if (!body.ok) return errorResponse(body.status, body.code, body.message, requestId);
    const value = body.value;
    if (!value || typeof value !== "object" || !("enabled" in value) || typeof value.enabled !== "boolean") {
      return errorResponse(400, "invalid_request", "Choose whether to enable optional analytics.", requestId);
    }
    const enabled = value.enabled;
    const id = crypto.randomUUID();
    const response = new Response(JSON.stringify({ ok: true, enabled }), {
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
    const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
    response.headers.append("Set-Cookie", `pdot_analytics_consent=${enabled ? `${auth.userId}.yes` : ""}; Path=/; Max-Age=${enabled ? 31536000 : 0}; SameSite=Lax; HttpOnly${secure}`);
    response.headers.append("Set-Cookie", `pdot_analytics_id=${enabled ? `${auth.userId}.${id}` : ""}; Path=/; Max-Age=${enabled ? 31536000 : 0}; SameSite=Lax; HttpOnly${secure}`);
    if (enabled) await captureProductEvent("account_analytics_started", id, {});
    return response;
  });
}
