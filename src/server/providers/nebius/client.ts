import "server-only";
import { z } from "zod";
import {
  createAbortScope,
  discardBody,
  kindFromErrorLabel,
  kindFromStatus,
  ProviderError,
  type AbortScope,
} from "../errors";
import { readSseData, SseFormatError } from "./sse";
import { createThinkFilter } from "./think";

// Nebius Token Factory exposes an OpenAI-compatible chat completions API.
// https://api.tokenfactory.nebius.com/docs

/** A whole tool call, joined from the streamed deltas. `arguments` is the raw JSON text from the model. */
export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

/** A function the model may call. `parameters` is a JSON Schema object. */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export type ChatMessage =
  /** `images`: data URLs sent after the text as `image_url` parts (the image text route, decision 0019). */
  | { role: "system" | "user"; content: string; images?: string[] }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; content: string };

export interface NebiusSettings {
  apiKey: string;
  baseUrl: string;
  model: string;
  maxOutputTokens: number;
  /**
   * Reasoning ("thinking") budget in tokens. When above 0, reasoning is on and
   * Nebius stops it after this many tokens (`thinking_token_budget`, checked on
   * Nano, Super and Ultra on 2026-10-19), so the reply always gets the rest of
   * `maxOutputTokens`. When 0 or unset, reasoning is off.
   */
  thinkingBudgetTokens?: number;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
}

export type CompletionChunk =
  | { type: "text"; text: string }
  /** The model is reasoning. Carries no text: reasoning is never shown or saved. */
  | { type: "reasoning" }
  /** The model started a tool call. Carries no text; counts as the first token. */
  | { type: "tool_progress" }
  /** The whole tool calls of this response, sent once just before `finish`. */
  | { type: "tool_calls"; calls: ToolCall[] }
  | { type: "finish"; finishReason: string | null; usage: TokenUsage | null };

export interface StreamOptions {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  /** Whole-request deadline (wall clock). */
  totalTimeoutMs?: number;
  /** Maximum gap between streamed chunks (including time to first byte). */
  idleTimeoutMs?: number;
  /** Functions the model may call. None or empty: the request has no `tools` field. */
  tools?: ToolDefinition[];
}

/** Most tool calls one response may carry. More is a malformed response. */
const MAX_TOOL_CALLS = 8;
/** Longest tool name and argument text joined from deltas. Longer is a malformed response. */
const MAX_TOOL_NAME_CHARS = 64;
const MAX_TOOL_ARGUMENT_CHARS = 16_000;

