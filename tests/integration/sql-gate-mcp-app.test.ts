import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createConnectedAccountRepository, createMcpAccountRepository } from "@/server/db/connected-accounts";
import { sqlGateClient } from "../support/sql-gate-client";
import { startSqlGate, type SqlGate } from "../support/sql-gate";

/** The MCP repository against the real SQL of every migration (decision 0016). */
let gate: SqlGate;

const C0 = `v1.${"A".repeat(16)}.${"B".repeat(40)}`;
const C1 = `v1.${"C".repeat(16)}.${"D".repeat(40)}`;
const C2 = `v1.${"E".repeat(16)}.${"F".repeat(40)}`;

beforeAll(async () => {
  gate = await startSqlGate({ defaults: "none" });
});

afterAll(async () => {
  await gate?.close();
});

describe("MCP accounts repository", () => {
  it("saves with no address, lists, and replaces on reconnect", async () => {
    const owner = await gate.createUser();
    const repo = createMcpAccountRepository(sqlGateClient(gate, owner));
    await createConnectedAccountRepository(sqlGateClient(gate, owner)).saveGoogle("g", "me@example.com", ["https://www.googleapis.com/auth/gmail.readonly"], C0);
    await repo.saveMcp("notion", "conn_a", ["default"], C0);
    expect(await repo.listMcp(owner)).toEqual([
      expect.objectContaining({ provider: "notion", subject: "conn_a", scopes: ["default"], status: "connected", tokenCiphertext: C0 }),
    ]);
    await repo.saveMcp("notion", "conn_b", ["default"], C1);
    expect(await repo.getMcp(owner, "notion")).toMatchObject({ subject: "conn_b", tokenCiphertext: C1, status: "connected" });
  });

  it("swaps only with the same subject, the ciphertext it read and status connected", async () => {
    const owner = await gate.createUser();
    const repo = createMcpAccountRepository(sqlGateClient(gate, owner));
    await repo.saveMcp("linear", "conn_a", ["read"], C0);
    expect(await repo.swapMcpCiphertext(owner, "linear", "conn_other", C0, C1)).toBe(false);
    expect(await repo.swapMcpCiphertext(owner, "linear", "conn_a", C2, C1)).toBe(false);
    expect(await repo.swapMcpCiphertext(owner, "linear", "conn_a", C0, C1)).toBe(true);
    expect(await repo.markMcpNeedsReconnect(owner, "linear", C1)).toBe(true);
    expect(await repo.swapMcpCiphertext(owner, "linear", "conn_a", C1, C2)).toBe(false);
    expect(await repo.getMcp(owner, "linear")).toMatchObject({ tokenCiphertext: C1, status: "needs_reconnect" });
  });

  it("deletes only the row with the ciphertext it read", async () => {
    const owner = await gate.createUser();
    const repo = createMcpAccountRepository(sqlGateClient(gate, owner));
    await repo.saveMcp("todoist", "conn_a", ["data:read"], C0);
    expect(await repo.deleteMcp(owner, "todoist", C1)).toBe(false);
    expect(await repo.deleteMcp(owner, "todoist", C0)).toBe(true);
    expect(await repo.getMcp(owner, "todoist")).toBeNull();
  });
});
