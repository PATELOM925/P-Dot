import "server-only";
import { SEARCH_EXCERPT_CHARS, SEARCH_MAX_RESULTS } from "@/lib/limits";
import { MAX_SAFE_URL_CHARS } from "@/lib/safe-url";
import { ConfigError } from "@/lib/supabase-config";
import type { ApiErrorCode } from "@/types/api";
import type { SpendLimit } from "@/server/db/spend";
import type { ChatMessage, TokenUsage, ToolDefinition } from "@/server/providers/nebius/client";
import {
  costMicroUsd,
  inputTokenBound,
  isValidUsage,
  priceForModel,
  type ModelPrice,
} from "@/server/providers/nebius/pricing";

/** The largest hold the database accepts for one Nebius call ($0.25). */
export const MAX_NEBIUS_HOLD_MICRO_USD = 250_000;

/** Credits for one Tavily search at `basic` depth (the only depth this app uses). */
export const TAVILY_BASIC_SEARCH_CREDITS = 1;

/**
 * Bytes that search results can add to the prompt: each result has a title
 * (200 characters) and an excerpt, with up to 4 UTF-8 bytes per character,
 * a normalized ASCII URL, and the wrapper text.
 */
export const SEARCH_RESULTS_MAX_BYTES =
  SEARCH_MAX_RESULTS * ((200 + SEARCH_EXCERPT_CHARS) * 4 + MAX_SAFE_URL_CHARS + 128) + 512;

/** The model's price. A model without a price is a configuration error: it is never called. */
function requirePrice(model: string): ModelPrice {
  const price = priceForModel(model);
  if (!price) throw new ConfigError(["NEBIUS_MODEL"]);
  return price;
}

/**
 * The worst-case cost of one Nebius call is above the largest hold the
 * database accepts. The call is refused before anything is reserved or sent,
 * because a smaller hold would not cover its real cost.
 */
export class NebiusHoldTooLargeError extends Error {
  constructor() {
    super("refused: the worst-case cost is too large for one spend hold");
    this.name = "NebiusHoldTooLargeError";
  }
}

function requireHold(price: ModelPrice, worstCase: TokenUsage): number {
  const hold = Math.max(1, costMicroUsd(price, worstCase));
  if (hold > MAX_NEBIUS_HOLD_MICRO_USD) throw new NebiusHoldTooLargeError();
  return hold;
}

/** Bytes an embedding request can add for each text, on top of its own UTF-8 bytes. */
const EMBEDDING_BYTES_PER_TEXT = 16;

/**
 * Worst-case cost of one embedding batch: every UTF-8 byte is one token, plus
 * a small overhead for each text. Throws NebiusHoldTooLargeError above the
 * ceiling and ConfigError for a model without a price.
 */
export function nebiusEmbeddingHoldMicroUsd(model: string, texts: string[]): number {
  const encoder = new TextEncoder();
  const bytes = texts.reduce((sum, t) => sum + encoder.encode(t).length + EMBEDDING_BYTES_PER_TEXT, 0);
  return requireHold(requirePrice(model), { promptTokens: bytes, completionTokens: 0 });
}

/**
 * Worst-case cost of one Nebius call, in micro-dollars: every input byte as a
 * token (tool definitions included), plus the full output token limit, at the
 * model's price. Throws a
 * ConfigError for a model that has no price and NebiusHoldTooLargeError above
 * the ceiling, before any provider call.
 */
export function nebiusHoldMicroUsd(
  model: string,
  messages: ChatMessage[],
  maxOutputTokens: number,
  extraInputBytes = 0,
  tools: ToolDefinition[] = [],
): number {
  return requireHold(requirePrice(model), {
    promptTokens: inputTokenBound(messages, extraInputBytes, tools),
    completionTokens: maxOutputTokens,
  });
}

/**
 * The amount to settle for a Nebius call. With valid usage, the real cost.
 * Without usage (error, stop, disconnect) or with invalid usage, the full
 * hold: a safe estimate, never zero. Never more than the hold, because settle
 * can only give back.
 */
export function nebiusSettleMicroUsd(model: string, heldMicroUsd: number, usage: TokenUsage | null): number {
  const price = priceForModel(model);
  if (!usage || !price || !isValidUsage(usage)) return heldMicroUsd;
  return Math.min(heldMicroUsd, costMicroUsd(price, usage));
}

export interface BudgetRefusal {
  status: number;
  code: ApiErrorCode;
  message: string;
  headers?: Record<string, string>;
}

function secondsToNextUtcDay(now: Date): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}

/** The response when the Nebius budget refuses a chat request. */
export function budgetRefusal(limit: SpendLimit, now: Date): BudgetRefusal {
  if (limit === "period") {
    return {
      status: 503,
      code: "budget_exhausted",
      message: "P-Dot has reached its total usage limit. Try again later.",
    };
  }
  return {
    status: 429,
    code: "budget_exhausted",
    message:
      limit === "user"
        ? "You have reached your daily usage limit. Try again tomorrow."
        : "P-Dot has reached its daily usage limit. Try again tomorrow.",
    headers: { "Retry-After": String(secondsToNextUtcDay(now)) },
  };
}

export const SEARCH_BUDGET_MESSAGE =
  "Web search was not used because P-Dot has reached its search limit for now, so this answer is not based on web sources.";
