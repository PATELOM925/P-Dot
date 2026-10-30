import "server-only";
import {
  HISTORY_CHAR_BUDGET,
  HISTORY_MESSAGE_LIMIT,
  MAX_ASSISTANT_CHARS,
  DOCUMENT_CONTEXT_MAX_DOCUMENTS,
  MEMORY_CONTEXT_COUNT,
  REPLY_CLAIM_LEASE_SECONDS,
  RETRIEVAL_MATCH_COUNT,
} from "@/lib/limits";
import type {
  ApiErrorCode,
  BriefRequest,
  ChatRequest,
  ChatStreamEvent,
  ConversationSummary,
  MessageDTO,
  Mode,
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
import type { ChatMessage, ModelProvider, TokenUsage, ToolCall } from "@/server/providers/model";
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
import { PROMPT_VERSION, buildPromptMessages, type ReplyFormat } from "./prompt";
import { briefSearch, deepResearch, type ResearchServices } from "./research";
import { createReplyNormalizer } from "@/lib/reply-text";
import { cleanTitle, titleMessages, titlePlan } from "./title";
import { routeRequest, type RouteDecision } from "./router";
import { detectToolIntent, type ToolIntent } from "@/lib/tool-intent";
import { forcedToolChoice, removeFalseClaims } from "./claim-guard";
import {
  BRIEF_RESULTS_MAX_BYTES,
  budgetRefusal,
  DOCUMENT_BLOCK_MAX_BYTES,
  MEMORY_BLOCK_MAX_BYTES,
  RESEARCH_RESULTS_MAX_BYTES,
  nebiusHoldMicroUsd,
  nebiusSettleMicroUsd,
  NebiusHoldTooLargeError,
  SEARCH_BUDGET_MESSAGE,
  SEARCH_RESULTS_MAX_BYTES,
  TAVILY_ADVANCED_SEARCH_CREDITS,
  TAVILY_BASIC_SEARCH_CREDITS,
} from "./spend";
import { RETRY_POLICY, type RoutingConfig } from "./tiers";
import {
  checkToolCall,
  earlierAttemptCheck,
  MAX_TOOL_CALLS_PER_HOP,
  MAX_TOOL_HOPS,
  selectTools,
  newGoogleTurn,
  TOOLS,
  toToolDefinition,
  type GoogleServices,
  type OwnDataServices,
  type ToolFlags,
  type ToolSpec,
} from "./tools";
import { googleForTurn, type TurnGoogle } from "./google-turn";
import type { MemoryMatch } from "@/server/db/retrieval";
import {
  NO_DOCUMENTS,
  fullDocumentContext,
  matchedDocumentContext,
  planDocumentContext,
  type DocumentContext,
  type DocumentPlan,
} from "./document-context";
import type { ConnectorServices, ConnectorTurn } from "@/server/mcp/connector-turn";

export interface AssistantDeps {
  repo: ConversationRepository;
  quota: QuotaGate;
  /** Global spend caps for paid providers, shared by all users. */
  spend: SpendGuard;
  /** Model tiers: chains, limits and timing. Each attempt is priced for its model. */
  routing: RoutingConfig;
  /** Null when web search is not configured on this server. */
  search: ((query: string, signal: AbortSignal) => Promise<WebSearchResult[]>) | null;
  /** Deep research and the morning brief (decision 0018). Null or missing when Tavily is not set up. */
  research?: ResearchServices | null;
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
  /**
   * The user's own P-Dot data for memory retrieval and the own-data tools
   * (decision 0013). Optional: without it, replies use no memories and those
   * tools are not offered.
   */
  ownData?: OwnDataServices | null;
  /** Make a title with the model for a new conversation, after the reply. Off when missing. */
  titles?: boolean;
  /** The Google tools' services. Null or missing when Google is not set up or the session is anonymous. */
  google?: GoogleServices | null;
  /** Why Google is off for this request, for the note to the model when the user asked for it. */
  googleBlocked?: "not_set_up" | "demo_session" | null;
  /** The verified `is_anonymous` claim of the session. A demo session never reads a connected app. */
  anonymous?: boolean;
  /** Reads of the user's connected apps (decision 0016). Null when connectors are not set up. */
  connectors?: ConnectorServices | null;
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
  /** Tavily credits, in the order of use. Each leaves when its search starts: a search that was sent keeps its credit. */
  tavily: string[];
  /** The claim to write the reply (decision 0012). Leaves when the reply is saved. */
  claim: { messageId: string; claimId: string } | null;
}

export interface PreparedTurn {
  requestId: string;
  userId: string;
  conversation: ConversationSummary;
  userMessage: MessageDTO;
  /**
   * True when this request answers a user message that was already saved:
   * "Retry reply", or a resend that found its message. False when this
   * request saved the message (a fresh turn).
   */
  repeat: boolean;
  /** Chronological history ending with `userMessage`. */
  history: HistoryMessage[];
  webSearch: boolean;
  /**
   * How the web is read: one basic search, deep research (decision 0018) or
   * the morning brief. Null when web search is off or not set up.
   */
  retrieval: "basic" | "deep" | "brief" | null;
  /** The brief's topics that have a held credit, in order. Empty for other turns. */
  briefTopics: string[];
  /** The user's IANA time zone from the browser, or null. */
  timeZone: string | null;
  /** True when search was requested but the Tavily budget refused it. */
  searchBudgetExhausted: boolean;
  /** The tier for this reply and why the router chose it. */
  route: RouteDecision;
  /** Which tools this turn offers. Fixed before the hold, so the hold prices them. */
  toolFlags: ToolFlags;
  /** What the message asks for, from the rules in tool-intent.ts. Null for a plain message. */
  toolIntent: ToolIntent | null;
  /** Google for this turn: the connection's flags and address, or why it is off. Null when not asked for. */
  google: TurnGoogle | null;
  /** The user's ready documents of this mode go into the turn: in full, or by search. Null: none. */
  documents: DocumentPlan | null;
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
  const requestedApps = request.connectors ?? [];
  // A demo session never reads a connected app: refused before the quota, any hold or any token (decision 0016).
  if (requestedApps.length > 0 && (deps.anonymous === true || deps.connectors?.anonymous === true)) {
    return { ok: false, status: 403, code: "account_required", message: "Create an account to use connected apps with P-Dot." };
  }

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
    let saved = await deps.repo.findMessageByClientRequest(userId, clientRequest.id);
    if (!saved && !existing) {
      const created = await deps.repo.findConversationByClientRequest(userId, clientRequest.id);
      if (created) {
        if (created.hash !== clientRequest.hash) return keyMismatch;
        const messages = await deps.repo.listRecentMessages(userId, created.conversation.id, HISTORY_MESSAGE_LIMIT);
        if (messages.length === 0) {
          existing = created.conversation;
          recent = messages;
        } else {
          // Another request with this key can have saved its message since the first lookup.
          saved = await deps.repo.findMessageByClientRequest(userId, clientRequest.id);
          if (!saved) return keyMismatch;
        }
      }
    }
    if (saved) {
      if (saved.hash !== clientRequest.hash) return keyMismatch;
      existing = await deps.repo.getConversation(userId, saved.conversationId);
      if (!existing) return keyMismatch;
      recent = await deps.repo.listRecentMessages(userId, existing.id, HISTORY_MESSAGE_LIMIT);
      if (recent.at(-1)?.id !== saved.message.id) return alreadySent(existing.id);
      answering = saved.message;
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

  const holds: TurnHolds = { nebius: null, tavily: [], claim: null };
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
    // Google (decision 0014, section 3): the connection read comes after the claim and before the hold.
    const google = await googleForTurn(deps, userId, request.useGoogle === true, pendingHistory.at(-1)?.content ?? "");
    const googleFlags = google?.flags ?? null;
    // The schema refuses two sources in one request; this keeps the server safe also without it.
    const noPrivateSource = googleFlags === null && requestedApps.length === 0;
    const searchWanted = request.webSearch && deps.search !== null && noPrivateSource;
    const brief: BriefRequest | null = request.action === "send" && !request.conversationId && !answering ? (request.brief ?? null) : null;
    const research = deps.research ?? null;
    const retrieval: PreparedTurn["retrieval"] =
      brief && noPrivateSource
        ? research
          ? "brief"
          : null
        : searchWanted
          ? request.research === true && research
            ? "deep"
            : "basic"
          : null;
    const format: ReplyFormat | undefined = retrieval === "deep" ? "research" : retrieval === "brief" ? "brief" : undefined;
    // The model may write a web search only in a conversation that never read Google or an app.
    const webSearchTool = googleFlags === null && requestedApps.length === 0 && !(await hadPrivateSourceReply(deps, userId, existing));
    // Every tool this turn can offer. If the search credit is refused below, web_search drops out,
    // which only makes the prompt smaller than the one this hold prices.
    // Memories go into every turn when the data services exist. The own-data tools only
    // when the message asks for them (detectToolIntent), so a plain message stays on the fast tier.
    const ownData = Boolean(deps.ownData);
    const latest = pendingHistory.at(-1)?.content ?? "";
    // A brief message holds the topics, which can be memory text such as "Remind me to ...": not a request.
    const toolIntent = ownData && !brief ? detectToolIntent(latest) : null;
    // The user's documents go into every turn, so a question about them never needs the words "my documents".
    const documents = ownData && !brief ? await planDocuments(deps, userId, mode, requestId) : null;
    const connectorTools =
      requestedApps.length > 0 && deps.connectors ? await deps.connectors.available(requestedApps) : new Map();
    const toolsBound = selectTools(TOOLS, {
      webSearch: retrieval === "basic",
      ownData: toolIntent !== null,
      webSearchTool,
      google: googleFlags,
      connectors: connectorTools,
    });
    const routed = withToolTier(
      routeRequest({
        message: latest,
        historyChars: pendingHistory.slice(0, -1).reduce((sum, message) => sum + message.content.length, 0),
        webSearch: request.webSearch,
        effort: request.effort ?? "auto",
        toolIntent,
      }),
      toolsBound.length > 0 || retrieval === "deep" || retrieval === "brief" || documents !== null,
    );
    // The reply of a turn that reads a private source is marked in its own row, before any read, so the
    // conversation never gets a model-written search again (decision 0014, decision 10; decision 0016).
    const route: RouteDecision = googleFlags
      ? { ...routed, reason: "google_request" }
      : requestedApps.length > 0
        ? { ...routed, reason: "connector_read" }
        : routed;
    const plan = deps.routing[route.tier];
    const promptBound = buildPromptMessages({
      history: buildContextWindow(pendingHistory, HISTORY_CHAR_BUDGET),
      webSearch: (request.webSearch || brief !== null) && googleFlags === null ? "failed" : "off",
      results: [],
      now: deps.now(),
      timeZone: request.timeZone,
      mode,
      toolGuidance: toolsBound.map((tool) => tool.guidance),
      serverNote: google?.note,
      format,
      tier: route.tier,
      privateSources: privateSourcesNote(request.useGoogle === true || requestedApps.length > 0, googleFlags !== null || connectorTools.size > 0),
    });
    const retrievalBytes =
      retrieval === "basic"
        ? SEARCH_RESULTS_MAX_BYTES
        : retrieval === "deep"
          ? RESEARCH_RESULTS_MAX_BYTES
          : retrieval === "brief"
            ? BRIEF_RESULTS_MAX_BYTES
            : 0;
    const toolDefinitionsBound = toolsBound.map(toToolDefinition);
    // The first attempt can run on any model of the tier (the breaker can skip
    // the first one), so hold for the most expensive one.
    let heldMicroUsd: number;
    try {
      heldMicroUsd = Math.max(
        ...plan.models.map((model) =>
          nebiusHoldMicroUsd(
            model,
            promptBound,
            plan.maxOutputTokens,
            retrievalBytes + (ownData ? MEMORY_BLOCK_MAX_BYTES : 0) + (documents ? DOCUMENT_BLOCK_MAX_BYTES : 0),
            toolDefinitionsBound,
          ),
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

    // One credit hold for each search the turn sends: 2 for an advanced search, 1 for each brief topic.
    // The deep research extract holds its own credit later, just before it is sent.
    let searchBudgetExhausted = false;
    const briefTopics: string[] = [];
    const searchCount = retrieval === "brief" ? brief!.topics.length : retrieval ? 1 : 0;
    for (let index = 0; index < searchCount; index += 1) {
      const tavily = await deps.spend.reserve(
        "tavily",
        retrieval === "deep" ? TAVILY_ADVANCED_SEARCH_CREDITS : TAVILY_BASIC_SEARCH_CREDITS,
      );
      if (!tavily.allowed) {
        deps.log("warn", "spend_limit_reached", { requestId, route: "chat", provider: "tavily", limit: tavily.limit });
        break;
      }
      holds.tavily.push(tavily.id);
      if (retrieval === "brief") briefTopics.push(brief!.topics[index]!);
    }
    searchBudgetExhausted = searchCount > 0 && holds.tavily.length === 0;

    let conversation: ConversationSummary;
    let userMessage: MessageDTO;
    if (!answering && request.action === "send") {
      conversation =
        existing ??
        (await deps.repo.createConversation(userId, brief ? `Brief for ${brief.date}` : titleFromMessage(request.message), mode, {
          clientRequest,
        }));
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
        repeat: answering !== null,
        history: recent.map(({ role, content }) => ({ role, content })),
        webSearch: (request.webSearch || brief !== null) && googleFlags === null,
        retrieval,
        briefTopics,
        timeZone: request.timeZone ?? null,
        searchBudgetExhausted,
        route,
        toolFlags: {
          webSearch: retrieval === "basic" && !searchBudgetExhausted,
          ownData: toolIntent !== null,
          webSearchTool,
          google: googleFlags,
          connectors: connectorTools,
        },
        toolIntent,
        google,
        documents,
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
 * The plan for the user's documents in this turn. One read of titles and
 * sizes, no text. A failed read means a turn without documents.
 */
async function planDocuments(deps: AssistantDeps, userId: string, mode: Mode, requestId: string): Promise<DocumentPlan | null> {
  if (!deps.ownData) return null;
  try {
    return planDocumentContext(await deps.ownData.retrieval.readyDocuments(userId, mode, DOCUMENT_CONTEXT_MAX_DOCUMENTS + 1));
  } catch {
    deps.log("warn", "document_list_failed", { requestId, route: "chat" });
    return null;
  }
}

/**
 * A turn that offers tools or document context runs on the standard tier at least (decision 0013):
 * tool hops need a model that calls tools well, and the standard tier has no
 * hedge. "Think harder" keeps the heavy tier. The reason stays the router's.
 */
/**
 * True when the conversation has any reply that read a private source: Google
 * (`google_request`) or a connected app (`connector_read`). No history window.
 * A failed check counts as true, so a model-written search stays off
 * (decision 0014, decision 10; decision 0016). The one helper for both features.
 */
async function hadPrivateSourceReply(deps: AssistantDeps, userId: string, conversation: ConversationSummary | null): Promise<boolean> {
  if (!conversation) return false;
  try {
    return await deps.repo.hasPrivateSourceReply(userId, conversation.id);
  } catch {
    deps.log("warn", "private_source_check_failed", { route: "chat" });
    return true;
  }
}

function withToolTier(route: RouteDecision, offersTools: boolean): RouteDecision {
  return offersTools && route.tier === "fast" ? { ...route, tier: "standard" } : route;
}

/**
 * Gives back every part of `holds` that no use took: the Nebius hold and the
 * Tavily credit settle at 0, and the claim ends. Runs once for each part, and
 * under `waitUntil`, so it completes after the client disconnects.
 */
function releaseHolds(deps: AssistantDeps, requestId: string, holds: TurnHolds): Promise<void> {
  const { nebius, tavily, claim } = holds;
  if (!nebius && tavily.length === 0 && !claim) return Promise.resolve();
  holds.nebius = null;
  holds.tavily = [];
  holds.claim = null;
  const work = Promise.all([
    nebius ? settleQuietly(deps, requestId, "nebius", nebius.reservationId, 0) : null,
    ...tavily.map((id) => settleQuietly(deps, requestId, "tavily", id, 0)),
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
  const apps = turn.toolFlags.connectors ? [...turn.toolFlags.connectors.keys()] : [];
  const connectors =
    apps.length > 0 && deps.connectors
      ? deps.connectors.startTurn({ requestId: turn.requestId, userMessage: turn.userMessage.content, servers: apps, signal })
      : null;
  try {
    yield* runChatTurn(deps, turn, signal, holds, settle, connectors);
  } finally {
    connectors?.close();
    // Gives back what no use took, for example the first hold after Stop during search.
    await releaseTurn(deps, turn);
    await Promise.all(settles);
  }
}

/**
 * The prompt line about Google and the apps. Asked for and on: the tools are on
 * now. Not asked for: say how to turn them on. Asked for but off: the server
 * note of that turn explains why, so no line.
 */
function privateSourcesNote(asked: boolean, on: boolean): "on" | "off" | undefined {
  if (on) return "on";
  return asked ? undefined : "off";
}

async function* runChatTurn(
  deps: AssistantDeps,
  turn: PreparedTurn,
  signal: AbortSignal,
  holds: TurnHolds,
  settle: (hold: NebiusHold, amount: number) => void,
  connectors: ConnectorTurn | null,
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

  // Memory and document retrieval run while the web search runs, so the reply does not wait for the two in turn.
  const ownLookup = retrieveOwnContext(deps, turn, signal);

  // 1. Optional web retrieval. Search is never called unless requested.
  let webSearch: WebSearchStatus = "off";
  let results: WebSearchResult[] = [];
  if (turn.webSearch) {
    if (turn.searchBudgetExhausted) {
      webSearch = "failed";
      yield { type: "search", status: "failed", sources: [], message: SEARCH_BUDGET_MESSAGE };
    } else if (!turn.retrieval) {
      webSearch = "failed";
      yield {
        type: "search",
        status: "failed",
        sources: [],
        message: "Web search is not configured on this server, so this answer is not based on web sources.",
      };
    } else {
      try {
        const research = deps.research ?? null;
        const context = research
          ? { research, spend: deps.spend, log: deps.log, waitUntil: deps.waitUntil, requestId: turn.requestId, credits: holds.tavily, signal }
          : null;
        if (turn.retrieval === "deep" && context) {
          results = yield* deepResearch(context, turn.userMessage.content);
        } else if (turn.retrieval === "brief" && context) {
          results = yield* briefSearch(context, turn.briefTopics);
        } else {
          holds.tavily = [];
          results = await deps.search!(turn.userMessage.content, signal);
        }
        webSearch = results.length > 0 ? "used" : "no_results";
        yield {
          type: "search",
          status: webSearch,
          sources: toSourceRefs(results),
          ...(webSearch === "no_results"
            ? { message: "Web search found no usable results, so this answer is not based on web sources." }
            : {}),
        };
        if (webSearch === "used" && (turn.retrieval === "deep" || turn.retrieval === "brief")) {
          yield { type: "status", tool: "research_write" };
        }
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

  const own = await ownLookup;
  if (own === "aborted") {
    deps.log("info", "chat_client_aborted", { ...logBase, stage: "memories" });
    return;
  }
  const { memories, documents } = own;
  const memoryIds = new Set(memories.map((memory) => memory.id));
  const documentChunkIds = new Set<string>(documents.chunkIds);

  // 2. Inference over a bounded context window, on the routed tier. When tools
  // are offered, up to MAX_TOOL_HOPS hops can call them, then one final pass
  // runs with tools off. Every attempt of every hop holds and settles spend.
  const historyWindow = buildContextWindow(turn.history, HISTORY_CHAR_BUDGET);
  const tools = selectTools(TOOLS, turn.toolFlags);
  const toolDefinitions = tools.map(toToolDefinition);
  const messages: ChatMessage[] = buildPromptMessages({
    history: historyWindow,
    webSearch,
    results,
    now: deps.now(),
    timeZone: turn.timeZone,
    mode: turn.conversation.mode,
    toolGuidance: tools.map((tool) => tool.guidance),
    memories,
    documents: documents.sources,
    serverNote: turn.google?.note,
    format: turn.retrieval === "deep" ? "research" : turn.retrieval === "brief" ? "brief" : undefined,
    tier: turn.route.tier,
    privateSources: privateSourcesNote(
      turn.google !== null || turn.route.reason === "connector_read",
      turn.toolFlags.google !== null || (turn.toolFlags.connectors?.size ?? 0) > 0,
    ),
  });
  const plan = deps.routing[turn.route.tier];
  const googleTurn = turn.toolFlags.google ? newGoogleTurn(turn.userMessage.content, turn.google?.ownAddress ?? null, turn.timeZone) : null;
  // One deadline for all hops and tool runs, so a turn stays inside the reply claim lease (decision 0012).
  const deadlineAt = Date.now() + plan.deadlineMs;
  const toolSignal = AbortSignal.any([signal, AbortSignal.timeout(plan.deadlineMs)]);
  const sources: WebSearchResult[] = [...results];
  const callsPerTool = new Map<string, number>();
  const earlierAttemptWrote = earlierAttemptCheck(deps.ownData, deps.repo, {
    repeat: turn.repeat,
    userId: turn.userId,
    conversationId: turn.conversation.id,
    userMessage: turn.userMessage,
  });

  let content = "";
  let truncated = false;
  let finishReason: string | null = null;
  const usages: (TokenUsage | null)[] = [];
  let report = newRouteReport(plan.tier);
  let fallback = false;
  // The model whose text the user already sees. Later hops use only it: the
  // commit rule of the executor (no model switch after the first visible
  // token) holds for the whole turn, not only for one hop.
  let textModel: string | null = null;
  // A message that asks to remember, or to add a task or a reminder, must get a tool call in the first hop.
  let forced = forcedToolChoice(turn.toolIntent, tools, turn.userMessage.content);
  let proposalsRun = 0;

  for (let hop = 0; hop <= MAX_TOOL_HOPS; hop += 1) {
    // Tools are off on the last pass, so the turn always ends with a reply.
    const offered = hop < MAX_TOOL_HOPS ? toolDefinitions : [];
    const hopMessages = [...messages];
    const remainingMs = deadlineAt - Date.now();
    report = newRouteReport(plan.tier);
    if (remainingMs < RETRY_POLICY.minAttemptMs) {
      deps.log("warn", "tool_loop_deadline", { ...logBase, hop });
      yield { type: "error", ...toPublicCompletionError(new ProviderError(deps.provider.name, "timeout")) };
      return;
    }
    const budget: AttemptBudget = {
      async reserve(model) {
        // The hold made before streaming pays for the first attempt of the first hop.
        if (holds.nebius) {
          const hold = holds.nebius;
          holds.nebius = null;
          return { allowed: true, hold };
        }
        const heldMicroUsd = nebiusHoldMicroUsd(model, hopMessages, plan.maxOutputTokens, 0, offered);
        const reservation = await deps.spend.reserve("nebius", heldMicroUsd);
        if (!reservation.allowed) {
          deps.log("warn", "spend_limit_reached", {
            ...logBase,
            provider: "nebius",
            limit: reservation.limit,
            stage: "attempt",
            hop,
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

    let calls: ToolCall[] = [];
    let hopText = "";
    let hopFinished = false;
    const normalizer = createReplyNormalizer();
    const accept = (normalized: string): string => {
      let text = normalized;
      // Text from two hops is kept apart, so it does not run together.
      if (!hopText && content && text) text = `\n\n${text.trimStart()}`;
      text = text.slice(0, MAX_ASSISTANT_CHARS - content.length);
      hopText += text;
      content += text;
      return text;
    };
    try {
      for await (const chunk of executeRouted({
        plan: { ...plan, deadlineMs: remainingMs, ...(textModel ? { models: [textModel] } : {}) },
        messages: hopMessages,
        tools: offered,
        ...(hop === 0 && forced ? { toolChoice: forced } : {}),
        provider: deps.provider,
        budget,
        breaker: deps.breaker,
        signal,
        report,
        random: deps.random,
      })) {
        if (chunk.type === "finish") {
          finishReason = chunk.finishReason;
          usages.push(chunk.usage);
          hopFinished = true;
          continue;
        }
        if (chunk.type === "tool_calls") {
          calls = chunk.calls;
          continue;
        }
        const text = accept(normalizer.push(chunk.text));
        if (text) yield { type: "delta", text };
        if (content.length >= MAX_ASSISTANT_CHARS) {
          truncated = true;
          break;
        }
      }
    } catch (error) {
      logRoute(deps, logBase, turn.route, report, hop);
      if (signal.aborted) {
        deps.log("info", "chat_client_aborted", { ...logBase, stage: "completion" });
        return;
      }
      // A model that refuses a forced tool choice gets the same hop again with "auto".
      if (hop === 0 && forced && !content && error instanceof ProviderError && error.kind === "invalid_request") {
        deps.log("warn", "tool_choice_refused", { ...logBase, hop });
        forced = null;
        hop -= 1;
        continue;
      }
      if (error instanceof BudgetExhaustedError) {
        yield { type: "error", code: "budget_exhausted", message: budgetRefusal(error.limit, deps.now()).message, retryable: false };
        return;
      }
      if (error instanceof NebiusHoldTooLargeError) {
        deps.log("warn", "spend_hold_too_large", { ...logBase, tier: plan.tier, hop });
        yield {
          type: "error",
          code: "payload_too_large",
          message: "This request is too large to answer. Start a new conversation or turn off web search.",
          retryable: false,
        };
        return;
      }
      if (error instanceof EmptyReplyError) {
        deps.log("error", "completion_empty", { ...logBase, finishReason, hop });
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
        hop,
      });
      yield { type: "error", ...publicError };
      return;
    }
    logRoute(deps, logBase, turn.route, report, hop);
    const tail = accept(normalizer.flush());
    if (tail) yield { type: "delta", text: tail };
    fallback ||= report.fallback;
    // A hop cut at the length limit has no usage, so the turn's sum must not look whole.
    if (!hopFinished) usages.push(null);
    if (hopText && !textModel) textModel = report.model;

    if (signal.aborted) {
      deps.log("info", "chat_client_aborted", { ...logBase, stage: "completion" });
      return;
    }
    if (truncated || calls.length === 0 || offered.length === 0) break;

    // Run the tool calls, then give the results to the next hop.
    messages.push({ role: "assistant", content: hopText, toolCalls: calls });
    for (const [index, call] of calls.entries()) {
      let result: string;
      const checked =
        index < MAX_TOOL_CALLS_PER_HOP
          ? checkToolCall(tools, call, callsPerTool)
          : { ok: false as const, content: `At most ${MAX_TOOL_CALLS_PER_HOP} tool calls run in one step. Nothing was done.` };
      if (!checked.ok) {
        deps.log("warn", "tool_call_refused", { ...logBase, tool: knownToolName(tools, call.name), hop });
        result = checked.content;
      } else {
        const spec: ToolSpec = checked.spec;
        callsPerTool.set(spec.name, (callsPerTool.get(spec.name) ?? 0) + 1);
        const query = spec.statusQuery(checked.args);
        yield { type: "status", tool: spec.name, ...(query ? { query } : {}) };
        try {
          const outcome = await spec.run(checked.args, {
            services: deps,
            requestId: turn.requestId,
            userId: turn.userId,
            mode: turn.conversation.mode,
            conversationId: turn.conversation.id,
            userMessageId: turn.userMessage.id,
            earlierAttemptWrote,
            signal: toolSignal,
            sources,
            google: googleTurn,
            connectors,
          });
          result = outcome.content;
          deps.log("info", "tool_ran", { ...logBase, tool: spec.name, hop, ok: true });
          if (spec.kind === "propose") proposalsRun += 1;
          for (const id of outcome.memoryIds ?? []) memoryIds.add(id);
          for (const id of outcome.documentChunkIds ?? []) documentChunkIds.add(id);
          if (outcome.sources && outcome.sources.length > 0) {
            sources.push(...outcome.sources);
            yield { type: "search", status: "used", sources: toSourceRefs(sources) };
          }
        } catch {
          if (signal.aborted) {
            deps.log("info", "chat_client_aborted", { ...logBase, stage: "tool" });
            return;
          }
          deps.log("warn", "tool_failed", { ...logBase, tool: spec.name, hop });
          deps.log("info", "tool_ran", { ...logBase, tool: spec.name, hop, ok: false });
          result = "The tool failed. Nothing was done. Answer without it, and say so.";
        }
      }
      messages.push({ role: "tool", toolCallId: call.id, content: result });
    }
  }

  // Only a turn that asked for a task, a reminder or a memory can have a false
  // "I added it" claim. In other turns the same words are a drafted email or a
  // recap of an earlier card, so the reply stays as the model wrote it.
  const actionAsked = turn.toolIntent === "task_request" || turn.toolIntent === "memory_request";
  if (proposalsRun === 0 && actionAsked) {
    const guarded = removeFalseClaims(content, actionAsked);
    if (guarded.removed) {
      deps.log("warn", "false_claim_removed", { ...logBase, intent: turn.toolIntent ?? "none" });
      content = guarded.text.slice(0, MAX_ASSISTANT_CHARS);
    }
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
  if (sources.length > 0) webSearch = "used";
  const usage = sumUsage(usages);

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
      sources: webSearch === "used" ? toSourceRefs(sources) : [],
      route: { model: report.model, tier: plan.tier, reason: turn.route.reason, fallback },
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
    const validUsage = usage;
    const record = deps.contextRecords
      .insertContextRecord(turn.userId, {
        messageId: saved.id,
        model: report.model,
        historyMessageCount: historyWindow.length,
        historyChars: historyWindow.reduce((sum, m) => sum + m.content.length, 0),
        memoryIds: [...memoryIds],
        documentChunkIds: [...documentChunkIds],
        webSourceCount: webSearch === "used" ? sources.length : 0,
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
    sourceCount: webSearch === "used" ? sources.length : 0,
    finishReason,
    model: report.model,
    tier: plan.tier,
    promptTokens: usage?.promptTokens,
    completionTokens: usage?.completionTokens,
  });
  yield { type: "done", message: saved, truncated: truncated || finishReason === "length" };

  // 4. A title made by the model for a new conversation, after the reply (decision 0013).
  if (
    deps.titles &&
    turn.retrieval !== "brief" &&
    turn.history.length === 1 &&
    turn.conversation.title === titleFromMessage(turn.userMessage.content)
  ) {
    yield* makeTitle(deps, turn, signal, settle);
  }
}

/** A message this short ("hi", "thanks!", "ok cool") gets no memory lookup: it costs an embedding call before the reply. */
const MEMORY_LOOKUP_MIN_CHARS = 12;

/**
 * Active memories of the mode, top MEMORY_CONTEXT_COUNT, and the user's
 * documents by the turn's plan: in full (one read, no embedding), or the best
 * search matches from the same embedding the memories use. Never throws: a
 * failure means a reply without that part, and a Stop gives "aborted".
 */
async function retrieveOwnContext(
  deps: AssistantDeps,
  turn: PreparedTurn,
  signal: AbortSignal,
): Promise<{ memories: MemoryMatch[]; documents: DocumentContext } | "aborted"> {
  const own = deps.ownData;
  if (!own) return { memories: [], documents: NO_DOCUMENTS };
  const mode = turn.conversation.mode;
  const plan = turn.documents;
  const failed = (event: string, error: unknown) =>
    deps.log("warn", event, { requestId: turn.requestId, route: "chat", kind: error instanceof Error ? error.name : "unknown" });

  const fullLookup =
    plan?.kind === "full"
      ? fullDocumentContext(own.retrieval, turn.userId, plan.documents).catch((error: unknown) => {
          failed("document_context_failed", error);
          return NO_DOCUMENTS;
        })
      : Promise.resolve(NO_DOCUMENTS);

  const text = turn.userMessage.content.trim();
  let vector: number[] | undefined;
  if (text.length >= MEMORY_LOOKUP_MIN_CHARS || text.split(/\s+/).length > 2) {
    try {
      [vector] = await own.embedder.embed([text], signal);
    } catch (error) {
      if (signal.aborted) return "aborted";
      failed("memory_retrieval_failed", error);
    }
  }

  const memoryLookup = vector
    ? own.retrieval.matchMemories(vector, mode, MEMORY_CONTEXT_COUNT).then(
        (found) => found.slice(0, MEMORY_CONTEXT_COUNT),
        (error: unknown) => {
          failed("memory_retrieval_failed", error);
          return [];
        },
      )
    : Promise.resolve([]);
  const documentLookup =
    vector && plan?.kind === "search"
      ? own.retrieval.matchDocumentChunks(vector, mode, RETRIEVAL_MATCH_COUNT).then(matchedDocumentContext, (error: unknown) => {
          failed("document_context_failed", error);
          return NO_DOCUMENTS;
        })
      : fullLookup;

  const [memories, documents] = await Promise.all([memoryLookup, documentLookup]);
  if (signal.aborted) return "aborted";
  return { memories, documents };
}

/**
 * One short call on the fast tier. Each attempt holds and settles spend like a
 * reply. Any failure keeps the title from the first message: the reply is
 * already saved, so this step never sends an error.
 */
async function* makeTitle(
  deps: AssistantDeps,
  turn: PreparedTurn,
  signal: AbortSignal,
  settle: (hold: NebiusHold, amount: number) => void,
): AsyncGenerator<ChatStreamEvent> {
  const logBase = { requestId: turn.requestId, route: "chat" };
  const plan = titlePlan(deps.routing.fast);
  const messages = titleMessages(turn.userMessage.content);
  const budget: AttemptBudget = {
    async reserve(model) {
      const heldMicroUsd = nebiusHoldMicroUsd(model, messages, plan.maxOutputTokens);
      const reservation = await deps.spend.reserve("nebius", heldMicroUsd);
      if (!reservation.allowed) return { allowed: false, limit: reservation.limit };
      return { allowed: true, hold: { reservationId: reservation.id, heldMicroUsd } };
    },
    settle(hold, model, outcome) {
      settle(hold, outcome.sent ? nebiusSettleMicroUsd(model, hold.heldMicroUsd, outcome.usage) : 0);
    },
  };
  let text = "";
  try {
    for await (const chunk of executeRouted({
      plan,
      messages,
      provider: deps.provider,
      budget,
      breaker: deps.breaker,
      signal,
      report: newRouteReport(plan.tier),
      random: deps.random,
    })) {
      if (chunk.type === "text") text += chunk.text;
      if (text.length > 400) break;
    }
  } catch (error) {
    deps.log("warn", "title_failed", { ...logBase, kind: error instanceof Error ? error.name : "unknown" });
    return;
  }
  const title = cleanTitle(text);
  if (!title || signal.aborted) return;
  // Only while the title is still the one this turn started with: a rename by the user wins.
  const renamed = await deps.repo.renameConversation(turn.userId, turn.conversation.id, title, turn.conversation.title).catch(() => {
    deps.log("warn", "title_save_failed", logBase);
    return null;
  });
  if (renamed) yield { type: "title", conversationId: renamed.id, title: renamed.title };
}

/**
 * The sum of the usage of every hop, or null when one hop has no valid usage:
 * a part count would look like the whole cost of the turn.
 */
function sumUsage(usages: (TokenUsage | null)[]): TokenUsage | null {
  if (usages.length === 0 || usages.some((usage) => !usage || !isValidUsage(usage))) return null;
  return usages.reduce<TokenUsage>(
    (sum, usage) => ({
      promptTokens: sum.promptTokens + usage!.promptTokens,
      completionTokens: sum.completionTokens + usage!.completionTokens,
    }),
    { promptTokens: 0, completionTokens: 0 },
  );
}

/** A tool name for logs: an offered tool's name, or "unknown". Never the model's text. */
function knownToolName(tools: readonly ToolSpec[], name: string): string {
  return tools.some((tool) => tool.name === name) ? name : "unknown";
}

/** One metadata-only log line for each routed model pass. No prompt or reply text. */
function logRoute(
  deps: AssistantDeps,
  logBase: { requestId: string; route: string },
  route: RouteDecision,
  report: RouteReport,
  hop: number,
): void {
  deps.log(report.outcome === "ok" || report.outcome === "stopped" ? "info" : "warn", "model_route", {
    ...logBase,
    hop,
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
