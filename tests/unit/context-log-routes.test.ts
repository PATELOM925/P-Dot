import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AuthContext } from "@/server/auth/session";
import { ACTION_LOG_LIMIT } from "@/lib/limits";
import { getAuthContext } from "@/server/auth/session";
import { RepositoryError } from "@/server/db/conversations";
import { MAX_CONTEXT_IDS, createContextRecordRepository, limitIds } from "@/server/db/context-records";
import * as actionLogRoute from "@/app/api/action-log/route";
import * as contextRoute from "@/app/api/messages/[id]/context/route";

vi.mock("@/server/auth/session", () => ({ getAuthContext: vi.fn() }));

const ALICE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BOB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const MSG_ALICE = uuid(1);
const MSG_BOB = uuid(2);
const MSG_NO_RECORD = uuid(3);
const MEM_A1 = uuid(11);
const MEM_A2 = uuid(12);
const MEM_B1 = uuid(13);
const MEM_GONE = uuid(14);
const DOC_A = uuid(21);
const DOC_B = uuid(22);
const CHUNK_A1 = uuid(31);
const CHUNK_A2 = uuid(32);
const CHUNK_B1 = uuid(33);
const CHUNK_GONE = uuid(34);

type Row = Record<string, unknown>;
interface QueryResult {
  data: unknown;
  error: { message: string } | null;
}

interface FakeDb {
  tables: Record<string, Row[]>;
  /** Every select, so tests can check which columns were requested. */
  selects: { table: string; columns: string }[];
  inserts: { table: string; row: Row }[];
  /** Tables whose queries fail, to test error handling. */
  failing: Set<string>;
}

/**
 * A small stand-in for the Supabase query builder. It applies eq, in, order
 * and limit in memory, and returns only the columns the code asks for.
 */
class FakeQuery {
  private filters: Array<(row: Row) => boolean> = [];
  private sortBy: { column: string; ascending: boolean } | null = null;
  private maxRows: number | null = null;
  private columns: string | null = null;
  private insertRow: Row | null = null;

  constructor(
    private readonly db: FakeDb,
    private readonly table: string,
  ) {}

  select(columns: string): this {
    this.columns = columns;
    this.db.selects.push({ table: this.table, columns });
    return this;
  }

  eq(column: string, value: unknown): this {
    this.filters.push((row) => row[column] === value);
    return this;
  }

  in(column: string, values: unknown[]): this {
    this.filters.push((row) => values.includes(row[column]));
    return this;
  }

  order(column: string, options: { ascending: boolean }): this {
    this.sortBy = { column, ascending: options.ascending };
    return this;
  }

  limit(count: number): this {
    this.maxRows = count;
    return this;
  }

  insert(row: Row): this {
    this.insertRow = row;
    this.db.inserts.push({ table: this.table, row });
    return this;
  }

  maybeSingle(): Promise<QueryResult> {
    return this.run().then((result) => ({
      data: Array.isArray(result.data) ? (result.data[0] ?? null) : result.data,
      error: result.error,
    }));
  }

  then<T1 = QueryResult, T2 = never>(
    onFulfilled?: ((value: QueryResult) => T1 | PromiseLike<T1>) | null,
    onRejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
  ): Promise<T1 | T2> {
    return this.run().then(onFulfilled, onRejected);
  }

  private run(): Promise<QueryResult> {
    if (this.db.failing.has(this.table)) {
      return Promise.resolve({ data: null, error: { message: "fake failure" } });
    }
    if (this.insertRow) return Promise.resolve({ data: null, error: null });

    let rows = (this.db.tables[this.table] ?? []).filter((row) => this.filters.every((keep) => keep(row)));
    if (this.sortBy) {
      const { column, ascending } = this.sortBy;
      const direction = ascending ? 1 : -1;
      rows = [...rows].sort((a, b) => {
        const left = String(a[column]);
        const right = String(b[column]);
        return (left < right ? -1 : left > right ? 1 : 0) * direction;
      });
    }
    if (this.maxRows !== null) rows = rows.slice(0, this.maxRows);
    return Promise.resolve({ data: rows.map((row) => this.project(row)), error: null });
  }

