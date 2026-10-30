import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createActionLogRepository } from "@/server/db/action-log";
import { createActionProposalRepository } from "@/server/db/action-proposals";
import { sqlGateClient } from "../support/sql-gate-client";
import { TASK, decideAs, propose, proposalEvents } from "../support/sql-gate-actions";
import { anon, errorCode, startSqlGate, user, type DefaultGrants, type SqlGate } from "../support/sql-gate";

/**
 * Database gate for decision 0014: connected accounts, and the external
 * action kinds with their claim, finish and recovery functions. Every check
 * runs with the older Supabase default grants and with none.
 */
const MODES: DefaultGrants[] = ["legacy", "none"];

const GMAIL_READ = "https://www.googleapis.com/auth/gmail.readonly";
const GMAIL_SEND = "https://www.googleapis.com/auth/gmail.send";
const CALENDAR = "https://www.googleapis.com/auth/calendar.events.owned";
const CIPHERTEXT = `v1.${"A".repeat(16)}.${"B".repeat(40)}`;
const OTHER_CIPHERTEXT = `v1.${"C".repeat(16)}.${"D".repeat(40)}`;
const LEASE = 120;

const EMAIL = { kind: "send_email", mode: "personal", to: ["sam@example.com"], subject: "Lunch", body: "Are you free at noon?" };
const EVENT = {
  kind: "create_calendar_event",
  mode: "work",
  title: "Planning",
  start: "2026-11-02T10:00:00Z",
  end: "2026-11-02T11:00:00Z",
  attendees: ["sam@example.com"],
};

const CHECK_VIOLATION = "23514";
const PERMISSION_DENIED = "42501";

let gate: SqlGate;

type Answer = { outcome: string; proposal: (Record<string, unknown> & { status: string; execution_claim_id: string | null }) | null };

async function call(owner: string, sql: string, params: unknown[]): Promise<Answer> {
  const result = await gate.as<{ r: Answer }>(user(owner), `select ${sql} as r`, params);
  return result.rows[0]!.r;
}

/** Approves through decide_action_proposal and returns the claim it stored. */
async function approveClaim(owner: string, id: string): Promise<string> {
  const answer = await call(owner, "public.decide_action_proposal($1, 'approve')", [id]);
  expect(answer.outcome).toBe("executing");
  return answer.proposal!.execution_claim_id!;
}

const finish = (owner: string, id: string, claim: string | null, succeeded: boolean, result: unknown) =>
  call(owner, "public.finish_external_action($1, $2, $3, $4::jsonb)", [id, claim, succeeded, JSON.stringify(result)]);
const reclaim = (owner: string, id: string, lease = LEASE) => call(owner, "public.reclaim_external_action($1, $2)", [id, lease]);
const settleUnknown = (owner: string, id: string, sent: boolean, lease = LEASE) =>
  call(owner, "public.settle_unknown_external_action($1, $2, $3)", [id, lease, sent]);

/** Moves the claim time back, as if the Worker stopped that long ago. */
const ageClaim = (id: string, seconds: number) =>
  gate.admin("update action_proposals set execution_started_at = now() - make_interval(secs => $2) where id = $1", [id, seconds]);

async function stored(id: string) {
  const result = await gate.admin<{ status: string; result: unknown; decided_by_function: boolean; execution_claim_id: string | null }>(
    "select status, result, decided_by_function, execution_claim_id from action_proposals where id = $1",
    [id],
  );
  return result.rows[0]!;
}

async function logRows(id: string) {
  const result = await gate.admin<{ event: string; detail: Record<string, unknown>; verified: boolean }>(
    "select event, detail, verified from action_log where proposal_id = $1 order by created_at",
    [id],
  );
  return result.rows;
}

const save = (owner: string, scopes: string[], ciphertext = CIPHERTEXT, email = "me@example.com") =>
  gate.as<{ id: string }>(user(owner), "select public.save_connected_account('google', $1, $2, $3) as id", [email, scopes, ciphertext]);

