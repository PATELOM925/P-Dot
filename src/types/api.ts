// Contracts shared by the browser and the API routes. No secrets or server-only types here.
import type { Effort, MessageRoute, ModelTier, RouteReason } from "@/lib/routing";

export type { Effort, MessageRoute, ModelTier, RouteReason } from "@/lib/routing";

export type MessageRole = "user" | "assistant";

/** Which side of life a conversation or task belongs to. */
export type Mode = "personal" | "work";

/** Outcome of web search for an assistant reply. */
export type WebSearchStatus = "off" | "used" | "no_results" | "failed";

export interface SourceRef {
  title: string;
  url: string;
}

export interface MessageDTO {
  id: string;
  role: MessageRole;
  content: string;
  webSearch: WebSearchStatus;
  sources: SourceRef[];
  /** Which model answered and why. Null for user messages and replies saved before routing. */
  route: MessageRoute | null;
  createdAt: string;
}

export interface ConversationSummary {
  id: string;
  title: string;
  mode: Mode;
  updatedAt: string;
}

export interface TaskDTO {
  id: string;
  mode: Mode;
  title: string;
  done: boolean;
  createdAt: string;
}

export interface ConversationDetail {
  id: string;
  title: string;
  mode: Mode;
  messages: MessageDTO[];
}

export type ApiErrorCode =
  | "unauthorized"
  | "forbidden"
  | "invalid_request"
  | "unsupported_media_type"
  | "payload_too_large"
  | "not_found"
  | "conflict"
  | "rate_limited"
  | "budget_exhausted"
  | "not_configured"
  | "provider_unavailable"
  | "provider_timeout"
  | "provider_rate_limited"
  | "internal_error";

export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
    requestId: string;
  };
}

/** Request body for POST /api/chat. */
export type ChatRequest =
  | { action: "send"; conversationId?: string; mode?: Mode; message: string; webSearch: boolean; effort?: Effort }
  | { action: "retry"; conversationId: string; webSearch: boolean; effort?: Effort };

/**
 * POST /api/chat responds with newline-delimited JSON (one event per line) once
 * the request has been accepted. Failures before that point use a normal JSON
 * error response with an HTTP error status.
 */
export type ChatStreamEvent =
  | {
      type: "start";
      requestId: string;
      conversation: ConversationSummary;
      userMessage: MessageDTO;
      /** The tier chosen for this reply. The model is known only at `done`. */
      route: { tier: ModelTier; reason: RouteReason };
    }
  | {
      type: "search";
      status: Exclude<WebSearchStatus, "off">;
      sources: SourceRef[];
      message?: string;
    }
  | { type: "delta"; text: string }
  | { type: "done"; message: MessageDTO; truncated: boolean }
  | { type: "error"; code: ApiErrorCode; message: string; retryable: boolean };
