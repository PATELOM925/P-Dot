import { z } from "zod";
import { MAX_CHAT_BODY_BYTES, MEMORY_LIST_LIMIT } from "@/lib/limits";
import { createMemorySchema, modeSchema } from "@/lib/schemas";
import { createActionLogRepository } from "@/server/db/action-log";
import { createMemoryRepository } from "@/server/db/memories";
import { readJsonBody } from "@/server/http/request";
import { errorResponse, jsonResponse } from "@/server/http/responses";
import { withAuthenticatedRoute } from "@/server/http/route";
import { embedMemoryText } from "@/server/memories/embedding";
import type { MemoryStatus } from "@/types/api";

const statusFilterSchema = z.enum(["proposed", "active"]);

/** GET /api/memories?mode=personal|work&status=proposed|active — the user's memories. */
export async function GET(request: Request): Promise<Response> {
  return withAuthenticatedRoute(request, { route: "memories.list" }, async ({ auth, requestId }) => {
    const params = new URL(request.url).searchParams;

    const mode = modeSchema.safeParse(params.get("mode"));
    if (!mode.success) return errorResponse(400, "invalid_request", "Choose a mode: personal or work.", requestId);

    // The status filter is optional. When it is sent, it must be a valid value.
    let status: MemoryStatus | undefined;
    const rawStatus = params.get("status");
    if (rawStatus !== null) {
      const parsed = statusFilterSchema.safeParse(rawStatus);
      if (!parsed.success) {
        return errorResponse(400, "invalid_request", "Choose a status: proposed or active.", requestId);
      }
      status = parsed.data;
    }

    const memories = await createMemoryRepository(auth.supabase).listMemories(
      auth.userId,
      mode.data,
      status,
      MEMORY_LIST_LIMIT,
    );
    return jsonResponse({ memories }, requestId);
  });
}

/** POST /api/memories — save a memory the user typed. Body: { mode, content }. */
export async function POST(request: Request): Promise<Response> {
  return withAuthenticatedRoute(request, { route: "memories.create", sameOrigin: true }, async ({ auth, requestId }) => {
    const body = await readJsonBody(request, MAX_CHAT_BODY_BYTES);
    if (!body.ok) return errorResponse(body.status, body.code, body.message, requestId);
    const parsed = createMemorySchema.safeParse(body.value);
    if (!parsed.success) {
      return errorResponse(400, "invalid_request", parsed.error.issues[0]?.message ?? "Invalid request.", requestId);
    }

    const embedding = await embedMemoryText(auth, requestId, parsed.data.content);
    const memory = await createMemoryRepository(auth.supabase).createMemory(
      auth.userId,
      {
        mode: parsed.data.mode,
        content: parsed.data.content,
        status: "active",
        source: "user",
        sourceMessageId: null,
      },
      embedding,
    );
    await createActionLogRepository(auth.supabase).append(auth.userId, "memory_added", {
      memoryId: memory.id,
      mode: memory.mode,
      source: memory.source,
    });
    return jsonResponse(memory, requestId, { status: 201 });
  });
}
