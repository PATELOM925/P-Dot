import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Mode } from "@/types/api";
import { toPgVector } from "@/server/providers/nebius/embeddings";
import { RepositoryError } from "./conversations";

export interface MemoryMatch {
  id: string;
  content: string;
  similarity: number;
}

export interface DocumentChunkMatch {
  id: string;
  documentId: string;
  title: string;
  content: string;
  similarity: number;
}

/** A ready document of the mode, without its text. */
export interface ReadyDocument {
  id: string;
  title: string;
  charCount: number;
}

/** One stored part of a document, in document order. */
export interface DocumentChunk {
  id: string;
  documentId: string;
  content: string;
}

const readyDocumentRow = z.object({ id: z.string(), title: z.string(), char_count: z.number() });
const documentChunkRow = z.object({ id: z.string(), document_id: z.string(), content: z.string() });

const memoryRow = z.object({ id: z.string(), content: z.string(), similarity: z.number() });
const chunkRow = z.object({
  id: z.string(),
  document_id: z.string(),
  title: z.string(),
  content: z.string(),
  similarity: z.number(),
});

/**
 * Similarity search over the signed-in user's active memories and ready
 * documents. The database functions run as the caller (RLS applies) and cap
 * the count at 20.
 */
export interface RetrievalRepository {
  matchMemories(vector: number[], mode: Mode, count: number): Promise<MemoryMatch[]>;
  matchDocumentChunks(vector: number[], mode: Mode, count: number): Promise<DocumentChunkMatch[]>;
  /** The user's ready documents of the mode, newest first, at most `limit`. Titles and sizes only. */
  readyDocuments(userId: string, mode: Mode, limit: number): Promise<ReadyDocument[]>;
  /** The parts of these documents, in document order, at most `limit`. */
  documentChunks(userId: string, documentIds: string[], limit: number): Promise<DocumentChunk[]>;
}

export function createRetrievalRepository(supabase: SupabaseClient): RetrievalRepository {
  return {
    async matchMemories(vector, mode, count) {
      const { data, error } = await supabase.rpc("match_memories", {
        p_query: toPgVector(vector),
        p_mode: mode,
        p_count: count,
      });
      if (error) throw new RepositoryError("matchMemories");
      return z.array(memoryRow).parse(data ?? []);
    },
    async matchDocumentChunks(vector, mode, count) {
      const { data, error } = await supabase.rpc("match_document_chunks", {
        p_query: toPgVector(vector),
        p_mode: mode,
        p_count: count,
      });
      if (error) throw new RepositoryError("matchDocumentChunks");
      return z
        .array(chunkRow)
        .parse(data ?? [])
        .map((r) => ({ id: r.id, documentId: r.document_id, title: r.title, content: r.content, similarity: r.similarity }));
    },
    async readyDocuments(userId, mode, limit) {
      const { data, error } = await supabase
        .from("documents")
        .select("id, title, char_count")
        .eq("user_id", userId)
        .eq("mode", mode)
        .eq("status", "ready")
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) throw new RepositoryError("readyDocuments");
      return z
        .array(readyDocumentRow)
        .parse(data ?? [])
        .map((r) => ({ id: r.id, title: r.title, charCount: r.char_count }));
    },
    async documentChunks(userId, documentIds, limit) {
      if (documentIds.length === 0) return [];
      const { data, error } = await supabase
        .from("document_chunks")
        .select("id, document_id, content")
        .eq("user_id", userId)
        .in("document_id", documentIds)
        .order("document_id")
        .order("chunk_index")
        .limit(limit);
      if (error) throw new RepositoryError("documentChunks");
      return z
        .array(documentChunkRow)
        .parse(data ?? [])
        .map((r) => ({ id: r.id, documentId: r.document_id, content: r.content }));
    },
  };
}
