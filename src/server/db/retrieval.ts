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
  };
}
