import { ACTION_LOG_LIMIT } from "@/lib/limits";
import { listPrivateSourceActivity } from "@/server/db/activity-policy";
import { jsonResponse } from "@/server/http/responses";
import { withAuthenticatedRoute } from "@/server/http/route";

export async function GET(request: Request): Promise<Response> {
  return withAuthenticatedRoute(request, { route: "activity.policy", sameOrigin: true }, async ({ auth, requestId }) => {
    const entries = await listPrivateSourceActivity(auth.supabase, auth.userId, ACTION_LOG_LIMIT);
    return jsonResponse({ entries }, requestId);
  });
}
