import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { DOCUMENT_MEDIA_TYPES } from "@/lib/document-types";
import type { DocumentDTO, DocumentMediaType, DocumentStatus, Mode } from "@/types/api";
import { EMBEDDING_MODEL, toPgVector } from "@/server/providers/nebius/embeddings";
import type { ClientRequest } from "@/server/http/request-key";
import { RepositoryError, repositoryError } from "./conversations";

export interface NewDocument {
  mode: Mode;
  title: string;
  mediaType: DocumentMediaType;
  charCount: number;
  clientRequest?: ClientRequest | null;
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
  /** The database refuses chunks for a document that is not "processing". */
  insertChunks(userId: string, documentId: string, chunks: NewChunk[]): Promise<void>;
  /**
   * settle_document: a "processing" document with chunks that all have an
   * embedding becomes "ready", any other "processing" one "failed". Another
   * status does not change. Returns the status after the call, or null when no
   * such document belongs to the user. It locks the row, so it cannot pass a
   * chunk insert. No embedding call is made.
   */
  settleDocument(documentId: string): Promise<DocumentStatus | null>;
  /**
   * Settles at most `limit` of the user's documents that are still "processing"
   * and were created before `createdBefore`, with `settleDocument`. Returns the
   * number of documents settled.
   */
  settleStaleDocuments(userId: string, createdBefore: Date, limit: number): Promise<number>;
  /** The document that is not "failed" with this request key, and the fingerprint of that request. */
  findDocumentByClientRequest(userId: string, key: string): Promise<{ document: DocumentDTO; hash: string } | null>;
  /** Returns false when no document with that ID belongs to the user. Chunks go with it. */
  deleteDocument(userId: string, documentId: string): Promise<boolean>;
}

const documentRow = z.object({
  id: z.string(),
  mode: z.enum(["personal", "work"]),
  title: z.string(),
  media_type: z.enum(DOCUMENT_MEDIA_TYPES),
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
  const settleDocument = async (documentId: string): Promise<DocumentStatus | null> => {
    const { data, error } = await supabase.rpc("settle_document", { p_document_id: documentId });
    if (error) throw repositoryError("settleDocument", error);
    const status = z.enum(["processing", "ready", "failed"]).nullable().safeParse(data);
    if (!status.success) throw new RepositoryError("settleDocument");
    return status.data;
  };

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
          ...(document.clientRequest
            ? { client_request_id: document.clientRequest.id, client_request_hash: document.clientRequest.hash }
            : {}),
        })
        .select(DOCUMENT_COLUMNS)
        .single();
      if (error || !data) throw repositoryError("createDocument", error);
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

    settleDocument,

    async settleStaleDocuments(userId, createdBefore, limit) {
      const { data, error } = await supabase
        .from("documents")
        .select("id")
        .eq("user_id", userId)
        .eq("status", "processing")
        .lt("created_at", createdBefore.toISOString())
        .order("created_at", { ascending: true })
        .limit(limit);
      if (error) throw new RepositoryError("findStaleDocuments");
      const ids = z.array(z.object({ id: z.string() })).parse(data ?? []).map((row) => row.id);

      let settled = 0;
      for (const id of ids) {
        const status = await settleDocument(id);
        if (status === "ready" || status === "failed") settled += 1;
      }
      return settled;
    },

    async findDocumentByClientRequest(userId, key) {
      const { data, error } = await supabase
        .from("documents")
        .select(`${DOCUMENT_COLUMNS}, client_request_hash`)
        .eq("user_id", userId)
        .eq("client_request_id", key);
      if (error) throw repositoryError("findDocumentByClientRequest", error);
      // The unique index allows many failed rows for a key, but only one other.
      const row = (data ?? []).find((candidate) => (candidate as { status?: string }).status !== "failed");
      if (!row) return null;
      return { document: toDocument(row), hash: z.object({ client_request_hash: z.string() }).parse(row).client_request_hash };
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
