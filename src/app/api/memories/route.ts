import { z } from "zod";
import { getAssistantConfig } from "@/server/config";
import { createMemoryRepository, type MemoryCategory } from "@/server/db/memories";
import { errorResponse, jsonResponse } from "@/server/http/responses";
import { withAuthenticatedRoute } from "@/server/http/route";
import { createSingleEmbedding } from "@/server/providers/nebius/embeddings";

const categorySchema = z.enum(["preference", "fact", "work", "personal", "general"]);

const createMemorySchema = z.object({
  content: z.string().trim().min(1).max(2000),
  category: categorySchema.optional().default("general"),
});

/** GET /api/memories — list saved personal memories for the signed-in user. */
export async function GET(request: Request): Promise<Response> {
  return withAuthenticatedRoute(request, { route: "memories.list" }, async ({ auth, requestId }) => {
    const url = new URL(request.url);
    const categoryParam = url.searchParams.get("category");
    const limitParam = url.searchParams.get("limit");
    const offsetParam = url.searchParams.get("offset");

    const categoryParsed = categoryParam ? categorySchema.safeParse(categoryParam) : null;
    const category: MemoryCategory | undefined = categoryParsed?.success ? categoryParsed.data : undefined;
    const limit = limitParam ? Math.min(Math.max(parseInt(limitParam, 10) || 20, 1), 100) : 50;
    const offset = offsetParam ? Math.max(parseInt(offsetParam, 10) || 0, 0) : 0;

    const repo = createMemoryRepository(auth.supabase);
    const memories = await repo.listMemories(auth.userId, { category, limit, offset });
    return jsonResponse({ memories }, requestId);
  });
}

/** POST /api/memories — embed and persist a new user memory item. */
export async function POST(request: Request): Promise<Response> {
  return withAuthenticatedRoute(
    request,
    { route: "memories.create", sameOrigin: true },
    async ({ auth, requestId }) => {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return errorResponse(400, "invalid_request", "Invalid JSON payload.", requestId);
      }

      const parsed = createMemorySchema.safeParse(body);
      if (!parsed.success) {
        return errorResponse(400, "invalid_request", "Invalid memory content or category.", requestId);
      }

      let config;
      try {
        config = getAssistantConfig();
      } catch {
        return errorResponse(503, "not_configured", "Assistant configuration is missing.", requestId);
      }

      try {
        const embedding = await createSingleEmbedding(
          {
            apiKey: config.nebius.apiKey,
            baseUrl: config.nebius.baseUrl,
            model: config.nebius.embeddingModel,
          },
          parsed.data.content,
        );

        const repo = createMemoryRepository(auth.supabase);
        const memory = await repo.createMemory(auth.userId, {
          content: parsed.data.content,
          category: parsed.data.category,
          embedding,
        });

        return jsonResponse({ memory }, requestId, { status: 201 });
      } catch (error) {
        return errorResponse(
          500,
          "internal_error",
          error instanceof Error ? error.message : "Failed to save memory.",
          requestId,
        );
      }
    },
  );
}
