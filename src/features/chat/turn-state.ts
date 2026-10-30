import type { ApiErrorCode } from "@/types/api";

/** After this long with no stream event, "Working" changes to a plain "no update" line. */
export const STALL_MS = 15_000;
export const STALL_LINE = "No update for 15 seconds. You can wait or press Stop.";

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