  private project(row: Row): Row {
    if (!this.columns) return { ...row };
    const names = this.columns.split(",").map((name) => name.trim());
    return Object.fromEntries(names.map((name) => [name, row[name]]));
  }
}

function fakeSupabase(tables: Record<string, Row[]>) {
  const db: FakeDb = { tables, selects: [], inserts: [], failing: new Set() };
  const client = { from: (table: string) => new FakeQuery(db, table) } as unknown as SupabaseClient;
  return { client, db };
}

function seedTables(): Record<string, Row[]> {
  return {
    context_records: [
      {
        message_id: MSG_ALICE,
        user_id: ALICE,
        model: "model-a",
        history_message_count: 4,
        history_chars: 900,
        // Order matters: the response must follow this list, not the table order.
        memory_ids: [MEM_A2, MEM_GONE, MEM_A1, MEM_B1],
        document_chunk_ids: [CHUNK_A2, CHUNK_GONE, CHUNK_A1, CHUNK_B1],
        web_source_count: 2,
        prompt_version: "2026-10-19.1",
        input_tokens: 812,
        output_tokens: 140,
        created_at: "2026-10-19T10:00:00.000Z",
      },
      {
        message_id: MSG_BOB,
        user_id: BOB,
        model: "model-b",
        history_message_count: 0,
        history_chars: 0,
        memory_ids: [],
        document_chunk_ids: [],
        web_source_count: 0,
        prompt_version: "2026-10-19.1",
        input_tokens: null,
        output_tokens: null,
        created_at: "2026-10-19T11:00:00.000Z",
      },
    ],
    memories: [
      { id: MEM_A1, user_id: ALICE, content: "Prefers metric units", embedding: [0.1] },
      { id: MEM_A2, user_id: ALICE, content: "Likes short answers", embedding: [0.2] },
      { id: MEM_B1, user_id: BOB, content: "Bob private memory", embedding: [0.3] },
    ],
    documents: [
      { id: DOC_A, user_id: ALICE, title: "Shop plan" },
      { id: DOC_B, user_id: BOB, title: "Bob private document" },
    ],
    document_chunks: [
      { id: CHUNK_A1, user_id: ALICE, document_id: DOC_A, content: "text one", embedding: [0.4] },
      { id: CHUNK_A2, user_id: ALICE, document_id: DOC_A, content: "text two", embedding: [0.5] },
      { id: CHUNK_B1, user_id: BOB, document_id: DOC_B, content: "bob text", embedding: [0.6] },
    ],
    action_log: [
      {
        id: uuid(41),
        user_id: ALICE,
        proposal_id: null,
        event: "memory_added",
        detail: { memory_count: 1 },
        created_at: "2026-10-18T09:00:00.000Z",
        payload: "text that must never be returned",
      },
      {
        id: uuid(42),
        user_id: ALICE,
        proposal_id: uuid(51),
        event: "approved",
        detail: {},
        created_at: "2026-10-19T09:00:00.000Z",
      },
      {
        id: uuid(43),
        user_id: ALICE,
        proposal_id: null,
        event: "reminder_added",
        detail: { count: 2 },
        created_at: "2026-10-17T09:00:00.000Z",
      },
      {
        id: uuid(44),
        user_id: BOB,
        proposal_id: null,
        event: "reminder_added",
        detail: {},
        created_at: "2026-10-20T09:00:00.000Z",
      },
    ],
  };
}

function signInAs(userId: string | null, supabase: SupabaseClient) {
  vi.mocked(getAuthContext).mockResolvedValue(
    userId ? ({ userId, email: `${userId}@example.com`, supabase } satisfies AuthContext) : null,
  );
}

function plainRequest(url: string) {
  return new Request(url, { method: "GET", headers: { host: "localhost", origin: "http://localhost" } });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

let fake: ReturnType<typeof fakeSupabase>;

beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  fake = fakeSupabase(seedTables());
});

