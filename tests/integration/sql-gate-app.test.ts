import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createActionLogRepository } from "@/server/db/action-log";
import { createActionProposalRepository } from "@/server/db/action-proposals";
import { createMemoryRepository } from "@/server/db/memories";
import { sqlGateClient } from "../support/sql-gate-client";
import { REMINDER, TASK, decideAs, propose } from "../support/sql-gate-actions";
import { errorCode, startSqlGate, user, type SqlGate } from "../support/sql-gate";

/**
 * The app's repositories against the real SQL of every migration, in the
 * in-memory database of the gate. tests/integration/sql-gate.test.ts checks
 * the database alone; this file checks how this code reads and writes it.
 */

let gate: SqlGate;

/** Starting PGlite and applying every migration can pass the default 10 s hook limit when other test files run in parallel. */
const SQL_GATE_HOOK_TIMEOUT_MS = 60_000;

beforeAll(async () => {
  gate = await startSqlGate({ defaults: "none" });
}, SQL_GATE_HOOK_TIMEOUT_MS);

afterAll(async () => {
  await gate?.close();
}, SQL_GATE_HOOK_TIMEOUT_MS);

describe("repositories against the real SQL", () => {
  it("decide() maps every outcome of the function", async () => {
    const owner = await gate.createUser();
    const repo = createActionProposalRepository(sqlGateClient(gate, owner));
    const id = await propose(gate, owner, TASK);
    expect(await repo.decide(id, "approve", { kind: "save_memory", mode: "personal", content: "x" })).toMatchObject({
      outcome: "kind_mismatch",
      proposal: { id, status: "proposed" },
    });
    const executed = await repo.decide(id, "approve", { kind: "create_task", mode: "work", title: "Edited" });
    expect(executed).toMatchObject({ outcome: "executed", proposal: { id, status: "executed", payload: { title: "Edited" } } });
    expect(executed.proposal!.decidedAt).toEqual(expect.any(String));
    expect(await repo.decide(id, "reject")).toMatchObject({ outcome: "already_decided", proposal: { status: "executed" } });
    expect(await repo.decide("00000000-0000-4000-8000-000000000000", "approve")).toEqual({ outcome: "not_found", proposal: null, row: null });
    const rejected = await propose(gate, owner, REMINDER);
    expect(await repo.decide(rejected, "reject")).toMatchObject({ outcome: "rejected", proposal: { status: "rejected" } });
  });

  it("writes a late vector only while the memory still has the text that was embedded", async () => {
    const owner = await gate.createUser();
    const repo = createMemoryRepository(sqlGateClient(gate, owner));
    const memory = await gate.as<{ id: string }>(
      user(owner),
      "insert into memories (user_id, mode, content, source) values ($1, 'personal', 'Prefers tea', 'user') returning id",
      [owner],
    );
    const id = memory.rows[0]!.id;
    const vector = Array.from({ length: 1024 }, (_, i) => (i === 1 ? 1 : 0));
    await gate.as(user(owner), "update memories set content = 'Prefers coffee' where id = $1", [id]);
    expect(await repo.setEmbeddingIfContent(owner, id, "Prefers tea", vector)).toBe(false);
    expect((await gate.admin("select embedding from memories where id = $1", [id])).rows).toEqual([{ embedding: null }]);
    expect(await repo.setEmbeddingIfContent(owner, id, "Prefers coffee", vector)).toBe(true);
    const stored = await gate.admin<{ has: boolean }>("select embedding is not null as has from memories where id = $1", [id]);
    expect(stored.rows[0]!.has).toBe(true);
    const events = await gate.admin<{ event: string }>(
      "select event from action_log where detail ->> 'memoryId' = $1 order by created_at",
      [id],
    );
    expect(events.rows.map((row) => row.event)).toEqual(["memory_added", "memory_edited"]);
  });
  it("updates a memory only while it still has the text that was read", async () => {
    const owner = await gate.createUser();
    const repo = createMemoryRepository(sqlGateClient(gate, owner));
    const memory = await gate.as<{ id: string }>(
      user(owner),
      "insert into memories (user_id, mode, content, source) values ($1, 'personal', 'Likes tea', 'user') returning id",
      [owner],
    );
    const id = memory.rows[0]!.id;
    await gate.as(user(owner), "update memories set content = 'Likes coffee' where id = $1", [id]);
    expect(await repo.updateMemory(owner, id, { mode: "work" }, undefined, "Likes tea")).toBeNull();
    expect((await gate.admin("select content, mode from memories where id = $1", [id])).rows).toEqual([
      { content: "Likes coffee", mode: "personal" },
    ]);
    expect(await repo.updateMemory(owner, id, { mode: "work" }, undefined, "Likes coffee")).toMatchObject({ mode: "work" });
  });

  it("lists a proposal decided by the function as verified, and one decided by direct writes as not verified", async () => {
    const owner = await gate.createUser();
    const viaFunction = await propose(gate, owner, TASK);
    await decideAs(gate, owner, viaFunction, "approve");
    const direct = await propose(gate, owner, TASK);
    await gate.admin("update action_proposals set status = 'rejected', decided_at = now() where id = $1", [direct]);
    const listed = await createActionProposalRepository(sqlGateClient(gate, owner)).listProposals(owner, undefined, 10);
    const verified = Object.fromEntries(listed.map((proposal) => [proposal.id, proposal.verified]));
    expect(verified).toEqual({ [viaFunction]: true, [direct]: false });
  });
});


