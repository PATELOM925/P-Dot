import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { createConversationRepository, isMissingRouteColumn, RepositoryError } from "@/server/db/conversations";

// The new code can run before the routing migration (a merge applies the
// migration and deploys at about the same time). This fake checks every
// selected and inserted column name against a schema, and fails the way
// Postgres and PostgREST do when a column is missing.

/** The columns of public.messages after the given migration files, read from the SQL. */
function messageColumns(files: string[]): string[] {
  const columns: string[] = [];
  for (const file of files) {
    const sql = readFileSync(join("supabase/migrations", file), "utf8");
    const table = /create table public\.messages \(([\s\S]*?)\n\);/.exec(sql);
    if (table) {
      for (const line of table[1]!.split("\n")) {
        const name = /^\s{2}([a-z_]+)\s+(uuid|text|jsonb|timestamptz|boolean)\b/.exec(line)?.[1];
        if (name) columns.push(name);
      }
    }
    for (const block of sql.matchAll(/alter table public\.messages([\s\S]*?);/g)) {
      for (const match of block[1]!.matchAll(/add column (?:if not exists )?([a-z_]+)/g)) columns.push(match[1]!);
    }
  }
  return columns;
}

const MIGRATIONS = readdirSync("supabase/migrations").filter((f) => f.endsWith(".sql")).sort();
const ROUTING_MIGRATION = MIGRATIONS.findIndex((f) => f.includes("message_routing"));
const OLD_COLUMNS = messageColumns(MIGRATIONS.slice(0, ROUTING_MIGRATION));
const NEW_COLUMNS = messageColumns(MIGRATIONS.slice(0, ROUTING_MIGRATION + 1));
const ALICE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONVERSATION = "11111111-1111-4111-8111-111111111111";

type Row = Record<string, unknown>;

function schemaClient(columns: string[]) {
  const known = new Set(columns);
  const rows: Row[] = [];
  const log: { op: "select" | "insert" | "returning"; columns: string[] }[] = [];
  const split = (list: string) => list.split(",").map((c) => c.trim());
  const missing = (names: string[]) => names.find((name) => !known.has(name));
  const pick = (row: Row, names: string[]) => Object.fromEntries(names.map((n) => [n, row[n] ?? null]));
  const columnError = (name: string) => ({ code: "42703", message: `column messages.${name} does not exist` });

  const client = {
    from: () => ({
      select(list: string) {
        const names = split(list);
        log.push({ op: "select", columns: names });
        const bad = missing(names);
        const result = bad
          ? { data: null, error: columnError(bad) }
          : { data: [...rows].reverse().map((row) => pick(row, names)), error: null };
        const query = { eq: () => query, order: () => query, limit: async () => result };
        return query;
      },
      insert(row: Row) {
        const keys = Object.keys(row);
        log.push({ op: "insert", columns: keys });
        return {
          select(list: string) {
            const names = split(list);
            log.push({ op: "returning", columns: names });
            return {
              async single() {
                const badKey = missing(keys);
                if (badKey) {
                  return {
                    data: null,
                    error: { code: "PGRST204", message: `Could not find the '${badKey}' column of 'messages' in the schema cache` },
                  };
                }
                const badSelect = missing(names);
                // The statement fails as a whole: no row is written.
                if (badSelect) return { data: null, error: columnError(badSelect) };
                const stored = { id: `m${rows.length + 1}`, created_at: "2026-10-19T12:00:00Z", ...row };
                rows.push(stored);
                return { data: pick(stored, names), error: null };
              },
            };
          },
        };
      },
    }),
  };
  return { client: client as unknown as SupabaseClient, rows, log };
}

const route = { model: "nvidia/nemotron-3-super-120b-a12b", tier: "standard" as const, reason: "analysis" as const, fallback: false };

