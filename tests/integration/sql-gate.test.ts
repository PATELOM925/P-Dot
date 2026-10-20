import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createActionLogRepository } from "@/server/db/action-log";
import { createActionProposalRepository } from "@/server/db/action-proposals";
import { sqlGateClient } from "../support/sql-gate-client";
import { anon, defaultGrantsOnNewTable, errorCode, startSqlGate, user, type SqlGate } from "../support/sql-gate";

/**
 * Database gate: applies every migration to an in-memory Postgres with
 * Supabase stand-ins, then checks grants and RLS as the anon and
 * authenticated roles. Runs in plain `npm test`; no hosted database.
 */

/** Every table in schema public. A new table fails the gate until it is listed here. */
const OWNED_TABLES = [
  "action_log",
  "action_proposals",
  "context_records",
  "conversations",
  "document_chunks",
  "documents",
  "memories",
  "messages",
  "reminders",
  "spend_reservations",
  "tasks",
  "usage_windows",
] as const;
const SERVER_ONLY_TABLES = ["spend_counters"] as const;
const ALL_TABLES = [...OWNED_TABLES, ...SERVER_ONLY_TABLES].sort();
const PROTECTED_COLUMNS = ["id", "user_id", "created_at"];
const PERMISSION_DENIED = "42501";

type OwnedTable = (typeof OWNED_TABLES)[number];

const EMBEDDING = `[${[1, ...Array<number>(1023).fill(0)].join(",")}]`;

interface Owned {
  conversationId: string;
  messageId: string;
  documentId: string;
  proposalId: string;
  memoryId: string;
  chunkId: string;
}

/** Seeds one row in every owned table for `userId`, as the migration owner. */
async function seedOwner(gate: SqlGate, userId: string): Promise<Owned> {
  const one = async (sql: string, params: unknown[]) => (await gate.admin<{ id: string }>(sql, params)).rows[0]!.id;
  const conversationId = await one(
    "insert into conversations (user_id, title) values ($1, 'gate') returning id",
    [userId],
  );
  const messageId = await one(
    "insert into messages (conversation_id, user_id, role, content) values ($1, $2, 'assistant', 'gate') returning id",
    [conversationId, userId],
  );
  const documentId = await one(
    `insert into documents (user_id, mode, title, media_type, char_count, status)
     values ($1, 'personal', 'gate', 'text/plain', 4, 'ready') returning id`,
    [userId],
  );
  const chunkId = await one(
    `insert into document_chunks (user_id, document_id, chunk_index, content, embedding)
     values ($1, $2, 0, 'gate', $3) returning id`,
    [userId, documentId, EMBEDDING],
  );
  const memoryId = await one(
    `insert into memories (user_id, mode, content, source, embedding)
     values ($1, 'personal', 'gate', 'user', $2) returning id`,
    [userId, EMBEDDING],
  );
  const proposalId = await one(
    `insert into action_proposals (user_id, conversation_id, kind, payload, summary)
     values ($1, $2, 'create_task', '{"kind":"create_task","mode":"personal","title":"gate"}', 'gate') returning id`,
    [userId, conversationId],
  );
  await gate.admin("insert into action_log (user_id, proposal_id, event) values ($1, $2, 'proposed')", [
    userId,
    proposalId,
  ]);
  await gate.admin(
    "insert into reminders (user_id, mode, title, due_at, proposal_id) values ($1, 'personal', 'gate', now(), $2)",
    [userId, proposalId],
  );
  await gate.admin(
    `insert into context_records (message_id, user_id, model, history_message_count, history_chars, prompt_version)
     values ($1, $2, 'gate', 0, 0, 'v1')`,
    [messageId, userId],
  );
  await gate.admin("insert into tasks (user_id, mode, title) values ($1, 'personal', 'gate')", [userId]);
  await gate.admin("insert into usage_windows (user_id, window_start, request_count) values ($1, now(), 1)", [userId]);
  await gate.admin(
    `insert into spend_reservations (user_id, provider, usage_day, period_kind, period_start, held, charged)
     values ($1, 'tavily', current_date, 'month', current_date, 1, 1)`,
    [userId],
  );
  return { conversationId, messageId, documentId, proposalId, memoryId, chunkId };
}

