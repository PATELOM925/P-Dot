import { z } from "zod";
import { MAX_CHAT_BODY_BYTES } from "@/lib/limits";
import { actionDecisionSchema } from "@/lib/schemas";
import type { AuthContext } from "@/server/auth/session";
import { createEmbedderForRequest } from "@/server/assistant/deps";
import type { Embedder } from "@/server/assistant/embed";
import { getAssistantConfig } from "@/server/config";
import { executeAction, type ActionDeps, type ActionResult } from "@/server/actions/execute";
import { createActionLogRepository, type ActionLogRepository, type LogDetail } from "@/server/db/action-log";
import { createActionProposalRepository } from "@/server/db/action-proposals";
import { createMemoryRepository } from "@/server/db/memories";
import { createReminderRepository } from "@/server/db/reminders";
import { createTaskRepository } from "@/server/db/tasks";
import { readJsonBody } from "@/server/http/request";
import { errorResponse, jsonResponse } from "@/server/http/responses";
import { withAuthenticatedRoute } from "@/server/http/route";
import { logEvent } from "@/server/log";
import type { ActionLogEvent } from "@/types/api";

interface Context {
  params: Promise<{ id: string }>;
}

const idSchema = z.uuid();

const actionNotFound = (requestId: string) => errorResponse(404, "not_found", "Action not found.", requestId);

/**
 * POST /api/actions/:id/decision. Body: { decision: "approve" | "reject", payload? }.
 * Only an approval runs the action. An edited payload must keep the same kind.
 * A proposal can be decided once: a second decision gets 409 and runs nothing.
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
    const proposalId = id.data;

    const proposals = createActionProposalRepository(auth.supabase);
    const log = createActionLogRepository(auth.supabase);

    const stored = await proposals.getProposal(auth.userId, proposalId);
    if (!stored) return actionNotFound(requestId);
    const kind = stored.payload.kind;

    if (edited && edited.kind !== kind) {
      return errorResponse(400, "invalid_request", "An edited action must keep the same kind.", requestId);
    }

    // The single guard against double approval: only a "proposed" row changes.
    const claimed = await proposals.claimForDecision(
      auth.userId,
      proposalId,
      decision === "approve" ? "approved" : "rejected",
    );
    if (!claimed) return errorResponse(409, "conflict", "This action was already decided.", requestId);

    const detail: LogDetail = { proposalId, kind, edited: edited !== undefined };

    if (decision === "reject") {
      await recordEvent(log, auth.userId, requestId, "rejected", detail, proposalId);
      return jsonResponse(claimed, requestId);
    }

    await recordEvent(log, auth.userId, requestId, "approved", detail, proposalId);

    let result: ActionResult;
    try {
      result = await executeAction(auth.userId, proposalId, edited ?? stored.payload, executionDeps(auth));
    } catch (error) {
      logEvent("error", "action_execution_failed", {
        requestId,
        kind,
        errorName: error instanceof Error ? error.name : "unknown",
      });
      await proposals.finish(auth.userId, proposalId, "failed", { error: "execution_failed" });
      await recordEvent(log, auth.userId, requestId, "failed", detail, proposalId);
      return errorResponse(502, "internal_error", "The action could not be completed.", requestId);
    }

    const executed = await proposals.finish(auth.userId, proposalId, "executed", result);
    await recordEvent(log, auth.userId, requestId, "executed", { ...detail, ...result }, proposalId);
    return jsonResponse(executed, requestId);
  });
}

/**
 * Writes one action-log row. A failed write never fails the request (owner
 * decision). The warning holds the request ID and the event name only. The
 * event name goes in `actionEvent`, because a field called `event` would
 * replace the log line's own `event` key.
 */
async function recordEvent(
  log: ActionLogRepository,
  userId: string,
  requestId: string,
  event: ActionLogEvent,
  detail: LogDetail,
  proposalId: string,
): Promise<void> {
  try {
    await log.append(userId, event, detail, proposalId);
  } catch {
    logEvent("warn", "action_log_failed", { requestId, actionEvent: event });
  }
}

function executionDeps(auth: AuthContext): ActionDeps {
  return {
    tasks: createTaskRepository(auth.supabase),
    reminders: createReminderRepository(auth.supabase),
    memories: createMemoryRepository(auth.supabase),
    embedder: lazyEmbedder(auth),
  };
}

/** Reads the embedding settings only when a memory is saved, so other kinds never need them. */
function lazyEmbedder(auth: AuthContext): Embedder {
  return {
    async embed(texts, signal) {
      return createEmbedderForRequest(auth, getAssistantConfig()).embed(texts, signal);
    },
  };
}
