import { z } from "zod";
import { MAX_CHAT_BODY_BYTES } from "@/lib/limits";
import { actionDecisionSchema } from "@/lib/schemas";
import { waitUntil } from "@/server/assistant/deps";
import type { AuthContext } from "@/server/auth/session";
import { createActionProposalRepository, type DecisionResult } from "@/server/db/action-proposals";
import { createMemoryRepository } from "@/server/db/memories";
import { isExternalPayload } from "@/server/google/external-action";
import { approveExternal } from "@/server/google/external-routes";
import { readJsonBody } from "@/server/http/request";
import { errorResponse, jsonResponse } from "@/server/http/responses";
import { withAuthenticatedRoute } from "@/server/http/route";
import { logEvent } from "@/server/log";
import { embedMemoryText } from "@/server/memories/embedding";
import type { ActionProposalDTO } from "@/types/api";

interface Context {
  params: Promise<{ id: string }>;
}

const idSchema = z.uuid();

const actionNotFound = (requestId: string) => errorResponse(404, "not_found", "Action not found.", requestId);

/**
 * POST /api/actions/:id/decision. Body: { decision: "approve" | "reject", payload? }.
 *
 * The database function `decide_action_proposal` does the work in one
 * transaction: it claims the proposal, runs an approved action as the user,
 * stores the outcome and writes the action log. A proposal can be decided
 * once: a second decision gets 409 and runs nothing. An edited payload must
 * keep the same kind.
 *
 * send_email and create_calendar_event (decision 0014): the function only
 * claims the proposal; this route then calls Google once with that claim and
 * stores the outcome. 202 means Google may have acted and the outcome is not
 * stored yet; POST /api/actions/:id/recover finishes it.
 */
export async function POST(request: Request, context: Context): Promise<Response> {
  return withAuthenticatedRoute(request, { route: "actions.decide", sameOrigin: true }, async ({ auth, requestId }) => {
    const id = idSchema.safeParse((await context.params).id);
    if (!id.success) return actionNotFound(requestId);

    const body = await readJsonBody(request, MAX_CHAT_BODY_BYTES);
    if (!body.ok) return errorResponse(body.status, body.code, body.message, requestId);
    const parsed = actionDecisionSchema.safeParse(body.value);
    if (!parsed.success) {
      return errorResponse(400, "invalid_request", parsed.error.issues[0]?.message ?? "Invalid request.", requestId);
    }
    const { decision, payload: edited } = parsed.data;
    const proposals = createActionProposalRepository(auth.supabase);
    const respond = (result: DecisionResult) => outcomeResponse(auth, requestId, result, Boolean(edited));

    if (decision === "approve") {
      const stored = await proposals.getProposal(auth.userId, id.data);
      if (stored && stored.status === "proposed" && isExternalPayload(stored.payload)) {
        return approveExternal(auth, requestId, proposals, { ...stored, payload: stored.payload }, edited, respond);
      }
    }
    return respond(await proposals.decide(id.data, decision, edited));
  });
}

/** Maps what a decision function answered to the HTTP answer. */
function outcomeResponse(auth: AuthContext, requestId: string, result: DecisionResult, edited: boolean): Response {
    const { outcome, proposal, row } = result;
    // A committed decision on an older row whose payload cannot be shown answers with its ID and status only.
    const decided = proposal ?? row;

    switch (outcome) {
      case "not_found":
        return actionNotFound(requestId);
      case "already_decided":
        return errorResponse(409, "conflict", "This action was already decided.", requestId);
      case "kind_mismatch":
        return errorResponse(400, "invalid_request", "An edited action must keep the same kind.", requestId);
      case "invalid":
        // A stored payload that does not parse is never shown or run, so it is "not found" to the user.
        return edited
          ? errorResponse(400, "invalid_request", "The edited action is not valid.", requestId)
          : actionNotFound(requestId);
      case "failed":
        logEvent("error", "action_execution_failed", {
          requestId,
          kind: proposal?.payload.kind ?? null,
          code: typeof proposal?.result?.code === "string" ? proposal.result.code : null,
        });
        return errorResponse(502, "internal_error", "The action could not be completed.", requestId);
      case "rejected":
        return jsonResponse(decided, requestId);
      case "executed":
        // The answer does not wait for the vector. waitUntil keeps the work alive after the response.
        if (proposal?.payload.kind === "save_memory") waitUntil(embedSavedMemory(auth, requestId, proposal));
        return jsonResponse(decided, requestId);
      default:
        // An external outcome reached the internal path, for example a claim with no claim ID.
        logEvent("error", "action_outcome_unexpected", { requestId, outcome });
        return errorResponse(500, "internal_error", "Something went wrong. Please retry.", requestId);
    }
}

/**
 * The database saves an approved memory with no vector. Embed it after the
 * response, so it can be found by search. The action already ran, so any
 * failure here only leaves the memory without a vector. This promise never
 * rejects. The log line holds IDs and the error name, never the text.
 */
async function embedSavedMemory(auth: AuthContext, requestId: string, proposal: ActionProposalDTO): Promise<void> {
  if (proposal.payload.kind !== "save_memory") return;
  const memoryId = proposal.result?.memoryId;
  if (typeof memoryId !== "string") return;
  try {
    const text = proposal.payload.content;
    const embedding = await embedMemoryText(auth, requestId, text);
    if (!embedding) return;
    // Only if the memory still has this text: an edit made meanwhile keeps its own vector.
    const written = await createMemoryRepository(auth.supabase).setEmbeddingIfContent(auth.userId, memoryId, text, embedding);
    if (!written) logEvent("info", "action_embedding_skipped", { requestId, proposalId: proposal.id });
  } catch (error) {
    logEvent("warn", "action_embedding_failed", {
      requestId,
      proposalId: proposal.id,
      errorName: error instanceof Error ? error.name : "unknown",
    });
  }
}
