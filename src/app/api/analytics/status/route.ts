import { cookieValue, isAnalyticsProductionHost } from "@/server/analytics";
import { withAuthenticatedRoute } from "@/server/http/route";

export async function GET(request: Request): Promise<Response> {
  return withAuthenticatedRoute(request, { route: "analytics-status", sameOrigin: true }, async ({ auth }) => {
    const available = !auth.isAnonymous && isAnalyticsProductionHost(request) && Boolean(process.env.POSTHOG_PROJECT_TOKEN);
    return Response.json({ available, enabled: available && cookieValue(request, "pdot_analytics_consent") === "yes" }, {
      headers: { "Cache-Control": "no-store" },
    });
  });
}
