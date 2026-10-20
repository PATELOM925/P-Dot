import { z } from "zod";
import { getAssistantConfig } from "@/server/config";
import { createConversationRepository } from "@/server/db/conversations";
import { createMemoryRepository } from "@/server/db/memories";
import { errorResponse, jsonResponse } from "@/server/http/responses";
import { withAuthenticatedRoute } from "@/server/http/route";
import { logEvent } from "@/server/log";
import { summarizeSession } from "@/server/memory/summarizer";
import { streamChatCompletion } from "@/server/providers/nebius/client";
import { createSingleEmbedding } from "@/server/providers/nebius/embeddings";

const summarizeRequestSchema = z.object({
  conversationId: z.string().uuid(),
});

/**
 * POST /api/memories/summarize
 * Asynchronously processes a conversation transcript to distill durable personal facts
 * into user_memories with embeddings and deduplication.
 */
export async function POST(request: Request): Promise<Response> {
  return withAuthenticatedRoute(
    request,
    { route: "memories.summarize", sameOrigin: true },
    async ({ auth, requestId }) => {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return errorResponse(400, "invalid_request", "Invalid JSON payload.", requestId);
      }

      const parsed = summarizeRequestSchema.safeParse(body);
      if (!parsed.success) {
        return errorResponse(400, "invalid_request", "Valid conversationId UUID is required.", requestId);
      }

      let config;
      try {
        config = getAssistantConfig();
      } catch {
        return errorResponse(503, "not_configured", "Assistant configuration is missing.", requestId);
      }

      const convRepo = createConversationRepository(auth.supabase);
      const conversation = await convRepo.getConversation(auth.userId, parsed.data.conversationId);
      if (!conversation) {
        return errorResponse(404, "not_found", "Conversation not found.", requestId);
      }

      const recentMessages = await convRepo.listRecentMessages(auth.userId, conversation.id, 100);
      if (recentMessages.length < 2) {
        return jsonResponse(
          {
            ok: true,
            extractedCount: 0,
            createdCount: 0,
            updatedCount: 0,
            memories: [],
            message: "Conversation does not have enough context for episodic summarization.",
          },
          requestId,
        );
      }

      const transcript = recentMessages.map((m) => ({
        role: m.role,
        content: m.content,
      }));

      const memoryRepo = createMemoryRepository(auth.supabase);

      try {
        const result = await summarizeSession(
          auth.userId,
          transcript,
          {
            complete: (messages, signal) =>
              streamChatCompletion(config.nebius, messages, { signal }),
            embed: (text, signal) =>
              createSingleEmbedding(
                {
                  apiKey: config.nebius.apiKey,
                  baseUrl: config.nebius.baseUrl,
                  model: config.nebius.embeddingModel,
                },
                text,
                { signal },
              ),
            memoryRepo,
            log: logEvent,
          },
        );

        return jsonResponse({ ok: true, ...result }, requestId);
      } catch (error) {
        logEvent("error", "session_summarization_failed", {
          conversationId: conversation.id,
          error: error instanceof Error ? error.message : String(error),
        });
        return errorResponse(
          500,
          "internal_error",
          error instanceof Error ? error.message : "Session summarization failed.",
          requestId,
        );
      }
    },
  );
}
