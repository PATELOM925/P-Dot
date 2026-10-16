import { CONVERSATION_LIST_LIMIT } from "@/lib/limits";
import { createConversationRepository } from "@/server/db/conversations";
import { modeSchema } from "@/lib/schemas";
import { errorResponse, jsonResponse } from "@/server/http/responses";
import { withAuthenticatedRoute } from "@/server/http/route";

/** GET /api/conversations[?mode=] — the signed-in user's conversations, most recent first. */
export async function GET(request: Request): Promise<Response> {
  return withAuthenticatedRoute(request, { route: "conversations.list" }, async ({ auth, requestId }) => {
    // Optional ?mode=personal|work limits the list to one side.
    const rawMode = new URL(request.url).searchParams.get("mode");
    const mode = rawMode === null ? undefined : modeSchema.safeParse(rawMode);
    if (mode && !mode.success) return errorResponse(400, "invalid_request", "Unknown mode.", requestId);

    const repo = createConversationRepository(auth.supabase);
    const conversations = await repo.listConversations(auth.userId, CONVERSATION_LIST_LIMIT, mode?.data);
    return jsonResponse({ conversations }, requestId);
  });
}
