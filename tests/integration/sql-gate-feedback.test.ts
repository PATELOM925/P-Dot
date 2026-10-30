import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FEEDBACK_DAILY_LIMIT, MAX_FEEDBACK_TEXT_CHARS } from "@/lib/limits";
import { FEEDBACK_KIND_IDS } from "@/lib/feedback";
import { MIGRATIONS_DIR, anon, anonymousUser, errorCode, startSqlGate, user, type DefaultGrants, type SqlGate } from "../support/sql-gate";

/**
 * Database gate for feedback requests: the table, its policies, its length
 * checks and the daily cap. Every check runs with the older Supabase default
 * grants and with none.
 */
const MODES: DefaultGrants[] = ["legacy", "none"];

const CHECK_VIOLATION = "23514";
const POLICY_VIOLATION = "42501";
const LIMIT_REACHED = "54000";

let gate: SqlGate;

const send = (owner: string, kind: string, text: string | null, anonymous = false) =>
  gate.as(anonymous ? anonymousUser(owner) : user(owner), "insert into feedback_requests (kind, text) values ($1, $2)", [kind, text]);
const count = async (owner: string) =>
  (await gate.admin<{ n: number }>("select count(*)::int as n from feedback_requests where user_id = $1", [owner])).rows[0]!.n;

describe("feedback migration", () => {
  it("uses the same daily cap and text limit as the app", () => {
    const sql = readFileSync(join(MIGRATIONS_DIR, "20261103000000_feedback_requests.sql"), "utf8");
    expect(sql).toContain(`) >= ${FEEDBACK_DAILY_LIMIT} then`);
    expect(sql).toContain(`char_length(text) between 1 and ${MAX_FEEDBACK_TEXT_CHARS}`);
  });
});

describe.each(MODES)("feedback requests with %s default grants", (defaults) => {
  beforeAll(async () => {
    gate = await startSqlGate({ defaults });
  });

  afterAll(async () => {
    await gate?.close();
  });

  it("stores a request for the signed-in user, with every kind the app offers", async () => {
    const owner = await gate.createUser();
    for (const kind of FEEDBACK_KIND_IDS) await send(owner, kind, kind === "other" ? "Strava" : null);
    const rows = await gate.as<{ user_id: string; kind: string; text: string | null }>(
      user(owner),
      "select user_id, kind, text from feedback_requests order by kind",
    );
    expect(rows.rows.map((row) => row.kind)).toEqual([...FEEDBACK_KIND_IDS].sort());
    expect(rows.rows.every((row) => row.user_id === owner)).toBe(true);
    expect(rows.rows.find((row) => row.kind === "other")!.text).toBe("Strava");
    expect(rows.rows.find((row) => row.kind === "slack")!.text).toBeNull();
  });

  it("accepts 500 characters and refuses 501, an empty or blank text, and 'other' without text", async () => {
    const owner = await gate.createUser();
    await send(owner, "slack", "x".repeat(MAX_FEEDBACK_TEXT_CHARS));
    expect(await errorCode(() => send(owner, "slack", "x".repeat(MAX_FEEDBACK_TEXT_CHARS + 1)))).toBe(CHECK_VIOLATION);
    expect(await errorCode(() => send(owner, "slack", ""))).toBe(CHECK_VIOLATION);
    expect(await errorCode(() => send(owner, "slack", "   "))).toBe(CHECK_VIOLATION);
    expect(await errorCode(() => send(owner, "other", null))).toBe(CHECK_VIOLATION);
    expect(await count(owner)).toBe(1);
  });

  it("refuses a kind that is not a short lowercase word", async () => {
    const owner = await gate.createUser();
    for (const kind of ["", "Slack", "a b", "x".repeat(33), "1slack", "slack;drop"]) {
      expect(await errorCode(() => send(owner, kind, null))).toBe(CHECK_VIOLATION);
    }
  });

  it(`allows ${FEEDBACK_DAILY_LIMIT} requests in 24 hours, then refuses the next one`, async () => {
    const owner = await gate.createUser();
    for (let i = 0; i < FEEDBACK_DAILY_LIMIT; i += 1) await send(owner, "slack", `Request ${i}`);
    expect(await errorCode(() => send(owner, "slack", "One more"))).toBe(LIMIT_REACHED);
    expect(await count(owner)).toBe(FEEDBACK_DAILY_LIMIT);

    // Another user has an own cap.
    const other = await gate.createUser();
    await send(other, "slack", null);

    // Rows older than 24 hours do not count.
    await gate.admin("update feedback_requests set created_at = now() - interval '25 hours' where user_id = $1", [owner]);
    await send(owner, "slack", "Next day");
    expect(await count(owner)).toBe(FEEDBACK_DAILY_LIMIT + 1);
  });

  it("counts rows of the same statement, so one bulk insert cannot pass the cap", async () => {
    const owner = await gate.createUser();
    const values = Array.from({ length: FEEDBACK_DAILY_LIMIT + 1 }, (_, i) => `('slack', 'Bulk ${i}')`).join(", ");
    expect(await errorCode(() => gate.as(user(owner), `insert into feedback_requests (kind, text) values ${values}`))).toBe(LIMIT_REACHED);
    expect(await count(owner)).toBe(0);
  });

  it("counts the trial session's own rows too", async () => {
    const trial = await gate.createUser();
    for (let i = 0; i < FEEDBACK_DAILY_LIMIT; i += 1) await send(trial, "drive", null, true);
    expect(await errorCode(() => send(trial, "drive", null, true))).toBe(LIMIT_REACHED);
  });

  it("keeps each user to the own rows, with no update and no delete", async () => {
    const owner = await gate.createUser();
    const other = await gate.createUser();
    await send(owner, "outlook", "Work calendar");
    expect((await gate.as(user(other), "select * from feedback_requests")).rows).toEqual([]);
    expect(
      await errorCode(() => gate.as(user(other), "insert into feedback_requests (user_id, kind) values ($1, 'slack')", [owner])),
    ).toBe(POLICY_VIOLATION);
    expect(await errorCode(() => gate.as(user(owner), "update feedback_requests set text = 'changed'"))).toBe(POLICY_VIOLATION);
    expect(await errorCode(() => gate.as(user(owner), "delete from feedback_requests"))).toBe(POLICY_VIOLATION);
    expect(
      await errorCode(() =>
        gate.as(user(owner), "insert into feedback_requests (kind, created_at) values ('slack', now() - interval '2 days')"),
      ),
    ).toBe(POLICY_VIOLATION);
    expect(await count(owner)).toBe(1);
  });

  it("refuses the anon role", async () => {
    expect(await errorCode(() => gate.as(anon, "insert into feedback_requests (kind) values ('slack')"))).toBe(POLICY_VIOLATION);
    expect(await errorCode(() => gate.as(anon, "select * from feedback_requests"))).toBe(POLICY_VIOLATION);
  });
});