describe("auth on the new GET routes", () => {
  it("returns 401 without a session", async () => {
    signInAs(null, fake.client);
    expect((await contextRoute.GET(plainRequest("http://localhost/api/messages/x/context"), params(MSG_ALICE))).status).toBe(401);
    expect((await actionLogRoute.GET(plainRequest("http://localhost/api/action-log"))).status).toBe(401);
  });
});

describe("GET /api/messages/:id/context", () => {
  it.each([
    ["a malformed ID", ALICE, "not-a-uuid"],
    ["another user's message", BOB, MSG_ALICE],
    ["a message without a record", ALICE, MSG_NO_RECORD],
  ])("returns the same 404 for %s", async (_label, userId, messageId) => {
    signInAs(userId, fake.client);
    const response = await contextRoute.GET(plainRequest(`http://localhost/api/messages/${messageId}/context`), params(messageId));
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: { code: "not_found", message: "No context record for this message." },
    });
  });

  it("keeps the order of the stored IDs and marks deleted or foreign items with nulls", async () => {
    signInAs(ALICE, fake.client);
    const response = await contextRoute.GET(plainRequest(`http://localhost/api/messages/${MSG_ALICE}/context`), params(MSG_ALICE));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      messageId: MSG_ALICE,
      model: "model-a",
      historyMessageCount: 4,
      historyChars: 900,
      memories: [
        { id: MEM_A2, content: "Likes short answers" },
        { id: MEM_GONE, content: null },
        { id: MEM_A1, content: "Prefers metric units" },
        { id: MEM_B1, content: null },
      ],
      documentChunks: [
        { id: CHUNK_A2, documentId: DOC_A, title: "Shop plan" },
        { id: CHUNK_GONE, documentId: null, title: null },
        { id: CHUNK_A1, documentId: DOC_A, title: "Shop plan" },
        { id: CHUNK_B1, documentId: null, title: null },
      ],
      webSourceCount: 2,
      promptVersion: "2026-10-19.1",
      inputTokens: 812,
      outputTokens: 140,
      createdAt: "2026-10-19T10:00:00.000Z",
    });
  });

  it("never selects embeddings and skips item queries when a record has no items", async () => {
    signInAs(BOB, fake.client);
    const response = await contextRoute.GET(plainRequest(`http://localhost/api/messages/${MSG_BOB}/context`), params(MSG_BOB));
    expect(await response.json()).toMatchObject({ memories: [], documentChunks: [], inputTokens: null });

    expect(fake.db.selects.length).toBeGreaterThan(0);
    for (const select of fake.db.selects) expect(select.columns).not.toContain("embedding");
    expect(fake.db.selects.map((s) => s.table)).toEqual(["context_records"]);
  });

  it("returns 500 without database details when the read fails", async () => {
    fake.db.failing.add("context_records");
    signInAs(ALICE, fake.client);
    const response = await contextRoute.GET(plainRequest(`http://localhost/api/messages/${MSG_ALICE}/context`), params(MSG_ALICE));
    expect(response.status).toBe(500);
    const text = JSON.stringify(await response.json());
    expect(text).toContain("internal_error");
    expect(text).not.toContain("fake failure");
    expect(text).not.toContain("context_records");
  });
});

describe("limitIds", () => {
  it("removes repeated IDs and keeps the first-seen order", () => {
    expect(limitIds(["b", "a", "b", "c", "a"])).toEqual(["b", "a", "c"]);
  });

  it("caps the list at 50 by default and keeps the first 50", () => {
    const ids = Array.from({ length: 60 }, (_, i) => uuid(100 + i));
    expect(MAX_CONTEXT_IDS).toBe(50);
    expect(limitIds(ids)).toEqual(ids.slice(0, 50));
  });

  it("uses a custom cap when one is given", () => {
    expect(limitIds(["a", "b", "c"], 2)).toEqual(["a", "b"]);
  });
});

