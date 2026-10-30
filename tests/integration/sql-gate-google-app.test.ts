import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createConnectedAccountRepository } from "@/server/db/connected-accounts";
import { sqlGateClient } from "../support/sql-gate-client";
import { startSqlGate, type SqlGate } from "../support/sql-gate";

/** The connected accounts repository against the real SQL of every migration (decision 0014). */
let gate: SqlGate;

const READ = "https://www.googleapis.com/auth/gmail.readonly";
const SEND = "https://www.googleapis.com/auth/gmail.send";
const CIPHERTEXT = `v1.${"A".repeat(16)}.${"B".repeat(40)}`;
const NEWER = `v1.${"C".repeat(16)}.${"D".repeat(40)}`;

beforeAll(async () => {
  gate = await startSqlGate({ defaults: "none" });
});

afterAll(async () => {
  await gate?.close();
});

describe("connected accounts repository", () => {
  it("saves, reads the status without the ciphertext, reads the token row, and replaces on reconnect", async () => {
    const owner = await gate.createUser();
    const repo = createConnectedAccountRepository(sqlGateClient(gate, owner));
    expect(await repo.getGoogleConnection(owner)).toBeNull();
    await repo.saveGoogle("sub-1", "a@example.com", [READ], CIPHERTEXT);
    const status = await repo.getGoogleConnection(owner);
    expect(status).toEqual({ email: "a@example.com", scopes: [READ], status: "connected" });
    expect(JSON.stringify(status)).not.toContain(CIPHERTEXT);
    expect(await repo.getGoogleToken(owner)).toEqual({
      subject: "sub-1",
      email: "a@example.com",
      scopes: [READ],
      status: "connected",
      tokenCiphertext: CIPHERTEXT,
    });
    await repo.saveGoogle("sub-2", "b@example.com", [READ, SEND], NEWER);
    expect(await repo.getGoogleToken(owner)).toMatchObject({ subject: "sub-2", scopes: [READ, SEND], tokenCiphertext: NEWER });
  });

  it("marks needs_reconnect only while the row has the same ciphertext", async () => {
    const owner = await gate.createUser();
    const repo = createConnectedAccountRepository(sqlGateClient(gate, owner));
    await repo.saveGoogle("sub-1", "a@example.com", [READ], NEWER);
    await repo.markGoogleNeedsReconnect(owner, CIPHERTEXT);
    expect((await repo.getGoogleConnection(owner))!.status).toBe("connected");
    await repo.markGoogleNeedsReconnect(owner, NEWER);
    expect((await repo.getGoogleConnection(owner))!.status).toBe("needs_reconnect");
    await repo.saveGoogle("sub-1", "a@example.com", [READ], CIPHERTEXT);
    expect((await repo.getGoogleConnection(owner))!.status).toBe("connected");
  });

  it("deletes only the caller's row, and another user's reads see nothing", async () => {
    const alice = await gate.createUser();
    const bob = await gate.createUser();
    const aliceRepo = createConnectedAccountRepository(sqlGateClient(gate, alice));
    const bobRepo = createConnectedAccountRepository(sqlGateClient(gate, bob));
    await aliceRepo.saveGoogle("sub-a", "a@example.com", [READ], CIPHERTEXT);
    expect(await bobRepo.getGoogleToken(alice)).toBeNull();
    expect(await bobRepo.deleteGoogle(alice)).toBe(false);
    expect(await aliceRepo.deleteGoogle(alice)).toBe(true);
    expect(await aliceRepo.deleteGoogle(alice)).toBe(false);
    expect(await aliceRepo.getGoogleConnection(alice)).toBeNull();
  });
});
