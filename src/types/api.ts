// Contracts shared by the browser and the API routes. No secrets or server-only types here.

export type MessageRole = "user" | "assistant";

/** Outcome of web search for an assistant reply. */
export type WebSearchStatus = "off" | "used" | "no_results" | "failed";

export interface SourceRef {
  title: string;
  url: string;
}

export type ProposedAction =
  | {
      id: string;
      kind: "reminder";
      title: string;
      dueAt: string;
      notes?: string;
    }
  | {
      id: string;
      kind: "task";
      title: string;
      priority?: "low" | "medium" | "high";
      dueDate?: string;
    };

export interface MessageDTO {
  id: string;
  role: MessageRole;
  content: string;
  webSearch: WebSearchStatus;
  sources: SourceRef[];
  actions?: ProposedAction[];
  createdAt: string;
}

export interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: string;
}

export interface ConversationDetail {
  id: string;
  title: string;
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
  | { action: "send"; conversationId?: string; message: string; webSearch: boolean }
  | { action: "retry"; conversationId: string; webSearch: boolean };

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
    }
  | {
      type: "search";
      status: Exclude<WebSearchStatus, "off">;
      sources: SourceRef[];
      message?: string;
    }
  | { type: "thought"; text: string }
  | { type: "action"; action: ProposedAction }
  | { type: "delta"; text: string }
  | { type: "done"; message: MessageDTO; truncated: boolean }
  | { type: "error"; code: ApiErrorCode; message: string; retryable: boolean };
