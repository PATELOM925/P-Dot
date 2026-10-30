import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MEMORY, REMINDER, TASK, decideAs, propose } from "../support/sql-gate-actions";
import { startSqlGate, user, type SqlGate } from "../support/sql-gate";

// The owner's clean-up SQL for old trial users (docs/DEPLOYMENT.md, decision 0015), run against every migration.
// Supabase's auth.users has is_anonymous and created_at; the stand-in gets them here.
const CLEANUP_COUNT = `select count(*)::int as n from auth.users where is_anonymous is true and created_at < $1::timestamptz`;
const CLEANUP = `delete from auth.users where is_anonymous is true and created_at < $1::timestamptz`;
const CUTOFF = "2026-11-01T00:00:00Z";

const OWNED_TABLES = [
  "action_log",
  "action_proposals",
  "context_records",
  "conversations",
  "documents",
  "memories",
  "messages",
  "reminders",
  "spend_reservations",
  "tasks",
  "usage_windows",
];

describe("trial user clean-up", () => {
  let gate: SqlGate;
  let oldTrial: string;
  let newTrial: string;
  let account: string;

  async function rowsOf(userId: string): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const table of OWNED_TABLES) {
      const result = await gate.admin<{ n: number }>(`select count(*)::int as n from public.${table} where user_id = $1`, [userId]);
      counts[table] = result.rows[0]!.n;
    }
    return counts;
  }

  async function seed(userId: string) {
    const conversation = await gate.as<{ id: string }>(
      user(userId),
      "insert into conversations (user_id, title) values ($1, 'trial') returning id",
      [userId],
    );
    await gate.as(user(userId), "insert into messages (conversation_id, user_id, role, content) values ($1, $2, 'user', 'hi')", [
      conversation.rows[0]!.id,
      userId,
    ]);
    await gate.as(user(userId), "insert into memories (user_id, mode, content, source) values ($1, 'personal', 'Short answers', 'user')", [
      userId,
    ]);
    await gate.as(
      user(userId),
      "insert into documents (user_id, mode, title, media_type, char_count, status) values ($1, 'personal', 'notes', 'text/plain', 5, 'ready')",
      [userId],
    );
    for (const payload of [TASK, REMINDER, MEMORY]) {
      const id = await propose(gate, userId, payload);
      expect((await decideAs(gate, userId, id, "approve")).outcome).toBe("executed");
    }
  }

  beforeAll(async () => {
    gate = await startSqlGate();
    await gate.admin(
      "alter table auth.users add column is_anonymous boolean not null default false, add column created_at timestamptz not null default now()",
    );
    oldTrial = await gate.createUser();
    newTrial = await gate.createUser();
    account = await gate.createUser();
    await gate.admin("update auth.users set is_anonymous = true, created_at = '2026-10-30T12:00:00Z' where id = $1", [oldTrial]);
    await gate.admin("update auth.users set is_anonymous = true, created_at = '2026-11-02T12:00:00Z' where id = $1", [newTrial]);
    await gate.admin("update auth.users set created_at = '2026-10-01T00:00:00Z' where id = $1", [account]);
    for (const id of [oldTrial, newTrial, account]) await seed(id);
    await gate.admin(
      "insert into public.spend_counters (provider, period_kind, period_start, used) values ('nebius', 'total', '2026-10-01', 1234)",
    );
  }, 60_000);

  afterAll(async () => {
    await gate?.close();
  });

  it("counts only trial users older than the cutoff", async () => {
    expect((await gate.admin<{ n: number }>(CLEANUP_COUNT, [CUTOFF])).rows[0]!.n).toBe(1);
  });

  it("deletes the old trial user and all of its app rows, and keeps everyone else and the spend totals", async () => {
    expect(Object.values(await rowsOf(oldTrial)).every((n) => n >= 0)).toBe(true);
    expect((await rowsOf(oldTrial)).memories).toBeGreaterThan(0);

    await gate.admin(CLEANUP, [CUTOFF]);

    const users = await gate.admin<{ id: string }>("select id from auth.users");
    expect(users.rows.map((r) => r.id).sort()).toEqual([newTrial, account].sort());
    expect(Object.values(await rowsOf(oldTrial)).every((n) => n === 0)).toBe(true);
    expect((await rowsOf(newTrial)).memories).toBeGreaterThan(0);
    expect((await rowsOf(account)).memories).toBeGreaterThan(0);
    const total = await gate.admin<{ used: string }>(
      "select used::text from public.spend_counters where provider = 'nebius' and period_kind = 'total'",
    );
    expect(total.rows[0]!.used).toBe("1234");
  });
});
