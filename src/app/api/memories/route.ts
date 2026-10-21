import { z } from "zod";
import { MAX_CHAT_BODY_BYTES, MEMORY_LIST_LIMIT } from "@/lib/limits";
import { createMemorySchema, modeSchema } from "@/lib/schemas";
import { createMemoryRepository } from "@/server/db/memories";
import { clientRequest, readRequestKey } from "@/server/http/request-key";
import { readJsonBody } from "@/server/http/request";
import { errorResponse, jsonResponse } from "@/server/http/responses";
import { withAuthenticatedRoute } from "@/server/http/route";
import { embedMemoryText } from "@/server/memories/embedding";
import type { MemoryDTO, MemoryStatus } from "@/types/api";

const statusFilterSchema = z.enum(["proposed", "active"]);

/** GET /api/memories?mode=personal|work&status=proposed|active: the user's memories. */
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

const KEY_MISMATCH = "This request key was used for a different memory. Add the memory again.";

/**
 * POST /api/memories: save a memory the user typed. Body: { mode, content }.
 * With an Idempotency-Key header, a resend returns the memory the first
 * request saved, with no second embedding (decision 0012).
 */
export async function POST(request: Request): Promise<Response> {
  return withAuthenticatedRoute(request, { route: "memories.create", sameOrigin: true }, async ({ auth, requestId }) => {
    const requestKey = readRequestKey(request);
    if (requestKey === "invalid") {
      return errorResponse(400, "invalid_request", "The Idempotency-Key header must be a UUID.", requestId);
    }
    const body = await readJsonBody(request, MAX_CHAT_BODY_BYTES);
    if (!body.ok) return errorResponse(body.status, body.code, body.message, requestId);
    const parsed = createMemorySchema.safeParse(body.value);
    if (!parsed.success) {
      return errorResponse(400, "invalid_request", parsed.error.issues[0]?.message ?? "Invalid request.", requestId);
    }
    const { mode, content } = parsed.data;
    const repository = createMemoryRepository(auth.supabase);
    const keyed = await clientRequest(requestKey, ["memory.create.v1", mode, content]);
    const answerSaved = (saved: { memory: MemoryDTO; hash: string }) =>
      saved.hash === keyed?.hash
        ? jsonResponse(saved.memory, requestId, { status: 201 })
        : errorResponse(409, "conflict", KEY_MISMATCH, requestId);

    const savedBefore = keyed ? await repository.findMemoryByClientRequest(auth.userId, keyed.id) : null;
    if (savedBefore) return answerSaved(savedBefore);

    const embedding = await embedMemoryText(auth, requestId, content);
    try {
      const memory = await repository.createMemory(
        auth.userId,
        { mode, content, status: "active", source: "user", sourceMessageId: null, clientRequest: keyed },
        embedding,
      );
      return jsonResponse(memory, requestId, { status: 201 });
    } catch (error) {
      // The insert may have committed (a lost response), or another request with the same key won.
      const saved = keyed ? await repository.findMemoryByClientRequest(auth.userId, keyed.id).catch(() => null) : null;
      if (!saved) throw error;
      return answerSaved(saved);
    }
  });
}
