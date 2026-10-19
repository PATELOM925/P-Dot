import { ACTION_LOG_LIMIT } from "@/lib/limits";
import { createActionLogRepository } from "@/server/db/action-log";
import { jsonResponse } from "@/server/http/responses";
import { withAuthenticatedRoute } from "@/server/http/route";

/** GET /api/action-log: the signed-in user's recent actions, newest first. IDs and counts only. */
export async function GET(request: Request): Promise<Response> {
  return withAuthenticatedRoute(request, { route: "actionLog.list" }, async ({ auth, requestId }) => {
    const entries = await createActionLogRepository(auth.supabase).list(auth.userId, ACTION_LOG_LIMIT);
    return jsonResponse({ entries }, requestId);
  });
}
