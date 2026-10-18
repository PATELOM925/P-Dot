import "server-only";
import { z } from "zod";
import type { ToolDefinition, ToolCall } from "@/server/assistant/tools";
import {
  createAbortScope,
  discardBody,
  kindFromStatus,
  ProviderError,
  type AbortScope,
  type ProviderErrorKind,
} from "../errors";
import { readSseData, SseFormatError } from "./sse";

// Nebius Token Factory exposes an OpenAI-compatible chat completions API.
// https://api.tokenfactory.nebius.com/docs

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface NebiusSettings {
  apiKey: string;
  baseUrl: string;
  model: string;
  maxOutputTokens: number;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
}

export type CompletionChunk =
  | { type: "text"; text: string }
  | { type: "tool_calls"; calls: ToolCall[] }
  | { type: "finish"; finishReason: string | null; usage: TokenUsage | null };

export interface StreamOptions {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  /** Whole-request deadline (wall clock). */
  totalTimeoutMs?: number;
  /** Maximum gap between streamed chunks (including time to first byte). */
  idleTimeoutMs?: number;
  /** Available function calling tools for the model. */
  tools?: ToolDefinition[];
  /** Control tool selection: 'auto', 'none', 'required', or a specific function. */
  toolChoice?: "auto" | "none" | "required" | { type: "function"; function: { name: string } };
}

const chunkSchema = z.object({
  choices: z
    .array(
      z.object({
        // `reasoning_content` and other delta fields are intentionally ignored.
        delta: z
          .object({
            content: z.string().nullish(),
            tool_calls: z
              .array(
                z.object({
                  index: z.number().nullish(),
                  id: z.string().nullish(),
                  type: z.string().nullish(),
                  function: z
                    .object({
                      name: z.string().nullish(),
                      arguments: z.string().nullish(),
                    })
                    .nullish(),
                }),
              )
              .nullish(),
          })
          .nullish(),
        finish_reason: z.string().nullish(),
      }),
    )
    .nullish(),
  usage: z
    .object({ prompt_tokens: z.number(), completion_tokens: z.number() })
    .nullish(),
  error: z
    .object({
      code: z.union([z.string(), z.number()]).nullish(),
      type: z.string().nullish(),
    })
    .nullish(),
});

function streamErrorKind(error: { code?: string | number | null; type?: string | null }): ProviderErrorKind {
  if (typeof error.code === "number") return kindFromStatus(error.code);
  const label = `${error.code ?? ""} ${error.type ?? ""}`.toLowerCase();
  if (label.includes("rate")) return "rate_limited";
  if (label.includes("timeout")) return "timeout";
  return "unavailable";
}

function networkError(scope: AbortScope, parent?: AbortSignal): ProviderError {
  if (parent?.aborted) return new ProviderError("nebius", "aborted");
  if (scope.timedOut()) return new ProviderError("nebius", "timeout");
  return new ProviderError("nebius", "unavailable");
}

/**
 * Streams a chat completion. Yields text chunks, any completed tool calls,
 * and then a single `finish` chunk. Throws ProviderError on HTTP errors,
 * in-stream errors, timeouts, malformed data, or a stream that ends prematurely.
 */
export async function* streamChatCompletion(
  settings: NebiusSettings,
  messages: ChatMessage[],
  options: StreamOptions = {},
): AsyncGenerator<CompletionChunk> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const scope = createAbortScope({
    totalMs: options.totalTimeoutMs ?? 55_000,
    idleMs: options.idleTimeoutMs ?? 25_000,
    parent: options.signal,
  });

  try {
    let response: Response;
    const bodyPayload: Record<string, unknown> = {
      model: settings.model,
      messages,
      max_tokens: settings.maxOutputTokens,
      stream: true,
      stream_options: { include_usage: true },
    };

    if (options.tools && options.tools.length > 0) {
      bodyPayload.tools = options.tools;
      if (options.toolChoice) {
        bodyPayload.tool_choice = options.toolChoice;
      }
    }

    try {
      response = await fetchImpl(`${settings.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${settings.apiKey}`,
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify(bodyPayload),
        signal: scope.signal,
      });
    } catch {
      throw networkError(scope, options.signal);
    }

    if (!response.ok) {
      await discardBody(response);
      throw new ProviderError("nebius", kindFromStatus(response.status), response.status);
    }
    if (!response.body) throw new ProviderError("nebius", "bad_response");
    scope.touch();

    let completed = false;
    let finishReason: string | null = null;
    let usage: TokenUsage | null = null;
    const toolCallsAcc: Map<number, { id: string; name: string; arguments: string }> = new Map();

    try {
      for await (const data of readSseData(response.body, scope.signal)) {
        scope.touch();
        if (data.trim() === "[DONE]") {
          completed = true;
          break;
        }

        let chunk: z.infer<typeof chunkSchema>;
        try {
          chunk = chunkSchema.parse(JSON.parse(data));
        } catch {
          throw new ProviderError("nebius", "bad_response");
        }
        if (chunk.error) throw new ProviderError("nebius", streamErrorKind(chunk.error));
        if (chunk.usage) {
          usage = {
            promptTokens: chunk.usage.prompt_tokens,
            completionTokens: chunk.usage.completion_tokens,
          };
        }
        for (const choice of chunk.choices ?? []) {
          const text = choice.delta?.content;
          if (text) yield { type: "text", text };

          if (choice.delta?.tool_calls) {
            for (const tc of choice.delta.tool_calls) {
              const idx = tc.index ?? toolCallsAcc.size;
              const existing = toolCallsAcc.get(idx) ?? { id: "", name: "", arguments: "" };
              if (tc.id) existing.id = tc.id;
              if (tc.function?.name) existing.name += tc.function.name;
              if (tc.function?.arguments) existing.arguments += tc.function.arguments;
              toolCallsAcc.set(idx, existing);
            }
          }

          if (choice.finish_reason) finishReason = choice.finish_reason;
        }
      }
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      if (error instanceof SseFormatError) throw new ProviderError("nebius", "bad_response");
      throw networkError(scope, options.signal);
    }

    // A stream that stops without [DONE] or a finish reason was cut off.
    if (!completed && finishReason === null) {
      throw networkError(scope, options.signal);
    }

    if (toolCallsAcc.size > 0) {
      const completedCalls: ToolCall[] = Array.from(toolCallsAcc.values()).map((tc) => ({
        id: tc.id || `call_${Math.random().toString(36).slice(2, 9)}`,
        type: "function",
        function: {
          name: tc.name,
          arguments: tc.arguments,
        },
      }));
      yield { type: "tool_calls", calls: completedCalls };
    }

    yield { type: "finish", finishReason, usage };
  } finally {
    scope.dispose();
  }
}
