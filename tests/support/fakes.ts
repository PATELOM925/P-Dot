import type { ConversationRepository, NewConversation, NewMessage, ReplyClaim } from "@/server/db/conversations";
import type { ClientRequest } from "@/server/http/request-key";
import type { QuotaGate } from "@/server/db/quota";
import type { SpendCaps, SpendGuard, SpendLimit, SpendProvider, SpendReservation } from "@/server/db/spend";
import type { AssistantDeps } from "@/server/assistant/service";
import { createCircuitBreaker } from "@/server/assistant/breaker";
import { buildRoutingConfig, type RoutingConfig } from "@/server/assistant/tiers";
import type { ChatMessage, CompletionChunk, ModelCallRequest, ModelProvider } from "@/server/providers/model";
import type { WebSearchResult } from "@/server/providers/tavily/client";
import type { ConversationSummary, MessageDTO, Mode, TaskDTO } from "@/types/api";
import type { TaskRepository } from "@/server/db/tasks";
import type { ContextRecordRepository, NewContextRecord } from "@/server/db/context-records";
import { createBudgetedEmbedder, type Embedder } from "@/server/assistant/embed";
import { EMBEDDING_DIMENSIONS } from "@/lib/limits";
import { actionPayloadSchema, actionSummarySchema } from "@/lib/schemas";
import type { OwnDataServices } from "@/server/assistant/tools";
import type { DocumentChunkMatch, MemoryMatch } from "@/server/db/retrieval";
import type { NewMemory } from "@/server/db/memories";
import type { NewActionProposal } from "@/server/db/action-proposals";
import type { ActionProposalDTO, MemoryDTO } from "@/types/api";

interface StoredConversation extends ConversationSummary {
  userId: string;
  clientRequest?: ClientRequest | null;
}

interface StoredMessage extends MessageDTO {
  userId: string;
  conversationId: string;
  clientRequest?: ClientRequest | null;
  replyTo?: string;
  replyClaimId?: string | null;
  /** Milliseconds on the repository clock. */
  replyClaimedAt?: number | null;
}

function toDto(message: StoredMessage): MessageDTO {
  const { id, role, content, webSearch, sources, route, createdAt } = message;
  return { id, role, content, webSearch, sources, route, createdAt };
}

/**
 * In-memory repository that mirrors the database's ownership rules (RLS):
 * every read and write is scoped to the given user ID. It also has the rules
 * of decision 0012: one row for each request key and user, one reply for each
 * user message, and the reply claim with its lease. The claim calls have no
 * session, so they do not check the user; the routes reach them only through
 * the user's own conversation.
 */
export class MemoryRepository implements ConversationRepository {
  conversations: StoredConversation[] = [];
  messages: StoredMessage[] = [];
  private counter = 0;
  failInsertForRole: "user" | "assistant" | null = null;
  /** The clock of the claim lease. A test moves it forward to end a lease. */
  now = () => Date.now();

  private nextId(): string {
    this.counter += 1;
    return `00000000-0000-4000-8000-${String(this.counter).padStart(12, "0")}`;
  }

  /** Rows saved with a server-picked ID still get a later time than the rows before them. */
  private ticks = 0;

  private timestamp(): string {
    return new Date(Date.UTC(2026, 9, 14, 12, 0, this.counter + this.ticks)).toISOString();
  }

  async getConversation(userId: string, id: string) {
    const found = this.conversations.find((c) => c.id === id && c.userId === userId);
    return found ? { id: found.id, title: found.title, mode: found.mode, updatedAt: found.updatedAt } : null;
  }

