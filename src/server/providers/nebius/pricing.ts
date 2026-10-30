import "server-only";
import { toolFields, type ChatMessage, type TokenUsage, type ToolDefinition } from "./client";

// Nebius Token Factory prices, from GET /v1/models?verbose=true (checked 2026-10-19).
// A price of X USD per million tokens is X micro-dollars per token. The table
// stores nano-dollars per token (1,000 nano = 1 micro) so the math stays in integers.

export interface ModelPrice {
  inputNanoUsdPerToken: number;
  outputNanoUsdPerToken: number;
}

const PRICES: Readonly<Record<string, ModelPrice>> = {
  "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B": { inputNanoUsdPerToken: 60, outputNanoUsdPerToken: 240 },
  "nvidia/Nemotron-3_5-Lightning": { inputNanoUsdPerToken: 60, outputNanoUsdPerToken: 240 },
  "nvidia/nemotron-3-super-120b-a12b": { inputNanoUsdPerToken: 300, outputNanoUsdPerToken: 900 },
  "nvidia/Nemotron-3.5-Super-VL": { inputNanoUsdPerToken: 300, outputNanoUsdPerToken: 900 },
  "nvidia/Nemotron-3-Ultra-550b-a55b": { inputNanoUsdPerToken: 1000, outputNanoUsdPerToken: 3000 },
  "Qwen/Qwen3-Embedding-8B": { inputNanoUsdPerToken: 10, outputNanoUsdPerToken: 0 },
};

/**
 * The price of a model, or null when the model is not in the table. There is
 * no fallback price: some Nebius models cost much more than any model here,
 * so a model without a price must not be used.
 */
export function priceForModel(model: string): ModelPrice | null {
  return Object.hasOwn(PRICES, model) ? (PRICES[model] ?? null) : null;
}

/** True when both token counts are non-negative safe integers. */
export function isValidUsage(usage: TokenUsage): boolean {
  return [usage.promptTokens, usage.completionTokens].every((n) => Number.isSafeInteger(n) && n >= 0);
}

/**
 * Cost in micro-dollars, rounded up. Completion tokens include any reasoning
 * tokens. Throws on invalid usage: callers must treat that as missing usage.
 */
export function costMicroUsd(price: ModelPrice, usage: TokenUsage): number {
  if (!isValidUsage(usage)) throw new RangeError("Invalid token usage");
  const nano = usage.promptTokens * price.inputNanoUsdPerToken + usage.completionTokens * price.outputNanoUsdPerToken;
  return Math.ceil(nano / 1000);
}

/** Tokens added by the chat template around each message and the whole prompt (generous). */
const TOKENS_PER_MESSAGE = 16;
const TOKENS_PER_PROMPT = 64;
/**
 * Tokens a chat template can add when tools are offered: its fixed text that
 * explains tool use, and the wrapper around each tool and each tool call.
 * Not measured; chosen well above the templates we know.
 */
const TOKENS_FOR_TOOLS = 512;
const TOKENS_PER_TOOL = 64;
const TOKENS_PER_TOOL_CALL = 32;

/**
 * An upper bound on the input tokens of a prompt. Byte-level tokenizers never
 * make more tokens than there are UTF-8 bytes, so the byte count is a safe
 * bound for any text, including emoji and other multi-byte characters. Tool
 * definitions count as their JSON request text, and tool calls and tool
 * results count with their IDs and names.
 */
export function inputTokenBound(messages: ChatMessage[], extraBytes = 0, tools: ToolDefinition[] = []): number {
  const encoder = new TextEncoder();
  const size = (text: string) => encoder.encode(text).length;
  let tokens = extraBytes + messages.length * TOKENS_PER_MESSAGE + TOKENS_PER_PROMPT;
  for (const message of messages) {
    tokens += size(message.content);
    if (message.role === "tool") tokens += size(message.toolCallId);
    if (message.role === "assistant") {
      for (const call of message.toolCalls ?? []) {
        tokens += size(call.id) + size(call.name) + size(call.arguments) + TOKENS_PER_TOOL_CALL;
      }
    }
  }
  if (tools.length > 0) {
    tokens += size(JSON.stringify(toolFields(tools))) + TOKENS_FOR_TOOLS + tools.length * TOKENS_PER_TOOL;
  }
  return tokens;
}
