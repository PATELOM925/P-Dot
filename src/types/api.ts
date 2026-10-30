// Contracts shared by the browser and the API routes. No secrets or server-only types here.
import type { Effort, MessageRoute, ModelTier, RouteReason } from "@/lib/routing";
import type { McpServerId } from "@/lib/connectors";

export type { Effort, MessageRoute, ModelTier, RouteReason } from "@/lib/routing";

export type MessageRole = "user" | "assistant";

/** Which side of life a conversation or task belongs to. */
export type Mode = "personal" | "work";

/** Tools the assistant can call (src/server/assistant/tools). */
export type AssistantToolName =
  | "web_search"
  | "search_documents"
  | "search_memories"
  | "propose_task"
  | "propose_reminder"
  | "save_memory"
  | "gmail_search"
  | "gmail_read"
  | "calendar_list_events"
  | "propose_email"
  | "propose_calendar_event"
  | "notion_search"
  | "notion_fetch"
  | "linear_search_issues"
  | "linear_get_issue"
  | "todoist_list_tasks"
  | "todoist_find_tasks";

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
  | "account_required"
  | "reconnect_required"
  | "invalid_request"
  | "unsupported_media_type"
  | "payload_too_large"
  | "not_found"
  | "conflict"
  | "busy"
  | "answered"
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
    /** With "busy" and "answered" from POST /api/chat: the conversation of the saved message. */
    conversationId?: string;
  };
}

/** Request body for POST /api/chat. */
export type ChatRequest =
  | {
      action: "send";
      conversationId?: string;
      mode?: Mode;
      message: string;
      webSearch: boolean;
      effort?: Effort;
      /** Apps to read for this message only (decision 0016). Never together with web search or Google. */
      connectors?: McpServerId[];
      /** Gmail and Calendar for this message only (decision 0014). Never together with web search or apps. */
      useGoogle?: true;
      /** The browser's IANA time zone, for example "Asia/Kolkata". */
      timeZone?: string;
    }
  | {
      action: "retry";
      conversationId: string;
      webSearch: boolean;
      effort?: Effort;
      connectors?: McpServerId[];
      useGoogle?: true;
      timeZone?: string;
    };

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
  /**
   * A tool started. Carries only the tool name and, for a search, the query
   * the user can see. Never saved, and never carries the model's text.
   */
  | { type: "status"; tool: AssistantToolName; query?: string }
  | { type: "delta"; text: string }
  | { type: "done"; message: MessageDTO; truncated: boolean }
  /** After `done` for a new conversation: the title the model made, already saved. */
  | { type: "title"; conversationId: string; title: string }
  | { type: "error"; code: ApiErrorCode; message: string; retryable: boolean };

// ---------------------------------------------------------------------------
// Memory, documents, action proposals, the action log, reminders and context
// records. Decision 0009.
// ---------------------------------------------------------------------------

/** "proposed": suggested by the assistant, waiting for the user. "active": used in replies. */
export type MemoryStatus = "proposed" | "active";
export type MemorySource = "user" | "assistant";

export interface MemoryDTO {
  id: string;
  mode: Mode;
  content: string;
  status: MemoryStatus;
  source: MemorySource;
  /** The message the memory came from, if it still exists. */
  sourceMessageId: string | null;
  createdAt: string;
  updatedAt: string;
}

export type DocumentMediaType = "text/plain" | "text/markdown";
export type DocumentStatus = "processing" | "ready" | "failed";

export interface DocumentDTO {
  id: string;
  mode: Mode;
  title: string;
  mediaType: DocumentMediaType;
  charCount: number;
  status: DocumentStatus;
  createdAt: string;
}

/**
 * Actions the assistant may propose. send_email and create_calendar_event act
 * in the user's Google account and always ask (decision 0014).
 */
export type ActionKind = "create_task" | "create_reminder" | "save_memory" | "send_email" | "create_calendar_event";
/** "executing": an external action whose Google call has started and has no stored outcome yet (decision 0014). */
export type ActionStatus = "proposed" | "approved" | "executing" | "rejected" | "executed" | "failed";

export type ActionPayload =
  | { kind: "create_task"; mode: Mode; title: string }
  | { kind: "create_reminder"; mode: Mode; title: string; dueAt: string }
  | { kind: "save_memory"; mode: Mode; content: string }
  | { kind: "send_email"; mode: Mode; to: string[]; subject: string; body: string }
  | { kind: "create_calendar_event"; mode: Mode; title: string; start: string; end: string; attendees: string[] };

export interface ActionProposalDTO {
  id: string;
  conversationId: string | null;
  payload: ActionPayload;
  /** One plain sentence for the approval card, for example "Add task: Pay the invoice". */
  summary: string;
  status: ActionStatus;
  /**
   * What execution produced: the new row's ID, for example { "taskId": "..." },
   * or { "error": "execution_failed", "code": "<SQLSTATE>" }. Null until
   * executed or failed. Only the database writes it.
   */
  result: Record<string, string | number | boolean | null> | null;
  createdAt: string;
  decidedAt: string | null;
  /** For an external action: when its Google call started. Null for the other kinds. */
  executionStartedAt?: string | null;
  /**
   * True only when the database function decide_action_proposal decided this
   * proposal, so `status` and `result` are a record of what the database ran.
   * False for a proposal decided by other writes (older code, or a user
   * during the expand step) and for older rows: their outcome is only what a
   * caller wrote. The screens show these as "Marked done".
   */
  verified: boolean;
}

/** Written only by database triggers (decision 0009). Keep in step with the `event` check in the migration. */
export type ActionLogEvent =
  | "proposed"
  | "approved"
  | "rejected"
  | "executed"
  | "failed"
  | "memory_added"
  | "memory_edited"
  | "memory_deleted"
  | "document_added"
  | "document_ready"
  | "document_failed"
  | "document_deleted"
  | "reminder_added"
  | "reminder_changed"
  | "reminder_deleted";

export interface ActionLogEntryDTO {
  id: string;
  proposalId: string | null;
  event: ActionLogEvent;
  /** IDs, kinds, modes, counts and flags only. Never message or memory text. Strings are at most 64 characters. */
  detail: Record<string, string | number | boolean | null>;
  createdAt: string;
  /**
   * True only for a row that the database log triggers wrote; for an action
   * outcome, only when decide_action_proposal decided it. False for a row an
   * app or a user inserted, and for older rows. A caller cannot set it.
   */
  verified: boolean;
}

export type ReminderStatus = "scheduled" | "done" | "cancelled";

export interface ReminderDTO {
  id: string;
  mode: Mode;
  title: string;
  dueAt: string;
  status: ReminderStatus;
  proposalId: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * "What was sent" for one assistant reply. The app writes this record with the
 * user's own session, so it is the user's own record of what the app sent. It
 * is not proof that a model received that context.
 */
export interface ContextRecordDTO {
  messageId: string;
  model: string;
  historyMessageCount: number;
  historyChars: number;
  /** Memories used, with their current text. A deleted memory has content null. */
  memories: { id: string; content: string | null }[];
  /** Document chunks used, with the document title. A deleted chunk has title null. */
  documentChunks: { id: string; documentId: string | null; title: string | null }[];
  webSourceCount: number;
  promptVersion: string;
  inputTokens: number | null;
  outputTokens: number | null;
  createdAt: string;
}