  async listConversations(userId: string, limit: number, mode?: Mode) {
    return this.conversations
      .filter((c) => c.userId === userId && (!mode || c.mode === mode))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit)
      .map(({ id, title, mode: m, updatedAt }) => ({ id, title, mode: m, updatedAt }));
  }

  async createConversation(userId: string, title: string, mode: Mode = "personal", options: NewConversation = {}) {
    const key = options.clientRequest?.id;
    if (key && this.conversations.some((c) => c.userId === userId && c.clientRequest?.id === key)) {
      throw new Error("duplicate key value violates unique constraint conversations_user_client_request_key");
    }
    const conversation = {
      id: options.id ?? this.nextId(),
      title,
      mode,
      updatedAt: this.timestamp(),
      userId,
      clientRequest: options.clientRequest ?? null,
    };
    this.conversations.push(conversation);
    return { id: conversation.id, title, mode, updatedAt: conversation.updatedAt };
  }

  async renameConversation(userId: string, id: string, title: string, ifTitle?: string) {
    const found = this.conversations.find((c) => c.id === id && c.userId === userId);
    if (!found || (ifTitle !== undefined && found.title !== ifTitle)) return null;
    found.title = title;
    return { id: found.id, title: found.title, mode: found.mode, updatedAt: found.updatedAt };
  }

  async deleteConversation(userId: string, id: string) {
    const before = this.conversations.length;
    this.conversations = this.conversations.filter((c) => !(c.id === id && c.userId === userId));
    const deleted = this.conversations.length < before;
    if (deleted) this.messages = this.messages.filter((m) => m.conversationId !== id);
    return deleted;
  }

  async listRecentMessages(userId: string, conversationId: string, limit: number) {
    return this.messages
      .filter((m) => m.conversationId === conversationId && m.userId === userId)
      .slice(-limit)
      .map(toDto);
  }

  async insertMessage(userId: string, message: NewMessage) {
    if (this.failInsertForRole === message.role) throw new Error("insert failed");
    const owner = this.conversations.find((c) => c.id === message.conversationId);
    if (!owner || owner.userId !== userId) throw new Error("RLS: conversation not owned by user");
    const key = message.clientRequest?.id;
    if (key && this.messages.some((m) => m.userId === userId && m.clientRequest?.id === key)) {
      throw new Error("duplicate key value violates unique constraint messages_user_client_request_key");
    }
    if (message.replyTo) {
      if (!this.messages.some((m) => m.id === message.replyTo && m.userId === userId)) {
        throw new Error("insert violates foreign key constraint messages_reply_to_fkey");
      }
      if (this.messages.some((m) => m.replyTo === message.replyTo)) {
        throw new Error("duplicate key value violates unique constraint messages_reply_to_key");
      }
    }
    if (message.id) this.ticks += 1;
    const stored: StoredMessage = {
      id: message.id ?? this.nextId(),
      role: message.role,
      content: message.content,
      webSearch: message.webSearch ?? "off",
      sources: message.sources ?? [],
      route: message.role === "assistant" ? (message.route ?? null) : null,
      createdAt: this.timestamp(),
      userId,
      conversationId: message.conversationId,
      clientRequest: message.clientRequest ?? null,
      replyTo: message.replyTo,
      replyClaimId: message.replyClaimId ?? null,
      replyClaimedAt: message.replyClaimId ? this.now() : null,
    };
    this.messages.push(stored);
    owner.updatedAt = stored.createdAt;
    return toDto(stored);
  }

  async getMessage(userId: string, messageId: string) {
    const found = this.messages.find((m) => m.id === messageId && m.userId === userId);
    return found ? toDto(found) : null;
  }

  async findMessageByClientRequest(userId: string, key: string) {
    const found = this.messages.find((m) => m.userId === userId && m.role === "user" && m.clientRequest?.id === key);
    return found ? { message: toDto(found), conversationId: found.conversationId, hash: found.clientRequest!.hash } : null;
  }

  async findConversationByClientRequest(userId: string, key: string) {
    const found = this.conversations.find((c) => c.userId === userId && c.clientRequest?.id === key);
    if (!found) return null;
    const { id, title, mode, updatedAt } = found;
    return { conversation: { id, title, mode, updatedAt }, hash: found.clientRequest!.hash };
  }

  async claimReply(messageId: string, leaseSeconds: number): Promise<ReplyClaim> {
    const message = this.messages.find((m) => m.id === messageId && m.role === "user");
    if (!message) return { outcome: "not_found" };
    const reply = this.messages.find((m) => m.replyTo === messageId);
    if (reply) return { outcome: "answered", replyId: reply.id };
    if (message.replyClaimId && (message.replyClaimedAt ?? 0) > this.now() - leaseSeconds * 1000) return { outcome: "busy" };
    message.replyClaimId = `claim-${this.nextId()}`;
    message.replyClaimedAt = this.now();
    return { outcome: "claimed", claimId: message.replyClaimId };
  }

  async releaseReplyClaim(messageId: string, claimId: string) {
    const message = this.messages.find((m) => m.id === messageId && m.replyClaimId === claimId);
    if (message) {
      message.replyClaimId = null;
      message.replyClaimedAt = null;
    }
  }

  /** The claim on a user message, for checks. */
  claimOf(messageId: string): string | null {
    return this.messages.find((m) => m.id === messageId)?.replyClaimId ?? null;
  }
}

