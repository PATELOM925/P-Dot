import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { isModelTier, isRouteReason, type MessageRoute } from "@/lib/routing";
import { toSafeHttpUrl } from "@/lib/safe-url";
import type { ClientRequest } from "@/server/http/request-key";
import type {
  ConversationSummary,
  MessageDTO,
  Mode,
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

/** A new column or function that the code needs does not exist yet: the migration is not applied. */
export class SchemaMissingError extends RepositoryError {
  constructor(operation: string) {
    super(operation);
    this.name = "SchemaMissingError";
  }
}

const SCHEMA_MISSING_CODES = new Set(["42703", "42883", "PGRST202", "PGRST204"]);

export function repositoryError(operation: string, error: { code?: string } | null): RepositoryError {
  return error?.code && SCHEMA_MISSING_CODES.has(error.code)
    ? new SchemaMissingError(operation)
    : new RepositoryError(operation);
}

export interface NewMessage {
  /** Picked by the server, so a lost response can be checked by reading this ID. */
  id?: string;
  conversationId: string;
  role: MessageRole;
  content: string;
  webSearch?: WebSearchStatus;
  sources?: SourceRef[];
  /** Assistant replies only: which model answered and why. */
  route?: MessageRoute;
  /** User messages only (decision 0012). */
  clientRequest?: ClientRequest | null;
  /** User messages only: the request that inserts the message also claims its reply. */
  replyClaimId?: string;
  /** Assistant replies only: the user message this reply answers. */
  replyTo?: string;
}

export interface NewConversation {
  id?: string;
  clientRequest?: ClientRequest | null;
}

/** A user message found by its request key. */
export interface KeyedMessage {
  message: MessageDTO;
  conversationId: string;
  hash: string;
}

export type ReplyClaim =
  | { outcome: "claimed"; claimId: string }
  | { outcome: "answered"; replyId: string }
  | { outcome: "busy" }
  | { outcome: "not_found" };

/**
 * Persistence for conversations and messages. Every method takes the
 * authenticated user's ID and filters by it explicitly; RLS enforces the same
 * rule in the database, so ownership is checked twice.
 */
export interface ConversationRepository {
  getConversation(userId: string, conversationId: string): Promise<ConversationSummary | null>;
  /** Newest first; `mode` limits the list to one side (personal or work). */
  listConversations(userId: string, limit: number, mode?: Mode): Promise<ConversationSummary[]>;
  createConversation(userId: string, title: string, mode: Mode, options?: NewConversation): Promise<ConversationSummary>;
  /**
   * Returns null when no conversation with that ID belongs to the user. With
   * `ifTitle`, the update applies only while the stored title still equals it
   * (the comparison is in the update), and returns null otherwise.
   */
  renameConversation(userId: string, conversationId: string, title: string, ifTitle?: string): Promise<ConversationSummary | null>;
  /** Returns false when no conversation with that ID belongs to the user. */
  deleteConversation(userId: string, conversationId: string): Promise<boolean>;
  /** The most recent `limit` messages, oldest first. */
  listRecentMessages(userId: string, conversationId: string, limit: number): Promise<MessageDTO[]>;
  insertMessage(userId: string, message: NewMessage): Promise<MessageDTO>;
  /** Returns null when no message with that ID belongs to the user. */
  getMessage(userId: string, messageId: string): Promise<MessageDTO | null>;
  /**
   * The `created_at`, as stored, of the first other user message in the
   * conversation at or after `message.createdAt`, or null. An equal time is
   * returned as is: the caller cannot tell which of the two came first.
   */
  nextUserMessageAt(userId: string, conversationId: string, message: { id: string; createdAt: string }): Promise<string | null>;
  findMessageByClientRequest(userId: string, key: string): Promise<KeyedMessage | null>;
  findConversationByClientRequest(
    userId: string,
    key: string,
  ): Promise<{ conversation: ConversationSummary; hash: string } | null>;
  /** The right to write the reply to a user message, for the session user (claim_reply). */
  claimReply(messageId: string, leaseSeconds: number): Promise<ReplyClaim>;
  releaseReplyClaim(messageId: string, claimId: string): Promise<void>;
  /**
   * True when the conversation has any reply that read a private source:
   * Google (`google_request`) or a connected app (`connector_read`). No history
   * window (decision 0014, decision 10; decision 0016).
   */
  hasPrivateSourceReply(userId: string, conversationId: string): Promise<boolean>;
}

/** Route reasons of a reply that read a private source. After one, no model-written web search in that conversation. */
export const PRIVATE_SOURCE_REASONS = ["google_request", "connector_read"] as const;

const conversationRow = z.object({
  id: z.string(),
  title: z.string(),
  mode: z.enum(["personal", "work"]),
  updated_at: z.string(),
});

const sourceRow = z.object({ title: z.string(), url: z.string() });

const messageRow = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  web_search: z.enum(["off", "used", "no_results", "failed"]),
  sources: z.array(z.unknown()),
  // Null for user messages and for replies saved before model routing.
  model: z.string().nullish(),
  model_tier: z.string().nullish(),
  route_reason: z.string().nullish(),
  model_fallback: z.boolean().nullish(),
  created_at: z.string(),
});

