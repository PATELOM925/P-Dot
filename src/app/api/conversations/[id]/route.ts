import { z } from "zod";
import { CONVERSATION_MESSAGE_LIMIT, MAX_CHAT_BODY_BYTES } from "@/lib/limits";
import { renameConversationSchema } from "@/lib/schemas";
import type { ConversationDetail } from "@/types/api";
import { createConversationRepository } from "@/server/db/conversations";
import { readJsonBody } from "@/server/http/request";
import { errorResponse, jsonResponse, notFound } from "@/server/http/responses";
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
    const detail: ConversationDetail = {
      id: conversation.id,
      title: conversation.title,
      mode: conversation.mode,
      messages,
    };
    return jsonResponse(detail, requestId);
  });
}

/** PATCH /api/conversations/:id — rename a conversation. Body: { title }. */
export async function PATCH(request: Request, context: Context): Promise<Response> {
  return withAuthenticatedRoute(
    request,
    { route: "conversations.rename", sameOrigin: true },
    async ({ auth, requestId }) => {
      const id = idSchema.safeParse((await context.params).id);
      if (!id.success) return notFound(requestId);

      const body = await readJsonBody(request, MAX_CHAT_BODY_BYTES);
      if (!body.ok) return errorResponse(body.status, body.code, body.message, requestId);
      const parsed = renameConversationSchema.safeParse(body.value);
      if (!parsed.success) {
        return errorResponse(400, "invalid_request", parsed.error.issues[0]?.message ?? "Invalid request.", requestId);
      }

      const repo = createConversationRepository(auth.supabase);
      const renamed = await repo.renameConversation(auth.userId, id.data, parsed.data.title);
      if (!renamed) return notFound(requestId);
      return jsonResponse(renamed, requestId);
    },
  );
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
