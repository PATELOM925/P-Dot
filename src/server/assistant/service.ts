import "server-only";
import {
  HISTORY_CHAR_BUDGET,
  HISTORY_MESSAGE_LIMIT,
  MAX_ASSISTANT_CHARS,
  REPLY_CLAIM_LEASE_SECONDS,
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
import type { ContextRecordRepository } from "@/server/db/context-records";
import type { ConversationRepository } from "@/server/db/conversations";
import type { QuotaGate } from "@/server/db/quota";
import type { SpendGuard } from "@/server/db/spend";
import { requestFingerprint, type ClientRequest } from "@/server/http/request-key";
import type { Logger } from "@/server/log";
import { ProviderError } from "@/server/providers/errors";
import { isValidUsage } from "@/server/providers/nebius/pricing";
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
import { PROMPT_VERSION, buildPromptMessages } from "./prompt";
import { routeRequest, type RouteDecision } from "./router";
import {
  budgetRefusal,
  nebiusHoldMicroUsd,
  nebiusSettleMicroUsd,
  NebiusHoldTooLargeError,
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
  /**
   * Stores "what was sent" for each saved reply (decision 0009). Optional:
   * without it, no record is written. A failed write never fails the reply.
   */
  contextRecords?: ContextRecordRepository;
}

/** A Nebius hold made before the stream starts and settled when it ends. */
export interface NebiusHold {
  reservationId: string;
  heldMicroUsd: number;
}

/**
 * What a turn holds before its stream runs. `releaseTurn` gives back each part
 * that is still here; a part leaves when its use starts or ends.
 */
export interface TurnHolds {
  /** Leaves when the first attempt takes it. That attempt settles it from its outcome. */
  nebius: NebiusHold | null;
  /** Leaves when the search starts: a search that was sent keeps its credit. */
  tavily: string | null;
  /** The claim to write the reply (decision 0012). Leaves when the reply is saved. */
  claim: { messageId: string; claimId: string } | null;
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
  /** The Nebius hold pays for the first attempt, on any model of the tier. */
  holds: TurnHolds;
}

export type PrepareResult =
  | { ok: true; turn: PreparedTurn }
  | {
      ok: false;
      status: number;
      code: ApiErrorCode;
      message: string;
      headers?: Record<string, string>;
      /** With "busy" and "answered": the conversation of the saved message. */
      conversationId?: string;
    };

const keyMismatch: PrepareResult = {
  ok: false,
  status: 409,
  code: "conflict",
  message: "This request key was used for a different message. Send the message again.",
};

const alreadySent = (conversationId: string): PrepareResult => ({
  ok: false,
  status: 409,
  code: "answered",
  message: "This message was already sent. Reload the conversation.",
  conversationId,
});

const stillReplying = (conversationId: string): PrepareResult => ({
  ok: false,
  status: 409,
  code: "busy",
  message: "P-Dot is still replying. Try again in a few minutes.",
  conversationId,
});

/**
 * Everything that must succeed before the response stream starts: ownership
 * check, the request key lookup, the claim to write the reply, usage quota,
 * global spend caps, and saving the user's message (decision 0012).
 * `userId` must come from the verified session, never from the request body.
 */
export async function prepareChatTurn(
  deps: AssistantDeps,
  input: { userId: string; requestId: string; request: ChatRequest; requestKey?: string | null },
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

  // A saved user message that this turn answers: "Retry reply", or a resend whose message was saved.
  let answering: MessageDTO | null = null;
  let clientRequest: ClientRequest | null = null;
  if (request.action === "send" && input.requestKey) {
    const target = request.conversationId ?? `new:${request.mode ?? "personal"}`;
    clientRequest = {
      id: input.requestKey,
      hash: await requestFingerprint(["chat.send.v1", target, request.message]),
    };
    const saved = await deps.repo.findMessageByClientRequest(userId, clientRequest.id);
    if (saved) {
      if (saved.hash !== clientRequest.hash) return keyMismatch;
      existing = await deps.repo.getConversation(userId, saved.conversationId);
      if (!existing) return keyMismatch;
      recent = await deps.repo.listRecentMessages(userId, existing.id, HISTORY_MESSAGE_LIMIT);
      if (recent.at(-1)?.id !== saved.message.id) return alreadySent(existing.id);
      answering = saved.message;
    } else if (!existing) {
      const created = await deps.repo.findConversationByClientRequest(userId, clientRequest.id);
      if (created) {
        if (created.hash !== clientRequest.hash) return keyMismatch;
        recent = await deps.repo.listRecentMessages(userId, created.conversation.id, HISTORY_MESSAGE_LIMIT);
        if (recent.length > 0) return keyMismatch;
        existing = created.conversation;
      }
    }
  }

  if (request.action === "retry") {
    const last = recent.at(-1);
    // The reply is saved, though this screen may not show it yet (its response was lost).
    if (last?.role === "assistant") return alreadySent(existing!.id);
    if (last?.role !== "user") {
      return {
        ok: false,
        status: 409,
        code: "conflict",
        message: "There is no unanswered message to retry.",
      };
    }
    answering = last;
  }

  const holds: TurnHolds = { nebius: null, tavily: null, claim: null };
  if (answering) {
    const claim = await deps.repo.claimReply(answering.id, REPLY_CLAIM_LEASE_SECONDS);
    if (claim.outcome === "busy") return stillReplying(existing!.id);
    if (claim.outcome !== "claimed") return alreadySent(existing!.id);
    holds.claim = { messageId: answering.id, claimId: claim.claimId };
  }

  try {
    const refused = async (result: PrepareResult): Promise<PrepareResult> => {
      await releaseHolds(deps, requestId, holds);
      return result;
    };

    const decision = await deps.quota.consume();
    if (!decision.allowed) {
      const seconds = Math.max(1, Math.ceil((decision.resetsAt.getTime() - deps.now().getTime()) / 1000));
      return refused({
        ok: false,
        status: 429,
        code: "rate_limited",
        message: "You have reached your request limit for now. Please try again later.",
        headers: { "Retry-After": String(seconds) },
      });
    }

    // Global spend caps, after the per-user quota and before any paid call.
    // The hold is the worst case for the prompt this turn will send.
    const mode = existing?.mode ?? (request.action === "send" ? (request.mode ?? "personal") : "personal");
    const pendingHistory: HistoryMessage[] = recent.map(({ role, content }) => ({ role, content }));
    if (request.action === "send" && !answering) pendingHistory.push({ role: "user", content: request.message });
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
    let heldMicroUsd: number;
    try {
      heldMicroUsd = Math.max(
        ...plan.models.map((model) =>
          nebiusHoldMicroUsd(model, promptBound, plan.maxOutputTokens, searchWanted ? SEARCH_RESULTS_MAX_BYTES : 0),
        ),
      );
    } catch (error) {
      if (!(error instanceof NebiusHoldTooLargeError)) throw error;
      deps.log("warn", "spend_hold_too_large", { requestId, route: "chat", tier: route.tier });
      return refused({
        ok: false,
        status: 413,
        code: "payload_too_large",
        message: "This request is too large to answer. Start a new conversation or turn off web search.",
      });
    }
    const nebius = await deps.spend.reserve("nebius", heldMicroUsd);
    if (!nebius.allowed) {
      deps.log("warn", "spend_limit_reached", { requestId, route: "chat", provider: "nebius", limit: nebius.limit });
      return refused({ ok: false, ...budgetRefusal(nebius.limit, deps.now()) });
    }
    holds.nebius = { reservationId: nebius.id, heldMicroUsd };

    let searchBudgetExhausted = false;
    if (searchWanted) {
      const tavily = await deps.spend.reserve("tavily", TAVILY_BASIC_SEARCH_CREDITS);
      if (tavily.allowed) {
        holds.tavily = tavily.id;
      } else {
        searchBudgetExhausted = true;
        deps.log("warn", "spend_limit_reached", { requestId, route: "chat", provider: "tavily", limit: tavily.limit });
      }
    }

    let conversation: ConversationSummary;
    let userMessage: MessageDTO;
    if (!answering && request.action === "send") {
      conversation =
        existing ??
        (await deps.repo.createConversation(userId, titleFromMessage(request.message), mode, { clientRequest }));
      // The claim is known before the insert, so a lost response can still end it.
      holds.claim = { messageId: crypto.randomUUID(), claimId: crypto.randomUUID() };
      userMessage = await deps.repo.insertMessage(userId, {
        id: holds.claim.messageId,
        conversationId: conversation.id,
        role: "user",
        content: request.message,
        clientRequest,
        replyClaimId: holds.claim.claimId,
      });
      recent = [...recent, userMessage];
    } else {
      conversation = existing!;
      userMessage = answering!;
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
        holds,
      },
    };
  } catch (error) {
    // No paid call will happen: give back what this turn holds (best effort; a
    // hold that is not given back stays counted, which is the safe side).
    await releaseHolds(deps, requestId, holds);
    throw error;
  }
}

