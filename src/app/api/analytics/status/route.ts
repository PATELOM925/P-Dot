import { accountAnalyticsCookie, isAnalyticsAccountEligible, isAnalyticsConfigured, isAnalyticsProductionHost } from "@/server/analytics";
import { withAuthenticatedRoute } from "@/server/http/route";

export async function GET(request: Request): Promise<Response> {
  return withAuthenticatedRoute(request, { route: "analytics-status", sameOrigin: true }, async ({ auth }) => {
    const available = !auth.isAnonymous && isAnalyticsAccountEligible(request, auth.userId) && isAnalyticsProductionHost(request) && isAnalyticsConfigured();
    return Response.json({ available, enabled: available && accountAnalyticsCookie(request, auth.userId, "pdot_analytics_consent") === "yes" }, {
      headers: { "Cache-Control": "no-store" },
    });
  });
}
