import type { ApiErrorCode } from "@/types/api";

/** After this long with no stream event, the step line changes to a plain "no update" line. */
export const STALL_MS = 30_000;
export const STALL_LINE = "No update for 30 seconds. You can wait or press Stop.";

/** The step a streaming reply is on, from its stream events. */
export function turnStepLine(step: {
  text: string;
  tool?: string;
  searching: boolean;
  /** Deep research (decision 0018). */
  deep?: boolean;
  tier?: string;
}): string {
  if (step.tool) return step.tool;
  if (step.text) return "Writing the reply…";
  if (step.searching) return step.deep ? "Searching the web (deep)…" : "Searching the web…";
  return step.tier === "heavy" ? "Thinking harder…" : "Thinking…";
}

/**
 * One state for each reply turn (spec D1). "working" only while events arrive;
 * "waiting" when the reply has a card that needs the user.
 */
export type TurnState = "working" | "stalled" | "waiting" | "stopped" | "failed" | "done";

export const TURN_STATE_LABELS: Record<TurnState, string> = {
  working: "Working",
  stalled: "No update",
  waiting: "Waiting for you",
  stopped: "Stopped",
  failed: "Did not finish",
  done: "Done",
};

export interface ChatErrorView {
  message: string;
  /** Show Retry. False for limits and for requests that cannot work again as they are. */
  retryable: boolean;
  /** A rate limit or a spend limit: say when, not Retry. */
  limit: boolean;
}

const NOT_RETRYABLE: ReadonlySet<string> = new Set([
  "rate_limited",
  "budget_exhausted",
  "invalid_request",
  "unsupported_media_type",
  "payload_too_large",
  "forbidden",
  "account_required",
  "not_configured",
  "conflict",
  "answered",
  "not_found",
]);

/**
 * The error block for a failed turn. `retryable` from the stream's error event
 * wins; an HTTP error before the stream has only its code.
 */
export function chatErrorView(
  code: ApiErrorCode | "network_error" | undefined,
  message: string,
  options: { retryable?: boolean; trial: boolean },
): ChatErrorView {
  const limit = code === "rate_limited" || code === "budget_exhausted";
  if (limit && options.trial) {
    return { message: "You reached the trial limit. Create an account for a higher limit.", retryable: false, limit };
  }
  if (limit) return { message, retryable: false, limit };
  const retryable = options.retryable ?? !(code && NOT_RETRYABLE.has(code));
  return { message, retryable, limit };
}

/** Adds a user message to the set that never shows Retry. A new set, for React state. */
export function withNoRetry(ids: ReadonlySet<string>, userMessageId: string): ReadonlySet<string> {
  if (ids.has(userMessageId)) return ids;
  return new Set(ids).add(userMessageId);
}

/** Retry shows for the last message only when it is a saved user message with no reply, and Retry can help. */
export function canRetryLast(input: {
  sending: boolean;
  loadingMessages: boolean;
  activeId: string | null;
  last: { id: string; role: string; pending?: boolean } | undefined;
  noRetryIds: ReadonlySet<string>;
}): boolean {
  const { sending, loadingMessages, activeId, last, noRetryIds } = input;
  return !sending && !loadingMessages && activeId !== null && last?.role === "user" && !last.pending && !noRetryIds.has(last.id);
}

/** True when Retry can never help this message: a final error, not a limit that ends later. */
export function blocksRetry(view: { retryable?: boolean; limit?: boolean }): boolean {
  return !view.retryable && !view.limit;
}
