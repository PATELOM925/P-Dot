import "server-only";
import type { ApiErrorCode } from "@/types/api";
import { ProviderError } from "@/server/providers/errors";

export interface PublicError {
  code: ApiErrorCode;
  message: string;
  retryable: boolean;
}

/** Maps internal failures to user-facing errors without provider internals. */
export function toPublicCompletionError(error: unknown): PublicError {
  if (error instanceof ProviderError) {
    switch (error.kind) {
      case "timeout":
        return {
          code: "provider_timeout",
          message: "The assistant took too long to respond. Please retry.",
          retryable: true,
        };
      case "rate_limited":
        return {
          code: "provider_rate_limited",
          message: "The assistant is busy right now. Wait a moment, then retry.",
          retryable: true,
        };
      case "auth":
      case "quota":
      case "invalid_request":
        return {
          code: "provider_unavailable",
          message: "The assistant could not process this request. If this keeps happening, the service may be misconfigured.",
          retryable: true,
        };
      default:
        return {
          code: "provider_unavailable",
          message: "The assistant is temporarily unavailable. Please retry.",
          retryable: true,
        };
    }
  }
  return { code: "internal_error", message: "Something went wrong. Please retry.", retryable: true };
}

export function publicSearchFailureMessage(error: unknown): string {
  if (error instanceof ProviderError && error.kind === "timeout") {
    return "Web search timed out, so this answer is not based on web sources.";
  }
  return "Web search failed, so this answer is not based on web sources.";
}
