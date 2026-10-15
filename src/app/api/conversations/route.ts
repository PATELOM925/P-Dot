import { CONVERSATION_LIST_LIMIT } from "@/lib/limits";
import { createConversationRepository } from "@/server/db/conversations";
import { jsonResponse } from "@/server/http/responses";
import { withAuthenticatedRoute } from "@/server/http/route";

/** GET /api/conversations — the signed-in user's conversations, most recent first. */
export async function GET(request: Request): Promise<Response> {
  return withAuthenticatedRoute(request, { route: "conversations.list" }, async ({ auth, requestId }) => {
    const repo = createConversationRepository(auth.supabase);
    const conversations = await repo.listConversations(auth.userId, CONVERSATION_LIST_LIMIT);
    return jsonResponse({ conversations }, requestId);
  });
}