/** An insert of a row owned by `owner`, for each owned table. References point at the owner's rows. */
function insertFor(table: OwnedTable, owner: string, refs: Owned): [string, unknown[]] {
  switch (table) {
    case "conversations":
      return ["insert into conversations (user_id, title) values ($1, 'x')", [owner]];
    case "messages":
      return [
        "insert into messages (conversation_id, user_id, role, content) values ($2, $1, 'user', 'x')",
        [owner, refs.conversationId],
      ];
    case "usage_windows":
      return ["insert into usage_windows (user_id, window_start) values ($1, now() - interval '1 day')", [owner]];
    case "tasks":
      return ["insert into tasks (user_id, mode, title) values ($1, 'personal', 'x')", [owner]];
    case "spend_reservations":
      return [
        `insert into spend_reservations (user_id, provider, usage_day, period_kind, period_start, held, charged)
         values ($1, 'tavily', current_date, 'month', current_date, 1, 1)`,
        [owner],
      ];
    case "memories":
      return ["insert into memories (user_id, mode, content, source) values ($1, 'personal', 'x', 'user')", [owner]];
    case "documents":
      return [
        "insert into documents (user_id, mode, title, media_type, char_count) values ($1, 'personal', 'x', 'text/plain', 1)",
        [owner],
      ];
    case "document_chunks":
      return [
        "insert into document_chunks (user_id, document_id, chunk_index, content) values ($1, $2, 1, 'x')",
        [owner, refs.documentId],
      ];
    case "action_proposals":
      return [
        `insert into action_proposals (user_id, kind, payload, summary)
         values ($1, 'create_task', '{"kind":"create_task","mode":"personal","title":"x"}', 'x')`,
        [owner],
      ];
    case "action_log":
      return ["insert into action_log (user_id, event) values ($1, 'proposed')", [owner]];
    case "reminders":
      return ["insert into reminders (user_id, mode, title, due_at) values ($1, 'personal', 'x', now())", [owner]];
    case "context_records":
      return [
        `insert into context_records (message_id, user_id, model, history_message_count, history_chars, prompt_version)
         values ($2, $1, 'x', 0, 0, 'v1')`,
        [owner, refs.messageId],
      ];
  }
}

let gate: SqlGate;
let userA: string;
let userB: string;
let rowsA: Owned;
let rowsB: Owned;

async function countOwnedBy(table: string, userId: string): Promise<number> {
  const result = await gate.admin<{ n: number }>(`select count(*)::int as n from ${table} where user_id = $1`, [userId]);
  return result.rows[0]!.n;
}

async function updatableColumns(table: string): Promise<string[]> {
  const result = await gate.admin<{ column_name: string }>(
    `select column_name from information_schema.column_privileges
      where table_schema = 'public' and table_name = $1 and grantee = 'authenticated' and privilege_type = 'UPDATE'
      order by column_name`,
    [table],
  );
  return result.rows.map((row) => row.column_name);
}

beforeAll(async () => {
  gate = await startSqlGate();
  userA = await gate.createUser();
  userB = await gate.createUser();
  rowsA = await seedOwner(gate, userA);
  rowsB = await seedOwner(gate, userB);
});

afterAll(async () => {
  await gate?.close();
});