const chunkSchema = z.object({
  choices: z
    .array(
      z.object({
        // Reasoning arrives in `reasoning` and `reasoning_content`. Those and
        // other delta fields are ignored, so reasoning is never shown or saved.
        delta: z
          .object({
            content: z.string().nullish(),
            reasoning: z.string().nullish(),
            reasoning_content: z.string().nullish(),
            tool_calls: z
              .array(
                z.object({
                  index: z.number().int().min(0).max(MAX_TOOL_CALLS - 1).nullish(),
                  id: z.string().max(200).nullish(),
                  function: z
                    .object({ name: z.string().nullish(), arguments: z.string().nullish() })
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
  // Checked separately (usageSchema): bad usage must not fail the reply.
  usage: z.unknown().optional(),
  error: z
    .object({
      code: z.union([z.string(), z.number()]).nullish(),
      type: z.string().nullish(),
    })
    .nullish(),
});

// Token counts must be non-negative safe integers. Anything else is treated
// as missing usage, so the spend guard keeps the full hold.
const tokenCount = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const usageSchema = z.object({ prompt_tokens: tokenCount, completion_tokens: tokenCount });

/**
 * An error event inside the stream. A numeric code (or a numeric string) is an
 * HTTP status and is kept, so the executor can tell 404 from 503. A known label
 * decides the kind first (for example `insufficient_quota`). Only the code and
 * type are read; the message is never read or logged.
 */
function streamError(error: { code?: string | number | null; type?: string | null }): ProviderError {
  const code = typeof error.code === "string" && /^\d{3}$/.test(error.code.trim()) ? Number(error.code) : error.code;
  const status = typeof code === "number" && Number.isInteger(code) && code >= 100 && code <= 599 ? code : undefined;
  const label = `${typeof code === "string" ? code : ""} ${error.type ?? ""}`;
  const kind = kindFromErrorLabel(label) ?? (status !== undefined ? kindFromStatus(status) : "unavailable");
  return new ProviderError("nebius", kind, status);
}

const MAX_ERROR_BODY_CHARS = 8_192;

/**
 * `error.code` and `error.type` from a JSON error body, read up to 8 KB. Used
 * only to choose the error kind; the body is never logged or returned.
 */
async function errorBodyLabel(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  try {
    const decoder = new TextDecoder();
    let text = "";
    while (text.length <= MAX_ERROR_BODY_CHARS) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    if (text.length > MAX_ERROR_BODY_CHARS) return "";
    const body: unknown = JSON.parse(text);
    const root = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const error = root.error && typeof root.error === "object" ? (root.error as Record<string, unknown>) : root;
    return [error.code, error.type].filter((value) => typeof value === "string").join(" ");
  } catch {
    return "";
  } finally {
    reader.cancel().catch(() => {});
  }
}

function thinkingFields(budget: number): Record<string, unknown> {
  if (budget <= 0) return { chat_template_kwargs: { enable_thinking: false } };
  return { chat_template_kwargs: { enable_thinking: true }, thinking_token_budget: budget };
}

function toWireMessage(message: ChatMessage): Record<string, unknown> {
  if (message.role === "tool") return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
  if (message.role === "assistant" && message.toolCalls && message.toolCalls.length > 0) {
    return {
      role: "assistant",
      content: message.content || null,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.arguments },
      })),
    };
  }
  if (message.role === "user" && message.images && message.images.length > 0) {
    return {
      role: "user",
      content: [
        { type: "text", text: message.content },
        ...message.images.map((url) => ({ type: "image_url", image_url: { url } })),
      ],
    };
  }
  return { role: message.role, content: message.content };
}

/** The `tools` and `tool_choice` fields, or nothing when no tool is offered. */
export function toolFields(tools: ToolDefinition[] | undefined): Record<string, unknown> {
  if (!tools || tools.length === 0) return {};
  return {
    tools: tools.map((tool) => ({
      type: "function",
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    })),
    tool_choice: "auto",
  };
}

interface PartialToolCall {
  id: string;
  name: string;
  arguments: string;
}

/**
 * Joins `delta.tool_calls` by index. Returns true when a new call starts.
 * Throws ProviderError("bad_response") when a call grows past the limits.
 */
function joinToolDelta(
  calls: Map<number, PartialToolCall>,
  delta: { index?: number | null; id?: string | null; function?: { name?: string | null; arguments?: string | null } | null },
): boolean {
  const index = delta.index ?? 0;
  let call = calls.get(index);
  const started = !call;
  if (!call) {
    if (calls.size >= MAX_TOOL_CALLS) throw new ProviderError("nebius", "bad_response");
    call = { id: "", name: "", arguments: "" };
    calls.set(index, call);
  }
  if (delta.id) call.id = delta.id;
  if (delta.function?.name) call.name += delta.function.name;
  if (delta.function?.arguments) call.arguments += delta.function.arguments;
  if (call.name.length > MAX_TOOL_NAME_CHARS || call.arguments.length > MAX_TOOL_ARGUMENT_CHARS) {
    throw new ProviderError("nebius", "bad_response");
  }
  return started;
}

/**
 * Whole calls in index order. A call without a name is dropped. Every call
 * gets a unique ID: a missing or repeated ID is replaced, so each tool result
 * answers exactly one call.
 */
function finishToolCalls(calls: Map<number, PartialToolCall>): ToolCall[] {
  const named = [...calls.entries()].sort(([a], [b]) => a - b).filter(([, call]) => call.name.length > 0);
  const used = new Set<string>();
  return named.map(([index, call]) => {
    let id = call.id;
    for (let n = 0; !id || used.has(id); n += 1) id = n === 0 ? `call_${index}` : `call_${index}_${n}`;
    used.add(id);
    return { id, name: call.name, arguments: call.arguments };
  });
}

/** `Retry-After` in milliseconds (seconds or an HTTP date), or undefined. */
export function parseRetryAfterMs(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1000);
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

function networkError(scope: AbortScope, parent?: AbortSignal): ProviderError {
  if (parent?.aborted) return new ProviderError("nebius", "aborted");
  if (scope.timedOut()) return new ProviderError("nebius", "timeout");
  return new ProviderError("nebius", "unavailable");
}

/**
 * Streams a chat completion. Yields text chunks, then the joined tool calls if
 * there are any, then a single `finish` chunk.
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
          messages: messages.map(toWireMessage),
          max_tokens: settings.maxOutputTokens,
          stream: true,
          // Token usage arrives in a last chunk with no choices. The spend guard needs it.
          stream_options: { include_usage: true },
          // Turns reasoning off (or on) for Nemotron and other models whose chat template
          // reads this flag. Reasoning tokens cost money and count against max_tokens, so
          // without a budget they could leave no room for the reply.
          ...thinkingFields(settings.thinkingBudgetTokens ?? 0),
          ...toolFields(options.tools),
        }),
        signal: scope.signal,
      });
    } catch {
      throw networkError(scope, options.signal);
    }

    if (!response.ok) {
      const label = await errorBodyLabel(response);
      await discardBody(response);
      const kind = kindFromErrorLabel(label) ?? kindFromStatus(response.status);
      throw new ProviderError("nebius", kind, response.status, {
        retryAfterMs: parseRetryAfterMs(response.headers.get("retry-after")),
      });
    }
    if (!response.body) throw new ProviderError("nebius", "bad_response");
    scope.touch();

    let completed = false;
    let finishReason: string | null = null;
    let usage: TokenUsage | null = null;
    const think = createThinkFilter();
    const toolCalls = new Map<number, PartialToolCall>();

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
        if (chunk.error) throw streamError(chunk.error);
        if (chunk.usage !== undefined && chunk.usage !== null) {
          const parsed = usageSchema.safeParse(chunk.usage);
          usage = parsed.success
            ? { promptTokens: parsed.data.prompt_tokens, completionTokens: parsed.data.completion_tokens }
            : null;
        }
        for (const choice of chunk.choices ?? []) {
          const text = choice.delta?.content ? think.push(choice.delta.content) : "";
          if (text) yield { type: "text", text };
          else if (choice.delta?.content || choice.delta?.reasoning || choice.delta?.reasoning_content) {
            yield { type: "reasoning" };
          }
          for (const delta of choice.delta?.tool_calls ?? []) {
            if (joinToolDelta(toolCalls, delta)) yield { type: "tool_progress" };
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
    const rest = think.flush();
    if (rest) yield { type: "text", text: rest };
    const calls = finishToolCalls(toolCalls);
    if (calls.length > 0) yield { type: "tool_calls", calls };
    yield { type: "finish", finishReason, usage };
  } finally {
    scope.dispose();
  }
}
