import "server-only";
import type { ChatMessage, TokenUsage } from "./client";

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

/** Used for a model that is not in the table: the most expensive known price. */
export const FALLBACK_PRICE: ModelPrice = Object.values(PRICES).reduce((max, price) => ({
  inputNanoUsdPerToken: Math.max(max.inputNanoUsdPerToken, price.inputNanoUsdPerToken),
  outputNanoUsdPerToken: Math.max(max.outputNanoUsdPerToken, price.outputNanoUsdPerToken),
}));

export function priceForModel(model: string): { price: ModelPrice; known: boolean } {
  const price = Object.hasOwn(PRICES, model) ? PRICES[model] : undefined;
  return price ? { price, known: true } : { price: FALLBACK_PRICE, known: false };
}

/** Cost in micro-dollars, rounded up. Completion tokens include any reasoning tokens. */
export function costMicroUsd(price: ModelPrice, usage: TokenUsage): number {
  const nano =
    Math.max(0, usage.promptTokens) * price.inputNanoUsdPerToken +
    Math.max(0, usage.completionTokens) * price.outputNanoUsdPerToken;
  return Math.ceil(nano / 1000);
}

/** Tokens added by the chat template around each message and the whole prompt (generous). */
const TOKENS_PER_MESSAGE = 16;
const TOKENS_PER_PROMPT = 64;

/**
 * An upper bound on the input tokens of a prompt. Byte-level tokenizers never
 * make more tokens than there are UTF-8 bytes, so the byte count is a safe
 * bound for any text, including emoji and other multi-byte characters.
 */
export function inputTokenBound(messages: ChatMessage[], extraBytes = 0): number {
  const encoder = new TextEncoder();
  let bytes = extraBytes;
  for (const message of messages) bytes += encoder.encode(message.content).length;
  return bytes + messages.length * TOKENS_PER_MESSAGE + TOKENS_PER_PROMPT;
}
