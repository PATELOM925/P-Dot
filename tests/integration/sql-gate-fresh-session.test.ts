import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startSqlGate, type SqlGate } from "../support/sql-gate";

// Each test here must be the first to write on its own database: on a session
// where nothing has called set_config, current_setting(name, true) is NULL, not ''.
let gate: SqlGate;
let logGate: SqlGate;

beforeAll(async () => {
  [gate, logGate] = await Promise.all([startSqlGate({ defaults: "none" }), startSqlGate({ defaults: "none" })]);
});

afterAll(async () => {
  await Promise.all([gate?.close(), logGate?.close()]);
});

const confirmExecuted = readFileSync(resolve(process.cwd(), "docs/decisions/0009-legacy-approved.sql"), "utf8")
  .split(/^-- name: /m)
  .find((block) => block.startsWith("confirm_executed"))!
  .split("\n")
  .slice(1)
  .join("\n")
  .trim()
  .replace(/;$/, "");

describe("owner writes on a session where the markers were never set", () => {
  it("confirm_executed marks a legacy approved task as executed and not verified", async () => {
    const owner = (await gate.admin<{ id: string }>("insert into auth.users (id) values (gen_random_uuid()) returning id"))
      .rows[0]!.id;
    const proposal = await gate.admin<{ id: string }>(
      `insert into action_proposals (user_id, kind, payload, summary, status, decided_at)
       values ($1, 'create_task', '{"kind":"create_task","mode":"personal","title":"Pay"}', 'x', 'approved', now())
       returning id`,
      [owner],
    );
    const id = proposal.rows[0]!.id;
    const task = await gate.admin<{ id: string }>(
      "insert into tasks (user_id, mode, title) values ($1, 'personal', 'Pay') returning id",
      [owner],
    );

    const confirmed = await gate.admin<{ id: string }>(confirmExecuted, [owner, id, task.rows[0]!.id]);

    expect(confirmed.rows.map((r) => r.id)).toEqual([id]);
    const row = await gate.admin("select status, decided_by_function from action_proposals where id = $1", [id]);
    expect(row.rows).toEqual([{ status: "executed", decided_by_function: false }]);
  });

  it("a direct owner insert into action_log is stored as not verified", async () => {
    const owner = (await logGate.admin<{ id: string }>("insert into auth.users (id) values (gen_random_uuid()) returning id"))
      .rows[0]!.id;
    await logGate.admin("insert into action_log (user_id, event, detail) values ($1, 'memory_added', '{\"kind\":\"memory\"}')", [owner]);
    const log = await logGate.admin("select verified from action_log where user_id = $1", [owner]);
    expect(log.rows).toEqual([{ verified: false }]);
  });
});
