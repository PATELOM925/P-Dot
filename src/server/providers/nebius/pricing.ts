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
 * Tokens a chat template can add around tools: its fixed text that explains
 * tool use (when tools are offered or earlier tool messages are in the
 * prompt), the wrapper around each tool definition, each tool call and each
 * tool result. An estimate, not a measurement: chosen well above the
 * templates we know (decision 0013).
 */
const TOKENS_FOR_TOOLS = 1_024;
const TOKENS_PER_TOOL = 128;
const TOKENS_PER_TOOL_CALL = 64;
const TOKENS_PER_TOOL_RESULT = 64;
/**
 * Input tokens one image can make. An estimate, not a measurement: the
 * browser sends at most 1,280 px on the long side, which vision models with
 * tiles of 448 to 512 px turn into a few thousand tokens. Chosen well above
 * that (decision 0019); the settle uses the real usage.
 */
export const TOKENS_PER_IMAGE = 16_384;

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
  let toolParts = tools.length;
  for (const message of messages) {
    tokens += size(message.content);
    if ((message.role === "user" || message.role === "system") && message.images) {
      tokens += message.images.length * TOKENS_PER_IMAGE;
    }
    if (message.role === "tool") {
      tokens += size(message.toolCallId) + TOKENS_PER_TOOL_RESULT;
      toolParts += 1;
    }
    if (message.role === "assistant") {
      for (const call of message.toolCalls ?? []) {
        tokens += size(call.id) + size(call.name) + size(call.arguments) + TOKENS_PER_TOOL_CALL;
        toolParts += 1;
      }
    }
  }
  if (tools.length > 0) tokens += size(JSON.stringify(toolFields(tools))) + tools.length * TOKENS_PER_TOOL;
  // The final pass has no tools field, but its earlier tool messages can still bring the template's tool text.
  if (toolParts > 0) tokens += TOKENS_FOR_TOOLS;
  return tokens;
}
