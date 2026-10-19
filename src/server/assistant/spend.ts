import "server-only";
import { SEARCH_EXCERPT_CHARS, SEARCH_MAX_RESULTS } from "@/lib/limits";
import type { ApiErrorCode } from "@/types/api";
import type { SpendLimit } from "@/server/db/spend";
import type { ChatMessage, TokenUsage } from "@/server/providers/nebius/client";
import { costMicroUsd, inputTokenBound, priceForModel } from "@/server/providers/nebius/pricing";

/** The largest hold the database accepts for one Nebius call ($0.25). */
export const MAX_NEBIUS_HOLD_MICRO_USD = 250_000;

/** Credits for one Tavily search at `basic` depth (the only depth this app uses). */
export const TAVILY_BASIC_SEARCH_CREDITS = 1;

/**
 * Bytes that search results can add to the prompt: each result has a title
 * (200 characters), a URL (2,048) and an excerpt, with up to 4 UTF-8 bytes
 * per character, plus the wrapper text.
 */
export const SEARCH_RESULTS_MAX_BYTES = SEARCH_MAX_RESULTS * ((200 + SEARCH_EXCERPT_CHARS) * 4 + 2_048 + 128) + 512;

/**
 * Worst-case cost of one Nebius call, in micro-dollars: every input byte as a
 * token, plus the full output token limit, at the model's price (or the most
 * expensive price for an unknown model).
 */
export function nebiusHoldMicroUsd(
  model: string,
  messages: ChatMessage[],
  maxOutputTokens: number,
  extraInputBytes = 0,
): number {
  const { price } = priceForModel(model);
  const cost = costMicroUsd(price, {
    promptTokens: inputTokenBound(messages, extraInputBytes),
    completionTokens: maxOutputTokens,
  });
  return Math.max(1, Math.min(cost, MAX_NEBIUS_HOLD_MICRO_USD));
}

/**
 * The amount to settle for a Nebius call. With usage, the real cost. Without
 * usage (error, stop, disconnect), the full hold: a safe estimate, never zero.
 * Never more than the hold, because settle can only give back.
 */
export function nebiusSettleMicroUsd(model: string, heldMicroUsd: number, usage: TokenUsage | null): number {
  if (!usage) return heldMicroUsd;
  return Math.min(heldMicroUsd, costMicroUsd(priceForModel(model).price, usage));
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