describe("createContextRecordRepository.insertContextRecord", () => {
  const ids = Array.from({ length: 60 }, (_, i) => uuid(100 + i));

  it("writes snake_case columns for the signed-in user, with IDs de-duplicated and capped", async () => {
    await createContextRecordRepository(fake.client).insertContextRecord(ALICE, {
      messageId: MSG_NO_RECORD,
      model: "model-a",
      historyMessageCount: 2,
      historyChars: 50,
      memoryIds: [...ids, ids[0]!, ids[1]!],
      documentChunkIds: [CHUNK_A1, CHUNK_A1],
      webSourceCount: 0,
      promptVersion: "2026-10-19.1",
      inputTokens: null,
      outputTokens: 7,
    });

    expect(fake.db.inserts).toHaveLength(1);
    const inserted = fake.db.inserts[0]!;
    expect(inserted.table).toBe("context_records");
    expect(inserted.row).toEqual({
      user_id: ALICE,
      message_id: MSG_NO_RECORD,
      model: "model-a",
      history_message_count: 2,
      history_chars: 50,
      memory_ids: ids.slice(0, 50),
      document_chunk_ids: [CHUNK_A1],
      web_source_count: 0,
      prompt_version: "2026-10-19.1",
      input_tokens: null,
      output_tokens: 7,
    });
  });

  it("throws a repository error with no database details when the insert fails", async () => {
    fake.db.failing.add("context_records");
    await expect(
      createContextRecordRepository(fake.client).insertContextRecord(ALICE, {
        messageId: MSG_NO_RECORD,
        model: "model-a",
        historyMessageCount: 0,
        historyChars: 0,
        memoryIds: [],
        documentChunkIds: [],
        webSourceCount: 0,
        promptVersion: "v1",
        inputTokens: null,
        outputTokens: null,
      }),
    ).rejects.toThrow(new RepositoryError("insertContextRecord"));
  });
});

