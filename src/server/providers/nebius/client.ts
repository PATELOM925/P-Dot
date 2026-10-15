import "server-only";
import { z } from "zod";
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
  role: "system" | "user" | "assistant";
  content: string;
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
  | { type: "finish"; finishReason: string | null; usage: TokenUsage | null };

export interface StreamOptions {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  /** Whole-request deadline (wall clock). */
  totalTimeoutMs?: number;
  /** Maximum gap between streamed chunks (including time to first byte). */
  idleTimeoutMs?: number;
}

const chunkSchema = z.object({
  choices: z
    .array(
      z.object({
        // `reasoning_content` and other delta fields are intentionally ignored.
        delta: z.object({ content: z.string().nullish() }).nullish(),
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
 * Streams a chat completion. Yields text chunks, then a single `finish` chunk.
 * Throws ProviderError on HTTP errors, in-stream errors, timeouts, malformed
 * data, or a stream that ends without completing.
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
    try {
      response = await fetchImpl(`${settings.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${settings.apiKey}`,
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify({
          model: settings.model,
          messages,
          max_tokens: settings.maxOutputTokens,
          stream: true,
          stream_options: { include_usage: true },
        }),
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
    yield { type: "finish", finishReason, usage };
  } finally {
    scope.dispose();
  }
}
