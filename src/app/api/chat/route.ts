import { MAX_CHAT_BODY_BYTES } from "@/lib/limits";
import { chatRequestSchema } from "@/lib/schemas";
import { createAssistantDeps } from "@/server/assistant/deps";
import { prepareChatTurn, releaseTurn, streamChatTurn } from "@/server/assistant/service";
import { getAssistantConfig } from "@/server/config";
import { toNdjsonStream } from "@/server/http/ndjson";
import { readRequestKey } from "@/server/http/request-key";
import { readJsonBody } from "@/server/http/request";
import { errorResponse } from "@/server/http/responses";
import { withAuthenticatedRoute } from "@/server/http/route";

/**
 * POST /api/chat — send a message (or retry the latest unanswered one) and
 * stream the assistant's reply as NDJSON. See ChatStreamEvent in src/types/api.ts.
 * A send can carry an Idempotency-Key header, so a resend continues the first
 * request instead of repeating it (decision 0012).
 */
export async function POST(request: Request): Promise<Response> {
  return withAuthenticatedRoute(request, { route: "chat", sameOrigin: true }, async ({ auth, requestId }) => {
    const requestKey = readRequestKey(request);
    if (requestKey === "invalid") {
      return errorResponse(400, "invalid_request", "The Idempotency-Key header must be a UUID.", requestId);
    }
    const body = await readJsonBody(request, MAX_CHAT_BODY_BYTES);
    if (!body.ok) return errorResponse(body.status, body.code, body.message, requestId);

    const parsed = chatRequestSchema.safeParse(body.value);
    if (!parsed.success) {
      const messageIssue = parsed.error.issues.find((issue) => issue.path[0] === "message");
      return errorResponse(400, "invalid_request", messageIssue?.message ?? "Invalid request.", requestId);
    }

    // Throws ConfigError (→ 503) when inference is not configured.
    const deps = createAssistantDeps(auth, getAssistantConfig());
    const prepared = await prepareChatTurn(deps, {
      userId: auth.userId,
      requestId,
      request: parsed.data,
      requestKey,
    });
    if (!prepared.ok) {
      return errorResponse(prepared.status, prepared.code, prepared.message, requestId, prepared.headers, {
        ...(prepared.conversationId ? { conversationId: prepared.conversationId } : {}),
      });
    }

    const turn = prepared.turn;
    const stream = toNdjsonStream(streamChatTurn(deps, turn, request.signal), () => releaseTurn(deps, turn));
    return new Response(stream, {
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Accel-Buffering": "no",
        "X-Request-Id": requestId,
      },
    });
  });
}
