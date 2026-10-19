import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { DocumentDTO, DocumentMediaType, DocumentStatus, Mode } from "@/types/api";
import { EMBEDDING_MODEL, toPgVector } from "@/server/providers/nebius/embeddings";
import { RepositoryError } from "./conversations";

export interface NewDocument {
  mode: Mode;
  title: string;
  mediaType: DocumentMediaType;
  charCount: number;
}

export interface NewChunk {
  index: number;
  content: string;
  embedding: number[];
}

/**
 * Persistence for uploaded documents and their chunks. Every method takes the
 * authenticated user's ID and filters by it explicitly; RLS enforces the same
 * rule in the database. Embeddings are written but never read back.
 */
export interface DocumentRepository {
  /** Newest first. */
  listDocuments(userId: string, mode: Mode, limit: number): Promise<DocumentDTO[]>;
  /** Creates the document with status "processing". */
  createDocument(userId: string, document: NewDocument): Promise<DocumentDTO>;
  insertChunks(userId: string, documentId: string, chunks: NewChunk[]): Promise<void>;
  setStatus(userId: string, documentId: string, status: DocumentStatus): Promise<void>;
  /** Returns false when no document with that ID belongs to the user. Chunks go with it. */
  deleteDocument(userId: string, documentId: string): Promise<boolean>;
}

const documentRow = z.object({
  id: z.string(),
  mode: z.enum(["personal", "work"]),
  title: z.string(),
  media_type: z.enum(["text/plain", "text/markdown"]),
  char_count: z.number(),
  status: z.enum(["processing", "ready", "failed"]),
  created_at: z.string(),
});

// The embedding column is deliberately left out: vectors are never sent to the client.
const DOCUMENT_COLUMNS = "id, mode, title, media_type, char_count, status, created_at";

function toDocument(row: unknown): DocumentDTO {
  const parsed = documentRow.parse(row);
  return {
    id: parsed.id,
    mode: parsed.mode,
    title: parsed.title,
    mediaType: parsed.media_type,
    charCount: parsed.char_count,
    status: parsed.status,
    createdAt: parsed.created_at,
  };
}

export function createDocumentRepository(supabase: SupabaseClient): DocumentRepository {
  return {
    async listDocuments(userId, mode, limit) {
      const { data, error } = await supabase
        .from("documents")
        .select(DOCUMENT_COLUMNS)
        .eq("user_id", userId)
        .eq("mode", mode)
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) throw new RepositoryError("listDocuments");
      return (data ?? []).map(toDocument);
    },

    async createDocument(userId, document) {
      const { data, error } = await supabase
        .from("documents")
        .insert({
          user_id: userId,
          mode: document.mode,
          title: document.title,
          media_type: document.mediaType,
          char_count: document.charCount,
          status: "processing",
        })
        .select(DOCUMENT_COLUMNS)
        .single();
      if (error || !data) throw new RepositoryError("createDocument");
      return toDocument(data);
    },

    async insertChunks(userId, documentId, chunks) {
      if (chunks.length === 0) return;
      const { error } = await supabase.from("document_chunks").insert(
        chunks.map((chunk) => ({
          user_id: userId,
          document_id: documentId,
          chunk_index: chunk.index,
          content: chunk.content,
          embedding: toPgVector(chunk.embedding),
          embedding_model: EMBEDDING_MODEL,
        })),
      );
      if (error) throw new RepositoryError("insertChunks");
    },

    async setStatus(userId, documentId, status) {
      const { error } = await supabase
        .from("documents")
        .update({ status })
        .eq("id", documentId)
        .eq("user_id", userId);
      if (error) throw new RepositoryError("setDocumentStatus");
    },

    async deleteDocument(userId, documentId) {
      const { count, error } = await supabase
        .from("documents")
        .delete({ count: "exact" })
        .eq("id", documentId)
        .eq("user_id", userId);
      if (error) throw new RepositoryError("deleteDocument");
      return (count ?? 0) > 0;
    },
  };
}
