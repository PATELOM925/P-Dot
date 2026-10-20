import { DOCUMENT_LIST_LIMIT, MAX_DOCUMENT_BODY_BYTES } from "@/lib/limits";
import { createDocumentSchema, modeSchema } from "@/lib/schemas";
import { budgetRefusal } from "@/server/assistant/spend";
import { chunkText } from "@/server/assistant/chunk";
import { createEmbedderForRequest } from "@/server/assistant/deps";
import { EmbeddingBudgetError } from "@/server/assistant/embed";
import { getAssistantConfig } from "@/server/config";
import { createDocumentRepository } from "@/server/db/documents";
import { readJsonBody } from "@/server/http/request";
import { errorResponse, jsonResponse } from "@/server/http/responses";
import { withAuthenticatedRoute } from "@/server/http/route";
import { ProviderError } from "@/server/providers/errors";

/** GET /api/documents?mode=personal|work. Lists the signed-in user's documents for one mode. */
export async function GET(request: Request): Promise<Response> {
  return withAuthenticatedRoute(request, { route: "documents.list" }, async ({ auth, requestId }) => {
    const mode = modeSchema.safeParse(new URL(request.url).searchParams.get("mode"));
    if (!mode.success) return errorResponse(400, "invalid_request", "Choose a mode: personal or work.", requestId);

    const documents = await createDocumentRepository(auth.supabase).listDocuments(
      auth.userId,
      mode.data,
      DOCUMENT_LIST_LIMIT,
    );
    return jsonResponse({ documents }, requestId);
  });
}

/**
 * POST /api/documents uploads plain text or Markdown. Body: { mode, title, mediaType, text }.
 * The text is split into chunks, embedded and stored. The document is "ready"
 * only when every step worked; otherwise it is "failed".
 */
export async function POST(request: Request): Promise<Response> {
  return withAuthenticatedRoute(request, { route: "documents.create", sameOrigin: true }, async ({ auth, requestId }) => {
    const body = await readJsonBody(request, MAX_DOCUMENT_BODY_BYTES);
    if (!body.ok) return errorResponse(body.status, body.code, body.message, requestId);
    const parsed = createDocumentSchema.safeParse(body.value);
    if (!parsed.success) {
      return errorResponse(400, "invalid_request", parsed.error.issues[0]?.message ?? "Invalid request.", requestId);
    }
    const { mode, title, mediaType, text } = parsed.data;

    // Read the config first: a missing key must fail before any document exists.
    const config = getAssistantConfig();
    const embedder = createEmbedderForRequest(auth, config);
    const documents = createDocumentRepository(auth.supabase);
    const document = await documents.createDocument(auth.userId, { mode, title, mediaType, charCount: text.length });

    try {
      const chunks = chunkText(text);
      const vectors = await embedder.embed(chunks);
      if (vectors.length !== chunks.length) throw new ProviderError("nebius", "bad_response");
      await documents.insertChunks(
        auth.userId,
        document.id,
        chunks.map((content, index) => ({ index, content, embedding: vectors[index]! })),
      );
      await documents.setStatus(auth.userId, document.id, "ready");
    } catch (error) {
      // Mark the document failed. A failure while marking is ignored, so the first error still reaches the user.
      await documents.setStatus(auth.userId, document.id, "failed").catch(() => {});

      if (error instanceof EmbeddingBudgetError) {
        const refusal = budgetRefusal(error.limit, new Date());
        return errorResponse(refusal.status, refusal.code, refusal.message, requestId, refusal.headers);
      }
      if (error instanceof ProviderError) {
        return errorResponse(
          502,
          "provider_unavailable",
          "The document could not be processed. Please retry.",
          requestId,
        );
      }
      throw error;
    }

    return jsonResponse({ ...document, status: "ready" }, requestId, { status: 201 });
  });
}
