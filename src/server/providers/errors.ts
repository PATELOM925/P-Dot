import "server-only";

export type ProviderName = "nebius" | "tavily";

export type ProviderErrorKind =
  | "timeout"
  | "rate_limited"
  | "auth" // credentials rejected: an operator problem, not the user's
  | "quota" // provider account out of credit or plan limit
  | "invalid_request" // e.g. unknown model ID or context too long
  | "unavailable"
  | "bad_response"
  | "aborted";

/**
 * Normalized provider failure. The message contains only the provider name,
 * kind, and HTTP status, so it is safe to log; it never includes response
 * bodies or credentials.
 */
export class ProviderError extends Error {
  constructor(
    public readonly provider: ProviderName,
    public readonly kind: ProviderErrorKind,
    public readonly status?: number,
  ) {
    super(`${provider} request failed: ${kind}${status ? ` (HTTP ${status})` : ""}`);
    this.name = "ProviderError";
  }
}

export function kindFromStatus(status: number): ProviderErrorKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 402 || status === 432 || status === 433) return "quota";
  if (status === 408 || status === 504) return "timeout";
  if (status === 429) return "rate_limited";
  if (status === 400 || status === 404 || status === 413 || status === 422) return "invalid_request";
  return "unavailable";
}

export interface AbortScope {
  signal: AbortSignal;
  /** True when the scope aborted because a timer fired (not the caller). */
  timedOut(): boolean;
  /** Restarts the idle timer; call whenever data arrives. */
  touch(): void;
  dispose(): void;
}

/**
 * An abort signal that fires on caller cancellation, after `totalMs`, or when
 * no data arrives for `idleMs`.
 */
export function createAbortScope(options: {
  totalMs: number;
  idleMs?: number;
  parent?: AbortSignal;
}): AbortScope {
  const controller = new AbortController();
  let timedOut = false;
  const fire = () => {
    timedOut = true;
    controller.abort();
  };
  const total = setTimeout(fire, options.totalMs);
  let idle = options.idleMs ? setTimeout(fire, options.idleMs) : undefined;
  const onParentAbort = () => controller.abort();
  if (options.parent?.aborted) controller.abort();
  else options.parent?.addEventListener("abort", onParentAbort, { once: true });

  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    touch() {
      if (idle === undefined) return;
      clearTimeout(idle);
      idle = setTimeout(fire, options.idleMs);
    },
    dispose() {
      clearTimeout(total);
      if (idle !== undefined) clearTimeout(idle);
      options.parent?.removeEventListener("abort", onParentAbort);
    },
  };
}

/** Cancels an unread response body (e.g. on an error status) so the connection is released. */
export async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Ignore: the body may already be consumed or the stream errored.
  }
}
