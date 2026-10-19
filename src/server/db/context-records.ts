import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { ContextRecordDTO } from "@/types/api";
import { RepositoryError } from "./conversations";

/** Most IDs one record may hold. The database check allows the same 50. */
export const MAX_CONTEXT_IDS = 50;

/** What the chat service stores after it saves a reply. IDs and counts only. */
export interface NewContextRecord {
  messageId: string;
  model: string;
  historyMessageCount: number;
  historyChars: number;
  memoryIds: string[];
  documentChunkIds: string[];
  webSourceCount: number;
  promptVersion: string;
  inputTokens: number | null;
  outputTokens: number | null;
}

/**
 * "What was sent" records (decision 0009). Every method filters by the
 * authenticated user's ID, and RLS enforces the same rule in the database.
 */
export interface ContextRecordRepository {
  insertContextRecord(userId: string, record: NewContextRecord): Promise<void>;
  /** Returns null when the message has no record or belongs to another user. */
  getContextRecord(userId: string, messageId: string): Promise<ContextRecordDTO | null>;
}

/**
 * Removes repeated IDs and keeps at most `max` of them, in their first-seen order.
 * Used before a record is stored, so a long list cannot break the database check.
 */
export function limitIds(ids: string[], max = MAX_CONTEXT_IDS): string[] {
  return [...new Set(ids)].slice(0, max);
}

const RECORD_COLUMNS =
  "message_id, model, history_message_count, history_chars, memory_ids, document_chunk_ids, " +
  "web_source_count, prompt_version, input_tokens, output_tokens, created_at";

const recordRow = z.object({
  message_id: z.string(),
  model: z.string(),
  history_message_count: z.number(),
  history_chars: z.number(),
  memory_ids: z.array(z.string()),
  document_chunk_ids: z.array(z.string()),
  web_source_count: z.number(),
  prompt_version: z.string(),
  input_tokens: z.number().nullable(),
  output_tokens: z.number().nullable(),
  created_at: z.string(),
});

const memoryRow = z.object({ id: z.string(), content: z.string() });
const chunkRow = z.object({ id: z.string(), document_id: z.string() });
const documentRow = z.object({ id: z.string(), title: z.string() });

/** Loads the current text of the listed memories. A missing or foreign memory maps to null. */
async function loadMemories(
  supabase: SupabaseClient,
  userId: string,
  ids: string[],
): Promise<ContextRecordDTO["memories"]> {
  if (ids.length === 0) return [];
  const { data, error } = await supabase
    .from("memories")
    .select("id, content")
    .eq("user_id", userId)
    .in("id", ids);
  if (error) throw new RepositoryError("loadContextMemories");

  const byId = new Map(z.array(memoryRow).parse(data ?? []).map((m) => [m.id, m.content]));
  return ids.map((id) => ({ id, content: byId.get(id) ?? null }));
}

/** Loads the listed chunks and their document titles. A missing or foreign chunk maps to nulls. */
async function loadChunks(
  supabase: SupabaseClient,
  userId: string,
  ids: string[],
): Promise<ContextRecordDTO["documentChunks"]> {
  if (ids.length === 0) return [];
  const { data, error } = await supabase
    .from("document_chunks")
    .select("id, document_id")
    .eq("user_id", userId)
    .in("id", ids);
  if (error) throw new RepositoryError("loadContextChunks");

  const chunks = new Map(z.array(chunkRow).parse(data ?? []).map((c) => [c.id, c.document_id]));
  const documentIds = [...new Set(chunks.values())];
  const titles = await loadDocumentTitles(supabase, userId, documentIds);

  return ids.map((id) => {
    const documentId = chunks.get(id);
    if (documentId === undefined) return { id, documentId: null, title: null };
    return { id, documentId, title: titles.get(documentId) ?? null };
  });
}

async function loadDocumentTitles(
  supabase: SupabaseClient,
  userId: string,
  ids: string[],
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const { data, error } = await supabase
    .from("documents")
    .select("id, title")
    .eq("user_id", userId)
    .in("id", ids);
  if (error) throw new RepositoryError("loadContextDocuments");
  return new Map(z.array(documentRow).parse(data ?? []).map((d) => [d.id, d.title]));
}

export function createContextRecordRepository(supabase: SupabaseClient): ContextRecordRepository {
  return {
    async insertContextRecord(userId, record) {
      const { error } = await supabase.from("context_records").insert({
        user_id: userId,
        message_id: record.messageId,
        model: record.model,
        history_message_count: record.historyMessageCount,
        history_chars: record.historyChars,
        memory_ids: limitIds(record.memoryIds),
        document_chunk_ids: limitIds(record.documentChunkIds),
        web_source_count: record.webSourceCount,
        prompt_version: record.promptVersion,
        input_tokens: record.inputTokens,
        output_tokens: record.outputTokens,
      });
      if (error) throw new RepositoryError("insertContextRecord");
    },

    async getContextRecord(userId, messageId) {
      const { data, error } = await supabase
        .from("context_records")
        .select(RECORD_COLUMNS)
        .eq("message_id", messageId)
        .eq("user_id", userId)
        .maybeSingle();
      if (error) throw new RepositoryError("getContextRecord");
      if (!data) return null;

      const row = recordRow.parse(data);
      const [memories, documentChunks] = await Promise.all([
        loadMemories(supabase, userId, row.memory_ids),
        loadChunks(supabase, userId, row.document_chunk_ids),
      ]);

      return {
        messageId: row.message_id,
        model: row.model,
        historyMessageCount: row.history_message_count,
        historyChars: row.history_chars,
        memories,
        documentChunks,
        webSourceCount: row.web_source_count,
        promptVersion: row.prompt_version,
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        createdAt: row.created_at,
      };
    },
  };
}
