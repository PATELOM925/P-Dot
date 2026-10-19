import "server-only";
import {
  HISTORY_CHAR_BUDGET,
  HISTORY_MESSAGE_LIMIT,
  MAX_ASSISTANT_CHARS,
} from "@/lib/limits";
import type {
  ApiErrorCode,
  ChatRequest,
  ChatStreamEvent,
  ConversationSummary,
  MessageDTO,
  SourceRef,
  WebSearchStatus,
} from "@/types/api";
import type { ConversationRepository } from "@/server/db/conversations";
import type { QuotaGate } from "@/server/db/quota";
import type { Logger } from "@/server/log";
import { ProviderError } from "@/server/providers/errors";
import type { ChatMessage, CompletionChunk, TokenUsage } from "@/server/providers/nebius/client";
import type { WebSearchResult } from "@/server/providers/tavily/client";
import { buildCompactedContextWindow, generateSmartTitle, titleFromMessage, type HistoryMessage } from "./context";
import { publicSearchFailureMessage, toPublicCompletionError } from "./errors";
import { buildPromptMessages, formatSearchResults } from "./prompt";
import { WEB_SEARCH_TOOL, type ToolDefinition, type ToolCall } from "./tools";

export interface CompleteOptions {
  tools?: ToolDefinition[];
  toolChoice?: "auto" | "none" | "required" | { type: "function"; function: { name: string } };
}

export interface AssistantDeps {
  repo: ConversationRepository;
  quota: QuotaGate;
  /** Null when web search is not configured on this server. */
  search: ((query: string, signal: AbortSignal) => Promise<WebSearchResult[]>) | null;
  complete: (
    messages: ChatMessage[],
    signal?: AbortSignal,
    options?: CompleteOptions,
  ) => AsyncIterable<CompletionChunk>;
  now: () => Date;
  log: Logger;
}

export interface PreparedTurn {
  requestId: string;
  userId: string;
  conversation: ConversationSummary;
  userMessage: MessageDTO;
  /** Chronological history ending with `userMessage`. */
  history: HistoryMessage[];
  webSearch: boolean;
}

export type PrepareResult =
  | { ok: true; turn: PreparedTurn }
  | {
      ok: false;
      status: number;
      code: ApiErrorCode;
      message: string;
      headers?: Record<string, string>;
    };

/**
 * Everything that must succeed before the response stream starts: ownership
 * check, retry precondition, usage quota, and saving the user's message.
 * `userId` must come from the verified session, never from the request body.
 */
export async function prepareChatTurn(
  deps: AssistantDeps,
  input: { userId: string; requestId: string; request: ChatRequest },
): Promise<PrepareResult> {
  const { userId, requestId, request } = input;

  let existing: ConversationSummary | null = null;
  let recent: MessageDTO[] = [];
  if (request.conversationId) {
    existing = await deps.repo.getConversation(userId, request.conversationId);
    if (!existing) {
      return { ok: false, status: 404, code: "not_found", message: "Conversation not found." };
    }
    recent = await deps.repo.listRecentMessages(userId, existing.id, HISTORY_MESSAGE_LIMIT);
  }

  if (request.action === "retry" && recent.at(-1)?.role !== "user") {
    return {
      ok: false,
      status: 409,
      code: "conflict",
      message: "There is no unanswered message to retry.",
    };
  }

  const decision = await deps.quota.consume();
  if (!decision.allowed) {
    const seconds = Math.max(1, Math.ceil((decision.resetsAt.getTime() - deps.now().getTime()) / 1000));
    return {
      ok: false,
      status: 429,
      code: "rate_limited",
      message: "You have reached your request limit for now. Please try again later.",
      headers: { "Retry-After": String(seconds) },
    };
  }

  let conversation: ConversationSummary;
  let userMessage: MessageDTO;
  if (request.action === "send") {
    conversation = existing ?? (await deps.repo.createConversation(userId, titleFromMessage(request.message)));
    userMessage = await deps.repo.insertMessage(userId, {
      conversationId: conversation.id,
      role: "user",
      content: request.message,
    });
    recent = [...recent, userMessage];
  } else {
    // Retry: both were verified above.
    conversation = existing!;
    userMessage = recent.at(-1)!;
  }

  return {
    ok: true,
    turn: {
      requestId,
      userId,
      conversation: { ...conversation, updatedAt: userMessage.createdAt },
      userMessage,
      history: recent.map(({ role, content }) => ({ role, content })),
      webSearch: request.webSearch,
    },
  };
}

