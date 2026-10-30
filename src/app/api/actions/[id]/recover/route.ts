import { z } from "zod";
import { actionRecoverSchema } from "@/lib/schemas";
import { createActionProposalRepository } from "@/server/db/action-proposals";
import { recoverExternal } from "@/server/google/external-routes";
import { accountRequired } from "@/server/http/account";
import { readJsonBody } from "@/server/http/request";
import { errorResponse } from "@/server/http/responses";
import { withAuthenticatedRoute } from "@/server/http/route";

interface Context {
  params: Promise<{ id: string }>;
}

const idSchema = z.uuid();
const MAX_BODY_BYTES = 1024;

/**
 * POST /api/actions/:id/recover. Body: {} or { answer: "done" | "not_done" }.
 *
 * For a send_email or create_calendar_event left "executing" after its lease
 * (decision 0014). With no answer, P-Dot tries a calendar event once more with
 * the same event ID in the same Google account; it never sends an email again.
 * With an answer, the user says if the action happened; that outcome is not
 * verified.
 */
export async function POST(request: Request, context: Context): Promise<Response> {
  return withAuthenticatedRoute(request, { route: "actions.recover", sameOrigin: true }, async ({ auth, requestId }) => {
    const refused = accountRequired(auth, requestId);
    if (refused) return refused;
    const id = idSchema.safeParse((await context.params).id);
    if (!id.success) return errorResponse(404, "not_found", "Action not found.", requestId);
    const body = await readJsonBody(request, MAX_BODY_BYTES);
    if (!body.ok) return errorResponse(body.status, body.code, body.message, requestId);
    const parsed = actionRecoverSchema.safeParse(body.value);
    if (!parsed.success) return errorResponse(400, "invalid_request", "Invalid request.", requestId);
    return recoverExternal(auth, requestId, createActionProposalRepository(auth.supabase), id.data, parsed.data.answer);
  });
}