describe.each(MODES)("Google connection and external actions with %s default grants", (defaults) => {
  let alice: string;
  let bob: string;

  beforeAll(async () => {
    gate = await startSqlGate({ defaults });
    alice = await gate.createUser();
    bob = await gate.createUser();
  });

  afterAll(async () => {
    await gate?.close();
  });

  describe("connected_accounts", () => {
    it("save_connected_account inserts one row, then replaces it and marks it connected again", async () => {
      const owner = await gate.createUser();
      const first = (await save(owner, [GMAIL_READ])).rows[0]!.id;
      await gate.as(user(owner), "update connected_accounts set status = 'needs_reconnect' where user_id = $1", [owner]);
      const second = (await save(owner, [GMAIL_READ, GMAIL_SEND, CALENDAR], OTHER_CIPHERTEXT, "new@example.com")).rows[0]!.id;
      expect(second).toBe(first);
      const rows = await gate.as<{ account_email: string; scopes: string[]; token_ciphertext: string; status: string }>(
        user(owner),
        "select account_email, scopes, token_ciphertext, status from connected_accounts",
      );
      expect(rows.rows).toEqual([
        { account_email: "new@example.com", scopes: [GMAIL_READ, GMAIL_SEND, CALENDAR], token_ciphertext: OTHER_CIPHERTEXT, status: "connected" },
      ]);
    });

    it("refuses an unknown scope, no scope, a NULL scope and a ciphertext that is not in the v1 form", async () => {
      const owner = await gate.createUser();
      expect(await errorCode(() => save(owner, ["https://mail.google.com/"]))).toBe(CHECK_VIOLATION);
      expect(await errorCode(() => save(owner, []))).toBe(CHECK_VIOLATION);
      expect(await errorCode(() => save(owner, [GMAIL_READ, null as unknown as string]))).toBe(CHECK_VIOLATION);
      expect(await errorCode(() => save(owner, [GMAIL_READ], "plain-refresh-token"))).toBe(CHECK_VIOLATION);
      expect(await errorCode(() => save(owner, [GMAIL_READ], `v1.${"A".repeat(16)}.${"B".repeat(40)}\nx`))).toBe(CHECK_VIOLATION);
    });

    it("keeps each user's row apart: no read, change, delete or save into another user's row", async () => {
      await save(alice, [GMAIL_READ]);
      await save(bob, [CALENDAR], OTHER_CIPHERTEXT, "bob@example.com");
      const seen = await gate.as(user(alice), "select * from connected_accounts where user_id = $1", [bob]);
      expect(seen.rows).toEqual([]);
      const changed = await gate.as(user(alice), "update connected_accounts set status = 'needs_reconnect' where user_id = $1", [bob]);
      expect(changed.affectedRows).toBe(0);
      const deleted = await gate.as(user(alice), "delete from connected_accounts where user_id = $1", [bob]);
      expect(deleted.affectedRows).toBe(0);
      const bobRow = await gate.admin<{ token_ciphertext: string; status: string }>(
        "select token_ciphertext, status from connected_accounts where user_id = $1",
        [bob],
      );
      expect(bobRow.rows).toEqual([{ token_ciphertext: OTHER_CIPHERTEXT, status: "connected" }]);
      expect(
        await errorCode(() =>
          gate.as(
            user(alice),
            "insert into connected_accounts (user_id, provider, account_email, scopes, token_ciphertext) values ($1, 'google', 'x@example.com', $2, $3)",
            [bob, [GMAIL_READ], CIPHERTEXT],
          ),
        ),
      ).toBe(PERMISSION_DENIED);
    });

    it("lets the owner change only the status, the address, the scopes and the ciphertext", async () => {
      const owner = await gate.createUser();
      await save(owner, [GMAIL_READ]);
      for (const column of ["id", "user_id", "provider", "created_at", "updated_at"]) {
        expect(await errorCode(() => gate.as(user(owner), `update connected_accounts set ${column} = ${column}`)), column).toBe(PERMISSION_DENIED);
      }
      const marked = await gate.as(
        user(owner),
        "update connected_accounts set status = 'needs_reconnect' where user_id = $1 and token_ciphertext = $2",
        [owner, CIPHERTEXT],
      );
      expect(marked.affectedRows).toBe(1);
      expect((await gate.as(user(owner), "delete from connected_accounts where user_id = $1", [owner])).affectedRows).toBe(1);
    });

    it("gives anon no access to the table or the function", async () => {
      expect(await errorCode(() => gate.as(anon, "select * from connected_accounts"))).toBe(PERMISSION_DENIED);
      expect(
        await errorCode(() => gate.as(anon, "select public.save_connected_account('google', 'a@example.com', $1, $2)", [[GMAIL_READ], CIPHERTEXT])),
      ).toBe(PERMISSION_DENIED);
    });

    it("goes away with the account", async () => {
      const owner = await gate.createUser();
      await save(owner, [GMAIL_READ]);
      await gate.admin("delete from auth.users where id = $1", [owner]);
      const left = await gate.admin("select 1 from connected_accounts where user_id = $1", [owner]);
      expect(left.rows).toEqual([]);
    });
  });

  describe("external action payloads", () => {
    it.each([
      ["send_email", EMAIL],
      ["create_calendar_event", EVENT],
      ["create_calendar_event with no attendees", { ...EVENT, attendees: [] }],
    ])("accepts a valid %s and stores it normalized", async (_name, payload) => {
      const id = await propose(gate, alice, { ...payload, ...("subject" in payload ? { subject: "  Lunch  " } : { title: " Planning " }) });
      const answer = await decideAs(gate, alice, id, "approve");
      expect(answer.outcome).toBe("executing");
      expect(answer.proposal!.payload).toEqual(payload);
    });

    it("accepts the largest email: 10 recipients of 254 characters, a 200-character subject and a 4,000-character body of 4-byte characters", async () => {
      const address = (i: number) => `${String(i).padStart(2, "0")}${"a".repeat(240)}@example.com`;
      const to = Array.from({ length: 10 }, (_, i) => address(i));
      expect(to[0]).toHaveLength(254);
      const payload = { ...EMAIL, to, subject: "é".repeat(200), body: "𝄞".repeat(4000) };
      const id = await propose(gate, alice, payload);
      expect((await decideAs(gate, alice, id, "approve")).outcome).toBe("executing");
    });

    it.each([
      ["a recipient with a line break", { ...EMAIL, to: ["sam@example.com\r\nBcc: eve@example.com"] }],
      ["a recipient with a space", { ...EMAIL, to: ["sam smith@example.com"] }],
      ["a recipient with no domain dot", { ...EMAIL, to: ["sam@localhost"] }],
      ["no recipient", { ...EMAIL, to: [] }],
      ["11 recipients", { ...EMAIL, to: Array.from({ length: 11 }, (_, i) => `p${i}@example.com`) }],
      ["a recipient that is not a string", { ...EMAIL, to: [42] }],
      ["a subject with a line break", { ...EMAIL, subject: "Lunch\r\nBcc: eve@example.com" }],
      ["a subject of 201 characters", { ...EMAIL, subject: "s".repeat(201) }],
      ["an empty body", { ...EMAIL, body: "   " }],
      ["a body of 4,001 characters", { ...EMAIL, body: "b".repeat(4001) }],
      ["an extra key", { ...EMAIL, cc: ["x@example.com"] }],
      ["an end before the start", { ...EVENT, end: "2026-11-02T09:00:00Z" }],
      ["an end equal to the start", { ...EVENT, end: EVENT.start }],
      ["an event of more than 31 days", { ...EVENT, end: "2026-12-04T10:00:00Z" }],
      ["a start with no time zone", { ...EVENT, start: "2026-11-02T10:00:00" }],
      ["30 February", { ...EVENT, start: "2026-02-30T10:00:00Z" }],
      ["21 attendees", { ...EVENT, attendees: Array.from({ length: 21 }, (_, i) => `p${i}@example.com`) }],
      ["a title with a line break", { ...EVENT, title: "Plan\nning" }],
      ["no attendees key", { kind: EVENT.kind, mode: EVENT.mode, title: EVENT.title, start: EVENT.start, end: EVENT.end }],
    ])("refuses %s on approval and claims nothing", async (_name, payload) => {
      const id = await propose(gate, alice, payload);
      const answer = await decideAs(gate, alice, id, "approve");
      expect(answer.outcome).toBe("invalid");
      expect((await stored(id)).status).toBe("proposed");
    });

    it("checks an edited payload too, and keeps the kind", async () => {
      const id = await propose(gate, alice, EMAIL);
      expect((await decideAs(gate, alice, id, "approve", { ...EMAIL, to: ["bad address"] })).outcome).toBe("invalid");
      expect((await decideAs(gate, alice, id, "approve", TASK)).outcome).toBe("kind_mismatch");
      const edited = await decideAs(gate, alice, id, "approve", { ...EMAIL, subject: "Lunch on Friday" });
      expect(edited.outcome).toBe("executing");
      expect(edited.proposal!.payload).toMatchObject({ subject: "Lunch on Friday" });
    });
  });

  describe("claim, finish and the action log", () => {
    it("claims once: the approval answers executing with a claim, a second decision gets already_decided", async () => {
      const id = await propose(gate, alice, EMAIL);
      expect(await approveClaim(alice, id)).toMatch(/^[0-9a-f-]{36}$/);
      expect((await decideAs(gate, alice, id, "approve")).outcome).toBe("already_decided");
      expect((await decideAs(gate, alice, id, "reject")).outcome).toBe("already_decided");
      expect((await stored(id)).decided_by_function).toBe(true);
    });

    it("finishes an email as executed with the message ID, verified, and logs no address, subject or body", async () => {
      const id = await propose(gate, alice, EMAIL);
      const claim = await approveClaim(alice, id);
      const done = await finish(alice, id, claim, true, { messageId: "18c2f0a1b2c3d4e5" });
      expect(done.outcome).toBe("executed");
      expect(await stored(id)).toMatchObject({ status: "executed", result: { messageId: "18c2f0a1b2c3d4e5" }, decided_by_function: true, execution_claim_id: null });
      const rows = await logRows(id);
      expect(rows.map((row) => row.event)).toEqual(["proposed", "approved", "executed"]);
      expect(rows.every((row) => row.verified)).toBe(true);
      expect(rows[2]!.detail).toEqual({ kind: "send_email", mode: "personal", messageId: "18c2f0a1b2c3d4e5" });
      const text = JSON.stringify(rows);
      for (const secret of ["sam@example.com", "Lunch", "noon"]) expect(text).not.toContain(secret);
      expect((await finish(alice, id, claim, true, { messageId: "again" })).outcome).toBe("already_decided");
    });

    it("finishes an event as failed with a reason from the fixed list", async () => {
      const id = await propose(gate, alice, EVENT);
      const claim = await approveClaim(alice, id);
      const failed = await finish(alice, id, claim, false, { error: "execution_failed", reason: "scope_missing" });
      expect(failed.outcome).toBe("failed");
      const rows = await logRows(id);
      expect(rows.at(-1)).toMatchObject({ event: "failed", verified: true, detail: { kind: "create_calendar_event", error: "execution_failed", reason: "scope_missing" } });
    });

    it.each([
      ["a message ID for an event", true, { messageId: "abc" }],
      ["an event ID with a slash", true, { eventId: "a/b" }],
      ["an extra key", true, { eventId: "abc", title: "Planning" }],
      ["a free-text reason", false, { error: "execution_failed", reason: "sam@example.com rejected it" }],
      ["a failure with no reason", false, { error: "execution_failed" }],
      ["not an object", true, ["abc"]],
    ])("refuses %s and keeps the row executing", async (_name, succeeded, result) => {
      const id = await propose(gate, alice, EVENT);
      const claim = await approveClaim(alice, id);
      expect((await finish(alice, id, claim, succeeded, result)).outcome).toBe("invalid");
      expect((await stored(id)).status).toBe("executing");
    });

    it("refuses a finish with a wrong or missing claim", async () => {
      const id = await propose(gate, alice, EMAIL);
      await decideAs(gate, alice, id, "approve");
      expect((await finish(alice, id, "00000000-0000-4000-8000-000000000000", true, { messageId: "abc" })).outcome).toBe("stale_claim");
      expect((await finish(alice, id, null, true, { messageId: "abc" })).outcome).toBe("stale_claim");
      expect((await stored(id)).status).toBe("executing");
    });

    it("gives another user's proposal the same not_found as a missing one, in every function, and changes nothing", async () => {
      const id = await propose(gate, alice, EMAIL);
      const claim = await approveClaim(alice, id);
      await ageClaim(id, 600);
      const missing = "00000000-0000-4000-8000-000000000001";
      for (const target of [id, missing]) {
        expect(await finish(bob, target, claim, true, { messageId: "abc" })).toEqual({ outcome: "not_found", proposal: null });
        expect(await reclaim(bob, target)).toEqual({ outcome: "not_found", proposal: null });
        expect(await settleUnknown(bob, target, true)).toEqual({ outcome: "not_found", proposal: null });
      }
      expect((await stored(id)).status).toBe("executing");
    });

    it("refuses a caller with no session and anon", async () => {
      const id = await propose(gate, alice, EMAIL);
      const noSession = { role: "authenticated", userId: "" } as const;
      for (const sql of [
        "select public.finish_external_action($1, null, true, '{}'::jsonb)",
        "select public.reclaim_external_action($1, 120)",
        "select public.settle_unknown_external_action($1, 120, true)",
      ]) {
        expect(await errorCode(() => gate.as(anon, sql, [id]))).toBe(PERMISSION_DENIED);
        expect(
          await errorCode(() =>
            gate.transactionAs(noSession, async (tx) => {
              await tx.query("select set_config('request.jwt.claims', '{}', true)");
              return tx.query(sql, [id]);
            }),
          ),
        ).toBe(PERMISSION_DENIED);
      }
    });

    it("keeps the status rules: an external kind is never approved, an internal kind is never executing, an executing row keeps its payload", async () => {
      const email = await propose(gate, alice, EMAIL);
      expect(await errorCode(() => gate.admin("update action_proposals set status = 'approved', decided_at = now() where id = $1", [email]))).toBe(CHECK_VIOLATION);
      const task = await propose(gate, alice, TASK);
      expect(
        await errorCode(() =>
          gate.admin("update action_proposals set status = 'executing', decided_at = now(), execution_claim_id = gen_random_uuid(), execution_started_at = now() where id = $1", [task]),
        ),
      ).toBe(CHECK_VIOLATION);
      await decideAs(gate, alice, email, "approve");
      expect(
        await errorCode(() => gate.admin(`update action_proposals set payload = payload || '{"subject":"Other"}' where id = $1`, [email])),
      ).toBe(CHECK_VIOLATION);
      expect(await errorCode(() => gate.admin("update action_proposals set status = 'proposed', decided_at = null where id = $1", [email]))).toBe(CHECK_VIOLATION);
      expect(await errorCode(() => gate.admin("update action_proposals set execution_claim_id = null where id = $1", [email]))).toBe(CHECK_VIOLATION);
      expect(
        await errorCode(() =>
          gate.as(user(alice), "insert into action_proposals (user_id, kind, payload, summary, execution_claim_id) values ($1, 'send_email', $2::jsonb, 'x', gen_random_uuid())", [
            alice,
            JSON.stringify(EMAIL),
          ]),
        ),
      ).toBe(CHECK_VIOLATION);
    });

    it("lets no API role update a proposal or its claim", async () => {
      const id = await propose(gate, alice, EMAIL);
      await decideAs(gate, alice, id, "approve");
      expect(
        await errorCode(() => gate.as(user(alice), "update action_proposals set execution_claim_id = gen_random_uuid() where id = $1", [id])),
      ).toBe(PERMISSION_DENIED);
    });
  });

  describe("recovery of a row left executing", () => {
    it("an event: busy inside the lease, then a new claim; the old claim can no longer finish", async () => {
      const id = await propose(gate, alice, EVENT);
      const oldClaim = await approveClaim(alice, id);
      expect((await reclaim(alice, id)).outcome).toBe("busy");
      await ageClaim(id, LEASE + 1);
      const again = await reclaim(alice, id);
      expect(again.outcome).toBe("claimed");
      const newClaim = again.proposal!.execution_claim_id!;
      expect(newClaim).not.toBe(oldClaim);
      expect((await reclaim(alice, id)).outcome).toBe("busy");
      expect((await finish(alice, id, oldClaim, true, { eventId: "abc" })).outcome).toBe("stale_claim");
      expect((await finish(alice, id, newClaim, true, { eventId: id.replaceAll("-", "") })).outcome).toBe("executed");
      expect((await stored(id)).decided_by_function).toBe(true);
      expect((await reclaim(alice, id)).outcome).toBe("already_decided");
    });

    it("an email: never a new claim; the user's answer settles it as not verified", async () => {
      const sent = await propose(gate, alice, EMAIL);
      const claim = await approveClaim(alice, sent);
      expect((await settleUnknown(alice, sent, true)).outcome).toBe("busy");
      await ageClaim(sent, LEASE + 1);
      expect((await reclaim(alice, sent)).outcome).toBe("outcome_unknown");
      expect((await stored(sent)).execution_claim_id).toBe(claim);
      expect((await settleUnknown(alice, sent, true)).outcome).toBe("executed");
      expect(await stored(sent)).toMatchObject({ status: "executed", result: { userConfirmed: true }, decided_by_function: false });
      expect((await logRows(sent)).at(-1)).toMatchObject({ event: "executed", verified: false, detail: { userConfirmed: true } });
      expect((await settleUnknown(alice, sent, false)).outcome).toBe("already_decided");

      const notSent = await propose(gate, alice, EMAIL);
      await decideAs(gate, alice, notSent, "approve");
      await ageClaim(notSent, LEASE + 1);
      expect((await settleUnknown(alice, notSent, false)).outcome).toBe("failed");
      expect(await stored(notSent)).toMatchObject({ result: { error: "execution_failed", reason: "not_sent" }, decided_by_function: false });
    });

    it("settle_unknown_external_action refuses an event and leaves it for the reclaim", async () => {
      const id = await propose(gate, alice, EVENT);
      await decideAs(gate, alice, id, "approve");
      await ageClaim(id, LEASE + 1);
      expect((await settleUnknown(alice, id, true)).outcome).toBe("invalid");
      expect((await stored(id)).status).toBe("executing");
    });

    it.each([59, 901])("refuses a lease of %i seconds", async (lease) => {
      const id = await propose(gate, alice, EVENT);
      expect(await errorCode(() => reclaim(alice, id, lease))).toBe("22023");
      expect(await errorCode(() => settleUnknown(alice, id, true, lease))).toBe("22023");
    });
  });

  describe("main's code on the new schema", () => {
    it("still decides the older kinds and lists proposals; it leaves out a row of a new kind it cannot parse", async () => {
      const owner = await gate.createUser();
      const repo = createActionProposalRepository(sqlGateClient(gate, owner));
      const task = await propose(gate, owner, TASK);
      await propose(gate, owner, EMAIL);
      expect((await repo.decide(task, "approve")).outcome).toBe("executed");
      const listed = await repo.listProposals(owner, undefined, 50);
      expect(listed.map((proposal) => proposal.id)).toEqual([task]);
      expect(await proposalEvents(gate, task)).toEqual(["proposed", "approved", "executed"]);
      const log = await createActionLogRepository(sqlGateClient(gate, owner)).list(owner, 50);
      expect(log.length).toBeGreaterThanOrEqual(4);
    });
  });
});