function toSourceRefs(results: WebSearchResult[]): SourceRef[] {
  return results.map(({ title, url }) => ({ title, url }));
}

/**
 * Runs retrieval (if requested) and inference, streaming events to the client.
 * The assistant reply is persisted only when it completes. Never throws:
 * failures become a final `error` event.
 */
export async function* streamChatTurn(
  deps: AssistantDeps,
  turn: PreparedTurn,
  signal: AbortSignal,
): AsyncGenerator<ChatStreamEvent> {
  const startedAt = Date.now();
  const logBase = { requestId: turn.requestId, route: "chat" };

  yield {
    type: "start",
    requestId: turn.requestId,
    conversation: turn.conversation,
    userMessage: turn.userMessage,
  };

  // 1. Optional web retrieval. Search is never called unless requested.
  let webSearch: WebSearchStatus = "off";
  let results: WebSearchResult[] = [];
  if (turn.webSearch) {
    if (!deps.search) {
      webSearch = "failed";
      yield {
        type: "search",
        status: "failed",
        sources: [],
        message: "Web search is not configured on this server, so this answer is not based on web sources.",
      };
    } else {
      try {
        results = await deps.search(turn.userMessage.content, signal);
        webSearch = results.length > 0 ? "used" : "no_results";
        yield {
          type: "search",
          status: webSearch,
          sources: toSourceRefs(results),
          ...(webSearch === "no_results"
            ? { message: "Web search found no usable results, so this answer is not based on web sources." }
            : {}),
        };
      } catch (error) {
        if (signal.aborted) {
          deps.log("info", "chat_client_aborted", { ...logBase, stage: "search" });
          return;
        }
        webSearch = "failed";
        results = [];
        deps.log("warn", "search_failed", {
          ...logBase,
          kind: error instanceof ProviderError ? error.kind : "unknown",
          status: error instanceof ProviderError ? error.status : undefined,
        });
        yield { type: "search", status: "failed", sources: [], message: publicSearchFailureMessage(error) };
      }
    }
  }

  // 2. Inference over a bounded context window with compaction support.
  const messages = buildPromptMessages({
    history: buildCompactedContextWindow(turn.history, HISTORY_CHAR_BUDGET),
    webSearch,
    results,
    now: deps.now(),
  });

  const tools = deps.search && webSearch === "off" ? [WEB_SEARCH_TOOL] : undefined;
  const toolChoice = tools ? "auto" : undefined;

  let content = "";
  let truncated = false;
  let finishReason: string | null = null;
  let usage: TokenUsage | null = null;
  let pendingToolCalls: ToolCall[] = [];

  try {
    for await (const chunk of deps.complete(messages, signal, { tools, toolChoice })) {
      if (chunk.type === "finish") {
        finishReason = chunk.finishReason;
        usage = chunk.usage;
        continue;
      }
      if (chunk.type === "tool_calls") {
        pendingToolCalls = chunk.calls;
        continue;
      }
      if (chunk.type === "text") {
        const room = MAX_ASSISTANT_CHARS - content.length;
        const text = chunk.text.slice(0, room);
        if (text) {
          content += text;
          yield { type: "delta", text };
        }
        if (content.length >= MAX_ASSISTANT_CHARS) {
          truncated = true;
          break;
        }
      }
    }

    // If the model autonomously decided to invoke a tool (e.g. web_search):
    if (pendingToolCalls.length > 0 && deps.search) {
      const searchCall = pendingToolCalls.find((call) => call.function.name === "web_search");
      if (searchCall) {
        let query = turn.userMessage.content;
        try {
          const parsed = JSON.parse(searchCall.function.arguments);
          if (typeof parsed.query === "string" && parsed.query.trim()) {
            query = parsed.query.trim();
          }
        } catch {
          // Fallback to original user query if parsing fails
        }

        try {
          results = await deps.search(query, signal);
          webSearch = results.length > 0 ? "used" : "no_results";
          yield {
            type: "search",
            status: webSearch,
            sources: toSourceRefs(results),
            ...(webSearch === "no_results"
              ? { message: "Web search found no usable results, so this answer is not based on web sources." }
              : {}),
          };
        } catch (error) {
          if (signal.aborted) {
            deps.log("info", "chat_client_aborted", { ...logBase, stage: "search" });
            return;
          }
          webSearch = "failed";
          results = [];
          deps.log("warn", "search_failed", {
            ...logBase,
            kind: error instanceof ProviderError ? error.kind : "unknown",
            status: error instanceof ProviderError ? error.status : undefined,
          });
          yield { type: "search", status: "failed", sources: [], message: publicSearchFailureMessage(error) };
        }

        // Add assistant tool invocation and tool response to context
        messages.push({
          role: "assistant",
          content: null,
          tool_calls: pendingToolCalls,
        });
        messages.push({
          role: "tool",
          tool_call_id: searchCall.id,
          name: "web_search",
          content: results.length > 0 ? formatSearchResults(results) : "No web search results found.",
        });

        // Second completion pass: model streams final grounded reply
        content = "";
        for await (const chunk of deps.complete(messages, signal)) {
          if (chunk.type === "finish") {
            finishReason = chunk.finishReason;
            if (chunk.usage && usage) {
              usage = {
                promptTokens: usage.promptTokens + chunk.usage.promptTokens,
                completionTokens: usage.completionTokens + chunk.usage.completionTokens,
              };
            } else if (chunk.usage) {
              usage = chunk.usage;
            }
            continue;
          }
          if (chunk.type === "text") {
            const room = MAX_ASSISTANT_CHARS - content.length;
            const text = chunk.text.slice(0, room);
            if (text) {
              content += text;
              yield { type: "delta", text };
            }
            if (content.length >= MAX_ASSISTANT_CHARS) {
              truncated = true;
              break;
            }
          }
        }
      }
    }
  } catch (error) {
    if (signal.aborted) {
      deps.log("info", "chat_client_aborted", { ...logBase, stage: "completion" });
      return;
    }
    const publicError = toPublicCompletionError(error);
    deps.log("error", "completion_failed", {
      ...logBase,
      kind: error instanceof ProviderError ? error.kind : "unknown",
      status: error instanceof ProviderError ? error.status : undefined,
      durationMs: Date.now() - startedAt,
    });
    yield { type: "error", ...publicError };
    return;
  }

  if (signal.aborted) {
    deps.log("info", "chat_client_aborted", { ...logBase, stage: "completion" });
    return;
  }
  if (content.trim().length === 0) {
    deps.log("error", "completion_empty", { ...logBase, finishReason });
    yield {
      type: "error",
      code: "provider_unavailable",
      message: "The assistant returned an empty reply. Please retry.",
      retryable: true,
    };
    return;
  }

  // 3. Persist the completed reply with its search outcome and sources.
  let saved: MessageDTO;
  try {
    saved = await deps.repo.insertMessage(turn.userId, {
      conversationId: turn.conversation.id,
      role: "assistant",
      content,
      webSearch,
      sources: webSearch === "used" ? toSourceRefs(results) : [],
    });
  } catch {
    deps.log("error", "assistant_message_save_failed", logBase);
    yield {
      type: "error",
      code: "internal_error",
      message: "The reply could not be saved. Please retry.",
      retryable: true,
    };
    return;
  }

  // Refine conversation title with smart title generator for the first turn
  if (turn.history.length <= 1) {
    generateSmartTitle(deps.complete, turn.userMessage.content)
      .then((smartTitle) => {
        if (smartTitle && smartTitle !== turn.conversation.title) {
          deps.repo.updateConversationTitle(turn.userId, turn.conversation.id, smartTitle).catch(() => {});
        }
      })
      .catch(() => {});
  }

  deps.log("info", "chat_completed", {
    ...logBase,
    durationMs: Date.now() - startedAt,
    webSearch,
    sourceCount: webSearch === "used" ? results.length : 0,
    finishReason,
    promptTokens: usage?.promptTokens,
    completionTokens: usage?.completionTokens,
  });
  yield { type: "done", message: saved, truncated: truncated || finishReason === "length" };
}