describe("repositories on a database that has rows the older schema allowed", () => {
  const OWNER = "22222222-2222-4222-8222-222222222222";
  const BAD_KIND = "22222222-2222-4222-8222-000000000001";
  const NESTED_LOG = "22222222-2222-4222-8222-000000000002";
  const OLD_FORGED_LOG = "22222222-2222-4222-8222-000000000003";
  let old: SqlGate;

  beforeAll(async () => {
    old = await startSqlGate({
      defaults: "legacy",
      beforeMigration: {
        file: "20261021000000_memory_hardening.sql",
        sql: `
          insert into auth.users (id) values ('${OWNER}');
          insert into action_proposals (id, user_id, kind, payload, summary) values
            ('${BAD_KIND}', '${OWNER}', 'create_task', '{"kind":"save_memory","mode":"personal","content":"x"}', 'bad');
          insert into action_log (id, user_id, event, detail) values
            ('${NESTED_LOG}', '${OWNER}', 'executed', '{"taskId":{"nested":"bad"}}'),
            (gen_random_uuid(), '${OWNER}', 'memory_added', '{"memoryId":"m"}'),
            ('${OLD_FORGED_LOG}', '${OWNER}', 'executed', '{"kind":"create_task","verified":true}');
        `,
      },
    });
  }, SQL_GATE_HOOK_TIMEOUT_MS);

  afterAll(async () => {
    await old?.close();
  }, SQL_GATE_HOOK_TIMEOUT_MS);

  it("rejects an older proposal whose payload names another kind, and answers with its ID and status", async () => {
    const repo = createActionProposalRepository(sqlGateClient(old, OWNER));
    expect(await repo.decide(BAD_KIND, "approve")).toEqual({
      outcome: "invalid",
      proposal: null,
      row: { id: BAD_KIND, status: "proposed" },
    });
    expect(await repo.decide(BAD_KIND, "reject")).toEqual({
      outcome: "rejected",
      proposal: null,
      row: { id: BAD_KIND, status: "rejected" },
    });
    const stored = await old.admin("select status from action_proposals where id = $1", [BAD_KIND]);
    expect(stored.rows).toEqual([{ status: "rejected" }]);
  });

  it("keeps older log rows, and the log reader skips the one it cannot read", async () => {
    const entries = await createActionLogRepository(sqlGateClient(old, OWNER)).list(OWNER, 50);
    expect(entries.map((entry) => entry.id)).not.toContain(NESTED_LOG);
    expect(entries.some((entry) => entry.event === "memory_added")).toBe(true);
  });

  it("reads a log row with a verified key, from before or during the expand step, as not verified", async () => {
    // During the expand step the older insert grant allows this; after the contract step it is refused.
    let duringId: string | null = null;
    const code = await errorCode(async () => {
      const during = await old.as<{ id: string }>(
        user(OWNER),
        `insert into action_log (user_id, event, detail)
         values ($1, 'executed', '{"kind":"create_task","verified":true,"taskId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}') returning id`,
        [OWNER],
      );
      duringId = during.rows[0]!.id;
    });
    expect([null, "42501"]).toContain(code);
    const entries = await createActionLogRepository(sqlGateClient(old, OWNER)).list(OWNER, 50);
    const verified = Object.fromEntries(entries.map((entry) => [entry.id, entry.verified]));
    expect(verified[OLD_FORGED_LOG]).toBe(false);
    if (duringId) expect(verified[duringId]).toBe(false);
  });
});
