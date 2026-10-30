import "server-only";
import { EXTERNAL_ACTION_LEASE_SECONDS } from "@/lib/limits";
import type { AuthContext } from "@/server/auth/session";
import type { ActionProposalRepository, DecisionResult, ExternalFailureReason } from "@/server/db/action-proposals";
import { createConnectedAccountRepository } from "@/server/db/connected-accounts";
import { errorResponse, jsonResponse } from "@/server/http/responses";
import { logEvent } from "@/server/log";
import type { ActionPayload, ActionProposalDTO } from "@/types/api";
import { googleFetch, readyGoogleConfig } from "./connect-flow";
import {
  isExternalPayload,
  prepareExternalAction,
  runExternalAction,
  type ExternalDeps,
  type PrepareResult,
} from "./external-action";
import type { GoogleAccess } from "./token-store";

// The HTTP side of an external action (decision 0014): approve, then claim,
// then one Google call, then finish. Used by POST /api/actions/:id/decision
// and POST /api/actions/:id/recover.

const NOT_READY: Record<Exclude<PrepareResult, { ok: true }>["reason"], [number, string]> = {
  not_set_up: [503, "Google is not set up on this site yet."],
  not_connected: [409, "Connect Google on the Connectors page first."],
  needs_reconnect: [409, "Google access ended. Connect Google again on the Connectors page."],
  scope_missing: [409, "Your Google connection does not allow this. Connect Google again and allow it."],
  unavailable: [503, "Google did not answer. Nothing was sent. Try again."],
};

const FAILED: Record<ExternalFailureReason, string> = {
  not_connected: "Connect Google on the Connectors page first.",
  needs_reconnect: "Google access ended. Connect Google again on the Connectors page.",
  scope_missing: "Your Google connection does not allow this. Connect Google again and allow it.",
  google_rejected: "Google refused this action. Nothing was sent.",
  account_changed: "The connected Google account changed. Ask P-Dot again.",
};

function deps(auth: AuthContext, requestId: string, route: string): ExternalDeps {
  return {
    config: readyGoogleConfig(requestId, route),
    accounts: createConnectedAccountRepository(auth.supabase),
    fetch: googleFetch,
    userId: auth.userId,
    requestId,
  };
}

/** 202: Google may have acted, and the outcome is not stored yet. The card shows the recovery steps. */
const unknownOutcome = (proposal: ActionProposalDTO | null, requestId: string) =>
  jsonResponse(proposal, requestId, { status: 202 });

/** Calls Google with a claim this request has just won, then stores the outcome (one retry of the store). */
async function runClaimed(
  proposals: ActionProposalRepository,
  access: GoogleAccess,
  claimed: DecisionResult & { claimId: string },
  requestId: string,
): Promise<Response> {
  const proposal = claimed.proposal;
  if (!proposal || !isExternalPayload(proposal.payload)) {
    logEvent("error", "external_action_unreadable", { requestId });
    return unknownOutcome(proposal, requestId);
  }
  const run = await runExternalAction(
    access,
    { id: proposal.id, payload: proposal.payload, accountSubject: claimed.accountSubject ?? null },
    requestId,
  );
  if ("unknown" in run) return unknownOutcome(proposal, requestId);

  let finished: DecisionResult | null = null;
  for (let attempt = 0; attempt < 2 && !finished; attempt += 1) {
    try {
      finished = await proposals.finishExternal(proposal.id, claimed.claimId, run);
    } catch {
      logEvent("warn", "external_action_finish_failed", { requestId, attempt });
    }
  }
  if (!finished) return unknownOutcome(proposal, requestId);

  switch (finished.outcome) {
    case "executed":
      return jsonResponse(finished.proposal ?? finished.row, requestId);
    case "failed":
      logEvent("warn", "action_execution_failed", { requestId, kind: proposal.payload.kind, reason: run.succeeded ? null : run.reason });
      return errorResponse(502, "internal_error", run.succeeded ? "The action could not be completed." : FAILED[run.reason], requestId);
    case "already_decided":
      // A lost answer to the first store, then the retry: the stored outcome is this request's.
      return finished.proposal?.status === "executed"
        ? jsonResponse(finished.proposal, requestId)
        : errorResponse(409, "conflict", "This action was already decided.", requestId);
    case "outcome_unknown":
      // A failure after a reclaim: an earlier attempt may have acted, so the user answers.
      return unknownOutcome(finished.proposal ?? proposal, requestId);
    default:
      logEvent("error", "external_action_finish_refused", { requestId, outcome: finished.outcome });
      return unknownOutcome(proposal, requestId);
  }
}

