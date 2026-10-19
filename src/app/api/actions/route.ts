import { z } from "zod";
import { ACTION_LIST_LIMIT } from "@/lib/limits";
import { createActionProposalRepository } from "@/server/db/action-proposals";
import { errorResponse, jsonResponse } from "@/server/http/responses";
import { withAuthenticatedRoute } from "@/server/http/route";

const statusFilterSchema = z.enum(["proposed", "approved", "rejected", "executed", "failed"]);

/** GET /api/actions?status=: the signed-in user's action proposals, newest first. */
export async function GET(request: Request): Promise<Response> {
  return withAuthenticatedRoute(request, { route: "actions.list" }, async ({ auth, requestId }) => {
    // The status filter is optional. When it is sent, it must be a valid value.
    const params = new URL(request.url).searchParams;
    let status: z.infer<typeof statusFilterSchema> | undefined;
    const rawStatus = params.get("status");
    if (rawStatus !== null) {
      const parsed = statusFilterSchema.safeParse(rawStatus);
      if (!parsed.success) {
        return errorResponse(
          400,
          "invalid_request",
          "Choose a status: proposed, approved, rejected, executed or failed.",
          requestId,
        );
      }
      status = parsed.data;
    }

    const actions = await createActionProposalRepository(auth.supabase).listProposals(
      auth.userId,
      status,
      ACTION_LIST_LIMIT,
    );
    return jsonResponse({ actions }, requestId);
  });
}
