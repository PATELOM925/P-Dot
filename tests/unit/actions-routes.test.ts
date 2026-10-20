import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AuthContext } from "@/server/auth/session";
import type { Embedder } from "@/server/assistant/embed";
import { createActionProposalRepository } from "@/server/db/action-proposals";
import { executeAction } from "@/server/actions/execute";
import type { ActionPayload } from "@/types/api";
import { ProviderError } from "@/server/providers/errors";
import { EMBEDDING_MODEL } from "@/server/providers/nebius/embeddings";
import { TEST_SPEND_CAPS, testRouting } from "../support/fakes";

vi.mock("@/server/auth/session", () => ({ getAuthContext: vi.fn() }));
vi.mock("@/server/config", () => ({ getAssistantConfig: vi.fn(), getSiteUrl: () => "http://localhost:3000" }));
vi.mock("@/server/assistant/deps", () => ({ createEmbedderForRequest: vi.fn() }));

const { getAuthContext } = await import("@/server/auth/session");
const { getAssistantConfig } = await import("@/server/config");
const { createEmbedderForRequest } = await import("@/server/assistant/deps");
const listRoute = await import("@/app/api/actions/route");
const decisionRoute = await import("@/app/api/actions/[id]/decision/route");

const ALICE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BOB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const MISSING_ID = "99999999-9999-4999-8999-999999999999";
const DUE = "2026-10-30T17:00:00Z";
const VECTOR = [0.1, 0.2, 0.3];
/** Distinct text, so a test can find it if it ever reaches a log. */
const SECRET_TITLE = "Pay the Acme invoice";
const SECRET_MEMORY = "Lives in Leeds with a dog";

// ---------------------------------------------------------------------------
// A small in-memory stand-in for the Supabase query builder. It runs the real
// repositories and applies `eq`, `order`, `limit`, `select` (only the listed
// columns, like PostgREST), `single` and `maybeSingle`. Tests can make inserts
// fail for one table, and can run code just before an update (to simulate a
// second request that wins a race).
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

class FakeDb {
  tables: Record<string, Row[]> = {
    action_proposals: [],
    action_log: [],
    tasks: [],
    reminders: [],
    memories: [],
  };
  /** When set, every insert into this table returns an error. */
  failInsertInto: string | null = null;
  /** Runs once, just before the next update on any table. */
  beforeNextUpdate: (() => void) | null = null;
  private seq = 0;

  nextTimestamp(): string {
    this.seq += 1;
    return new Date(Date.UTC(2026, 9, 19) + this.seq * 1000).toISOString();
  }

  from(table: string): FakeQuery {
    return new FakeQuery(this, table);
  }
}

interface FakeResult {
  data: unknown;
  error: { message: string } | null;
  count?: number;
}

class FakeQuery implements PromiseLike<FakeResult> {
  private filters: { column: string; value: unknown }[] = [];
  private op: "select" | "insert" | "update" = "select";
  private payload: Row = {};
  private columns: string | null = null;
  private ordering: { column: string; ascending: boolean } | null = null;
  private max = Number.POSITIVE_INFINITY;
  private shape: "many" | "single" | "maybe" = "many";

  constructor(
    private readonly db: FakeDb,
    private readonly table: string,
  ) {}

  select(columns: string): this {
    this.columns = columns;
    return this;
  }
  insert(row: Row): this {
    this.op = "insert";
    this.payload = row;
    return this;
  }
  update(changes: Row): this {
    this.op = "update";
    this.payload = changes;
    return this;
  }
  eq(column: string, value: unknown): this {
    this.filters.push({ column, value });
    return this;
  }
  order(column: string, options?: { ascending?: boolean }): this {
    this.ordering = { column, ascending: options?.ascending !== false };
    return this;
  }
  limit(count: number): this {
    this.max = count;
    return this;
  }
  single(): this {
    this.shape = "single";
    return this;
  }
  maybeSingle(): this {
    this.shape = "maybe";
    return this;
  }

