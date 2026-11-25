import { captureProductEvent, cookieValue, isAnalyticsProductionHost } from "@/server/analytics";
import { errorResponse } from "@/server/http/responses";
import { withAuthenticatedRoute } from "@/server/http/route";
import { readJsonBody } from "@/server/http/request";

export async function POST(request: Request): Promise<Response> {
  return withAuthenticatedRoute(request, { route: "analytics-active", sameOrigin: true }, async ({ auth, requestId }) => {
    if (auth.isAnonymous || !isAnalyticsProductionHost(request) || cookieValue(request, "pdot_analytics_consent") !== "yes") {
      return errorResponse(404, "not_found", "Not found.", requestId);
    }
    const parsed = await readJsonBody(request, 128);
    if (!parsed.ok) return errorResponse(parsed.status, parsed.code, parsed.message, requestId);
    const body = parsed.value;
    if (!body || typeof body !== "object" || !("seconds" in body) || typeof body.seconds !== "number" || !Number.isInteger(body.seconds) || body.seconds < 1 || body.seconds > 30) {
      return errorResponse(400, "invalid_request", "Invalid activity interval.", requestId);
    }
    const id = cookieValue(request, "pdot_analytics_id");
    if (id) await captureProductEvent("workspace_active_seconds", id, { seconds: body.seconds });
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  });
}
