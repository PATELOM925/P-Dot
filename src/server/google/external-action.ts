import "server-only";
import type { GoogleConfig } from "@/server/config";
import type { ConnectedAccountRepository } from "@/server/db/connected-accounts";
import type { ExternalFailureReason, ExternalOutcome } from "@/server/db/action-proposals";
import { logEvent } from "@/server/log";
import type { ActionPayload } from "@/types/api";
import { GoogleScopeMissingError, requireScope } from "./api";
import { calendarCreateEvent, eventIdForProposal } from "./calendar";
import { gmailSend } from "./gmail";
import { GoogleApiError, type FetchLike } from "./http";
import { CALENDAR_ALL_SCOPE, CALENDAR_SCOPE, GMAIL_SEND_SCOPE } from "./oauth";
import { GoogleReconnectNeededError, openGoogleAccess, type GoogleAccess } from "./token-store";

// Runs an approved send_email or create_calendar_event (decision 0014).
// `prepareExternalAction` runs before the claim: if Google cannot be used,
// nothing is claimed and the proposal keeps waiting. `runExternalAction` runs
// with a claim this request has just won, and says if Google acted.

export type ExternalPayload = Extract<ActionPayload, { kind: "send_email" | "create_calendar_event" }>;

export const isExternalPayload = (payload: ActionPayload): payload is ExternalPayload =>
  payload.kind === "send_email" || payload.kind === "create_calendar_event";

export type PrepareResult =
  | { ok: true; access: GoogleAccess }
  | { ok: false; reason: "not_set_up" | "not_connected" | "needs_reconnect" | "scope_missing" | "unavailable" };

export interface ExternalDeps {
  config: GoogleConfig | null;
  accounts: ConnectedAccountRepository;
  fetch: FetchLike;
  userId: string;
  requestId: string;
}

/** Opens the user's Google access and gets an access token, before any claim. Calls only the token endpoint. */
export async function prepareExternalAction(deps: ExternalDeps, kind: ExternalPayload["kind"]): Promise<PrepareResult> {
  if (!deps.config) return { ok: false, reason: "not_set_up" };
  const opened = await openGoogleAccess({ repo: deps.accounts, config: deps.config, fetch: deps.fetch, userId: deps.userId, requestId: deps.requestId });
  if (!opened.ok) return opened;
  try {
    if (kind === "send_email") requireScope(opened.access, GMAIL_SEND_SCOPE);
    else requireScope(opened.access, CALENDAR_SCOPE, CALENDAR_ALL_SCOPE);
    await opened.access.accessToken();
    return { ok: true, access: opened.access };
  } catch (error) {
    if (error instanceof GoogleScopeMissingError) return { ok: false, reason: "scope_missing" };
    if (error instanceof GoogleReconnectNeededError) return { ok: false, reason: "needs_reconnect" };
    logEvent("warn", "google_token_unavailable", {
      requestId: deps.requestId,
      kind: error instanceof GoogleApiError ? error.kind : "unknown",
    });
    return { ok: false, reason: "unavailable" };
  }
}

/** "unknown": Google may have acted. The row stays executing for the recovery path. */
export type RunResult = ExternalOutcome | { unknown: true };

const notDone = (reason: ExternalFailureReason): RunResult => ({ succeeded: false, reason });

/**
 * Calls Google once for a claimed proposal. A failure is "not done" only when
 * Google did not act: the account changed, a scope or token is missing, or
 * Google answered 4xx. A timeout, a network error, a 5xx or a 2xx that does
 * not parse are "unknown".
 */
export async function runExternalAction(
  access: GoogleAccess,
  proposal: { id: string; payload: ExternalPayload; accountSubject: string | null },
  requestId: string,
): Promise<RunResult> {
  if (!proposal.accountSubject || proposal.accountSubject !== access.subject) return notDone("account_changed");
  try {
    if (proposal.payload.kind === "send_email") {
      const sent = await gmailSend(access, proposal.payload);
      return { succeeded: true, result: { messageId: sent.messageId } };
    }
    const created = await calendarCreateEvent(access, proposal.payload, eventIdForProposal(proposal.id));
    return { succeeded: true, result: { eventId: created.eventId } };
  } catch (error) {
    if (error instanceof GoogleScopeMissingError) return notDone("scope_missing");
    if (error instanceof GoogleReconnectNeededError) return notDone("needs_reconnect");
    if (error instanceof RangeError) return notDone("google_rejected");
    if (error instanceof GoogleApiError && error.notDone) {
      logEvent("warn", "google_action_refused", { requestId, kind: error.kind, label: error.label });
      return notDone(error.status === 401 ? "needs_reconnect" : "google_rejected");
    }
    logEvent("warn", "google_action_outcome_unknown", {
      requestId,
      kind: error instanceof GoogleApiError ? error.kind : error instanceof Error ? error.name : "unknown",
    });
    return { unknown: true };
  }
}
