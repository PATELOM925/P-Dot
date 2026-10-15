import { z } from "zod";
import { CONVERSATION_MESSAGE_LIMIT } from "@/lib/limits";
import type { ConversationDetail } from "@/types/api";
import { createConversationRepository } from "@/server/db/conversations";
import { jsonResponse, notFound } from "@/server/http/responses";
import { withAuthenticatedRoute } from "@/server/http/route";

interface Context {
  params: Promise<{ id: string }>;
}

const idSchema = z.uuid();

/** GET /api/conversations/:id — one conversation with its messages. */
export async function GET(request: Request, context: Context): Promise<Response> {
  return withAuthenticatedRoute(request, { route: "conversations.get" }, async ({ auth, requestId }) => {
    const id = idSchema.safeParse((await context.params).id);
    // Malformed, missing, and other users' IDs all look the same: 404.
    if (!id.success) return notFound(requestId);

    const repo = createConversationRepository(auth.supabase);
    const conversation = await repo.getConversation(auth.userId, id.data);
    if (!conversation) return notFound(requestId);

    const messages = await repo.listRecentMessages(auth.userId, conversation.id, CONVERSATION_MESSAGE_LIMIT);
    const detail: ConversationDetail = { id: conversation.id, title: conversation.title, messages };
    return jsonResponse(detail, requestId);
  });
}

/** DELETE /api/conversations/:id — permanently removes the conversation and its messages. */
export async function DELETE(request: Request, context: Context): Promise<Response> {
  return withAuthenticatedRoute(
    request,
    { route: "conversations.delete", sameOrigin: true },
    async ({ auth, requestId }) => {
      const id = idSchema.safeParse((await context.params).id);
      if (!id.success) return notFound(requestId);

      const repo = createConversationRepository(auth.supabase);
      const deleted = await repo.deleteConversation(auth.userId, id.data);
      if (!deleted) return notFound(requestId);
      return new Response(null, { status: 204, headers: { "Cache-Control": "no-store", "X-Request-Id": requestId } });
    },
  );
}
