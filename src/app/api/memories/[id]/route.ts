import { z } from "zod";
import { createMemoryRepository } from "@/server/db/memories";
import { errorResponse, jsonResponse, notFound } from "@/server/http/responses";
import { withAuthenticatedRoute } from "@/server/http/route";

interface Context {
  params: Promise<{ id: string }>;
}

const idSchema = z.string().uuid();

/** GET /api/memories/:id — view a single memory item owned by the signed-in user. */
export async function GET(request: Request, context: Context): Promise<Response> {
  return withAuthenticatedRoute(request, { route: "memories.get" }, async ({ auth, requestId }) => {
    const id = idSchema.safeParse((await context.params).id);
    if (!id.success) return notFound(requestId);

    const repo = createMemoryRepository(auth.supabase);
    const memory = await repo.getMemory(auth.userId, id.data);
    if (!memory) return errorResponse(404, "not_found", "Memory not found.", requestId);

    return jsonResponse(memory, requestId);
  });
}

/** DELETE /api/memories/:id — delete a memory item owned by the signed-in user. */
export async function DELETE(request: Request, context: Context): Promise<Response> {
  return withAuthenticatedRoute(
    request,
    { route: "memories.delete", sameOrigin: true },
    async ({ auth, requestId }) => {
      const id = idSchema.safeParse((await context.params).id);
      if (!id.success) return notFound(requestId);

      const repo = createMemoryRepository(auth.supabase);
      const deleted = await repo.deleteMemory(auth.userId, id.data);
      if (!deleted) return errorResponse(404, "not_found", "Memory not found.", requestId);

      return new Response(null, {
        status: 204,
        headers: { "Cache-Control": "no-store", "X-Request-Id": requestId },
      });
    },
  );
}