/**
 * Gives back every part of `holds` that no use took: the Nebius hold and the
 * Tavily credit settle at 0, and the claim ends. Runs once for each part, and
 * under `waitUntil`, so it completes after the client disconnects.
 */
function releaseHolds(deps: AssistantDeps, requestId: string, holds: TurnHolds): Promise<void> {
  const { nebius, tavily, claim } = holds;
  if (!nebius && !tavily && !claim) return Promise.resolve();
  holds.nebius = null;
  holds.tavily = null;
  holds.claim = null;
  const work = Promise.all([
    nebius ? settleQuietly(deps, requestId, "nebius", nebius.reservationId, 0) : null,
    tavily ? settleQuietly(deps, requestId, "tavily", tavily, 0) : null,
    claim
      ? deps.repo.releaseReplyClaim(claim.messageId, claim.claimId).catch(() => {
          deps.log("warn", "reply_claim_release_failed", { requestId, route: "chat" });
        })
      : null,
  ]).then(() => undefined);
  deps.waitUntil(work);
  return work;
}

/** Gives back what a prepared turn still holds. The chat route also calls it when the stream is cancelled before it starts. */
export function releaseTurn(deps: AssistantDeps, turn: PreparedTurn): Promise<void> {
  return releaseHolds(deps, turn.requestId, turn.holds);
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
  const holds = turn.holds;
  const settle = (hold: NebiusHold, amount: number) => {
    const settling = settleQuietly(deps, turn.requestId, "nebius", hold.reservationId, amount);
    deps.waitUntil(settling);
    settles.push(settling);
  };
  try {
    yield* runChatTurn(deps, turn, signal, holds, settle);
  } finally {
    // Gives back what no use took, for example the first hold after Stop during search.
    await releaseTurn(deps, turn);
    await Promise.all(settles);
  }
}

