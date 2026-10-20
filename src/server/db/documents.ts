import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { RepositoryError } from "./conversations";

export interface UserDocument {
  id: string;
  userId: string;
  filename: string;
  filePath?: string | null;
  fileSize: number;
  mimeType: string;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentChunkMatch {
  id: string;
  documentId: string;
  filename: string;
  chunkIndex: number;
  content: string;
  similarity: number;
}

export interface NewDocument {
  filename: string;
  filePath?: string | null;
  fileSize: number;
  mimeType?: string;
}

export interface NewChunk {
  documentId: string;
  chunkIndex: number;
  content: string;
  embedding: number[];
}

export interface DocumentRepository {
  listDocuments(userId: string): Promise<UserDocument[]>;
  getDocument(userId: string, documentId: string): Promise<UserDocument | null>;
  createDocument(userId: string, doc: NewDocument): Promise<UserDocument>;
  insertChunks(userId: string, chunks: NewChunk[]): Promise<void>;
  searchChunks(
    userId: string,
    queryEmbedding: number[],
    options?: { threshold?: number; limit?: number },
  ): Promise<DocumentChunkMatch[]>;
  deleteDocument(userId: string, documentId: string): Promise<boolean>;
}

const documentRowSchema = z.object({
  id: z.string(),
  user_id: z.string(),
  filename: z.string(),
  file_path: z.string().nullable().optional(),
  file_size: z.number(),
  mime_type: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});

const chunkMatchRowSchema = z.object({
  id: z.string(),
  document_id: z.string(),
  filename: z.string(),
  chunk_index: z.number(),
  content: z.string(),
  similarity: z.number(),
});

function toUserDocument(row: unknown): UserDocument {
  const parsed = documentRowSchema.parse(row);
  return {
    id: parsed.id,
    userId: parsed.user_id,
    filename: parsed.filename,
    filePath: parsed.file_path ?? null,
    fileSize: parsed.file_size,
    mimeType: parsed.mime_type,
    createdAt: parsed.created_at,
    updatedAt: parsed.updated_at,
  };
}

export function createDocumentRepository(supabase: SupabaseClient): DocumentRepository {
  return {
    async listDocuments(userId: string): Promise<UserDocument[]> {
      const { data, error } = await supabase
        .from("user_documents")
        .select("id, user_id, filename, file_path, file_size, mime_type, created_at, updated_at")
        .eq("user_id", userId)
        .order("updated_at", { ascending: false });

      if (error) throw new RepositoryError("listDocuments");
      return (data ?? []).map(toUserDocument);
    },

    async getDocument(userId: string, documentId: string): Promise<UserDocument | null> {
      const { data, error } = await supabase
        .from("user_documents")
        .select("id, user_id, filename, file_path, file_size, mime_type, created_at, updated_at")
        .eq("id", documentId)
        .eq("user_id", userId)
        .maybeSingle();

      if (error) throw new RepositoryError("getDocument");
      return data ? toUserDocument(data) : null;
    },

    async createDocument(userId: string, doc: NewDocument): Promise<UserDocument> {
      const { data, error } = await supabase
        .from("user_documents")
        .insert({
          user_id: userId,
          filename: doc.filename,
          file_path: doc.filePath ?? null,
          file_size: doc.fileSize,
          mime_type: doc.mimeType ?? "text/plain",
        })
        .select("id, user_id, filename, file_path, file_size, mime_type, created_at, updated_at")
        .single();

      if (error || !data) throw new RepositoryError("createDocument");
      return toUserDocument(data);
    },

    async insertChunks(userId: string, chunks: NewChunk[]): Promise<void> {
      if (chunks.length === 0) return;

      const rows = chunks.map((c) => ({
        document_id: c.documentId,
        user_id: userId,
        chunk_index: c.chunkIndex,
        content: c.content,
        embedding: c.embedding,
      }));

      const { error } = await supabase.from("document_chunks").insert(rows);
      if (error) throw new RepositoryError("insertChunks");
    },

    async searchChunks(
      _userId: string,
      queryEmbedding: number[],
      options = {},
    ): Promise<DocumentChunkMatch[]> {
      const threshold = options.threshold ?? 0.25;
      const limit = options.limit ?? 5;

      const { data, error } = await supabase.rpc("match_document_chunks", {
        p_query_embedding: queryEmbedding,
        p_match_threshold: threshold,
        p_match_count: limit,
      });

      if (error) throw new RepositoryError("searchChunks");

      return (data ?? []).map((row: unknown) => {
        const parsed = chunkMatchRowSchema.parse(row);
        return {
          id: parsed.id,
          documentId: parsed.document_id,
          filename: parsed.filename,
          chunkIndex: parsed.chunk_index,
          content: parsed.content,
          similarity: parsed.similarity,
        };
      });
    },

    async deleteDocument(userId: string, documentId: string): Promise<boolean> {
      const { error, count } = await supabase
        .from("user_documents")
        .delete({ count: "exact" })
        .eq("id", documentId)
        .eq("user_id", userId);

      if (error) throw new RepositoryError("deleteDocument");
      return (count ?? 0) > 0;
    },
  };
}

/**
 * In-memory Mock Document Repository for unit tests and local evaluation.
 */
export function createMockDocumentRepository(
  initialDocs: UserDocument[] = [],
  initialChunks: Array<NewChunk & { id: string; userId: string; filename: string }> = [],
): DocumentRepository {
  const docs = new Map<string, UserDocument>(initialDocs.map((d) => [d.id, { ...d }]));
  const chunks = [...initialChunks];

  // Simple cosine similarity calculator for mock vector matching
  function cosineSimilarity(a: number[], b: number[]): number {
    let dot = 0;
    let normA = 0;
    let normB = 0;
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) {
      dot += a[i]! * b[i]!;
      normA += a[i]! * a[i]!;
      normB += b[i]! * b[i]!;
    }
    if (normA === 0 || normB === 0) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  return {
    async listDocuments(userId: string): Promise<UserDocument[]> {
      return [...docs.values()]
        .filter((d) => d.userId === userId)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },

    async getDocument(userId: string, documentId: string): Promise<UserDocument | null> {
      const doc = docs.get(documentId);
      return doc && doc.userId === userId ? { ...doc } : null;
    },

    async createDocument(userId: string, newDoc: NewDocument): Promise<UserDocument> {
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      const doc: UserDocument = {
        id,
        userId,
        filename: newDoc.filename,
        filePath: newDoc.filePath ?? null,
        fileSize: newDoc.fileSize,
        mimeType: newDoc.mimeType ?? "text/plain",
        createdAt: now,
        updatedAt: now,
      };
      docs.set(id, doc);
      return { ...doc };
    },

    async insertChunks(userId: string, newChunks: NewChunk[]): Promise<void> {
      for (const c of newChunks) {
        const doc = docs.get(c.documentId);
        chunks.push({
          id: crypto.randomUUID(),
          userId,
          documentId: c.documentId,
          filename: doc?.filename ?? "document.txt",
          chunkIndex: c.chunkIndex,
          content: c.content,
          embedding: c.embedding,
        });
      }
    },

    async searchChunks(
      userId: string,
      queryEmbedding: number[],
      options = {},
    ): Promise<DocumentChunkMatch[]> {
      const threshold = options.threshold ?? 0.25;
      const limit = options.limit ?? 5;

      const matches: DocumentChunkMatch[] = [];

      for (const c of chunks) {
        if (c.userId !== userId) continue;
        const sim = cosineSimilarity(queryEmbedding, c.embedding);
        if (sim >= threshold) {
          matches.push({
            id: c.id,
            documentId: c.documentId,
            filename: c.filename,
            chunkIndex: c.chunkIndex,
            content: c.content,
            similarity: Math.round(sim * 10000) / 10000,
          });
        }
      }

      return matches.sort((a, b) => b.similarity - a.similarity).slice(0, limit);
    },

    async deleteDocument(userId: string, documentId: string): Promise<boolean> {
      const doc = docs.get(documentId);
      if (!doc || doc.userId !== userId) return false;
      docs.delete(documentId);
      // Delete associated chunks
      const remaining = chunks.filter((c) => c.documentId !== documentId);
      chunks.length = 0;
      chunks.push(...remaining);
      return true;
    },
  };
}
