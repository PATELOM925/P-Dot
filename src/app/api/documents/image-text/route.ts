import { MAX_IMAGE_TEXT_BODY_BYTES } from "@/lib/limits";
import { imageTextSchema } from "@/lib/schemas";
import { createImageTextDeps } from "@/server/assistant/deps";
import { readImageText } from "@/server/assistant/image-text";
import { getAssistantConfig } from "@/server/config";
import { readJsonBody } from "@/server/http/request";
import { errorResponse, jsonResponse } from "@/server/http/responses";
import { withAuthenticatedRoute } from "@/server/http/route";
import { logEvent } from "@/server/log";

/**
 * POST /api/documents/image-text reads the text in one image and describes
 * it, for a document (decision 0019). Body: { image } as a JPEG data URL that
 * the browser made smaller. Answers { text }. Nothing is saved here and the
 * image is not kept: the user adds the text with POST /api/documents. The log
 * has only metadata, never the image or the text.
 */
export async function POST(request: Request): Promise<Response> {
  return withAuthenticatedRoute(request, { route: "documents.image_text", sameOrigin: true }, async ({ auth, requestId }) => {
    const body = await readJsonBody(request, MAX_IMAGE_TEXT_BODY_BYTES);
    if (!body.ok) return errorResponse(body.status, body.code, body.message, requestId);
    const parsed = imageTextSchema.safeParse(body.value);
    if (!parsed.success) {
      return errorResponse(400, "invalid_request", parsed.error.issues[0]?.message ?? "Invalid request.", requestId);
    }

    // A missing Nebius key throws ConfigError here: 503 before any quota or spend.
    const deps = createImageTextDeps(auth, getAssistantConfig());
    const result = await readImageText(deps, parsed.data.image, request.signal);
    logEvent(result.ok ? "info" : "warn", "image_text", {
      requestId,
      route: "documents.image_text",
      outcome: result.ok ? "ok" : result.code,
      model: result.report.model,
      attempts: result.report.attempts,
      chars: result.ok ? result.text.length : 0,
    });
    if (!result.ok) return errorResponse(result.status, result.code, result.message, requestId, result.headers);
    return jsonResponse({ text: result.text }, requestId);
  });
}