const CONVERSATION_COLUMNS = "id, title, mode, updated_at";
const LEGACY_MESSAGE_COLUMNS = "id, role, content, web_search, sources, created_at";
const MESSAGE_COLUMNS =
  "id, role, content, web_search, sources, model, model_tier, route_reason, model_fallback, created_at";

const ROUTE_COLUMNS = new Set(["model", "model_tier", "route_reason", "model_fallback"]);

const keyedRow = z.object({ conversation_id: z.string(), client_request_hash: z.string() });
const createdAtRow = z.object({ created_at: z.string() });

const claimRow = z.object({
  outcome: z.enum(["claimed", "answered", "busy", "not_found"]),
  claim_id: z.string().nullable(),
  reply_id: z.string().nullable(),
});

function toClaim(data: unknown): ReplyClaim {
  const parsed = claimRow.safeParse(Array.isArray(data) ? data[0] : data);
  if (!parsed.success) throw new RepositoryError("claimReply");
  const row = parsed.data;
  if (row.outcome === "claimed" && row.claim_id) return { outcome: "claimed", claimId: row.claim_id };
  if (row.outcome === "answered" && row.reply_id) return { outcome: "answered", replyId: row.reply_id };
  if (row.outcome === "busy" || row.outcome === "not_found") return { outcome: row.outcome };
  throw new RepositoryError("claimReply");
}

function clientRequestColumns(request: ClientRequest | null | undefined): Record<string, string> {
  return request ? { client_request_id: request.id, client_request_hash: request.hash } : {};
}

/**
 * The exact error messages for a missing column of `public.messages`. Each one
 * captures the column name. Any other text (another table, extra words) does
 * not match.
 */
const MISSING_COLUMN_MESSAGES: Record<string, RegExp[]> = {
  // Postgres, as PostgREST returns it for a select, and for a direct insert.
  "42703": [
    /^column (?:public\.)?messages\.([a-z_]+) does not exist$/,
    /^column "([a-z_]+)" of relation "messages" does not exist$/,
  ],
  // PostgREST schema cache, for an insert.
  PGRST204: [/^Could not find the '([a-z_]+)' column of 'messages' in the schema cache$/],
};

/**
 * True only when a database error says that one of the four model routing
 * columns of `messages` does not exist yet. This happens when new code runs
 * before the additive routing migration. Every other error returns false.
 */
export function isMissingRouteColumn(error: { code?: string; message?: string } | null): boolean {
  const patterns = error?.code ? MISSING_COLUMN_MESSAGES[error.code] : undefined;
  if (!patterns) return false;
  const message = (error?.message ?? "").trim();
  return patterns.some((pattern) => {
    const column = pattern.exec(message)?.[1];
    return column !== undefined && ROUTE_COLUMNS.has(column);
  });
}

