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
  ProposedAction,
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
import type { DocumentRepository } from "@/server/db/documents";
import { formatDocumentMatches, buildPromptMessages, formatSearchResults } from "./prompt";
import {
  WEB_SEARCH_TOOL,
  SEARCH_DOCUMENTS_TOOL,
  PROPOSE_REMINDER_TOOL,
  PROPOSE_TASK_TOOL,
  type ToolDefinition,
  type ToolCall,
} from "./tools";

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
  /** Document repository for personal RAG */
  documentRepo?: DocumentRepository;
  /** Embedding generator for personal RAG */
  embed?: (text: string, signal?: AbortSignal) => Promise<number[]>;
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

function normalizeAssistantText(text: string): string {
  return text
    .replace(/[\u202F\u00A0]/g, " ")
    .replace(/【([0-9]+)】/g, "[$1]");
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
  let allSources: SourceRef[] = [];
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
        allSources = [...toSourceRefs(results)];
        yield {
          type: "search",
          status: webSearch,
          sources: allSources,
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

  const availableTools: ToolDefinition[] = [
    ...(deps.search ? [WEB_SEARCH_TOOL] : []),
    ...(deps.documentRepo && deps.embed ? [SEARCH_DOCUMENTS_TOOL] : []),
    PROPOSE_REMINDER_TOOL,
    PROPOSE_TASK_TOOL,
  ];

  let content = "";
  let truncated = false;
  let finishReason: string | null = null;
  let usage: TokenUsage | null = null;
  const proposedActions: ProposedAction[] = [];
  const MAX_TOOL_HOPS = 3; // Strict budget of up to 3 tool execution attempts per turn
  let hop = 0;

  try {
    while (hop < MAX_TOOL_HOPS) {
      let pendingToolCalls: ToolCall[] = [];
      const remainingAttempts = MAX_TOOL_HOPS - hop;
      // Provide tools while attempts remain; on the final hop, disable tools so the model synthesizes text
      const currentTools = hop < MAX_TOOL_HOPS - 1 && availableTools.length > 0 ? availableTools : undefined;
      const currentToolChoice = currentTools ? "auto" : undefined;

      content = "";
      for await (const chunk of deps.complete(messages, signal, { tools: currentTools, toolChoice: currentToolChoice })) {
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
        if (chunk.type === "tool_calls") {
          pendingToolCalls = chunk.calls;
          continue;
        }

        if (chunk.type === "text") {
          const normalized = normalizeAssistantText(chunk.text);
          const room = MAX_ASSISTANT_CHARS - content.length;
          const text = normalized.slice(0, room);
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

      if (pendingToolCalls.length === 0) {
        // Model provided its direct text reply without calling tools
        break;
      }

      // Check if model called web_search, search_documents, propose_reminder, or propose_task
      const searchCall = pendingToolCalls.find((call) => call.function.name === "web_search");
      const docCall = pendingToolCalls.find((call) => call.function.name === "search_documents");
      const reminderCall = pendingToolCalls.find((call) => call.function.name === "propose_reminder");
      const taskCall = pendingToolCalls.find((call) => call.function.name === "propose_task");
      const activeCall = searchCall ?? docCall ?? reminderCall ?? taskCall ?? pendingToolCalls[0]!;

      // Chain of Thought event: emit the model's reasoning or plan for this hop
      const rawThought = content.trim();
      let planningThought = rawThought;
      if (!planningThought) {
        if (searchCall) {
          let q = turn.userMessage.content;
          try {
            const p = JSON.parse(searchCall.function.arguments);
            if (typeof p.query === "string" && p.query.trim()) q = p.query.trim();
          } catch {}
          planningThought = `Searching the web for "${q}" (Hop ${hop + 1} of ${MAX_TOOL_HOPS})...`;
        } else if (docCall) {
          let q = turn.userMessage.content;
          try {
            const p = JSON.parse(docCall.function.arguments);
            if (typeof p.query === "string" && p.query.trim()) q = p.query.trim();
          } catch {}
          planningThought = `Searching personal documents for "${q}" (Hop ${hop + 1} of ${MAX_TOOL_HOPS})...`;
        } else if (reminderCall) {
          planningThought = `Preparing reminder proposal...`;
        } else if (taskCall) {
          planningThought = `Preparing task proposal...`;
        } else {
          planningThought = `Executing ${activeCall.function.name}...`;
        }
      }

      yield { type: "thought", text: planningThought };
      content = ""; // Clear content buffer so intermediate thought doesn't contaminate final response

      if (searchCall && deps.search) {
        let query = turn.userMessage.content;
        try {
          const parsed = JSON.parse(searchCall.function.arguments);
          if (typeof parsed.query === "string" && parsed.query.trim()) {
            query = parsed.query.trim();
          }
        } catch {
          // Fallback to original user query
        }

        try {
          const newResults = await deps.search(query, signal);
          results = [...results, ...newResults];
          allSources = [...allSources, ...toSourceRefs(newResults)];
          webSearch = results.length > 0 ? "used" : "no_results";
          yield {
            type: "search",
            status: webSearch,
            sources: allSources,
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
          yield { type: "search", status: "failed", sources: allSources, message: publicSearchFailureMessage(error) };
        }

        // Add assistant tool invocation and tool response to context with remaining attempt guidance
        messages.push({
          role: "assistant",
          content: null,
          tool_calls: [searchCall],
        });
        messages.push({
          role: "tool",
          tool_call_id: searchCall.id,
          name: "web_search",
          content: results.length > 0
            ? `${formatSearchResults(results)}\n\n(Search attempts remaining: ${remainingAttempts - 1} of ${MAX_TOOL_HOPS}. If you have sufficient information, answer now with [n] citations.)`
            : "No web search results found.",
        });
      } else if (docCall && deps.documentRepo && deps.embed) {
        let query = turn.userMessage.content;
        try {
          const parsed = JSON.parse(docCall.function.arguments);
          if (typeof parsed.query === "string" && parsed.query.trim()) {
            query = parsed.query.trim();
          }
        } catch {
          // Fallback to original user query
        }

        try {
          const queryEmbedding = await deps.embed(query, signal);
          const matches = await deps.documentRepo.searchChunks(turn.userId, queryEmbedding, {
            threshold: 0.2,
            limit: 4,
          });

          if (matches.length > 0) {
            const docSources: SourceRef[] = matches.map((m) => ({
              title: `${m.filename} (Section ${m.chunkIndex + 1})`,
              url: `doc://${m.documentId}#chunk-${m.chunkIndex}`,
            }));
            allSources = [...allSources, ...docSources];
            yield {
              type: "search",
              status: "used",
              sources: allSources,
            };
          }

          messages.push({
            role: "assistant",
            content: null,
            tool_calls: [docCall],
          });
          messages.push({
            role: "tool",
            tool_call_id: docCall.id,
            name: "search_documents",
            content: matches.length > 0
              ? `${formatDocumentMatches(matches, allSources.length - matches.length + 1)}\n\n(Attempts remaining: ${remainingAttempts - 1} of ${MAX_TOOL_HOPS}. If you have sufficient information, answer now citing document sources with [n]. If additional public information is needed to fulfill the user's goal, you may call 'web_search' next.)`
              : `No relevant information found in personal documents for "${query}". (Attempts remaining: ${remainingAttempts - 1} of ${MAX_TOOL_HOPS}. If this question can be answered using public information, you may call 'web_search' next, or answer directly if you already know.)`,
          });
        } catch (error) {
          if (signal.aborted) {
            deps.log("info", "chat_client_aborted", { ...logBase, stage: "search_documents" });
            return;
          }
          deps.log("warn", "search_documents_failed", {
            ...logBase,
            error: error instanceof Error ? error.message : String(error),
          });
          messages.push({
            role: "assistant",
            content: null,
            tool_calls: [docCall],
          });
          messages.push({
            role: "tool",
            tool_call_id: docCall.id,
            name: "search_documents",
            content: "Document search unavailable. Please answer from other context or general knowledge.",
          });
        }
      } else if (reminderCall) {
        let title = "Reminder";
        let dueAt = "tomorrow";
        let notes: string | undefined;
        try {
          const parsed = JSON.parse(reminderCall.function.arguments);
          if (parsed.title) title = parsed.title;
          if (parsed.due_at) dueAt = parsed.due_at;
          if (parsed.notes) notes = parsed.notes;
        } catch {}

        const action: ProposedAction = {
          id: `act_${Math.random().toString(36).slice(2, 9)}`,
          kind: "reminder",
          title,
          dueAt,
          notes,
        };
        proposedActions.push(action);
        yield { type: "action", action };

        messages.push({
          role: "assistant",
          content: null,
          tool_calls: [reminderCall],
        });
        messages.push({
          role: "tool",
          tool_call_id: reminderCall.id,
          name: "propose_reminder",
          content: `Reminder "${title}" scheduled for "${dueAt}" has been presented as an interactive card for the user's approval. Confirm this politely to the user.`,
        });
      } else if (taskCall) {
        let title = "Task";
        let priority: "low" | "medium" | "high" = "medium";
        let dueDate: string | undefined;
        try {
          const parsed = JSON.parse(taskCall.function.arguments);
          if (parsed.title) title = parsed.title;
          if (parsed.priority) priority = parsed.priority;
          if (parsed.due_date) dueDate = parsed.due_date;
        } catch {}

        const action: ProposedAction = {
          id: `act_${Math.random().toString(36).slice(2, 9)}`,
          kind: "task",
          title,
          priority,
          dueDate,
        };
        proposedActions.push(action);
        yield { type: "action", action };

        messages.push({
          role: "assistant",
          content: null,
          tool_calls: [taskCall],
        });
        messages.push({
          role: "tool",
          tool_call_id: taskCall.id,
          name: "propose_task",
          content: `Task "${title}" (priority: ${priority}) has been presented as an interactive card for the user's approval. Confirm this politely to the user.`,
        });
      } else {
        messages.push({
          role: "assistant",
          content: null,
          tool_calls: [activeCall],
        });
        messages.push({
          role: "tool",
          tool_call_id: activeCall.id,
          name: activeCall.function.name,
          content: "Tool completed.",
        });
      }

      hop++;
    }

    // Fallback synthesis pass if after all hops content is still empty:
    if (content.trim().length === 0) {
      const finalMessages: ChatMessage[] = [
        ...messages,
        {
          role: "user",
          content: "All tool attempts have concluded. Please provide your direct final response now.",
        },
      ];
      for await (const chunk of deps.complete(finalMessages, signal)) {
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
          const normalized = normalizeAssistantText(chunk.text);
          const room = MAX_ASSISTANT_CHARS - content.length;
          const text = normalized.slice(0, room);
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
      sources: allSources.slice(0, 10),
    });
    if (proposedActions.length > 0) {
      saved = { ...saved, actions: proposedActions };
    }
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
