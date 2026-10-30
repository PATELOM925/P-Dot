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
type Result = { data?: unknown; error?: unknown; count?: number | null };

/**
 * Pass one result for every call, or a list with one result per `from()` call
 * in order. `rpcResults` answers `rpc()` calls in order.
 */
function fakeSupabase(results: Result | Result[] = {}, rpcResults: Result[] = []) {
  const calls: Call[] = [];
  const rpcs: { name: string; args: unknown }[] = [];
  const supabase = {
    rpc(name: string, args: unknown) {
      rpcs.push({ name, args });
      return Promise.resolve(rpcResults[rpcs.length - 1] ?? { data: null, error: null });
    },
    from(table: string) {
      const call: Call = { table, op: "select", filters: [] };
      const result = Array.isArray(results) ? (results[calls.length] ?? {}) : results;
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
        lt(column: string, value: unknown) {
          call.filters.push([`${column} <`, value]);
          return builder;
        },
        is(column: string, value: unknown) {
          call.filters.push([`${column} is`, value]);
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
  return { supabase: supabase as unknown as SupabaseClient, calls, rpcs };
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

  it("settles one document with settle_document and answers the status after it", async () => {
    const { supabase, calls, rpcs } = fakeSupabase({}, [
      { data: "ready", error: null },
      { data: null, error: null },
    ]);
    const repository = createDocumentRepository(supabase);
    expect(await repository.settleDocument(DOC)).toBe("ready");
    expect(await repository.settleDocument(DOC)).toBeNull();
    expect(rpcs).toEqual([
      { name: "settle_document", args: { p_document_id: DOC } },
      { name: "settle_document", args: { p_document_id: DOC } },
    ]);
    expect(calls).toHaveLength(0);
  });

  it("refuses an answer of settle_document that is not a status", async () => {
    const { supabase } = fakeSupabase({}, [{ data: "done", error: null }]);
    await expect(createDocumentRepository(supabase).settleDocument(DOC)).rejects.toThrow(
      "Database operation failed: settleDocument",
    );
  });

  it("names a missing function or column as a schema error", async () => {
    const { supabase } = fakeSupabase({}, [{ data: null, error: { code: "PGRST202", message: "Could not find the function" } }]);
    const error = await createDocumentRepository(supabase)
      .settleDocument(DOC)
      .catch((e: unknown) => e);
    expect((error as Error).name).toBe("SchemaMissingError");
  });

  it("stores the request key and fingerprint with a new document", async () => {
    const { supabase, calls } = fakeSupabase({ data: { ...row, status: "processing" }, error: null });
    await createDocumentRepository(supabase).createDocument(ALICE, {
      mode: "work",
      title: "Handbook",
      mediaType: "text/markdown",
      charCount: 1200,
      clientRequest: { id: DOC, hash: "a".repeat(64) },
    });
    expect(calls[0]).toMatchObject({
      table: "documents",
      op: "insert",
      payload: { user_id: ALICE, status: "processing", client_request_id: DOC, client_request_hash: "a".repeat(64) },
    });
  });

  it("finds the document with a key that is not failed, for the given user", async () => {
    const failed = { ...row, id: "f", status: "failed", client_request_hash: "b".repeat(64) };
    const current = { ...row, status: "processing", client_request_hash: "a".repeat(64) };
    const { supabase, calls } = fakeSupabase({ data: [failed, current], error: null });
    const found = await createDocumentRepository(supabase).findDocumentByClientRequest(ALICE, DOC);
    expect(found).toMatchObject({ document: { id: DOC, status: "processing" }, hash: "a".repeat(64) });
    expect(calls[0]!.filters).toEqual([
      ["user_id", ALICE],
      ["client_request_id", DOC],
    ]);

    const onlyFailed = fakeSupabase({ data: [failed], error: null });
    expect(await createDocumentRepository(onlyFailed.supabase).findDocumentByClientRequest(ALICE, DOC)).toBeNull();
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

  describe("settleStaleDocuments", () => {
    const BEFORE = new Date("2026-10-20T10:00:00.000Z");
    const DOC2 = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

    it("finds only the user's old processing documents, with a limit", async () => {
      const { supabase, calls } = fakeSupabase([{ data: [], error: null }]);
      expect(await createDocumentRepository(supabase).settleStaleDocuments(ALICE, BEFORE, 5)).toBe(0);

      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ table: "documents", op: "select", columns: "id", limit: 5 });
      expect(calls[0]!.filters).toEqual([
        ["user_id", ALICE],
        ["status", "processing"],
        ["created_at <", BEFORE.toISOString()],
      ]);
    });

    it("settles each stale document with settle_document and counts the ones it settled", async () => {
      const { supabase, rpcs } = fakeSupabase([{ data: [{ id: DOC }, { id: DOC2 }], error: null }], [
        { data: "ready", error: null },
        // A parallel request settled this one first: it is no longer processing.
        { data: null, error: null },
      ]);
      expect(await createDocumentRepository(supabase).settleStaleDocuments(ALICE, BEFORE, 5)).toBe(1);
      expect(rpcs.map((call) => call.args)).toEqual([{ p_document_id: DOC }, { p_document_id: DOC2 }]);
    });

    it("stops at a failed settle and throws a repository error", async () => {
      const { supabase, rpcs } = fakeSupabase([{ data: [{ id: DOC }, { id: DOC2 }], error: null }], [
        { data: null, error: { message: "connection lost" } },
      ]);
      await expect(createDocumentRepository(supabase).settleStaleDocuments(ALICE, BEFORE, 5)).rejects.toThrow(
        "Database operation failed: settleDocument",
      );
      expect(rpcs).toHaveLength(1);
    });
  });
});
