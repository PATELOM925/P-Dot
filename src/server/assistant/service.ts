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
  SourceRef,
  WebSearchStatus,
} from "@/types/api";
import type { ConversationRepository } from "@/server/db/conversations";
import type { QuotaGate } from "@/server/db/quota";
import type { SpendGuard } from "@/server/db/spend";
import type { Logger } from "@/server/log";
import { ProviderError } from "@/server/providers/errors";
import type { ModelProvider, TokenUsage } from "@/server/providers/model";
import type { WebSearchResult } from "@/server/providers/tavily/client";
import type { CircuitBreaker } from "./breaker";
import { buildContextWindow, titleFromMessage, type HistoryMessage } from "./context";
import { publicSearchFailureMessage, toPublicCompletionError } from "./errors";
import {
  BudgetExhaustedError,
  EmptyReplyError,
  executeRouted,
  newRouteReport,
  type AttemptBudget,
  type RouteReport,
} from "./executor";
import { buildPromptMessages } from "./prompt";
import { routeRequest, type RouteDecision } from "./router";
import {
  budgetRefusal,
  nebiusHoldMicroUsd,
  nebiusSettleMicroUsd,
  SEARCH_BUDGET_MESSAGE,
  SEARCH_RESULTS_MAX_BYTES,
  TAVILY_BASIC_SEARCH_CREDITS,
} from "./spend";
import type { RoutingConfig } from "./tiers";

export interface AssistantDeps {
  repo: ConversationRepository;
  quota: QuotaGate;
  /** Global spend caps for paid providers, shared by all users. */
  spend: SpendGuard;
  /** Model tiers: chains, limits and timing. Each attempt is priced for its model. */
  routing: RoutingConfig;
  /** Null when web search is not configured on this server. */
  search: ((query: string, signal: AbortSignal) => Promise<WebSearchResult[]>) | null;
  /** The model provider used by the executor for every attempt. */
  provider: ModelProvider;
  /** Soft per-model circuit breaker (isolate memory, best effort). */
  breaker: CircuitBreaker;
  /** Random number from 0 to 1 for backoff jitter (tests replace it). */
  random?: () => number;
  now: () => Date;
  log: Logger;
  /** Keeps work (the spend settle) running after the client disconnects. */
  waitUntil: (work: Promise<unknown>) => void;
}

/** A Nebius hold made before the stream starts and settled when it ends. */
export interface NebiusHold {
  reservationId: string;
  heldMicroUsd: number;
}

export interface PreparedTurn {
  requestId: string;
  userId: string;
  conversation: ConversationSummary;
  userMessage: MessageDTO;
  /** Chronological history ending with `userMessage`. */
  history: HistoryMessage[];
  webSearch: boolean;
  /** True when search was requested but the Tavily budget refused it. */
  searchBudgetExhausted: boolean;
  /** The tier for this reply and why the router chose it. */
  route: RouteDecision;
  /** Held before streaming. It pays for the first attempt, on any model of the tier. */
  nebiusHold: NebiusHold;
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
 * check, retry precondition, usage quota, global spend caps, and saving the
 * user's message.
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

  // Global spend caps, after the per-user quota and before any paid call.
  // The hold is the worst case for the prompt this turn will send.
  const mode = existing?.mode ?? (request.action === "send" ? (request.mode ?? "personal") : "personal");
  const pendingHistory: HistoryMessage[] = recent.map(({ role, content }) => ({ role, content }));
  if (request.action === "send") pendingHistory.push({ role: "user", content: request.message });
  const searchWanted = request.webSearch && deps.search !== null;
  const route = routeRequest({
    message: pendingHistory.at(-1)?.content ?? "",
    historyChars: pendingHistory.slice(0, -1).reduce((sum, message) => sum + message.content.length, 0),
    webSearch: request.webSearch,
    effort: request.effort ?? "auto",
  });
  const plan = deps.routing[route.tier];
  const promptBound = buildPromptMessages({
    history: buildContextWindow(pendingHistory, HISTORY_CHAR_BUDGET),
    webSearch: request.webSearch ? "failed" : "off",
    results: [],
    now: deps.now(),
    mode,
  });
  // The first attempt can run on any model of the tier (the breaker can skip
  // the first one), so hold for the most expensive one.
  const heldMicroUsd = Math.max(
    ...plan.models.map((model) =>
      nebiusHoldMicroUsd(model, promptBound, plan.maxOutputTokens, searchWanted ? SEARCH_RESULTS_MAX_BYTES : 0),
    ),
  );
  const nebius = await deps.spend.reserve("nebius", heldMicroUsd);
  if (!nebius.allowed) {
    deps.log("warn", "spend_limit_reached", { requestId, route: "chat", provider: "nebius", limit: nebius.limit });
    return { ok: false, ...budgetRefusal(nebius.limit, deps.now()) };
  }
  const nebiusHold: NebiusHold = { reservationId: nebius.id, heldMicroUsd };

