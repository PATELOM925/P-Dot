import type { ConversationRepository, NewMessage } from "@/server/db/conversations";
import type { QuotaGate } from "@/server/db/quota";
import type { AssistantDeps } from "@/server/assistant/service";
import type { ChatMessage, CompletionChunk } from "@/server/providers/nebius/client";
import type { WebSearchResult } from "@/server/providers/tavily/client";
import type { ConversationSummary, MessageDTO, Mode, TaskDTO } from "@/types/api";
import type { TaskRepository } from "@/server/db/tasks";

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
    return found ? { id: found.id, title: found.title, mode: found.mode, updatedAt: found.updatedAt } : null;
  }

  async listConversations(userId: string, limit: number, mode?: Mode) {
    return this.conversations
      .filter((c) => c.userId === userId && (!mode || c.mode === mode))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit)
      .map(({ id, title, mode: m, updatedAt }) => ({ id, title, mode: m, updatedAt }));
  }

  async createConversation(userId: string, title: string, mode: Mode = "personal") {
    const conversation = { id: this.nextId(), title, mode, updatedAt: this.timestamp(), userId };
    this.conversations.push(conversation);
    return { id: conversation.id, title, mode, updatedAt: conversation.updatedAt };
  }

  async renameConversation(userId: string, id: string, title: string) {
    const found = this.conversations.find((c) => c.id === id && c.userId === userId);
    if (!found) return null;
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
  reply?: string[] | ((messages: ChatMessage[], signal: AbortSignal) => AsyncIterable<CompletionChunk>);
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
    complete: (messages, signal) => {
      prompts.push(messages);
      if (typeof reply === "function") return reply(messages, signal);
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