describe("Supabase stand-in", () => {
  it("gives a new public table the legacy Supabase default grants, so the checks below are not vacuous", async () => {
    const all = ["DELETE", "INSERT", "REFERENCES", "SELECT", "TRIGGER", "TRUNCATE", "UPDATE"];
    expect(await defaultGrantsOnNewTable(gate)).toEqual({ anon: all, authenticated: all, service_role: all });
  });

  it("applies every migration and finds exactly the classified tables", async () => {
    const result = await gate.admin<{ tablename: string }>(
      "select tablename from pg_tables where schemaname = 'public' order by tablename",
    );
    expect(result.rows.map((row) => row.tablename)).toEqual(ALL_TABLES);
  });

  it("has row-level security on every public table and a user_id column on every owned table", async () => {
    const rls = await gate.admin<{ relname: string; relrowsecurity: boolean }>(
      `select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r'`,
    );
    expect(rls.rows.filter((row) => !row.relrowsecurity).map((row) => row.relname)).toEqual([]);
    const withOwner = await gate.admin<{ table_name: string }>(
      `select table_name from information_schema.columns
        where table_schema = 'public' and column_name = 'user_id' order by table_name`,
    );
    expect(withOwner.rows.map((row) => row.table_name)).toEqual([...OWNED_TABLES].sort());
  });
});

describe("anon", () => {
  it.each(ALL_TABLES)("has no privilege on %s and cannot read it", async (table) => {
    const privileges = await gate.admin<{ granted: boolean }>(
      `select has_table_privilege('anon', $1, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
           or has_any_column_privilege('anon', $1, 'SELECT, INSERT, UPDATE') as granted`,
      [`public.${table}`],
    );
    expect(privileges.rows[0]!.granted).toBe(false);
    expect(await errorCode(() => gate.as(anon, `select * from ${table}`))).toBe(PERMISSION_DENIED);
    expect(await errorCode(() => gate.as(anon, `delete from ${table}`))).toBe(PERMISSION_DENIED);
  });

  it("cannot execute any function in schema public", async () => {
    const result = await gate.admin<{ proname: string }>(
      `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'EXECUTE')`,
    );
    expect(result.rows.map((row) => row.proname)).toEqual([]);
    expect(
      await errorCode(() => gate.as(anon, "select * from match_memories($1, 'personal', 5)", [EMBEDDING])),
    ).toBe(PERMISSION_DENIED);
  });
});

describe("one signed-in user against another user's rows", () => {
  it.each(OWNED_TABLES)("user A cannot read user B's rows in %s", async (table) => {
    const code = await errorCode(async () => {
      const result = await gate.as(user(userA), `select * from ${table} where user_id = $1`, [userB]);
      expect(result.rows).toEqual([]);
    });
    expect([null, PERMISSION_DENIED]).toContain(code);
  });

  it.each(OWNED_TABLES)("user A cannot update user B's rows in %s", async (table) => {
    const [column] = await updatableColumns(table);
    if (!column) {
      expect(
        await errorCode(() => gate.as(user(userA), `update ${table} set user_id = user_id where user_id = $1`, [userB])),
      ).toBe(PERMISSION_DENIED);
      return;
    }
    const result = await gate.as(user(userA), `update ${table} set ${column} = ${column} where user_id = $1`, [userB]);
    expect(result.affectedRows).toBe(0);
  });

  it.each(OWNED_TABLES)("user A cannot delete user B's rows in %s", async (table) => {
    const before = await countOwnedBy(table, userB);
    const code = await errorCode(async () => {
      const result = await gate.as(user(userA), `delete from ${table} where user_id = $1`, [userB]);
      expect(result.affectedRows).toBe(0);
    });
    expect([null, PERMISSION_DENIED]).toContain(code);
    expect(await countOwnedBy(table, userB)).toBe(before);
  });

  it.each(OWNED_TABLES)("user A cannot insert a row owned by user B into %s", async (table) => {
    const [sql, params] = insertFor(table, userB, rowsB);
    expect(await errorCode(() => gate.as(user(userA), sql, params))).toBe(PERMISSION_DENIED);
  });

  it("cannot read or write the server-only spend counters", async () => {
    expect(await errorCode(() => gate.as(user(userA), "select * from spend_counters"))).toBe(PERMISSION_DENIED);
    expect(
      await errorCode(() =>
        gate.as(user(userA), "insert into spend_counters (provider, period_kind, period_start) values ('tavily', 'day', current_date)"),
      ),
    ).toBe(PERMISSION_DENIED);
  });
});

