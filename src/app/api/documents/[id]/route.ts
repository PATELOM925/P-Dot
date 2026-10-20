import { z } from "zod";
import { createDocumentRepository } from "@/server/db/documents";
import { errorResponse, jsonResponse, notFound } from "@/server/http/responses";
import { withAuthenticatedRoute } from "@/server/http/route";

interface Context {
  params: Promise<{ id: string }>;
}

const idSchema = z.uuid();

/** GET /api/documents/:id — details of one document owned by the signed-in user. */
export async function GET(request: Request, context: Context): Promise<Response> {
  return withAuthenticatedRoute(request, { route: "documents.get" }, async ({ auth, requestId }) => {
    const id = idSchema.safeParse((await context.params).id);
    if (!id.success) return notFound(requestId);

    const repo = createDocumentRepository(auth.supabase);
    const document = await repo.getDocument(auth.userId, id.data);
    if (!document) return errorResponse(404, "not_found", "Document not found.", requestId);

    return jsonResponse(document, requestId);
  });
}

/** DELETE /api/documents/:id — permanently removes the document and all associated vector chunks. */
export async function DELETE(request: Request, context: Context): Promise<Response> {
  return withAuthenticatedRoute(
    request,
    { route: "documents.delete", sameOrigin: true },
    async ({ auth, requestId }) => {
      const id = idSchema.safeParse((await context.params).id);
      if (!id.success) return notFound(requestId);

      const repo = createDocumentRepository(auth.supabase);
      const deleted = await repo.deleteDocument(auth.userId, id.data);
      if (!deleted) return errorResponse(404, "not_found", "Document not found.", requestId);

      return new Response(null, {
        status: 204,
        headers: { "Cache-Control": "no-store", "X-Request-Id": requestId },
      });
    },
  );
}
