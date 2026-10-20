import { z } from "zod";
import { getAssistantConfig } from "@/server/config";
import { createDocumentRepository } from "@/server/db/documents";
import { errorResponse, jsonResponse } from "@/server/http/responses";
import { withAuthenticatedRoute } from "@/server/http/route";
import { createEmbeddings } from "@/server/providers/nebius/embeddings";
import { ingestDocumentText } from "@/server/rag/ingestion";

const ingestRequestSchema = z.object({
  filename: z.string().trim().min(1).max(255),
  content: z.string().trim().min(1).max(500_000),
  mimeType: z.string().trim().max(100).optional(),
});

/** GET /api/documents — list all uploaded documents for the signed-in user. */
export async function GET(request: Request): Promise<Response> {
  return withAuthenticatedRoute(request, { route: "documents.list" }, async ({ auth, requestId }) => {
    const repo = createDocumentRepository(auth.supabase);
    const documents = await repo.listDocuments(auth.userId);
    return jsonResponse({ documents }, requestId);
  });
}

/** POST /api/documents — chunk, embed, and ingest a new document for personal vector RAG. */
export async function POST(request: Request): Promise<Response> {
  return withAuthenticatedRoute(
    request,
    { route: "documents.ingest", sameOrigin: true },
    async ({ auth, requestId }) => {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return errorResponse(400, "invalid_request", "Invalid JSON payload.", requestId);
      }

      const parsed = ingestRequestSchema.safeParse(body);
      if (!parsed.success) {
        return errorResponse(400, "invalid_request", "Invalid document data.", requestId);
      }

      let config;
      try {
        config = getAssistantConfig();
      } catch {
        return errorResponse(503, "not_configured", "Assistant configuration is missing.", requestId);
      }

      const repo = createDocumentRepository(auth.supabase);

      try {
        const result = await ingestDocumentText({
          repo,
          embed: (texts) =>
            createEmbeddings(
              {
                apiKey: config.nebius.apiKey,
                baseUrl: config.nebius.baseUrl,
                model: config.nebius.embeddingModel,
              },
              texts,
            ),
          userId: auth.userId,
          filename: parsed.data.filename,
          content: parsed.data.content,
          mimeType: parsed.data.mimeType,
        });

        return jsonResponse(result, requestId, { status: 201 });
      } catch (error) {
        return errorResponse(
          500,
          "internal_error",
          error instanceof Error ? error.message : "Failed to ingest document.",
          requestId,
        );
      }
    },
  );
}