  let tavilyReservation: string | null = null;
  try {
    let searchBudgetExhausted = false;
    if (searchWanted) {
      const tavily = await deps.spend.reserve("tavily", TAVILY_BASIC_SEARCH_CREDITS);
      if (tavily.allowed) {
        tavilyReservation = tavily.id;
      } else {
        searchBudgetExhausted = true;
        deps.log("warn", "spend_limit_reached", { requestId, route: "chat", provider: "tavily", limit: tavily.limit });
      }
    }

    let conversation: ConversationSummary;
    let userMessage: MessageDTO;
    if (request.action === "send") {
      conversation =
        existing ?? (await deps.repo.createConversation(userId, titleFromMessage(request.message), mode));
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
        searchBudgetExhausted,
        route,
        nebiusHold,
      },
    };
  } catch (error) {
    // No paid call will happen: give the holds back (best effort; a hold that
    // is not given back stays counted, which is the safe side).
    await settleQuietly(deps, requestId, "nebius", nebiusHold.reservationId, 0);
    if (tavilyReservation) await settleQuietly(deps, requestId, "tavily", tavilyReservation, 0);
    throw error;
  }
}

async function settleQuietly(
  deps: AssistantDeps,
  requestId: string,
  provider: "nebius" | "tavily",
  reservationId: string,
  amount: number,
): Promise<void> {
  try {
    await deps.spend.settle(reservationId, amount);
  } catch {
    deps.log("warn", "spend_settle_failed", { requestId, route: "chat", provider });
  }
}

function toSourceRefs(results: WebSearchResult[]): SourceRef[] {
  return results.map(({ title, url }) => ({ title, url }));
}

/**
 * Runs retrieval (if requested) and inference, streaming events to the client.
 * The assistant reply is persisted only when it completes. Never throws:
 * failures become a final `error` event. Every Nebius hold is settled, also
 * when the client stops or disconnects.
 */
export async function* streamChatTurn(
  deps: AssistantDeps,
  turn: PreparedTurn,
  signal: AbortSignal,
): AsyncGenerator<ChatStreamEvent> {
  const settles: Promise<void>[] = [];
  const holds = { prepaid: turn.nebiusHold as NebiusHold | null };
  const settle = (hold: NebiusHold, amount: number) => {
    const settling = settleQuietly(deps, turn.requestId, "nebius", hold.reservationId, amount);
    deps.waitUntil(settling);
    settles.push(settling);
  };
  try {
    yield* runChatTurn(deps, turn, signal, holds, settle);
  } finally {
    // No attempt used the first hold (for example Stop during search): no call was made.
    if (holds.prepaid) settle(holds.prepaid, 0);
    await Promise.all(settles);
  }
}