  then<T1 = FakeResult, T2 = never>(
    onFulfilled?: ((value: FakeResult) => T1 | PromiseLike<T1>) | null,
    onRejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
  ): Promise<T1 | T2> {
    return Promise.resolve(this.execute()).then(onFulfilled, onRejected);
  }

  private project(row: Row): Row {
    const columns = (this.columns ?? "").split(",").map((c) => c.trim()).filter(Boolean);
    return Object.fromEntries(columns.map((c) => [c, row[c]]));
  }

  private execute(): FakeResult {
    if (this.op === "insert" && this.db.failInsertInto === this.table) {
      return { data: null, error: { message: "simulated insert failure" } };
    }
    if (this.op === "update" && this.db.beforeNextUpdate) {
      const hook = this.db.beforeNextUpdate;
      this.db.beforeNextUpdate = null;
      hook();
    }

    const rows = this.db.tables[this.table] ?? [];

    if (this.op === "insert") {
      const row: Row = {
        id: randomUUID(),
        created_at: this.db.nextTimestamp(),
        updated_at: this.db.nextTimestamp(),
        decided_at: null,
        result: null,
        conversation_id: null,
        source_message_id: null,
        proposal_id: null,
        status: "scheduled",
        done: false,
        embedding: null,
        embedding_model: null,
        ...this.payload,
      };
      rows.push(row);
      return { data: this.columns ? this.shapeOne([this.project(row)]) : null, error: null };
    }

    const matches = rows.filter((row) => this.filters.every((f) => row[f.column] === f.value));

    if (this.op === "update") {
      for (const row of matches) Object.assign(row, this.payload);
      return { data: this.columns ? this.shapeOne(matches.map((r) => this.project(r))) : null, error: null };
    }

    let found = [...matches];
    if (this.ordering) {
      const { column, ascending } = this.ordering;
      found.sort((a, b) => (String(a[column]) < String(b[column]) ? -1 : 1) * (ascending ? 1 : -1));
    }
    found = found.slice(0, this.max);
    return { data: this.shapeOne(found.map((r) => this.project(r))), error: null };
  }

  /** Applies single() and maybeSingle(): one row or null. Otherwise the array. */
  private shapeOne(rows: Row[]): unknown {
    if (this.shape === "many") return rows;
    return rows[0] ?? null;
  }
}

// ---------------------------------------------------------------------------
// Test setup and helpers.
// ---------------------------------------------------------------------------

let db: FakeDb;
let embed: ReturnType<typeof vi.fn<(texts: string[], signal?: AbortSignal) => Promise<number[][]>>>;
let consoleLines: string[];

function signInAs(userId: string | null) {
  vi.mocked(getAuthContext).mockResolvedValue(
    userId ? ({ userId, email: `${userId}@example.com`, supabase: db as unknown as SupabaseClient } satisfies AuthContext) : null,
  );
}