/** In-memory task store with the same per-user scoping as RLS. */
export class MemoryTasks implements TaskRepository {
  tasks: (TaskDTO & { userId: string })[] = [];
  private counter = 0;

  private dto({ userId: _userId, ...task }: TaskDTO & { userId: string }): TaskDTO {
    void _userId;
    return task;
  }

  async listTasks(userId: string, mode: Mode, limit: number) {
    return this.tasks
      .filter((t) => t.userId === userId && t.mode === mode)
      .slice(0, limit)
      .map((t) => this.dto(t));
  }

  async createTask(userId: string, mode: Mode, title: string) {
    this.counter += 1;
    const task = {
      id: `10000000-0000-4000-8000-${String(this.counter).padStart(12, "0")}`,
      mode,
      title,
      done: false,
      createdAt: new Date(Date.UTC(2026, 9, 16, 9, 0, this.counter)).toISOString(),
      userId,
    };
    this.tasks.push(task);
    return this.dto(task);
  }

  async updateTask(userId: string, id: string, changes: { title?: string; done?: boolean }) {
    const task = this.tasks.find((t) => t.id === id && t.userId === userId);
    if (!task) return null;
    Object.assign(task, changes);
    return this.dto(task);
  }

  async deleteTask(userId: string, id: string) {
    const before = this.tasks.length;
    this.tasks = this.tasks.filter((t) => !(t.id === id && t.userId === userId));
    return this.tasks.length < before;
  }
}

/** The default caps from config, in micro-dollars (Nebius) and credits (Tavily). */
export const TEST_SPEND_CAPS: Record<SpendProvider, SpendCaps> = {
  nebius: { day: 1_000_000, period: 20_000_000, userDay: 250_000 },
  tavily: { day: 40, period: 800, userDay: 10 },
};

/**
 * In-memory spend guard with the database's rules: a reservation holds its
 * amount, and settle can give back part of it once.
 */
export class FakeSpend implements SpendGuard {
  reservations: { id: string; provider: SpendProvider; held: number; settled: number | null }[] = [];
  refuse: Partial<Record<SpendProvider, SpendLimit>> = {};
  failReserve = false;

  async reserve(provider: SpendProvider, amount: number): Promise<SpendReservation> {
    if (this.failReserve) throw new Error("reserve failed");
    const limit = this.refuse[provider];
    if (limit) return { allowed: false, limit };
    const id = `res-${this.reservations.length + 1}`;
    this.reservations.push({ id, provider, held: amount, settled: null });
    return { allowed: true, id };
  }

  async settle(id: string, amount: number) {
    const reservation = this.reservations.find((r) => r.id === id);
    if (!reservation || reservation.settled !== null) throw new Error("nothing to settle");
    if (amount < 0 || amount > reservation.held) throw new Error("invalid amount");
    reservation.settled = amount;
  }

  /** What stays counted for a provider: settled amounts, or the hold if not settled. */
  counted(provider: SpendProvider): number {
    return this.reservations
      .filter((r) => r.provider === provider)
      .reduce((sum, r) => sum + (r.settled ?? r.held), 0);
  }
}

/** In-memory "what was sent" records, scoped to the user like RLS. */
export class FakeContextRecords implements ContextRecordRepository {
  records: (NewContextRecord & { userId: string })[] = [];

