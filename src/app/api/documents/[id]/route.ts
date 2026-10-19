import { z } from "zod";
import { createActionLogRepository } from "@/server/db/action-log";
import { createDocumentRepository } from "@/server/db/documents";
import { errorResponse } from "@/server/http/responses";
import { withAuthenticatedRoute } from "@/server/http/route";

interface Context {
  params: Promise<{ id: string }>;
}

const idSchema = z.uuid();

const documentNotFound = (requestId: string) =>
  errorResponse(404, "not_found", "Document not found.", requestId);

/** DELETE /api/documents/:id. Removes a document and all its chunks. */
export async function DELETE(request: Request, context: Context): Promise<Response> {
  return withAuthenticatedRoute(request, { route: "documents.delete", sameOrigin: true }, async ({ auth, requestId }) => {
    const id = idSchema.safeParse((await context.params).id);
    if (!id.success) return documentNotFound(requestId);

    const deleted = await createDocumentRepository(auth.supabase).deleteDocument(auth.userId, id.data);
    if (!deleted) return documentNotFound(requestId);

    await createActionLogRepository(auth.supabase).append(auth.userId, "document_deleted", { documentId: id.data });
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store", "X-Request-Id": requestId } });
  });
}
