import type { ConversationRepository, NewMessage } from "@/server/db/conversations";
import type { QuotaGate } from "@/server/db/quota";
import type { AssistantDeps, CompleteOptions } from "@/server/assistant/service";
import type { ChatMessage, CompletionChunk } from "@/server/providers/nebius/client";
import type { WebSearchResult } from "@/server/providers/tavily/client";
import type { ConversationSummary, MessageDTO } from "@/types/api";

interface StoredConversation extends ConversationSummary {
  userId: string;
}

interface StoredMessage extends MessageDTO {
  userId: string;
  conversationId: string;
}

function toDto(message: StoredMessage): MessageDTO {
  const { id, role, content, webSearch, sources, createdAt } = message;
  return { id, role, content, webSearch, sources, createdAt };
}

/**
 * In-memory repository that mirrors the database's ownership rules (RLS):
 * every read and write is scoped to the given user ID.
 */
export class MemoryRepository implements ConversationRepository {
  conversations: StoredConversation[] = [];
  messages: StoredMessage[] = [];
  private counter = 0;
  failInsertForRole: "user" | "assistant" | null = null;

  private nextId(): string {
    this.counter += 1;
    return `00000000-0000-4000-8000-${String(this.counter).padStart(12, "0")}`;
  }

  private timestamp(): string {
    return new Date(Date.UTC(2026, 9, 14, 12, 0, this.counter)).toISOString();
  }

  async getConversation(userId: string, id: string) {
    const found = this.conversations.find((c) => c.id === id && c.userId === userId);
    return found ? { id: found.id, title: found.title, updatedAt: found.updatedAt } : null;
  }

  async listConversations(userId: string, limit: number) {
    return this.conversations
      .filter((c) => c.userId === userId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit)
      .map(({ id, title, updatedAt }) => ({ id, title, updatedAt }));
  }

  async createConversation(userId: string, title: string) {
    const conversation = { id: this.nextId(), title, updatedAt: this.timestamp(), userId };
    this.conversations.push(conversation);
    return { id: conversation.id, title, updatedAt: conversation.updatedAt };
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
    const stored: StoredMessage = {
      id: this.nextId(),
      role: message.role,
      content: message.content,
      webSearch: message.webSearch ?? "off",
      sources: message.sources ?? [],
      createdAt: this.timestamp(),
      userId,
      conversationId: message.conversationId,
    };
    this.messages.push(stored);
    owner.updatedAt = stored.createdAt;
    return toDto(stored);
  }
}

export class FakeQuota implements QuotaGate {
  calls = 0;
  constructor(private readonly allow = true) {}
  async consume() {
    this.calls += 1;
    return { allowed: this.allow, resetsAt: new Date(Date.UTC(2026, 9, 14, 13, 0, 0)) };
  }
}

export interface FakeDepsOptions {
  repo?: MemoryRepository;
  quota?: FakeQuota;
  search?: ((query: string, signal: AbortSignal) => Promise<WebSearchResult[]>) | null;
  reply?:
    | string[]
    | ((
        messages: ChatMessage[],
        signal: AbortSignal,
        options?: CompleteOptions,
      ) => AsyncIterable<CompletionChunk>);
}

export function fakeDeps(options: FakeDepsOptions = {}) {
  const prompts: ChatMessage[][] = [];
  const searches: string[] = [];
  const logs: { level: string; event: string; fields: Record<string, unknown> }[] = [];
  const reply = options.reply ?? ["Hello", " there."];

  const deps: AssistantDeps = {
    repo: options.repo ?? new MemoryRepository(),
    quota: options.quota ?? new FakeQuota(),
    search:
      options.search === null
        ? null
        : async (query, signal) => {
            searches.push(query);
            return options.search ? options.search(query, signal) : [];
          },
    complete: (messages, signal, completeOptions) => {
      prompts.push(messages);
      if (typeof reply === "function") return reply(messages, signal, completeOptions);
      return (async function* () {
        for (const text of reply) yield { type: "text" as const, text };
        yield { type: "finish" as const, finishReason: "stop", usage: { promptTokens: 10, completionTokens: 2 } };
      })();
    },
    now: () => new Date(Date.UTC(2026, 9, 14, 12, 30, 0)),
    log: (level, event, fields = {}) => {
      logs.push({ level, event, fields });
    },
  };
  return { deps, prompts, searches, logs };
}
