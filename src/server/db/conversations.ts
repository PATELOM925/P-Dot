import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { toSafeHttpUrl } from "@/lib/safe-url";
import type {
  ConversationSummary,
  MessageDTO,
  MessageRole,
  SourceRef,
  WebSearchStatus,
} from "@/types/api";

export class RepositoryError extends Error {
  constructor(operation: string) {
    // Never include database error details: they can echo row content.
    super(`Database operation failed: ${operation}`);
    this.name = "RepositoryError";
  }
}

export interface NewMessage {
  conversationId: string;
  role: MessageRole;
  content: string;
  webSearch?: WebSearchStatus;
  sources?: SourceRef[];
}

/**
 * Persistence for conversations and messages. Every method takes the
 * authenticated user's ID and filters by it explicitly; RLS enforces the same
 * rule in the database, so ownership is checked twice.
 */
export interface ConversationRepository {
  getConversation(userId: string, conversationId: string): Promise<ConversationSummary | null>;
  listConversations(userId: string, limit: number): Promise<ConversationSummary[]>;
  createConversation(userId: string, title: string): Promise<ConversationSummary>;
  updateConversationTitle(userId: string, conversationId: string, title: string): Promise<boolean>;
  /** Returns false when no conversation with that ID belongs to the user. */
  deleteConversation(userId: string, conversationId: string): Promise<boolean>;
  /** The most recent `limit` messages, oldest first. */
  listRecentMessages(userId: string, conversationId: string, limit: number): Promise<MessageDTO[]>;
  insertMessage(userId: string, message: NewMessage): Promise<MessageDTO>;
}

const conversationRow = z.object({
  id: z.string(),
  title: z.string(),
  updated_at: z.string(),
});

const sourceRow = z.object({ title: z.string(), url: z.string() });

const messageRow = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  web_search: z.enum(["off", "used", "no_results", "failed"]),
  sources: z.array(z.unknown()),
  created_at: z.string(),
});

const CONVERSATION_COLUMNS = "id, title, updated_at";
const MESSAGE_COLUMNS = "id, role, content, web_search, sources, created_at";

function toConversation(row: unknown): ConversationSummary {
  const parsed = conversationRow.parse(row);
  return { id: parsed.id, title: parsed.title, updatedAt: parsed.updated_at };
}

function toSources(values: unknown[]): SourceRef[] {
  const sources: SourceRef[] = [];
  for (const value of values) {
    const parsed = sourceRow.safeParse(value);
    const url = parsed.success ? toSafeHttpUrl(parsed.data.url) : null;
    if (parsed.success && url) sources.push({ title: parsed.data.title, url });
  }
  return sources;
}

function toMessage(row: unknown): MessageDTO {
  const parsed = messageRow.parse(row);
  return {
    id: parsed.id,
    role: parsed.role,
    content: parsed.content,
    webSearch: parsed.web_search,
    sources: toSources(parsed.sources),
    createdAt: parsed.created_at,
  };
}

export function createConversationRepository(supabase: SupabaseClient): ConversationRepository {
  return {
    async getConversation(userId, conversationId) {
      const { data, error } = await supabase
        .from("conversations")
        .select(CONVERSATION_COLUMNS)
        .eq("id", conversationId)
        .eq("user_id", userId)
        .maybeSingle();
      if (error) throw new RepositoryError("getConversation");
      return data ? toConversation(data) : null;
    },

    async listConversations(userId, limit) {
      const { data, error } = await supabase
        .from("conversations")
        .select(CONVERSATION_COLUMNS)
        .eq("user_id", userId)
        .order("updated_at", { ascending: false })
        .limit(limit);
      if (error) throw new RepositoryError("listConversations");
      return (data ?? []).map(toConversation);
    },

    async createConversation(userId, title) {
      const { data, error } = await supabase
        .from("conversations")
        .insert({ user_id: userId, title })
        .select(CONVERSATION_COLUMNS)
        .single();
      if (error || !data) throw new RepositoryError("createConversation");
      return toConversation(data);
    },

    async updateConversationTitle(userId, conversationId, title) {
      const { error } = await supabase
        .from("conversations")
        .update({ title })
        .eq("id", conversationId)
        .eq("user_id", userId);
      if (error) throw new RepositoryError("updateConversationTitle");
      return true;
    },

    async deleteConversation(userId, conversationId) {
      const { count, error } = await supabase
        .from("conversations")
        .delete({ count: "exact" })
        .eq("id", conversationId)
        .eq("user_id", userId);
      if (error) throw new RepositoryError("deleteConversation");
      return (count ?? 0) > 0;
    },

    async listRecentMessages(userId, conversationId, limit) {
      const { data, error } = await supabase
        .from("messages")
        .select(MESSAGE_COLUMNS)
        .eq("conversation_id", conversationId)
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) throw new RepositoryError("listRecentMessages");
      return (data ?? []).map(toMessage).reverse();
    },

    async insertMessage(userId, message) {
      const { data, error } = await supabase
        .from("messages")
        .insert({
          conversation_id: message.conversationId,
          user_id: userId,
          role: message.role,
          content: message.content,
          web_search: message.webSearch ?? "off",
          sources: message.sources ?? [],
        })
        .select(MESSAGE_COLUMNS)
        .single();
      if (error || !data) throw new RepositoryError("insertMessage");
      return toMessage(data);
    },
  };
}