  async insertContextRecord(userId: string, record: NewContextRecord) {
    this.records.push({ ...record, userId });
  }

  async getContextRecord(userId: string, messageId: string) {
    const found = this.records.find((r) => r.userId === userId && r.messageId === messageId);
    if (!found) return null;
    const { userId: _userId, memoryIds, documentChunkIds, ...record } = found;
    void _userId;
    return {
      ...record,
      memories: memoryIds.map((id) => ({ id, content: null })),
      documentChunks: documentChunkIds.map((id) => ({ id, documentId: null, title: null })),
      createdAt: "2026-10-14T12:00:00.000Z",
    };
  }
}

/**
 * A fake embeddings endpoint: one vector for each input, with token usage.
 * `calls` counts the requests, so a test can prove that no embedding was paid for.
 */
export function fakeEmbeddingFetch() {
  const state = { calls: 0 };
  const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
    state.calls += 1;
    const input = (JSON.parse(String(init?.body)) as { input: string[] }).input;
    const data = input.map((_text, index) => ({ index, embedding: Array<number>(EMBEDDING_DIMENSIONS).fill(0.5) }));
    return new Response(JSON.stringify({ data, usage: { prompt_tokens: input.length * 8 } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { fetchImpl: fetchImpl as typeof fetch, state };
}

/** The real budgeted embedder, on a fake endpoint and the given spend guard. */
export function testEmbedder(spend: SpendGuard, fetchImpl: typeof fetch = fakeEmbeddingFetch().fetchImpl): Embedder {
  return createBudgetedEmbedder({ settings: { apiKey: "test-key", baseUrl: "https://nebius.test/v1" }, spend, fetchImpl });
}

export class FakeQuota implements QuotaGate {
  calls = 0;
  constructor(private readonly allow = true) {}
  async consume() {
    this.calls += 1;
    return { allowed: this.allow, resetsAt: new Date(Date.UTC(2026, 9, 14, 13, 0, 0)) };
  }
}

/** Routing where every tier uses one model with 1,024 output tokens and no hedge. */
export function testRouting(model = "nvidia/nemotron-3-super-120b-a12b") {
  return buildRoutingConfig({
    chains: { fast: [model], standard: [model], heavy: [model], vision: [model] },
    maxOutputTokens: 1024,
    standardMaxOutputTokens: 1024,
    heavyMaxOutputTokens: 1024,
    heavyThinkingBudgetTokens: 0,
    hedgeAfterMs: 0,
  });
}

/**
 * The user's own data for the chat tools, scoped by user like RLS. Search
 * returns the stored matches of the asked mode, at most `count`, as the
 * database functions do. Proposals and memories are checked with the same
 * schemas as the database limits.
 */
export class FakeOwnData {
  memoryMatches: (MemoryMatch & { userId: string; mode: Mode })[] = [];
  chunkMatches: (DocumentChunkMatch & { userId: string; mode: Mode })[] = [];
  memories: (MemoryDTO & { userId: string })[] = [];
  proposals: (ActionProposalDTO & { userId: string })[] = [];
  searches: { kind: "memories" | "documents"; mode: Mode; count: number }[] = [];
  failMatch = false;
  private counter = 0;
  /**
   * `clock` gives the database time of a new row. Pass the conversation
   * repository's latest message time, so rows sort with the messages.
   */
  constructor(
    readonly userId: string,
    readonly embedder: OwnDataServices["embedder"],
    readonly clock: () => string = () => "2026-10-30T12:00:00.000Z",
  ) {}

  private id(): string {
    this.counter += 1;
    return `20000000-0000-4000-8000-${String(this.counter).padStart(12, "0")}`;
  }

  services(): OwnDataServices {
    return {
      embedder: this.embedder,
      retrieval: {
        matchMemories: async (_vector, mode, count) => {
          this.searches.push({ kind: "memories", mode, count });
          if (this.failMatch) throw new Error("match failed");
          return this.memoryMatches.filter((m) => m.userId === this.userId && m.mode === mode).slice(0, Math.min(count, 20));
        },
        matchDocumentChunks: async (_vector, mode, count) => {
          this.searches.push({ kind: "documents", mode, count });
          if (this.failMatch) throw new Error("match failed");
          return this.chunkMatches.filter((m) => m.userId === this.userId && m.mode === mode).slice(0, Math.min(count, 20));
        },
      },
      memories: {
        createMemory: async (userId: string, memory: NewMemory) => {
          const row = {
            id: this.id(),
            mode: memory.mode,
            content: memory.content,
            status: memory.status,
            source: memory.source,
            sourceMessageId: memory.sourceMessageId,
            createdAt: this.clock(),
            updatedAt: this.clock(),
            userId,
          };
          this.memories.push(row);
          return row;
        },
        listMemoriesFromMessage: async (userId: string, messageId: string) =>
          this.memories
            .filter((m) => m.userId === userId && m.sourceMessageId === messageId)
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      },
      proposals: {
        createProposal: async (userId: string, proposal: NewActionProposal) => {
          const row = {
            id: this.id(),
            conversationId: proposal.conversationId,
            payload: actionPayloadSchema.parse(proposal.payload),
            summary: actionSummarySchema.parse(proposal.summary),
            status: "proposed" as const,
            result: null,
            createdAt: this.clock(),
            decidedAt: null,
            userId,
          } as ActionProposalDTO & { userId: string };
          this.proposals.push(row);
          return row;
        },
        listTurnProposals: async (userId: string, conversationId: string, since: string) =>
          this.proposals
            .filter((p) => p.userId === userId && p.conversationId === conversationId && p.createdAt >= since)
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      },
    };
  }
}

export interface FakeDepsOptions {
  repo?: MemoryRepository;
  quota?: FakeQuota;
  spend?: FakeSpend;
  /** Every tier uses only this model (default: Super), so prices stay simple in tests. */
  model?: string;
  search?: ((query: string, signal: AbortSignal) => Promise<WebSearchResult[]>) | null;
  reply?: string[] | ((messages: ChatMessage[], signal: AbortSignal) => AsyncIterable<CompletionChunk>);
  /** Replaces the simple reply provider (for routing tests). */
  provider?: ModelProvider;
  routing?: RoutingConfig;
  contextRecords?: ContextRecordRepository;
  ownData?: OwnDataServices;
}

export function fakeDeps(options: FakeDepsOptions = {}) {
  const prompts: ChatMessage[][] = [];
  const calls: ModelCallRequest[] = [];
  const model = options.model ?? "nvidia/nemotron-3-super-120b-a12b";
  const searches: string[] = [];
  const logs: { level: string; event: string; fields: Record<string, unknown> }[] = [];
  const waited: Promise<unknown>[] = [];
  const reply = options.reply ?? ["Hello", " there."];

  const deps: AssistantDeps = {
    repo: options.repo ?? new MemoryRepository(),
    quota: options.quota ?? new FakeQuota(),
    spend: options.spend ?? new FakeSpend(),
    routing: options.routing ?? testRouting(model),
    search:
      options.search === null
        ? null
        : async (query, signal) => {
            searches.push(query);
            return options.search ? options.search(query, signal) : [];
          },
    provider: options.provider ?? {
      name: "nebius",
      stream: (request, signal) => {
        calls.push(request);
        prompts.push(request.messages);
        if (typeof reply === "function") return reply(request.messages, signal);
        return (async function* () {
          for (const text of reply) yield { type: "text" as const, text };
          yield { type: "finish" as const, finishReason: "stop", usage: { promptTokens: 10, completionTokens: 2 } };
        })();
      },
    },
    ...(options.contextRecords ? { contextRecords: options.contextRecords } : {}),
    ...(options.ownData ? { ownData: options.ownData } : {}),
    breaker: createCircuitBreaker({ threshold: 3, cooldownMs: 30_000 }),
    random: () => 0,
    now: () => new Date(Date.UTC(2026, 9, 14, 12, 30, 0)),
    log: (level, event, fields = {}) => {
      logs.push({ level, event, fields });
    },
    waitUntil: (work) => {
      waited.push(work);
    },
  };
  return { deps, prompts, calls, searches, logs, waited };
}