async function* runChatTurn(
  deps: AssistantDeps,
  turn: PreparedTurn,
  signal: AbortSignal,
  holds: { prepaid: NebiusHold | null },
  settle: (hold: NebiusHold, amount: number) => void,
): AsyncGenerator<ChatStreamEvent> {
  const startedAt = Date.now();
  const logBase = { requestId: turn.requestId, route: "chat" };

  yield {
    type: "start",
    requestId: turn.requestId,
    conversation: turn.conversation,
    userMessage: turn.userMessage,
    route: turn.route,
  };

  // 1. Optional web retrieval. Search is never called unless requested.
  let webSearch: WebSearchStatus = "off";
  let results: WebSearchResult[] = [];
  if (turn.webSearch) {
    if (turn.searchBudgetExhausted) {
      webSearch = "failed";
      yield { type: "search", status: "failed", sources: [], message: SEARCH_BUDGET_MESSAGE };
    } else if (!deps.search) {
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
        yield {
          type: "search",
          status: webSearch,
          sources: toSourceRefs(results),
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

  // 2. Inference over a bounded context window, on the routed tier.
  const messages = buildPromptMessages({
    history: buildContextWindow(turn.history, HISTORY_CHAR_BUDGET),
    webSearch,
    results,
    now: deps.now(),
    mode: turn.conversation.mode,
  });
  const plan = deps.routing[turn.route.tier];
  const report = newRouteReport(plan.tier);
  const budget: AttemptBudget = {
    async reserve(model) {
      // The hold made before streaming pays for the first attempt.
      if (holds.prepaid) {
        const hold = holds.prepaid;
        holds.prepaid = null;
        return { allowed: true, hold };
      }
      const heldMicroUsd = nebiusHoldMicroUsd(model, messages, plan.maxOutputTokens);
      const reservation = await deps.spend.reserve("nebius", heldMicroUsd);
      if (!reservation.allowed) {
        deps.log("warn", "spend_limit_reached", {
          ...logBase,
          provider: "nebius",
          limit: reservation.limit,
          stage: "attempt",
        });
        return { allowed: false, limit: reservation.limit };
      }
      return { allowed: true, hold: { reservationId: reservation.id, heldMicroUsd } };
    },
    settle(hold, model, outcome) {
      // Without valid usage the full hold stays counted; 0 only when no call was sent.
      settle(hold, outcome.sent ? nebiusSettleMicroUsd(model, hold.heldMicroUsd, outcome.usage) : 0);
    },
  };

  let content = "";
  let truncated = false;
  let finishReason: string | null = null;
  let usage: TokenUsage | null = null;
  try {
    for await (const chunk of executeRouted({
      plan,
      messages,
      provider: deps.provider,
      budget,
      breaker: deps.breaker,
      signal,
      report,
      random: deps.random,
    })) {
      if (chunk.type === "finish") {
        finishReason = chunk.finishReason;
        usage = chunk.usage;
        continue;
      }
      const room = MAX_ASSISTANT_CHARS - content.length;
      const text = chunk.text.slice(0, room);
      if (text) {
        content += text;
        yield { type: "delta", text };
      }
      if (content.length >= MAX_ASSISTANT_CHARS) {
        truncated = true;
        break;
      }
    }
  } catch (error) {
    logRoute(deps, logBase, turn.route, report);
    if (signal.aborted) {
      deps.log("info", "chat_client_aborted", { ...logBase, stage: "completion" });
      return;
    }
    if (error instanceof BudgetExhaustedError) {
      yield { type: "error", code: "budget_exhausted", message: budgetRefusal(error.limit, deps.now()).message, retryable: false };
      return;
    }
    if (error instanceof EmptyReplyError) {
      deps.log("error", "completion_empty", { ...logBase, finishReason });
      yield {
        type: "error",
        code: "provider_unavailable",
        message: "The assistant returned an empty reply. Please retry.",
        retryable: true,
      };
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
  logRoute(deps, logBase, turn.route, report);

  if (signal.aborted) {
    deps.log("info", "chat_client_aborted", { ...logBase, stage: "completion" });
    return;
  }
  if (content.trim().length === 0 || !report.model) {
    deps.log("error", "completion_empty", { ...logBase, finishReason });
    yield {
      type: "error",
      code: "provider_unavailable",
      message: "The assistant returned an empty reply. Please retry.",
      retryable: true,
    };
    return;
  }

  // 3. Persist the completed reply with its search outcome, sources and route.
  let saved: MessageDTO;
  try {
    saved = await deps.repo.insertMessage(turn.userId, {
      conversationId: turn.conversation.id,
      role: "assistant",
      content,
      webSearch,
      sources: webSearch === "used" ? toSourceRefs(results) : [],
      route: { model: report.model, tier: plan.tier, reason: turn.route.reason, fallback: report.fallback },
    });
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

  deps.log("info", "chat_completed", {
    ...logBase,
    durationMs: Date.now() - startedAt,
    webSearch,
    sourceCount: webSearch === "used" ? results.length : 0,
    finishReason,
    model: report.model,
    tier: plan.tier,
    promptTokens: usage?.promptTokens,
    completionTokens: usage?.completionTokens,
  });
  yield { type: "done", message: saved, truncated: truncated || finishReason === "length" };
}

/** One metadata-only log line for each routed reply. No prompt or reply text. */
function logRoute(
  deps: AssistantDeps,
  logBase: { requestId: string; route: string },
  route: RouteDecision,
  report: RouteReport,
): void {
  deps.log(report.outcome === "ok" || report.outcome === "stopped" ? "info" : "warn", "model_route", {
    ...logBase,
    tier: report.tier,
    reason: route.reason,
    modelsTried: report.modelsTried.join(">"),
    attempts: report.attempts,
    hedgeFired: report.hedgeFired,
    hedgeWon: report.hedgeWon,
    breakerSkips: report.breakerSkips,
    model: report.model,
    fallback: report.fallback,
    firstTokenMs: report.firstTokenMs,
    totalMs: report.totalMs,
    outcome: report.outcome,
  });
}
