import "server-only";
import type { ProviderName } from "./errors";
import { streamChatCompletion, type ChatMessage, type CompletionChunk, type ToolDefinition } from "./nebius/client";

export type { ChatMessage, CompletionChunk, TokenUsage, ToolCall, ToolDefinition } from "./nebius/client";

/** One call to one model. The executor builds one for each attempt. */
export interface ModelCallRequest {
  model: string;
  messages: ChatMessage[];
  maxOutputTokens: number;
  /** Reasoning token budget; 0 turns reasoning off. */
  thinkingBudgetTokens: number;
  /** Wall-clock limit for this call (the request deadline that is left). */
  timeoutMs: number;
  /** Functions the model may call in this call. None: tools are off. */
  tools?: ToolDefinition[];
}

/**
 * A streaming chat model provider. The executor (src/server/assistant/executor.ts)
 * uses only this interface, so retries, fallbacks and hedging do not depend on
 * one provider. Errors must be ProviderError; an aborted `signal` must end the
 * stream.
 */
export interface ModelProvider {
  readonly name: ProviderName;
  stream(request: ModelCallRequest, signal: AbortSignal): AsyncIterable<CompletionChunk>;
}

export function createNebiusProvider(
  settings: { apiKey: string; baseUrl: string },
  options: { fetchImpl?: typeof fetch } = {},
): ModelProvider {
  return {
    name: "nebius",
    stream: (request, signal) =>
      streamChatCompletion(
        {
          apiKey: settings.apiKey,
          baseUrl: settings.baseUrl,
          model: request.model,
          maxOutputTokens: request.maxOutputTokens,
          thinkingBudgetTokens: request.thinkingBudgetTokens,
        },
        request.messages,
        { signal, totalTimeoutMs: request.timeoutMs, fetchImpl: options.fetchImpl, tools: request.tools },
      ),
  };
}
