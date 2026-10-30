import { FEEDBACK_DAILY_LIMIT } from "@/lib/limits";
import { feedbackSchema } from "@/lib/schemas";
import { createFeedbackRepository } from "@/server/db/feedback";
import { readJsonBody } from "@/server/http/request";
import { errorResponse, jsonResponse } from "@/server/http/responses";
import { withAuthenticatedRoute } from "@/server/http/route";

const MAX_FEEDBACK_BODY_BYTES = 4 * 1024;

/** POST /api/feedback — send one "What should P-Dot connect to next?" request. Body: { kind, text? }. */
export async function POST(request: Request): Promise<Response> {
  return withAuthenticatedRoute(request, { route: "feedback.create", sameOrigin: true }, async ({ auth, requestId }) => {
    const body = await readJsonBody(request, MAX_FEEDBACK_BODY_BYTES);
    if (!body.ok) return errorResponse(body.status, body.code, body.message, requestId);
    const parsed = feedbackSchema.safeParse(body.value);
    if (!parsed.success) {
      return errorResponse(400, "invalid_request", parsed.error.issues[0]?.message ?? "Invalid request.", requestId);
    }

    const result = await createFeedbackRepository(auth.supabase).send(parsed.data);
    if (result === "rate_limited") {
      return errorResponse(
        429,
        "rate_limited",
        `You can send ${FEEDBACK_DAILY_LIMIT} requests in one day. Try again tomorrow.`,
        requestId,
      );
    }
    return jsonResponse({ ok: true }, requestId, { status: 201 });
  });
}