function jsonRequest(url: string, method: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(url, {
    method,
    headers: { host: "localhost", origin: "http://localhost", "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function plainRequest(url: string, method = "GET", headers: Record<string, string> = {}) {
  return new Request(url, { method, headers: { host: "localhost", origin: "http://localhost", ...headers } });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

const decide = (id: string, body: unknown, headers: Record<string, string> = {}) =>
  decisionRoute.POST(jsonRequest(`http://localhost/api/actions/${id}/decision`, "POST", body, headers), params(id));

const taskPayload = (title = "Pay the invoice") => ({ kind: "create_task" as const, mode: "personal" as const, title });
const reminderPayload = () => ({ kind: "create_reminder" as const, mode: "work" as const, title: "Call the supplier", dueAt: DUE });
const memoryPayload = (content = "Prefers short replies") => ({ kind: "save_memory" as const, mode: "personal" as const, content });

function seedProposal(userId: string, payload: Row, overrides: Partial<Row> = {}): Row {
  const row: Row = {
    id: randomUUID(),
    user_id: userId,
    conversation_id: null,
    kind: payload.kind,
    payload,
    summary: "Add a task",
    status: "proposed",
    result: null,
    created_at: db.nextTimestamp(),
    decided_at: null,
    ...overrides,
  };
  db.tables.action_proposals!.push(row);
  return row;
}

function storedProposal(id: string): Row | undefined {
  return db.tables.action_proposals!.find((r) => r.id === id);
}

function rowsOf(table: string, userId?: string): Row[] {
  return (db.tables[table] ?? []).filter((r) => userId === undefined || r.user_id === userId);
}

function logEvents(): Row[] {
  return db.tables.action_log ?? [];
}

beforeEach(() => {
  db = new FakeDb();
  consoleLines = [];
  for (const level of ["info", "warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation((line: unknown) => {
      consoleLines.push(String(line));
    });
  }
  embed = vi.fn(async (texts: string[]) => texts.map(() => VECTOR));
  vi.mocked(createEmbedderForRequest).mockReturnValue({ embed } as Embedder);
  vi.mocked(getAssistantConfig).mockReturnValue({
    nebius: { apiKey: "k", baseUrl: "https://nebius.test/v1" },
    routing: testRouting(),
    tavily: null,
    quota: { requestsPerWindow: 30, windowSeconds: 3600 },
    spend: TEST_SPEND_CAPS,
  });
});

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

describe("sessions and origins", () => {
  it("requires a session on both routes and runs nothing", async () => {
    signInAs(null);
    const row = seedProposal(ALICE, taskPayload());
    const id = row.id as string;

    expect((await listRoute.GET(plainRequest("http://localhost/api/actions"))).status).toBe(401);
    expect((await decide(id, { decision: "approve" })).status).toBe(401);
    expect(storedProposal(id)?.status).toBe("proposed");
    expect(rowsOf("tasks")).toHaveLength(0);
  });

  it("rejects a cross-origin decision and changes nothing", async () => {
    signInAs(ALICE);
    const row = seedProposal(ALICE, taskPayload());
    const response = await decide(row.id as string, { decision: "approve" }, { origin: "https://evil.example" });
    expect(response.status).toBe(403);
    expect(storedProposal(row.id as string)?.status).toBe("proposed");
    expect(rowsOf("tasks")).toHaveLength(0);
  });
});

describe("GET /api/actions", () => {
  it("lists the user's proposals newest first, filters by status, and leaves out a row with a bad payload", async () => {
    signInAs(ALICE);
    const older = seedProposal(ALICE, taskPayload("older"), { summary: "older" });
    const newer = seedProposal(ALICE, reminderPayload(), { summary: "newer", status: "approved" });
    seedProposal(ALICE, { kind: "create_task", mode: "hobby", title: "bad mode" }, { summary: "bad" });
    seedProposal(BOB, taskPayload("bob's"), { summary: "bob" });

    const all = await (await listRoute.GET(plainRequest("http://localhost/api/actions"))).json();
    expect(all.actions.map((a: { id: string }) => a.id)).toEqual([newer.id, older.id]);
    expect(all.actions[0]).toMatchObject({
      id: newer.id,
      status: "approved",
      summary: "newer",
      payload: { kind: "create_reminder", mode: "work", title: "Call the supplier", dueAt: DUE },
    });

    const proposed = await (await listRoute.GET(plainRequest("http://localhost/api/actions?status=proposed"))).json();
    expect(proposed.actions.map((a: { id: string }) => a.id)).toEqual([older.id]);
  });

  it.each([
    ["an unknown status", "http://localhost/api/actions?status=archived"],
    ["an empty status", "http://localhost/api/actions?status="],
    ["a status in the wrong case", "http://localhost/api/actions?status=Proposed"],
  ])("answers 400 for %s", async (_label, url) => {
    signInAs(ALICE);
    expect((await listRoute.GET(plainRequest(url))).status).toBe(400);
  });
});

describe("POST /api/actions/:id/decision: request checks", () => {
  it.each([
    ["an unknown decision", { decision: "maybe" }],
    ["a missing decision", {}],
    ["an unknown field", { decision: "approve", userId: BOB }],
    ["a reject that carries a payload", { decision: "reject", payload: taskPayload("Changed") }],
    ["an edit that changes the kind", { decision: "approve", payload: reminderPayload() }],
    ["an edit with a blank title", { decision: "approve", payload: taskPayload("   ") }],
    ["an edit with an unknown mode", { decision: "approve", payload: { ...taskPayload(), mode: "hobby" } }],
  ])("answers 400 for %s and runs nothing", async (_label, body) => {
    signInAs(ALICE);
    const row = seedProposal(ALICE, taskPayload());
    const response = await decide(row.id as string, body);
    expect(response.status).toBe(400);
    expect(storedProposal(row.id as string)?.status).toBe("proposed");
    expect(rowsOf("tasks")).toHaveLength(0);
  });

  it("answers 400 when the edit changes the kind, using the stored kind in the message", async () => {
    signInAs(ALICE);
    const row = seedProposal(ALICE, taskPayload());
    const body = await (await decide(row.id as string, { decision: "approve", payload: reminderPayload() })).json();
    expect(body.error.code).toBe("invalid_request");
    expect(body.error.message).toBe("An edited action must keep the same kind.");
  });

  it("answers 415 for a body that is not JSON", async () => {
    signInAs(ALICE);
    const row = seedProposal(ALICE, taskPayload());
    const request = new Request(`http://localhost/api/actions/${row.id}/decision`, {
      method: "POST",
      headers: { host: "localhost", origin: "http://localhost", "content-type": "text/plain" },
      body: "decision=approve",
    });
    expect((await decisionRoute.POST(request, params(row.id as string))).status).toBe(415);
    expect(storedProposal(row.id as string)?.status).toBe("proposed");
  });

  it("answers 404 for an id that is not a UUID", async () => {
    signInAs(ALICE);
    expect((await decide("not-an-id", { decision: "approve" })).status).toBe(404);
  });
});

describe("POST /api/actions/:id/decision: ownership and stored payloads", () => {
  it("answers 404 for another user's proposal and runs nothing", async () => {
    signInAs(ALICE);
    const row = seedProposal(BOB, taskPayload("Bob's task"));
    const response = await decide(row.id as string, { decision: "approve" });
    expect(response.status).toBe(404);
    expect((await response.json()).error.message).toBe("Action not found.");
    expect(storedProposal(row.id as string)?.status).toBe("proposed");
    expect(rowsOf("tasks")).toHaveLength(0);
  });

  it("answers 404 for a stored payload that does not parse, and never runs it", async () => {
    signInAs(ALICE);
    const row = seedProposal(ALICE, { kind: "create_task", mode: "personal", title: "" });
    const response = await decide(row.id as string, { decision: "approve" });
    expect(response.status).toBe(404);
    expect(storedProposal(row.id as string)?.status).toBe("proposed");
    expect(rowsOf("tasks")).toHaveLength(0);
  });

  it("answers 404 for an unknown proposal", async () => {
    signInAs(ALICE);
    expect((await decide(MISSING_ID, { decision: "reject" })).status).toBe(404);
  });
});

describe("POST /api/actions/:id/decision: approve", () => {
  it("creates a task once and returns the executed proposal with the task ID", async () => {
    signInAs(ALICE);
    const row = seedProposal(ALICE, taskPayload());
    const response = await decide(row.id as string, { decision: "approve" });
    expect(response.status).toBe(200);
    const body = await response.json();
    const task = rowsOf("tasks", ALICE)[0] as Row;

    expect(rowsOf("tasks")).toHaveLength(1);
    expect(task).toMatchObject({ mode: "personal", title: "Pay the invoice", done: false });
    expect(body).toMatchObject({ id: row.id, status: "executed", result: { taskId: task.id }, decidedAt: expect.any(String) });
    expect(storedProposal(row.id as string)).toMatchObject({ status: "executed", result: { taskId: task.id } });
  });

  it("creates a reminder once, linked to the proposal", async () => {
    signInAs(ALICE);
    const row = seedProposal(ALICE, reminderPayload());
    const response = await decide(row.id as string, { decision: "approve" });
    expect(response.status).toBe(200);
    const reminder = rowsOf("reminders", ALICE)[0] as Row;

    expect(rowsOf("reminders")).toHaveLength(1);
    expect(reminder).toMatchObject({ mode: "work", title: "Call the supplier", due_at: DUE, proposal_id: row.id });
    expect((await response.json()).result).toEqual({ reminderId: reminder.id });
  });

  it("saves a memory as active from the assistant, with its vector", async () => {
    signInAs(ALICE);
    const row = seedProposal(ALICE, memoryPayload());
    const response = await decide(row.id as string, { decision: "approve" });
    expect(response.status).toBe(200);
    const memory = rowsOf("memories", ALICE)[0] as Row;

    expect(rowsOf("memories")).toHaveLength(1);
    expect(memory).toMatchObject({
      mode: "personal",
      content: "Prefers short replies",
      status: "active",
      source: "assistant",
      embedding: "[0.1,0.2,0.3]",
      embedding_model: EMBEDDING_MODEL,
    });
    expect(embed.mock.calls[0]?.[0]).toEqual(["Prefers short replies"]);
    expect((await response.json()).result).toEqual({ memoryId: memory.id });
  });

  it("saves the memory without a vector when the provider fails, and still counts it as executed", async () => {
    signInAs(ALICE);
    embed.mockRejectedValueOnce(new ProviderError("nebius", "unavailable"));
    const row = seedProposal(ALICE, memoryPayload());
    const response = await decide(row.id as string, { decision: "approve" });
    expect(response.status).toBe(200);
    expect(rowsOf("memories")).toHaveLength(1);
    expect(rowsOf("memories")[0]).toMatchObject({ embedding: null, embedding_model: null });
    expect(storedProposal(row.id as string)?.status).toBe("executed");
  });

  it("does not read the embedding settings for a task", async () => {
    signInAs(ALICE);
    const row = seedProposal(ALICE, taskPayload());
    await decide(row.id as string, { decision: "approve" });
    expect(getAssistantConfig).not.toHaveBeenCalled();
    expect(embed).not.toHaveBeenCalled();
  });

  it("uses the edited values when the user changes the payload before approving", async () => {
    signInAs(ALICE);
    const row = seedProposal(ALICE, taskPayload("Pay the invoice"));
    const response = await decide(row.id as string, {
      decision: "approve",
      payload: taskPayload("Pay the invoice today"),
    });
    expect(response.status).toBe(200);
    expect(rowsOf("tasks", ALICE)[0]).toMatchObject({ title: "Pay the invoice today" });
  });

  it("runs an action once, and a second approval gets 409 without running it again", async () => {
    signInAs(ALICE);
    const row = seedProposal(ALICE, taskPayload());
    expect((await decide(row.id as string, { decision: "approve" })).status).toBe(200);

    const second = await decide(row.id as string, { decision: "approve" });
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ error: { code: "conflict", message: "This action was already decided." } });
    expect(rowsOf("tasks")).toHaveLength(1);
  });

  it("runs nothing when the conditional update finds the proposal already decided", async () => {
    signInAs(ALICE);
    const row = seedProposal(ALICE, taskPayload());
    // Another request decides the proposal after this one has read it.
    db.beforeNextUpdate = () => {
      row.status = "rejected";
    };
    const response = await decide(row.id as string, { decision: "approve" });
    expect(response.status).toBe(409);
    expect(storedProposal(row.id as string)?.status).toBe("rejected");
    expect(rowsOf("tasks")).toHaveLength(0);
  });
});

describe("POST /api/actions/:id/decision: reject", () => {
  it("marks the proposal rejected and runs nothing", async () => {
    signInAs(ALICE);
    const row = seedProposal(ALICE, taskPayload());
    const response = await decide(row.id as string, { decision: "reject" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: row.id, status: "rejected", result: null, decidedAt: expect.any(String) });

    expect(rowsOf("tasks")).toHaveLength(0);
    expect(rowsOf("reminders")).toHaveLength(0);
    expect(rowsOf("memories")).toHaveLength(0);
  });

  it("answers 409 for a second decision after a reject, and does not approve it", async () => {
    signInAs(ALICE);
    const row = seedProposal(ALICE, taskPayload());
    await decide(row.id as string, { decision: "reject" });
    const second = await decide(row.id as string, { decision: "approve" });
    expect(second.status).toBe(409);
    expect(storedProposal(row.id as string)?.status).toBe("rejected");
    expect(rowsOf("tasks")).toHaveLength(0);
  });
});

describe("POST /api/actions/:id/decision: failures", () => {
  it("marks the proposal failed and answers 502 when the action cannot run", async () => {
    signInAs(ALICE);
    db.failInsertInto = "tasks";
    const row = seedProposal(ALICE, taskPayload());
    const response = await decide(row.id as string, { decision: "approve" });
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      error: { code: "internal_error", message: "The action could not be completed." },
    });

    expect(storedProposal(row.id as string)).toMatchObject({ status: "failed", result: { error: "execution_failed" } });
    expect(consoleLines.some((l) => l.includes('"event":"action_execution_failed"'))).toBe(true);
  });
});