async function* runChatTurn(
  deps: AssistantDeps,
  turn: PreparedTurn,
  signal: AbortSignal,
  holds: TurnHolds,
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
        holds.tavily = null;
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
  const historyWindow = buildContextWindow(turn.history, HISTORY_CHAR_BUDGET);
  const messages = buildPromptMessages({
    history: historyWindow,
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
      if (holds.nebius) {
        const hold = holds.nebius;
        holds.nebius = null;
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
  // The ID is picked here, so a lost response can be checked by reading it.
  const replyId = crypto.randomUUID();
  let saved: MessageDTO | null = null;
  try {
    saved = await deps.repo.insertMessage(turn.userId, {
      id: replyId,
      conversationId: turn.conversation.id,
      role: "assistant",
      content,
      webSearch,
      sources: webSearch === "used" ? toSourceRefs(results) : [],
      route: { model: report.model, tier: plan.tier, reason: turn.route.reason, fallback: report.fallback },
      replyTo: turn.userMessage.id,
    });
  } catch {
    saved = await deps.repo.getMessage(turn.userId, replyId).catch(() => null);
    if (saved) deps.log("warn", "assistant_message_save_recovered", logBase);
  }
  if (!saved) {
    deps.log("error", "assistant_message_save_failed", logBase);
    yield {
      type: "error",
      code: "internal_error",
      message: "The reply could not be saved. Please retry.",
      retryable: true,
    };
    return;
  }
  holds.claim = null;

  if (deps.contextRecords) {
    const validUsage = usage && isValidUsage(usage) ? usage : null;
    const record = deps.contextRecords
      .insertContextRecord(turn.userId, {
        messageId: saved.id,
        model: report.model,
        historyMessageCount: historyWindow.length,
        historyChars: historyWindow.reduce((sum, m) => sum + m.content.length, 0),
        memoryIds: [],
        documentChunkIds: [],
        webSourceCount: webSearch === "used" ? results.length : 0,
        promptVersion: PROMPT_VERSION,
        inputTokens: validUsage?.promptTokens ?? null,
        outputTokens: validUsage?.completionTokens ?? null,
      })
      .catch(() => deps.log("warn", "context_record_failed", logBase));
    deps.waitUntil(record);
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