describe("messages before and after the routing migration", () => {
  it("works on the old schema: saves and reads messages without the route", async () => {
    const db = schemaClient(OLD_COLUMNS);
    const repo = createConversationRepository(db.client);

    const user = await repo.insertMessage(ALICE, { conversationId: CONVERSATION, role: "user", content: "hi" });
    const reply = await repo.insertMessage(ALICE, { conversationId: CONVERSATION, role: "assistant", content: "hello", route });
    const read = await repo.listRecentMessages(ALICE, CONVERSATION, 10);

    expect([user.route, reply.route]).toEqual([null, null]);
    expect(read.map((m) => [m.role, m.content, m.route])).toEqual([
      ["user", "hi", null],
      ["assistant", "hello", null],
    ]);
    // Exactly one row for each message: the failed statement wrote nothing.
    expect(db.rows).toHaveLength(2);
    // Only the first statement asked for the new columns (42703). After that, the
    // repository used only old columns.
    const usedNew = db.log.filter((entry) => entry.columns.some((c) => !OLD_COLUMNS.includes(c)));
    expect(usedNew).toEqual([{ op: "returning", columns: expect.arrayContaining(["model"]) }]);
    expect(db.log.indexOf(usedNew[0]!)).toBe(1);
  });

  it("saves a routed reply on the old schema when that is the first call (PGRST204)", async () => {
    const db = schemaClient(OLD_COLUMNS);
    const repo = createConversationRepository(db.client);
    const reply = await repo.insertMessage(ALICE, { conversationId: CONVERSATION, role: "assistant", content: "hello", route });
    expect(reply).toMatchObject({ content: "hello", route: null });
    expect(db.rows).toHaveLength(1);
    expect(db.log[0]).toMatchObject({ op: "insert", columns: expect.arrayContaining(["model", "model_tier"]) });
    expect(db.log.at(-1)!.columns.every((c) => OLD_COLUMNS.includes(c))).toBe(true);
  });

  it("saves and reads the route on the new schema", async () => {
    const db = schemaClient(NEW_COLUMNS);
    const repo = createConversationRepository(db.client);
    await repo.insertMessage(ALICE, { conversationId: CONVERSATION, role: "assistant", content: "hello", route });
    const [message] = await repo.listRecentMessages(ALICE, CONVERSATION, 10);
    expect(message!.route).toEqual(route);
    expect(db.rows[0]).toMatchObject({ model: route.model, model_tier: "standard", route_reason: "analysis", model_fallback: false });
  });

  it("reads the schemas from the migration files", () => {
    expect(OLD_COLUMNS.sort()).toEqual(
      ["content", "conversation_id", "created_at", "id", "role", "sources", "user_id", "web_search"].sort(),
    );
    expect(NEW_COLUMNS.filter((c) => !OLD_COLUMNS.includes(c)).sort()).toEqual(
      ["model", "model_fallback", "model_tier", "route_reason"].sort(),
    );
    expect(messageColumns(MIGRATIONS).filter((c) => !NEW_COLUMNS.includes(c)).sort()).toEqual(
      ["client_request_hash", "client_request_id", "reply_claim_id", "reply_claimed_at", "reply_to"].sort(),
    );
  });

  it("asks only for columns that the migrations create", () => {
    const db = schemaClient(NEW_COLUMNS);
    const repo = createConversationRepository(db.client);
    void repo.listRecentMessages(ALICE, CONVERSATION, 1);
    expect(db.log[0]!.columns.every((c) => NEW_COLUMNS.includes(c))).toBe(true);
  });

  it("does not hide other missing columns or other errors", async () => {
    const db = schemaClient(OLD_COLUMNS.filter((c) => c !== "sources"));
    const repo = createConversationRepository(db.client);
    await expect(repo.listRecentMessages(ALICE, CONVERSATION, 10)).rejects.toBeInstanceOf(RepositoryError);
  });

  it.each(["model", "model_tier", "route_reason", "model_fallback"])(
    "knows that a missing %s column of messages is a routing column (42703 and PGRST204)",
    (column) => {
      expect(isMissingRouteColumn({ code: "42703", message: `column messages.${column} does not exist` })).toBe(true);
      expect(isMissingRouteColumn({ code: "42703", message: `column public.messages.${column} does not exist` })).toBe(true);
      expect(
        isMissingRouteColumn({ code: "42703", message: `column "${column}" of relation "messages" does not exist` }),
      ).toBe(true);
      expect(
        isMissingRouteColumn({
          code: "PGRST204",
          message: `Could not find the '${column}' column of 'messages' in the schema cache`,
        }),
      ).toBe(true);
    },
  );

  it.each([
    // Review round 2: other tables must not match.
    ["42703", "column audit.model does not exist"],
    ["42703", "column model.sources does not exist"],
    ["PGRST204", "Could not find the 'model' column of 'audit' in the schema cache"],
    // Other columns, near misses and extra text.
    ["42703", "column messages.sources does not exist"],
    ["42703", "column messages.models does not exist"],
    ["42703", 'column "model" does not exist'],
    ["42703", 'column "model" of relation "audit" does not exist'],
    ["42703", "column messages.model does not exist (and more)"],
    ["PGRST204", "Could not find the 'models' column of 'messages' in the schema cache"],
    ["23514", "column messages.model does not exist"],
    ["", "column messages.model does not exist"],
  ])("does not treat %s %j as a missing routing column", (code, message) => {
    expect(isMissingRouteColumn({ code, message })).toBe(false);
  });

  it("does not treat a missing error, code or message as a missing routing column", () => {
    expect(isMissingRouteColumn(null)).toBe(false);
    expect(isMissingRouteColumn({ message: "column messages.model does not exist" })).toBe(false);
    expect(isMissingRouteColumn({ code: "42703" })).toBe(false);
  });
});