describe("protected columns", () => {
  it.each(ALL_TABLES)("authenticated has no table-wide UPDATE and cannot update id, user_id or created_at on %s", async (table) => {
    const tableWide = await gate.admin<{ granted: boolean }>(
      "select has_table_privilege('authenticated', $1, 'UPDATE') as granted",
      [`public.${table}`],
    );
    expect(tableWide.rows[0]!.granted).toBe(false);
    const updatable = await updatableColumns(table);
    expect(updatable.filter((column) => PROTECTED_COLUMNS.includes(column))).toEqual([]);
  });

  it.each(OWNED_TABLES)("user A cannot move an own row in %s to user B", async (table) => {
    expect(
      await errorCode(() => gate.as(user(userA), `update ${table} set user_id = $1 where user_id = $2`, [userB, userA])),
    ).toBe(PERMISSION_DENIED);
  });
});

describe("similarity search", () => {
  it.each([
    ["match_memories", "memoryId"],
    ["match_document_chunks", "chunkId"],
  ] as const)("%s returns only the caller's rows", async (fn, key) => {
    for (const [caller, own] of [
      [userA, rowsA],
      [userB, rowsB],
    ] as const) {
      const result = await gate.as<{ id: string }>(user(caller), `select id from ${fn}($1, 'personal', 20)`, [
        EMBEDDING,
      ]);
      expect(result.rows.map((row) => row.id)).toEqual([own[key]]);
    }
  });
});

describe("app parsers read every row the database accepts", () => {
  it("lists flat action log rows, with and without a proposal, exactly as stored", async () => {
    const owner = await gate.createUser();
    const proposal = await gate.admin<{ id: string }>(
      `insert into action_proposals (user_id, kind, payload, summary)
       values ($1, 'create_task', '{"kind":"create_task","mode":"personal","title":"x"}', 'x') returning id`,
      [owner],
    );
    const proposalId = proposal.rows[0]!.id;
    await gate.admin(
      `insert into action_log (user_id, proposal_id, event, detail) values
        ($1, $2, 'proposed', '{"kind":"create_task","count":2,"edited":true,"taskId":null}'),
        ($1, null, 'memory_added', '{}')`,
      [owner, proposalId],
    );
    const entries = await createActionLogRepository(sqlGateClient(gate, owner)).list(owner, 50);
    // The insert trigger on action_proposals adds the third row.
    expect(entries).toHaveLength(3);
    expect(entries.filter((entry) => entry.event === "proposed" && entry.proposalId === proposalId)).toHaveLength(2);
    expect(entries.filter((entry) => entry.proposalId === null)).toHaveLength(1);
    expect(entries.every((entry) => typeof entry.createdAt === "string")).toBe(true);
  });

  it("lists proposals in every stored state, including NULL conversation, result and decided_at", async () => {
    const owner = await gate.createUser();
    const conversation = await gate.admin<{ id: string }>(
      "insert into conversations (user_id, title) values ($1, 'x') returning id",
      [owner],
    );
    await gate.admin(
      `insert into action_proposals (user_id, conversation_id, kind, payload, summary, status, result, decided_at) values
        ($1, null, 'create_task', '{"kind":"create_task","mode":"work","title":"Call Sam"}', 'Add a task', 'proposed', null, null),
        ($1, $2, 'create_reminder', '{"kind":"create_reminder","mode":"personal","title":"Dentist","dueAt":"2026-10-30T17:00:00Z"}',
          'Remind me', 'executed', '{"reminderId":"r1"}', now()),
        ($1, $2, 'save_memory', '{"kind":"save_memory","mode":"personal","content":"Likes tea"}',
          'Remember this', 'failed', '{"error":"execution_failed","code":"23514"}', now()),
        ($1, $2, 'create_task', '{"kind":"create_task","mode":"personal","title":"Old"}', 'Old', 'rejected', null, now())`,
      [owner, conversation.rows[0]!.id],
    );
    const proposals = await createActionProposalRepository(sqlGateClient(gate, owner)).listProposals(
      owner,
      undefined,
      50,
    );
    expect(proposals.map((proposal) => proposal.status).sort()).toEqual(["executed", "failed", "proposed", "rejected"]);
    const pending = proposals.find((proposal) => proposal.status === "proposed")!;
    expect(pending.conversationId).toBeNull();
    expect(pending.result).toBeNull();
    expect(pending.decidedAt).toBeNull();
  });

  it("does not accept an action log detail that the log reader refuses", async () => {
    const owner = await gate.createUser();
    const code = await errorCode(() =>
      gate.admin(`insert into action_log (user_id, event, detail) values ($1, 'executed', '{"taskId":{"nested":"bad"}}')`, [
        owner,
      ]),
    );
    if (code !== null) return;
    await expect(createActionLogRepository(sqlGateClient(gate, owner)).list(owner, 50)).resolves.toHaveLength(
      await countOwnedBy("action_log", owner),
    );
  });
});