/**
 * Approves a send_email or create_calendar_event proposal. Google access is
 * checked before the claim, so a missing connection or an outage leaves the
 * proposal waiting. `outcomeResponse` maps the other decision outcomes.
 */
export async function approveExternal(
  auth: AuthContext,
  requestId: string,
  proposals: ActionProposalRepository,
  stored: ActionProposalDTO & { payload: Extract<ActionPayload, { kind: "send_email" | "create_calendar_event" }> },
  edited: ActionPayload | undefined,
  outcomeResponse: (result: DecisionResult) => Response,
): Promise<Response> {
  const ready = await prepareExternalAction(deps(auth, requestId, "actions.decide"), stored.payload.kind);
  if (!ready.ok) {
    const [status, message] = NOT_READY[ready.reason];
    return errorResponse(status, status === 503 ? "provider_unavailable" : "conflict", message, requestId);
  }
  const decided = await proposals.decide(stored.id, "approve", edited);
  if (decided.outcome === "not_connected") {
    return errorResponse(409, "conflict", NOT_READY.not_connected[1], requestId);
  }
  if (decided.outcome !== "executing" || !decided.claimId) return outcomeResponse(decided);
  return runClaimed(proposals, ready.access, { ...decided, claimId: decided.claimId }, requestId);
}

/**
 * Recovery of a row left executing (decision 0014). No answer: a new claim
 * for a calendar event in the same Google account, then one more insert with
 * the same event ID. With an answer: the user's word for an action that
 * P-Dot cannot finish by itself.
 */
export async function recoverExternal(
  auth: AuthContext,
  requestId: string,
  proposals: ActionProposalRepository,
  proposalId: string,
  answer: "done" | "not_done" | undefined,
): Promise<Response> {
  const notFound = () => errorResponse(404, "not_found", "Action not found.", requestId);
  if (answer) {
    const settled = await proposals.settleUnknownExternal(proposalId, EXTERNAL_ACTION_LEASE_SECONDS, answer === "done");
    switch (settled.outcome) {
      case "executed":
      case "failed":
      case "already_decided":
        return jsonResponse(settled.proposal ?? settled.row, requestId);
      case "busy":
        return errorResponse(409, "busy", "P-Dot is still trying. Try again in two minutes.", requestId);
      case "invalid":
        return errorResponse(409, "conflict", "P-Dot can still finish this. Use Check again.", requestId);
      default:
        return notFound();
    }
  }

  const ready = await prepareExternalAction(deps(auth, requestId, "actions.recover"), "create_calendar_event");
  const reclaimed = await proposals.reclaimExternal(proposalId, EXTERNAL_ACTION_LEASE_SECONDS);
  switch (reclaimed.outcome) {
    case "not_found":
      return notFound();
    case "already_decided":
      return jsonResponse(reclaimed.proposal ?? reclaimed.row, requestId);
    case "busy":
      return errorResponse(409, "busy", "P-Dot is still trying. Try again in two minutes.", requestId);
    case "outcome_unknown":
    case "account_changed":
      return errorResponse(409, "conflict", "P-Dot cannot check this by itself. Tell P-Dot if it happened.", requestId);
    case "claimed":
      if (!reclaimed.claimId) return unknownOutcome(reclaimed.proposal, requestId);
      if (!ready.ok) return unknownOutcome(reclaimed.proposal, requestId);
      return runClaimed(proposals, ready.access, { ...reclaimed, claimId: reclaimed.claimId }, requestId);
    default:
      return unknownOutcome(reclaimed.proposal, requestId);
  }
}