describe("action log content", () => {
  it("never writes task, reminder or memory text to the log or to the logger", async () => {
    signInAs(ALICE);
    const task = seedProposal(ALICE, taskPayload(SECRET_TITLE));
    const memory = seedProposal(ALICE, memoryPayload(SECRET_MEMORY));
    await decide(task.id as string, { decision: "approve" });
    await decide(memory.id as string, { decision: "approve" });

    const logText = JSON.stringify(logEvents());
    expect(logText).not.toContain(SECRET_TITLE);
    expect(logText).not.toContain(SECRET_MEMORY);
    expect(consoleLines.join("\n")).not.toContain(SECRET_TITLE);
    expect(consoleLines.join("\n")).not.toContain(SECRET_MEMORY);
  });

  it("writes no action-log rows: the database writes them from triggers", async () => {
    signInAs(ALICE);
    const row = seedProposal(ALICE, taskPayload());
    await decide(row.id as string, { decision: "approve" });
    expect(logEvents()).toHaveLength(0);
  });
});

describe("createProposal and finish", () => {
  const repo = () => createActionProposalRepository(db as unknown as SupabaseClient);

  it("stores a valid proposal as proposed", async () => {
    const dto = await repo().createProposal(ALICE, {
      conversationId: null,
      payload: taskPayload(),
      summary: "  Add task: Pay the invoice  ",
    });
    expect(dto).toMatchObject({ status: "proposed", summary: "Add task: Pay the invoice", payload: taskPayload() });
    expect(storedProposal(dto.id)).toMatchObject({ user_id: ALICE, status: "proposed", kind: "create_task" });
  });

  it("throws and stores nothing for an invalid payload or summary", async () => {
    await expect(
      repo().createProposal(ALICE, { conversationId: null, payload: taskPayload("  "), summary: "Add a task" }),
    ).rejects.toThrow();
    await expect(
      repo().createProposal(ALICE, { conversationId: null, payload: taskPayload(), summary: "   " }),
    ).rejects.toThrow();
    expect(db.tables.action_proposals).toHaveLength(0);
  });

  it("finish refuses a proposal that is not approved", async () => {
    const row = seedProposal(ALICE, taskPayload());
    await expect(repo().finish(ALICE, row.id as string, "executed", { taskId: "x" })).rejects.toThrow();
    expect(storedProposal(row.id as string)?.status).toBe("proposed");
  });
});

describe("executeAction", () => {
  it("throws for a kind outside the three approved kinds, and changes nothing", async () => {
    const createTask = vi.fn();
    const createReminder = vi.fn();
    const createMemory = vi.fn();
    const outsideKind = { kind: "send_email", mode: "work", to: "someone@example.com" } as unknown as ActionPayload;

    await expect(
      executeAction(ALICE, randomUUID(), outsideKind, { tasks: { createTask }, reminders: { createReminder }, memories: { createMemory } }),
    ).rejects.toThrow("This kind of action is not supported.");
    expect(createTask).not.toHaveBeenCalled();
    expect(createReminder).not.toHaveBeenCalled();
    expect(createMemory).not.toHaveBeenCalled();
  });
});
