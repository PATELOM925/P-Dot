import { errorResponse } from "@/server/http/responses";
import { withAuthenticatedRoute } from "@/server/http/route";
import { isAnalyticsProductionHost } from "@/server/analytics";
import { readJsonBody } from "@/server/http/request";

export async function POST(request: Request): Promise<Response> {
  return withAuthenticatedRoute(request, { route: "analytics-consent", sameOrigin: true }, async ({ auth, requestId }) => {
    if (auth.isAnonymous || !isAnalyticsProductionHost(request) || !process.env.POSTHOG_PROJECT_TOKEN) {
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
    response.headers.append("Set-Cookie", `pdot_analytics_consent=${enabled ? "yes" : "no"}; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly${secure}`);
    response.headers.append("Set-Cookie", `pdot_analytics_id=${id}; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly${secure}`);
    return response;
  });
}