describe("GET /api/action-log", () => {
  it("returns the user's entries newest first, with only the allowed fields", async () => {
    signInAs(ALICE, fake.client);
    const response = await actionLogRoute.GET(plainRequest("http://localhost/api/action-log"));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { entries: Record<string, unknown>[] };

    expect(body.entries.map((entry) => entry.id)).toEqual([uuid(42), uuid(41), uuid(43)]);
    expect(body.entries[0]).toEqual({
      id: uuid(42),
      proposalId: uuid(51),
      event: "approved",
      detail: {},
      createdAt: "2026-10-19T09:00:00.000Z",
      verified: false,
    });
    for (const entry of body.entries) {
      expect(Object.keys(entry).sort()).toEqual(["createdAt", "detail", "event", "id", "proposalId", "verified"]);
    }
    expect(JSON.stringify(body)).not.toContain("must never be returned");
  });

  it("returns at most ACTION_LOG_LIMIT entries and selects only the allowed columns", async () => {
    const extra = Array.from({ length: ACTION_LOG_LIMIT + 5 }, (_, i) => ({
      id: uuid(1000 + i),
      user_id: ALICE,
      proposal_id: null,
      event: "reminder_added",
      detail: {},
      created_at: `2026-09-${String((i % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
    }));
    fake.db.tables.action_log!.push(...extra);

    signInAs(ALICE, fake.client);
    const body = (await (await actionLogRoute.GET(plainRequest("http://localhost/api/action-log"))).json()) as {
      entries: unknown[];
    };
    expect(body.entries).toHaveLength(ACTION_LOG_LIMIT);
    expect(fake.db.selects.find((s) => s.table === "action_log")?.columns).toBe(
      "id, proposal_id, event, detail, created_at, verified",
    );
  });

  it("skips a row that does not parse and logs its ID only, so one bad row cannot break the page", async () => {
    fake.db.tables.action_log!.push(
      {
        id: uuid(61),
        user_id: ALICE,
        proposal_id: null,
        event: "executed",
        detail: { taskId: { nested: "private words" } },
        created_at: "2026-10-20T09:00:00.000Z",
      },
      {
        id: uuid(62),
        user_id: ALICE,
        proposal_id: null,
        event: "made_up_event",
        detail: {},
        created_at: "2026-10-20T08:00:00.000Z",
      },
      { id: uuid(63), user_id: ALICE, proposal_id: null, event: "approved", detail: null, created_at: null },
    );
    const warn = vi.mocked(console.warn);

    signInAs(ALICE, fake.client);
    const response = await actionLogRoute.GET(plainRequest("http://localhost/api/action-log"));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { entries: { id: string }[] };
    expect(body.entries.map((entry) => entry.id)).toEqual([uuid(42), uuid(41), uuid(43)]);

    const lines = warn.mock.calls.map((call) => String(call[0]));
    const skipped = lines.filter((line) => line.includes('"event":"action_log_row_skipped"'));
    expect(skipped).toHaveLength(3);
    for (const id of [uuid(61), uuid(62), uuid(63)]) expect(skipped.some((line) => line.includes(id))).toBe(true);
    expect(lines.join("\n")).not.toContain("private words");
  });

  it("reads the row shapes that the database triggers write", async () => {
    // One row of each event, copied from a run of the migration in a throwaway database.
    const triggerRows = [
      { event: "proposed", proposal_id: uuid(71), detail: { kind: "create_task", mode: "work" } },
      { event: "approved", proposal_id: uuid(71), detail: { kind: "create_task", mode: "personal", edited: false } },
      { event: "rejected", proposal_id: uuid(71), detail: { kind: "create_task", mode: "personal" } },
      { event: "executed", proposal_id: uuid(71), detail: { kind: "save_memory", mode: "personal", memoryId: uuid(72) } },
      {
        event: "failed",
        proposal_id: uuid(71),
        detail: { code: "23514", kind: "create_task", mode: "personal", error: "execution_failed" },
      },
      { event: "memory_added", proposal_id: null, detail: { mode: "personal", source: "assistant", status: "active", memoryId: uuid(72) } },
      {
        event: "memory_edited",
        proposal_id: null,
        detail: {
          mode: "personal",
          source: "user",
          status: "active",
          memoryId: uuid(72),
          modeChanged: false,
          statusChanged: false,
          contentChanged: true,
        },
      },
      { event: "memory_deleted", proposal_id: null, detail: { mode: "personal", source: "user", memoryId: uuid(72) } },
      { event: "document_added", proposal_id: null, detail: { mode: "work", status: "processing", documentId: uuid(73) } },
      { event: "document_ready", proposal_id: null, detail: { mode: "work", chunkCount: 2, documentId: uuid(73) } },
      { event: "document_failed", proposal_id: null, detail: { mode: "work", documentId: uuid(73) } },
      { event: "document_deleted", proposal_id: null, detail: { mode: "work", documentId: uuid(73) } },
      {
        event: "reminder_added",
        proposal_id: uuid(71),
        detail: { mode: "personal", status: "scheduled", reminderId: uuid(74), fromProposal: true },
      },
      {
        event: "reminder_changed",
        proposal_id: null,
        detail: {
          mode: "personal",
          status: "done",
          dueChanged: false,
          reminderId: uuid(74),
          modeChanged: false,
          titleChanged: true,
          statusChanged: true,
        },
      },
      { event: "reminder_deleted", proposal_id: null, detail: { mode: "personal", reminderId: uuid(74) } },
    ].map((row, i) => ({ id: uuid(2000 + i), user_id: ALICE, created_at: "2026-10-20T16:56:39.302+00:00", ...row }));
    fake.db.tables.action_log = triggerRows;
    const warn = vi.mocked(console.warn);

    signInAs(ALICE, fake.client);
    const body = (await (await actionLogRoute.GET(plainRequest("http://localhost/api/action-log"))).json()) as {
      entries: { event: string }[];
    };
    expect(body.entries.map((entry) => entry.event).sort()).toEqual(triggerRows.map((row) => row.event).sort());
    expect(warn.mock.calls.some((call) => String(call[0]).includes("action_log_row_skipped"))).toBe(false);
  });
});