describe("records the app must be able to trust", () => {
  it("authenticated cannot insert into action_log", async () => {
    expect(
      await errorCode(() =>
        gate.as(user(userA), "insert into action_log (user_id, event, detail) values ($1, 'executed', '{}')", [userA]),
      ),
    ).toBe(PERMISSION_DENIED);
  });

  it("authenticated cannot update action_proposals, so an approved action cannot be reset and run again", async () => {
    const approved = await gate.admin<{ id: string }>(
      `insert into action_proposals (user_id, kind, payload, summary, status, decided_at)
       values ($1, 'create_task', '{"kind":"create_task","mode":"personal","title":"x"}', 'x', 'approved', now())
       returning id`,
      [userA],
    );
    const id = approved.rows[0]!.id;
    await errorCode(() =>
      gate.as(user(userA), "update action_proposals set status = 'proposed', decided_at = null where id = $1", [id]),
    );
    const stored = await gate.admin<{ status: string }>("select status from action_proposals where id = $1", [id]);
    expect(stored.rows[0]!.status).toBe("approved");
  });
});

describe("legacy proposals left approved (decision 0009)", () => {
  /** The owner statements, read from the file the decision links to, so the two cannot drift. */
  const statements = new Map(
    readFileSync(resolve(process.cwd(), "docs/decisions/0009-legacy-approved.sql"), "utf8")
      .split(/^-- name: /m)
      .slice(1)
      .map((block) => {
        const [header, ...body] = block.split("\n");
        return [header!.split(" ")[0]!, { header: header!, sql: body.join("\n").trim().replace(/;$/, "") }] as const;
      }),
  );
  const run = <T,>(name: string, params: unknown[]) => gate.admin<T>(statements.get(name)!.sql, params);

  async function legacyApproved(owner: string, title: string): Promise<string> {
    const row = await gate.admin<{ id: string }>(
      `insert into action_proposals (user_id, kind, payload, summary, status, decided_at)
       values ($1, 'create_task', jsonb_build_object('kind', 'create_task', 'mode', 'personal', 'title', $2::text), 'x', 'approved', now())
       returning id`,
      [owner, title],
    );
    return row.rows[0]!.id;
  }

  async function taskFor(owner: string, title: string): Promise<string> {
    const row = await gate.admin<{ id: string }>(
      "insert into tasks (user_id, mode, title) values ($1, 'personal', $2) returning id",
      [owner, title],
    );
    return row.rows[0]!.id;
  }

  const statusOf = async (id: string) =>
    (await gate.admin<{ status: string }>("select status from action_proposals where id = $1", [id])).rows[0]!.status;

  it("each statement says whether it is read-only, and only confirm_executed writes", () => {
    expect([...statements.keys()]).toEqual([
      "find_approved",
      "find_reminder",
      "list_tasks_near_decision",
      "list_memories_near_decision",
      "confirm_executed",
    ]);
    for (const [name, { header, sql }] of statements) {
      const readOnly = header.includes("(read-only)");
      expect(readOnly || header.includes("(writes"), name).toBe(true);
      expect(/^select\b/i.test(sql), name).toBe(readOnly);
      expect(sql, name).toContain("user_id = $1");
    }
  });

  it("the decision function answers already_decided, runs nothing and leaves the row approved", async () => {
    const owner = await gate.createUser();
    const id = await legacyApproved(owner, "Legacy task");
    const answer = await gate.as<{ answer: { outcome: string } }>(
      user(owner),
      "select public.decide_action_proposal($1, 'approve') as answer",
      [id],
    );
    expect(answer.rows[0]!.answer.outcome).toBe("already_decided");
    expect(await statusOf(id)).toBe("approved");
    expect(await countOwnedBy("tasks", owner)).toBe(0);
  });

  it("the read-only statements return only the chosen user's rows", async () => {
    const owner = await gate.createUser();
    const other = await gate.createUser();
    const mine = await legacyApproved(owner, "Mine");
    const theirs = await legacyApproved(other, "Theirs");
    await taskFor(owner, "Mine");
    await taskFor(other, "Theirs");

    const found = await run<{ id: string }>("find_approved", [owner]);
    expect(found.rows.map((r) => r.id)).toEqual([mine]);
    const tasks = await run<{ title: string }>("list_tasks_near_decision", [owner, mine]);
    expect(tasks.rows.map((r) => r.title)).toEqual(["Mine"]);
    expect((await run("list_tasks_near_decision", [owner, theirs])).rows).toEqual([]);
    expect((await run("list_memories_near_decision", [owner, mine])).rows).toEqual([]);
    expect((await run("find_reminder", [owner, theirs])).rows).toEqual([]);
  });

  it("an edited task still shows in the list, and the row is set executed only for the row the user confirms", async () => {
    const owner = await gate.createUser();
    const other = await gate.createUser();
    const id = await legacyApproved(owner, "Pay the invoice");
    const task = await taskFor(owner, "Pay the invoice");
    await gate.admin("update tasks set title = 'Paid, edited later' where id = $1", [task]);
    const othersTask = await taskFor(other, "Pay the invoice");

    const listed = await run<{ id: string }>("list_tasks_near_decision", [owner, id]);
    expect(listed.rows.map((r) => r.id)).toEqual([task]);

    // Another user's row, or another user's proposal, changes nothing.
    expect((await run("confirm_executed", [owner, id, othersTask])).rows).toEqual([]);
    expect((await run("confirm_executed", [other, id, task])).rows).toEqual([]);
    expect(await statusOf(id)).toBe("approved");

    expect((await run<{ id: string }>("confirm_executed", [owner, id, task])).rows.map((r) => r.id)).toEqual([id]);
    const proposals = await createActionProposalRepository(sqlGateClient(gate, owner)).listProposals(owner, undefined, 50);
    expect(proposals.find((p) => p.id === id)).toMatchObject({ status: "executed", result: { taskId: task } });
    const log = await gate.admin<{ event: string }>(
      "select event from action_log where user_id = $1 and proposal_id = $2 and event = 'executed'",
      [owner, id],
    );
    expect(log.rows).toHaveLength(1);
    expect((await run("confirm_executed", [owner, id, task])).rows).toEqual([]);
  });

  it("a row with an unknown outcome stays approved and an approval cannot make a second task", async () => {
    const owner = await gate.createUser();
    const id = await legacyApproved(owner, "Call Sam");
    const task = await taskFor(owner, "Call Sam");
    await gate.admin("delete from tasks where id = $1", [task]);
    expect((await run("list_tasks_near_decision", [owner, id])).rows).toEqual([]);

    const answer = await gate.as<{ answer: { outcome: string } }>(
      user(owner),
      "select public.decide_action_proposal($1, 'approve') as answer",
      [id],
    );
    expect(answer.rows[0]!.answer.outcome).toBe("already_decided");
    expect(await statusOf(id)).toBe("approved");
    expect(await countOwnedBy("tasks", owner)).toBe(0);
  });
});