function toConversation(row: unknown): ConversationSummary {
  const parsed = conversationRow.parse(row);
  return { id: parsed.id, title: parsed.title, mode: parsed.mode, updatedAt: parsed.updated_at };
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

/** The route of an assistant reply, or null when any part is missing or unknown. */
function toRoute(row: z.infer<typeof messageRow>): MessageRoute | null {
  if (row.role !== "assistant" || !row.model) return null;
  if (!isModelTier(row.model_tier) || !isRouteReason(row.route_reason)) return null;
  return { model: row.model, tier: row.model_tier, reason: row.route_reason, fallback: row.model_fallback === true };
}

function toMessage(row: unknown): MessageDTO {
  const parsed = messageRow.parse(row);
  return {
    id: parsed.id,
    role: parsed.role,
    content: parsed.content,
    webSearch: parsed.web_search,
    sources: toSources(parsed.sources),
    route: toRoute(parsed),
    createdAt: parsed.created_at,
  };
}

export function createConversationRepository(supabase: SupabaseClient): ConversationRepository {
  // False after the database said the routing columns do not exist yet. Then
  // messages are read and written without them, and `route` is null. Each
  // request makes a new repository, so this ends when the migration is applied.
  let routeColumns = true;

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

    async listConversations(userId, limit, mode) {
      let query = supabase
        .from("conversations")
        .select(CONVERSATION_COLUMNS)
        .eq("user_id", userId);
      if (mode) query = query.eq("mode", mode);
      const { data, error } = await query.order("updated_at", { ascending: false }).limit(limit);
      if (error) throw new RepositoryError("listConversations");
      return (data ?? []).map(toConversation);
    },

    async createConversation(userId, title, mode, options = {}) {
      const { data, error } = await supabase
        .from("conversations")
        .insert({
          ...(options.id ? { id: options.id } : {}),
          user_id: userId,
          title,
          mode,
          ...clientRequestColumns(options.clientRequest),
        })
        .select(CONVERSATION_COLUMNS)
        .single();
      if (error || !data) throw repositoryError("createConversation", error);
      return toConversation(data);
    },

    async renameConversation(userId, conversationId, title, ifTitle) {
      let query = supabase.from("conversations").update({ title }).eq("id", conversationId).eq("user_id", userId);
      if (ifTitle !== undefined) query = query.eq("title", ifTitle);
      const { data, error } = await query.select(CONVERSATION_COLUMNS).maybeSingle();
      if (error) throw new RepositoryError("renameConversation");
      return data ? toConversation(data) : null;
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
      const query = (columns: string) =>
        supabase
          .from("messages")
          .select(columns)
          .eq("conversation_id", conversationId)
          .eq("user_id", userId)
          .order("created_at", { ascending: false })
          .limit(limit);
      let result = await query(routeColumns ? MESSAGE_COLUMNS : LEGACY_MESSAGE_COLUMNS);
      if (result.error && routeColumns && isMissingRouteColumn(result.error)) {
        routeColumns = false;
        result = await query(LEGACY_MESSAGE_COLUMNS);
      }
      if (result.error) throw new RepositoryError("listRecentMessages");
      return ((result.data ?? []) as unknown[]).map(toMessage).reverse();
    },

    async insertMessage(userId, message) {
      const base: Record<string, unknown> = {
        ...(message.id ? { id: message.id } : {}),
        conversation_id: message.conversationId,
        user_id: userId,
        role: message.role,
        content: message.content,
        web_search: message.webSearch ?? "off",
        sources: message.sources ?? [],
        ...clientRequestColumns(message.clientRequest),
        ...(message.replyClaimId ? { reply_claim_id: message.replyClaimId } : {}),
        ...(message.replyTo ? { reply_to: message.replyTo } : {}),
      };
      const route = message.route
        ? {
            model: message.route.model,
            model_tier: message.route.tier,
            route_reason: message.route.reason,
            model_fallback: message.route.fallback,
          }
        : {};
      const insert = (withRoute: boolean) =>
        supabase
          .from("messages")
          .insert(withRoute ? { ...base, ...route } : base)
          .select(withRoute ? MESSAGE_COLUMNS : LEGACY_MESSAGE_COLUMNS)
          .single();
      // A missing column fails the statement before any row is written, so
      // the second insert cannot make a duplicate.
      let result = await insert(routeColumns);
      if (result.error && routeColumns && isMissingRouteColumn(result.error)) {
        routeColumns = false;
        result = await insert(false);
      }
      if (result.error || !result.data) throw repositoryError("insertMessage", result.error);
      return toMessage(result.data);
    },

    async getMessage(userId, messageId) {
      const { data, error } = await supabase
        .from("messages")
        .select(MESSAGE_COLUMNS)
        .eq("id", messageId)
        .eq("user_id", userId)
        .maybeSingle();
      if (error) throw repositoryError("getMessage", error);
      return data ? toMessage(data) : null;
    },

    async hasPrivateSourceReply(userId, conversationId) {
      const { data, error } = await supabase
        .from("messages")
        .select("id")
        .eq("user_id", userId)
        .eq("conversation_id", conversationId)
        .eq("role", "assistant")
        .in("route_reason", [...PRIVATE_SOURCE_REASONS])
        .limit(1);
      if (error) throw repositoryError("hasPrivateSourceReply", error);
      return Array.isArray(data) && data.length > 0;
    },

    async nextUserMessageAt(userId, conversationId, message) {
      const { data, error } = await supabase
        .from("messages")
        .select("created_at")
        .eq("user_id", userId)
        .eq("conversation_id", conversationId)
        .eq("role", "user")
        .neq("id", message.id)
        .gte("created_at", message.createdAt)
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();
      if (error) throw repositoryError("nextUserMessageAt", error);
      return data ? createdAtRow.parse(data).created_at : null;
    },

    async findMessageByClientRequest(userId, key) {
      const { data, error } = await supabase
        .from("messages")
        .select(`${MESSAGE_COLUMNS}, conversation_id, client_request_hash`)
        .eq("user_id", userId)
        .eq("client_request_id", key)
        .eq("role", "user")
        .maybeSingle();
      if (error) throw repositoryError("findMessageByClientRequest", error);
      if (!data) return null;
      const keyed = keyedRow.parse(data);
      return { message: toMessage(data), conversationId: keyed.conversation_id, hash: keyed.client_request_hash };
    },

    async findConversationByClientRequest(userId, key) {
      const { data, error } = await supabase
        .from("conversations")
        .select(`${CONVERSATION_COLUMNS}, client_request_hash`)
        .eq("user_id", userId)
        .eq("client_request_id", key)
        .maybeSingle();
      if (error) throw repositoryError("findConversationByClientRequest", error);
      if (!data) return null;
      const hash = z.object({ client_request_hash: z.string() }).parse(data).client_request_hash;
      return { conversation: toConversation(data), hash };
    },

    async claimReply(messageId, leaseSeconds) {
      const { data, error } = await supabase.rpc("claim_reply", {
        p_message_id: messageId,
        p_lease_seconds: leaseSeconds,
      });
      if (error) throw repositoryError("claimReply", error);
      return toClaim(data);
    },

    async releaseReplyClaim(messageId, claimId) {
      const { error } = await supabase.rpc("release_reply_claim", {
        p_message_id: messageId,
        p_claim_id: claimId,
      });
      if (error) throw repositoryError("releaseReplyClaim", error);
    },
  };
}
