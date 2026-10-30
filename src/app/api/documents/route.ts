import {
  DOCUMENT_LIST_LIMIT,
  DOCUMENT_PROCESSING_STALE_MS,
  MAX_DOCUMENT_BODY_BYTES,
  STALE_DOCUMENT_SETTLE_LIMIT,
} from "@/lib/limits";
import { createDocumentSchema, modeSchema } from "@/lib/schemas";
import { budgetRefusal, NebiusHoldTooLargeError } from "@/server/assistant/spend";
import { chunkText } from "@/server/assistant/chunk";
import { createEmbedderForRequest } from "@/server/assistant/deps";
import { EmbeddingBudgetError } from "@/server/assistant/embed";
import { getAssistantConfig } from "@/server/config";
import { RepositoryError } from "@/server/db/conversations";
import { createDocumentRepository } from "@/server/db/documents";
import { clientRequest, readRequestKey } from "@/server/http/request-key";
import { readJsonBody } from "@/server/http/request";
import { errorResponse, jsonResponse } from "@/server/http/responses";
import { withAuthenticatedRoute } from "@/server/http/route";
import { logEvent } from "@/server/log";
import { ProviderError } from "@/server/providers/errors";
import type { DocumentDTO } from "@/types/api";

/**
 * GET /api/documents?mode=personal|work. Lists the signed-in user's documents for one mode.
 * First it settles the user's stale "processing" documents (an upload that stopped
 * before its final status write). If that fails, the list is still returned.
 */
export async function GET(request: Request): Promise<Response> {
  return withAuthenticatedRoute(request, { route: "documents.list" }, async ({ auth, requestId }) => {
    const mode = modeSchema.safeParse(new URL(request.url).searchParams.get("mode"));
    if (!mode.success) return errorResponse(400, "invalid_request", "Choose a mode: personal or work.", requestId);

    const repository = createDocumentRepository(auth.supabase);
    const staleBefore = new Date(Date.now() - DOCUMENT_PROCESSING_STALE_MS);
    await repository.settleStaleDocuments(auth.userId, staleBefore, STALE_DOCUMENT_SETTLE_LIMIT).catch(() => {
      logEvent("warn", "documents_settle_failed", { requestId, route: "documents.list" });
    });

    const documents = await repository.listDocuments(
      auth.userId,
      mode.data,
      DOCUMENT_LIST_LIMIT,
    );
    return jsonResponse({ documents }, requestId);
  });
}

const KEY_MISMATCH = "This request key was used for a different document. Add the document again.";

/**
 * POST /api/documents adds the text of a file (decision 0019). Body: { mode, title, mediaType, text }.
 * The text is split into chunks, embedded and stored. The answer is 201 only
 * when settle_document makes the document "ready". With an Idempotency-Key
 * header, a resend returns or completes the document the first request saved,
 * without a second embedding when its chunks are saved (decision 0012).
 */
export async function POST(request: Request): Promise<Response> {
  return withAuthenticatedRoute(request, { route: "documents.create", sameOrigin: true }, async ({ auth, requestId }) => {
    const requestKey = readRequestKey(request);
    if (requestKey === "invalid") {
      return errorResponse(400, "invalid_request", "The Idempotency-Key header must be a UUID.", requestId);
    }
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
    const keyed = await clientRequest(requestKey, ["document.create.v1", mode, title, mediaType, text]);
    const ready = (document: DocumentDTO) => jsonResponse({ ...document, status: "ready" }, requestId, { status: 201 });

    if (keyed) {
      const saved = await documents.findDocumentByClientRequest(auth.userId, keyed.id);
      if (saved && saved.hash !== keyed.hash) return errorResponse(409, "conflict", KEY_MISMATCH, requestId);
      // A failed settle releases the key, and the upload below runs again.
      if (saved && (await documents.settleDocument(saved.document.id)) === "ready") return ready(saved.document);
    }

    const document = await documents.createDocument(auth.userId, {
      mode,
      title,
      mediaType,
      charCount: text.length,
      clientRequest: keyed,
    });

    try {
      const chunks = chunkText(text);
      const vectors = await embedder.embed(chunks);
      if (vectors.length !== chunks.length) throw new ProviderError("nebius", "bad_response");
      await documents.insertChunks(
        auth.userId,
        document.id,
        chunks.map((content, index) => ({ index, content, embedding: vectors[index]! })),
      );
      const status = await documents.settleDocument(document.id);
      if (status !== "ready") throw new RepositoryError("settleDocument");
    } catch (error) {
      // Settle by the facts: a chunk insert whose response was lost still makes the document ready.
      // If the settle also fails, the document stays "processing"; a resend or the list settles it.
      const status = await documents.settleDocument(document.id).catch(() => {
        logEvent("warn", "document_status_write_failed", {
          requestId,
          route: "documents.create",
          documentId: document.id,
        });
        return null;
      });
      if (status === "ready") return ready(document);

      if (error instanceof EmbeddingBudgetError) {
        const refusal = budgetRefusal(error.limit, new Date());
        return errorResponse(refusal.status, refusal.code, refusal.message, requestId, refusal.headers);
      }
      if (error instanceof NebiusHoldTooLargeError) {
        return errorResponse(413, "payload_too_large", "The document is too large to process.", requestId);
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

    return ready(document);
  });
}
