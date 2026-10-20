import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createActionLogRepository } from "@/server/db/action-log";
import { createActionProposalRepository } from "@/server/db/action-proposals";
import { sqlGateClient } from "../support/sql-gate-client";
import { TASK, propose } from "../support/sql-gate-actions";
import { startSqlGate, type SqlGate } from "../support/sql-gate";

/**
 * The code on main against the expand migration (20261021000000), with the
 * older default grants of the hosted project. The expand step must not break
 * it. The code PR that follows removes this code and this file.
 */

let gate: SqlGate;

beforeAll(async () => {
  gate = await startSqlGate({ defaults: "legacy" });
});

afterAll(async () => {
  await gate?.close();
});

describe("main's decision repository on the expand schema", () => {
  it("claims and finishes a proposal in two writes, as main's route does", async () => {
    const owner = await gate.createUser();
    const repo = createActionProposalRepository(sqlGateClient(gate, owner));
    const id = await propose(gate, owner, TASK);
    const claimed = await repo.claimForDecision(owner, id, "approved");
    expect(claimed).toMatchObject({ id, status: "approved" });
    const finished = await repo.finish(owner, id, "executed", { taskId: "00000000-0000-4000-8000-000000000001" });
    expect(finished).toMatchObject({ id, status: "executed" });
    // A second claim finds nothing, so main's route answers 409 and runs nothing.
    expect(await repo.claimForDecision(owner, id, "approved")).toBeNull();
    const row = await gate.admin("select decided_by_function from action_proposals where id = $1", [id]);
    expect(row.rows).toEqual([{ decided_by_function: false }]);
  });

  it("rejects in one write", async () => {
    const owner = await gate.createUser();
    const repo = createActionProposalRepository(sqlGateClient(gate, owner));
    const id = await propose(gate, owner, TASK);
    expect(await repo.claimForDecision(owner, id, "rejected")).toMatchObject({ status: "rejected" });
  });

  it("lists the log that the triggers write", async () => {
    const owner = await gate.createUser();
    await propose(gate, owner, TASK);
    const entries = await createActionLogRepository(sqlGateClient(gate, owner)).list(owner, 10);
    expect(entries.map((entry) => entry.event)).toEqual(["proposed"]);
  });
});
