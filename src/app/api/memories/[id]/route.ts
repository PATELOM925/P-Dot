import { z } from "zod";
import { MAX_CHAT_BODY_BYTES } from "@/lib/limits";
import { updateMemorySchema } from "@/lib/schemas";
import { createActionLogRepository } from "@/server/db/action-log";
import { createMemoryRepository } from "@/server/db/memories";
import { readJsonBody } from "@/server/http/request";
import { errorResponse, jsonResponse } from "@/server/http/responses";
import { withAuthenticatedRoute } from "@/server/http/route";
import { embedMemoryText } from "@/server/memories/embedding";

interface Context {
  params: Promise<{ id: string }>;
}

const idSchema = z.uuid();

const memoryNotFound = (requestId: string) => errorResponse(404, "not_found", "Memory not found.", requestId);

/** PATCH /api/memories/:id: edit the text or mode, or approve a proposed memory. */
export async function PATCH(request: Request, context: Context): Promise<Response> {
  return withAuthenticatedRoute(request, { route: "memories.update", sameOrigin: true }, async ({ auth, requestId }) => {
    const id = idSchema.safeParse((await context.params).id);
    if (!id.success) return memoryNotFound(requestId);

    const body = await readJsonBody(request, MAX_CHAT_BODY_BYTES);
    if (!body.ok) return errorResponse(body.status, body.code, body.message, requestId);
    const parsed = updateMemorySchema.safeParse(body.value);
    if (!parsed.success) {
      return errorResponse(400, "invalid_request", parsed.error.issues[0]?.message ?? "Invalid request.", requestId);
    }

    // Only a new text needs a new vector. A mode or status change keeps the
    // stored vector, so it does not call the embedder.
    const changes = parsed.data;
    const embedding = changes.content === undefined ? undefined : await embedMemoryText(auth, requestId, changes.content);

    const memory = await createMemoryRepository(auth.supabase).updateMemory(auth.userId, id.data, changes, embedding);
    if (!memory) return memoryNotFound(requestId);

    await createActionLogRepository(auth.supabase).append(auth.userId, "memory_edited", {
      memoryId: memory.id,
      mode: memory.mode,
      source: memory.source,
    });
    return jsonResponse(memory, requestId);
  });
}

/** DELETE /api/memories/:id: remove a memory and its vector. */
export async function DELETE(request: Request, context: Context): Promise<Response> {
  return withAuthenticatedRoute(request, { route: "memories.delete", sameOrigin: true }, async ({ auth, requestId }) => {
    const id = idSchema.safeParse((await context.params).id);
    if (!id.success) return memoryNotFound(requestId);

    // Read the row first so the log can name its mode and source.
    const memories = createMemoryRepository(auth.supabase);
    const existing = await memories.getMemory(auth.userId, id.data);
    if (!existing) return memoryNotFound(requestId);
    const deleted = await memories.deleteMemory(auth.userId, id.data);
    if (!deleted) return memoryNotFound(requestId);

    await createActionLogRepository(auth.supabase).append(auth.userId, "memory_deleted", {
      memoryId: existing.id,
      mode: existing.mode,
      source: existing.source,
    });
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store", "X-Request-Id": requestId } });
  });
}
