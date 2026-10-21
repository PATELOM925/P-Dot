import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createDocumentRepository } from "@/server/db/documents";
import { EMBEDDING_MODEL } from "@/server/providers/nebius/embeddings";

const ALICE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DOC = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

interface Call {
  table: string;
  op: "select" | "insert" | "update" | "delete";
  columns?: string;
  payload?: unknown;
  filters: [string, unknown][];
  limit?: number;
}

/**
 * A fake Supabase query builder. It records each call and resolves to the
 * given result. Used only to check what the repository asks for.
 */
function fakeSupabase(result: { data?: unknown; error?: unknown; count?: number | null } = {}) {
  const calls: Call[] = [];
  const supabase = {
    from(table: string) {
      const call: Call = { table, op: "select", filters: [] };
      calls.push(call);
      const builder = {
        select(columns: string) {
          call.columns = columns;
          return builder;
        },
        insert(payload: unknown) {
          call.op = "insert";
          call.payload = payload;
          return builder;
        },
        update(payload: unknown) {
          call.op = "update";
          call.payload = payload;
          return builder;
        },
        delete() {
          call.op = "delete";
          return builder;
        },
        eq(column: string, value: unknown) {
          call.filters.push([column, value]);
          return builder;
        },
        order() {
          return builder;
        },
        limit(n: number) {
          call.limit = n;
          return builder;
        },
        single: () => Promise.resolve(result),
        then<T>(resolve: (value: typeof result) => T, reject: (reason: unknown) => T) {
          return Promise.resolve(result).then(resolve, reject);
        },
      };
      return builder;
    },
  };
  return { supabase: supabase as unknown as SupabaseClient, calls };
}

const row = {
  id: DOC,
  mode: "work",
  title: "Handbook",
  media_type: "text/markdown",
  char_count: 1200,
  status: "ready",
  created_at: "2026-10-19T10:00:00.000Z",
  embedding: [0.1, 0.2],
};

describe("document repository", () => {
  it("lists one mode for one user, newest first, without selecting embeddings", async () => {
    const { supabase, calls } = fakeSupabase({ data: [row], error: null });
    const docs = await createDocumentRepository(supabase).listDocuments(ALICE, "work", 100);

    expect(calls[0]).toMatchObject({ table: "documents", op: "select", limit: 100 });
    expect(calls[0]!.columns).not.toContain("embedding");
    expect(calls[0]!.filters).toEqual([
      ["user_id", ALICE],
      ["mode", "work"],
    ]);
    expect(docs).toEqual([
      {
        id: DOC,
        mode: "work",
        title: "Handbook",
        mediaType: "text/markdown",
        charCount: 1200,
        status: "ready",
        createdAt: "2026-10-19T10:00:00.000Z",
      },
    ]);
    expect(JSON.stringify(docs)).not.toContain("embedding");
  });

  it("creates a document as processing for the given user", async () => {
    const { supabase, calls } = fakeSupabase({ data: { ...row, status: "processing" }, error: null });
    const doc = await createDocumentRepository(supabase).createDocument(ALICE, {
      mode: "work",
      title: "Handbook",
      mediaType: "text/markdown",
      charCount: 1200,
    });

    expect(calls[0]).toMatchObject({ op: "insert" });
    expect(calls[0]!.payload).toEqual({
      user_id: ALICE,
      mode: "work",
      title: "Handbook",
      media_type: "text/markdown",
      char_count: 1200,
      status: "processing",
    });
    expect(doc.status).toBe("processing");
  });

  it("stores chunks with the pgvector text and the model name, for the given user", async () => {
    const { supabase, calls } = fakeSupabase({ data: null, error: null });
    await createDocumentRepository(supabase).insertChunks(ALICE, DOC, [
      { index: 0, content: "first", embedding: [0.5, -1] },
      { index: 1, content: "second", embedding: [2, 3] },
    ]);

    expect(calls[0]).toMatchObject({ table: "document_chunks", op: "insert" });
    expect(calls[0]!.payload).toEqual([
      {
        user_id: ALICE,
        document_id: DOC,
        chunk_index: 0,
        content: "first",
        embedding: "[0.5,-1]",
        embedding_model: EMBEDDING_MODEL,
      },
      {
        user_id: ALICE,
        document_id: DOC,
        chunk_index: 1,
        content: "second",
        embedding: "[2,3]",
        embedding_model: EMBEDDING_MODEL,
      },
    ]);
  });

  it("does not call the database for an empty chunk list", async () => {
    const { supabase, calls } = fakeSupabase({ data: null, error: null });
    await createDocumentRepository(supabase).insertChunks(ALICE, DOC, []);
    expect(calls).toHaveLength(0);
  });

  it("changes only the status, and only for the given user", async () => {
    const { supabase, calls } = fakeSupabase({ data: null, error: null });
    await createDocumentRepository(supabase).setStatus(ALICE, DOC, "failed");

    expect(calls[0]).toMatchObject({ table: "documents", op: "update", payload: { status: "failed" } });
    expect(calls[0]!.filters).toEqual([
      ["id", DOC],
      ["user_id", ALICE],
    ]);
  });

  it("deletes only the user's document and reports whether one was removed", async () => {
    const found = fakeSupabase({ data: null, error: null, count: 1 });
    expect(await createDocumentRepository(found.supabase).deleteDocument(ALICE, DOC)).toBe(true);
    expect(found.calls[0]!.filters).toEqual([
      ["id", DOC],
      ["user_id", ALICE],
    ]);

    const missing = fakeSupabase({ data: null, error: null, count: 0 });
    expect(await createDocumentRepository(missing.supabase).deleteDocument(ALICE, DOC)).toBe(false);
  });

  it("throws a repository error without database details", async () => {
    const { supabase } = fakeSupabase({ data: null, error: { message: 'duplicate key "secret text"' } });
    const error = await createDocumentRepository(supabase)
      .listDocuments(ALICE, "work", 10)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Database operation failed: listDocuments");
  });
});
